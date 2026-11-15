import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, testServer, type TestServer } from './helpers';

/** A JSON-RPC call to the MCP endpoint; the answer may come as JSON or as one server-sent event. */
async function rpc(t: TestServer, method: string, params: object, headers: Record<string, string> = AUTH) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: {
      ...headers,
      host: 'localhost',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  const body = res.body.startsWith('{') ? res.body : (/^data: (.*)$/m.exec(res.body)?.[1] ?? '{}');
  return {
    status: res.statusCode,
    json: JSON.parse(body) as { result?: { tools?: { name: string }[]; content?: { text: string }[] } },
  };
}

describe('MCP sunucusu', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('araçları listeler, bir bota sorar ve yanıtını döndürür', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const init = await rpc(t, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.status).toBe(200);
    const tools = await rpc(t, 'tools/list', {});
    expect(tools.json.result!.tools!.map((x) => x.name).sort()).toEqual([
      'ask_bot',
      'get_reply',
      'list_bots',
    ]);
    const listed = await rpc(t, 'tools/call', { name: 'list_bots', arguments: {} });
    expect(listed.json.result!.content![0]!.text).toContain(bot.id);
    const asked = await rpc(t, 'tools/call', {
      name: 'ask_bot',
      arguments: { bot: 'Katip', message: 'merhaba' },
    });
    const reply = JSON.parse(asked.json.result!.content![0]!.text) as { status: string; reply: string };
    expect(reply).toMatchObject({ status: 'done' });
    expect(reply.reply).toContain('merhaba');
  });

  it('anahtarsız isteği reddeder', async () => {
    expect((await rpc(t, 'tools/list', {}, {})).status).toBe(401);
  });
});
