import type { Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closestNames } from '../src/services/bots';
import { testServer, type TestServer } from './helpers';

describe('closestNames', () => {
  it('folds case and Turkish letters, and finds prefixes, parts and small typos', () => {
    const names = ['Ayşe', 'Çağrı', 'Muhasebe Botu', 'Satış', 'Depo'];
    expect(closestNames('ayse', names)).toEqual(['Ayşe']);
    expect(closestNames('CAGRI', names)).toEqual(['Çağrı']);
    expect(closestNames('muhasebe', names)).toEqual(['Muhasebe Botu']);
    expect(closestNames('Satiş', names)).toEqual(['Satış']);
    expect(closestNames('Dopo', names)).toEqual(['Depo']);
  });

  it('suggests nothing when nothing is close, and caps the list', () => {
    expect(closestNames('zzzzzz', ['Ayşe', 'Depo'])).toEqual([]);
    expect(closestNames('', ['Ayşe'])).toEqual([]);
    expect(closestNames('bot', ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4'])).toHaveLength(3);
  });
});

describe('talking with other bots', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const lastText = async (threadId: string) => (await t.messages(threadId)).at(-1)!.text;

  it('offers a close name for a misspelt teammate but does not send to it', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayse","message":"selam"}]');
    await t.services.turns.idle();
    expect(await lastText(ta.id)).toContain('"Ayşe"');
    expect((await t.services.jobs.requestsFrom(a.id)).length).toBe(0);
    expect(
      (await t.api<Thread[]>('GET', `/api/bots/${b.id}/threads`)).body.some((x) => x.kind === 'bot'),
    ).toBe(false);
  });

  it('does not name a bot the person cannot reach', async () => {
    const a = await t.bot({ name: 'Ali' });
    const other = await t.person('other');
    const hidden = (
      await other.api<{ id: string }>('POST', '/api/bots', { name: 'Gizli Muhasebe', permissionMode: 'ask' })
    ).body;
    expect(hidden.id).toBeTruthy();
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Gizli Muhasebe","message":"selam"}]');
    await t.services.turns.idle();
    expect(await lastText(ta.id)).not.toContain('Şunu mu demek istedin');
  });

  it('lists only the requests this bot sent, open ones first', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    const tb = await main(b.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"ilk soru"}]');
    await t.services.turns.idle();
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"[bekle:300] ikinci soru"}]');
    // Ayşe's own request to Ali is not Ali's.
    await t.send(tb.id, '[araç:bot_send {"bot":"Ali","message":"Ayşe sorar"}]');
    await t.services.turns.idle();
    const mine = await t.services.jobs.requestsFrom(a.id);
    expect(mine.map((r) => r.request)).toEqual(['[bekle:300] ikinci soru', 'ilk soru']);
    expect(mine.every((r) => r.toBotName === 'Ayşe')).toBe(true);
    await t.send(ta.id, '[araç:bot_requests {}]');
    await t.services.turns.idle();
    const text = await lastText(ta.id);
    expect(text).toContain('ilk soru');
    expect(text).toContain('cevaplandı');
    expect(text).not.toContain('Ayşe sorar');
  });
});
