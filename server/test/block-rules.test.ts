import type { Approval, PermissionRule, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockedPattern, ruleMatches } from '../src/services/approvals';
import { testServer, waitFor, type TestServer } from './helpers';

const ROUTINE = { name: 'Sabah', prompt: 'Günaydın de.', schedule: { type: 'daily', time: '08:00' } };

describe('engel kuralları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('engellenen araç hiçbir kipte, kart açılmadan çalışmaz', async () => {
    const rule = await t.api<PermissionRule>('POST', '/api/rules', {
      list: 'block',
      pattern: 'mcp__yumakbot__routine_create',
    });
    expect(rule.status).toBe(200);
    for (const mode of ['ask', 'auto'] as const) {
      const bot = await t.bot({ name: `Bot ${mode}`, permissionMode: mode });
      const thread = await main(bot.id);
      await t.send(thread.id, `[araç:routine_create ${JSON.stringify(ROUTINE)}]`);
      await t.services.turns.idle();
      expect(await pending()).toEqual([]);
      expect((await t.messages(thread.id)).at(-1)!.text).toContain('engelledi');
      expect((await t.services.routines.list(bot.id)).length).toBe(0);
    }
  });

  it('karttaki "hiç izin verme" aracı engeller; sonraki istek sormadan reddedilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, `[araç:routine_create ${JSON.stringify(ROUTINE)}]`);
    const card = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny', remember: true });
    await t.services.turns.idle();
    const rules = (await t.api<PermissionRule[]>('GET', '/api/rules')).body;
    expect(rules).toEqual([
      expect.objectContaining({ list: 'block', pattern: card.toolName, botId: bot.id }),
    ]);

    await t.send(thread.id, `[araç:routine_create ${JSON.stringify({ ...ROUTINE, name: 'Öğle' })}]`);
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('engelledi');
  });

  it('"hiç izin verme" yalnızca o adımı ve yalnızca o botta engeller', async () => {
    const [bot, other] = [
      await t.bot({ name: 'A', permissionMode: 'ask' }),
      await t.bot({ name: 'B', permissionMode: 'ask' }),
    ];
    const thread = await main(bot.id);
    const push = `[izin:Bash ${JSON.stringify({ command: 'git push origin main' })}]`;
    await t.send(thread.id, push);
    const card = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny', remember: true });
    await t.services.turns.idle();
    const rules = (await t.api<PermissionRule[]>('GET', '/api/rules')).body;
    expect(rules).toEqual([
      expect.objectContaining({ list: 'block', pattern: 'Bash(git push:*)', botId: bot.id }),
    ]);

    // The same push again is refused without a card; another command still asks.
    await t.send(thread.id, `[izin:Bash ${JSON.stringify({ command: 'git push origin dev' })}]`);
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('engelledi');
    await t.send(thread.id, `[izin:Bash ${JSON.stringify({ command: 'gh pr list' })}]`);
    const status = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${status.id}`, { decision: 'deny' });
    await t.services.turns.idle();

    // Another bot still asks for the same push.
    await t.send((await main(other.id)).id, push);
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ botId: other.id });
    await t.api('POST', `/api/threads/${(await main(other.id)).id}/stop`);
    await t.services.turns.idle();
  });

  it('"hiç izin verme" dosyayı, desenli komutu ve sırlı adımı da dar ve sırsız engeller', () => {
    expect(blockedPattern('Write', { file_path: 'notes/draft.md' })).toBe('Write(notes/draft.md)');
    expect(blockedPattern('Edit', { file_path: '/w/a/b.ts' })).toBe('Edit(/w/a/b.ts)');
    expect(blockedPattern('Bash', { command: 'git push origin main' })).toBe('Bash(git push:*)');
    expect(blockedPattern('Bash', { command: 'rm -f *.log' })).toBe('Bash(rm -f *.log)');
    expect(blockedPattern('Bash', { command: 'PGPASSWORD=hunter22 psql -h db' })).toBe(
      'Bash(PGPASSWORD=* psql:*)',
    );
    expect(blockedPattern('WebFetch', { url: 'not a url' })).toBe('WebFetch(not a url)');
    expect(blockedPattern('mcp__yumakbot__routine_create', { name: 'x' })).toBe(
      'mcp__yumakbot__routine_create',
    );
    // What it writes covers the step it was written for.
    for (const [tool, input] of [
      ['Write', { file_path: 'notes/draft.md' }],
      ['Bash', { command: 'rm -f *.log' }],
      ['Bash', { command: 'PGPASSWORD=hunter22 psql -h db' }],
    ] as const) {
      expect(ruleMatches(blockedPattern(tool, input), tool, input), tool).toBe(true);
    }
  });
});
