import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeAction, type Connection, type Routine, type RoutineRun, type Thread } from '@leafbot/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { testServer, type TestServer } from './helpers';

/** A mail app with a tool that reads the unread mail and one that sends. */
async function mailApp() {
  const state = { unread: 'yok', calls: 0 };
  const http: Server = createHttpServer(async (req, res) => {
    const s = new McpServer({ name: 'mail', version: '1.0.0' });
    s.registerTool(
      'unread',
      {
        description: 'Unread mail',
        inputSchema: { folder: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ folder }) => {
        state.calls++;
        return { content: [{ type: 'text', text: `${folder}: ${state.unread}` }] };
      },
    );
    s.registerTool('send', { description: 'Sends mail', inputSchema: { to: z.string() } }, async () => ({
      content: [{ type: 'text', text: 'sent' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void s.close();
    });
    await s.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}

describe('rutin denetimi', () => {
  let t: TestServer;
  let app: Awaited<ReturnType<typeof mailApp>>;
  let conn: Connection;
  beforeEach(async () => {
    t = await testServer();
    app = await mailApp();
    conn = (
      await t.api<Connection>('POST', '/api/connections', { name: 'Posta', url: app.url, auth: 'none' })
    ).body;
  });
  afterEach(async () => {
    await t.dispose();
    await app.close();
  });

  const tick = async () => {
    t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
    await t.services.routines.tick();
    await t.services.turns.idle();
  };

  it('bot yalnız uygulamanın cevabı değişince çalışır ve yeni cevabı alır', async () => {
    const bot = await t.bot();
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Posta',
      prompt: 'Yeni postayı özetle',
      schedule: { type: 'interval', minutes: 30 },
      check: { connectionId: conn.id, tool: 'unread', args: { folder: 'gelen' } },
    });
    expect(r.status).toBe(200);
    const runs = async () => (await t.api<RoutineRun[]>('GET', `/api/routines/${r.body.id}/runs`)).body;
    await tick(); // the first answer only sets what later ones are compared with
    await tick(); // unchanged
    expect(await runs()).toHaveLength(0);
    expect(app.state.calls).toBe(2);
    app.state.unread = 'Ayşe: fatura';
    await tick();
    expect(await runs()).toHaveLength(1);
    expect(t.engine.requests.at(-1)!.prompt).toContain('gelen: Ayşe: fatura');
    expect(t.engine.requests.at(-1)!.prompt).toContain('Posta · unread');
    await tick();
    expect(await runs()).toHaveLength(1);

    // Removing the check makes it an ordinary schedule again.
    await t.api('PATCH', `/api/routines/${r.body.id}`, { check: null });
    const all = (await t.api<Routine[]>('GET', '/api/routines')).body;
    expect(all.find((x) => x.id === r.body.id)!.check).toBeNull();
    await tick();
    expect(await runs()).toHaveLength(2);
  });

  it('yazan bir araç denetim olamaz', async () => {
    const bot = await t.bot();
    const r = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Gönder',
      prompt: 'x',
      schedule: { type: 'interval', minutes: 30 },
      check: { connectionId: conn.id, tool: 'send', args: { to: 'a@b.c' } },
    });
    expect(r.status).toBe(400);
  });

  it('bot denetimi kendi gördüğü araç adıyla kurar; yazan aracı kuramaz', async () => {
    const bot = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(
      thread.id,
      '[araç:routine_create {"name":"Gönderici","prompt":"x","schedule":{"type":"hourly","minute":0},"check_tool":"send"}]',
    );
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('denetim olamaz');
    await t.send(
      thread.id,
      `[araç:routine_create {"name":"Posta","prompt":"x","schedule":{"type":"hourly","minute":0},"check_tool":"mcp__${conn.slug}__unread","check_args":{"folder":"gelen"}}]`,
    );
    await t.services.turns.idle();
    const made = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.name === 'Posta')!;
    expect(made.check).toEqual({ connectionId: conn.id, tool: 'unread', args: { folder: 'gelen' } });
    expect(
      describeAction(
        'mcp__leafbot__routine_create',
        { name: 'X', schedule: { type: 'daily', time: '07:00' }, prompt: 'p', check_tool: 'unread' },
        { bot: 'Ali', locale: 'en' },
      ).detail,
    ).toBe('Every day at 07:00\nonly when unread answers something new\np');
  });
});
