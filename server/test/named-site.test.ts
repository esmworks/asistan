import type { Approval, Bot, Thread } from '@leafbot/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resembledSite } from '../src/runtime/outside';
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

describe('opening a page after outside text', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  /** The person asks the manager, which hands the work on after reading outside text. */
  const handOver = async (step: string) => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const manager = await t.bot({ name: 'Yönetici', isManager: true });
    const to: Bot = await t.bot({ name: 'İş Sosyal', permissionMode: 'auto', internet: true });
    const thread = (await t.api<Thread>('GET', `/api/bots/${manager.id}/main-thread`)).body;
    const asked = await t.send(thread.id, 'Facebook grubundaki üyelik isteklerine bak');
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
    await t.services.turns.idle();
  };

  it('goes without a card on the site the person named', async () => {
    await handOver('[izin:WebFetch {"url":"https://www.facebook.com/groups/1/member-requests"}]');
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(0);
  });

  it('goes without a card on another ordinary site too: the text read does not lower the level', async () => {
    await handOver('[izin:WebFetch {"url":"https://ornek-dukkan.com/"}]');
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(0);
  });
});

describe('a copy of a site', () => {
  const said = ['Facebook grubuna bak, 3esogutma.com sitesine de'];

  it('is told apart by look-alike letters, one letter off, or the name inside another domain', () => {
    for (const [url, site] of [
      ['https://faceb00k.com/login', 'facebook'],
      ['https://facebok.com', 'facebook'],
      ['https://facebook.com.giris.io', 'facebook'],
      ['https://facebook-login.net', 'facebook'],
      ['https://xn--fcebook-8va.com', 'facebook'],
      ['https://xn--instagram-5jf.com', 'instagram'],
      ['https://paypa1.com', 'paypal'],
      ['https://ptt-kargo-takip.xyz', 'ptt'],
      ['https://edevlet-giris.com', 'edevlet'],
      // A domain the person wrote, and a site they keep a sign-in for.
      ['https://3esogutrna.com', '3esogutma'],
      ['https://leafdesk-login.io', 'leafdesk'],
    ] as const) {
      expect(resembledSite(url, said, ['app.leafdesk.com']), url).toBe(site);
    }
    // A copy's address the person pasted from a message they were sent is still a copy.
    expect(resembledSite('https://faceb00k.com/giris', ['şu linke bak: faceb00k.com/giris'])).toBe(
      'facebook',
    );
  });

  it('is not the site itself on any suffix, nor an ordinary site', () => {
    for (const url of [
      'https://www.facebook.com/groups/1',
      'https://m.facebook.com',
      'https://google.com.tr',
      'https://3esogutma.com',
      'https://turkiye.gov.tr',
      'https://bbc.co.uk',
      'https://kontrol-paneli.com',
      'https://grubuna.com',
      'file:///etc/passwd',
    ]) {
      expect(resembledSite(url, said), url).toBeNull();
    }
  });
});

describe('opening a copy of a site', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  it('asks at every level, warns on the card and keeps no "always allow"', async () => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const bot = await t.bot({ name: 'İş Sosyal', permissionMode: 'auto', internet: true });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'Facebook grubuna bak [izin:WebFetch {"url":"https://faceb00k.com/giris"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    const shown = (await t.services.threads.messages(card.threadId, { limit: 20 })).find(
      (m) => m.role === 'approval',
    );
    expect(shown?.props.resembles).toBe('Facebook');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await t.services.turns.idle();
    expect((await t.services.approvals.rules(bot.id)).filter((r) => r.list === 'allow')).toHaveLength(0);
    expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.permissionMode).toBe('auto');
  });
});
