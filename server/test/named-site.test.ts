import type { Approval, Bot, Thread } from '@yumakbot/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { namesSite } from '../src/runtime/outside';
import type * as SkillLink from '../src/services/skill-link';
import { testServer, waitFor, type TestServer } from './helpers';

// Tests do not reach the internet: the sites below count as public without a name lookup.
vi.mock('../src/services/skill-link', async (load) => {
  const real = await load<typeof SkillLink>();
  return {
    ...real,
    publicHost: async (host: string) => /(^|\.)(facebook\.com|ornek-dukkan\.com)$/.test(host),
  };
});

describe('a site the person named', () => {
  it('is found by its domain or by its name at the start of a word', () => {
    const said = ["Facebook'taki SOĞUTMACILAR grubunun bekleyen isteklerine bak, sonra x.com'a da göz at"];
    expect(namesSite('https://www.facebook.com/groups/1/requests', said)).toBe(true);
    expect(namesSite('facebook.com', said)).toBe(true);
    expect(namesSite('https://m.facebook.com/', said)).toBe(true);
    expect(namesSite('https://x.com/erhanerbas', said)).toBe(true);
    expect(namesSite('https://www.instagram.com/', ['İNSTAGRAM hesabına bak'])).toBe(true);
    expect(namesSite('https://ornek-dukkan.com/sepet', ['Ornek-Dukkan siparişlerini say'])).toBe(true);
  });

  it('is not found in a longer word, another domain or a short name in a sentence', () => {
    const said = ['Facebook grubuna bak, tamam mı'];
    expect(namesSite('https://facebook.com.kotu.io/', said)).toBe(false);
    expect(namesSite('https://notfacebook.com/', said)).toBe(false);
    expect(namesSite('https://ok.ru/', ['ok, devam et'])).toBe(false);
    expect(namesSite('https://x.com/', ['bir sonraki adım'])).toBe(false);
    expect(namesSite('https://ebook.com/', ['facebook grubuna bak'])).toBe(false);
    // A look-alike letter makes another domain.
    expect(namesSite('https://www.İnstagram.com/', ['instagram hesabına bak'])).toBe(false);
    expect(namesSite('file:///etc/passwd', said)).toBe(false);
    expect(namesSite(undefined, said)).toBe(false);
  });
});

describe('opening a page on a site the person named, after outside text', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  /** The person asks the manager, which hands the work on after reading outside text. */
  const handOver = async (said: string, step: string, mode: Bot['permissionMode'] = 'review') => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const manager = await t.bot({ name: 'Yönetici', isManager: true });
    const to: Bot = await t.bot({ name: 'İş Sosyal', permissionMode: mode, internet: true });
    const thread = (await t.api<Thread>('GET', `/api/bots/${manager.id}/main-thread`)).body;
    const asked = await t.send(thread.id, said);
    await t.services.turns.idle();
    await t.services.jobs.send({
      from: manager,
      fromThreadId: thread.id,
      fromTurnId: asked.turnId!,
      parentJobId: null,
      to,
      text: step,
      kind: 'send',
      approvalId: null,
      outside: 'web',
    });
  };
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('goes without a card or a review', async () => {
    await handOver(
      'Facebook grubundaki üyelik isteklerine bak',
      '[izin:WebFetch {"url":"https://www.facebook.com/groups/1/member-requests"}]',
    );
    await t.services.turns.idle();
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(0);
    expect(t.engine.reviews).toHaveLength(0);
  });

  it('still goes to the review on a site the person did not name', async () => {
    await handOver(
      'Facebook grubundaki üyelik isteklerine bak',
      '[izin:WebFetch {"url":"https://ornek-dukkan.com/"}]',
    );
    await waitFor(async () => t.engine.reviews.find((r) => r.toolName === 'WebFetch'));
    for (const card of await pending())
      await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });
});
