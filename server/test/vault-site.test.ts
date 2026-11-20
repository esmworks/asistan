import type { Approval } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registrableSite, siteMatches } from '../src/services/vault';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type TestServer } from './helpers';

describe('girişin kaydedildiği site', () => {
  it('girişi kaydedilebilir alan adına göre saklar; ortak son ekleri ve kişisel sayfaları ayırır', () => {
    expect(registrableSite('accounts.google.com')).toBe('google.com');
    expect(registrableSite('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableSite('ayse.github.io')).toBe('ayse.github.io');
    expect(registrableSite('127.0.0.1')).toBe('127.0.0.1');
    expect(registrableSite('localhost')).toBe('localhost');
    // Saved for the site, it is found on its other addresses, never on a neighbour's.
    expect(siteMatches('mail.google.com', registrableSite('accounts.google.com'))).toBe(true);
    expect(siteMatches('other.co.uk', registrableSite('www.bbc.co.uk'))).toBe(false);
    expect(siteMatches('mehmet.github.io', registrableSite('ayse.github.io'))).toBe(false);
  });

  describe('giriş kartı', () => {
    let t: TestServer;
    beforeEach(async () => {
      t = await testServer();
    });
    afterEach(() => t.dispose());

    const card = async (exact: boolean) => {
      const bot = await t.bot();
      const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
      const asked = t.services.approvals.ask({
        threadId: thread.id,
        botId: bot.id,
        turnId: null,
        kind: 'login',
        toolName: 'browser_login',
        input: { site: 'example.com', host: 'accounts.example.com' },
      });
      const a = await waitFor(
        async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
      );
      await t.api('POST', `/api/approvals/${a.id}`, {
        decision: 'allow',
        login: { username: 'ayse', password: 'gizli-123', save: true, exact },
      });
      await asked;
      return (await t.api<{ site: string }[]>('GET', '/api/vault')).body.map((x) => x.site);
    };

    it('girişi siteye kaydeder; kişi isterse yalnızca o adrese', async () => {
      expect(await card(false)).toEqual(['example.com']);
      expect(await card(true)).toContain('accounts.example.com');
    });

    it("says why no login fits without naming any: a count of the person's own kept for other bots, and sites of the same name", async () => {
      const bot = await t.bot();
      const other = await t.bot();
      const save = (site: string, botIds?: string[]) =>
        t.api('POST', '/api/vault', { site, username: `kisi@${site}`, password: 'gizli-123', botIds });
      await save('example.com', [other.id]);
      await save('example.org');
      await save('unrelated.net');
      const why = await t.services.vault.whyNone('www.example.com', bot.id, OWNER_ID);
      expect(why).toEqual({ notShared: 1, otherSites: ['example.org'] });
      // The page of another site named alike sees the same-named sites only, never the rest.
      const alike = await t.services.vault.whyNone('example.co.uk', bot.id, OWNER_ID);
      expect(alike).toEqual({ notShared: 0, otherSites: ['example.org'] });
      // Another person's kept logins are not counted for someone else.
      expect((await t.services.vault.whyNone('example.com', bot.id, null)).notShared).toBe(0);
      expect(await t.services.vault.whyNone('plain.test', bot.id, OWNER_ID)).toEqual({
        notShared: 0,
        otherSites: [],
      });
    });
  });
});
