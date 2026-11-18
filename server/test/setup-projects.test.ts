import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProjects } from '../src/services/setup-import';
import { testServer, type TestServer } from './helpers';

/** A home folder whose coding tools have worked in some folders, some of them not to be offered. */
function fakeHome() {
  const root = mkdtempSync(join(tmpdir(), 'yumakbot-proj-'));
  const home = join(root, 'ev');
  const dir = (...p: string[]) => {
    const d = join(home, ...p);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const site = dir('kod', 'site');
  const api = dir('kod', 'api');
  const used = dir('kod', 'bot-var');
  const worktree = dir('kod', 'site', '.claude', 'worktrees', 'deneme');
  const outside = join(root, 'disari');
  mkdirSync(outside);
  const data = dir('veri');
  dir('.ssh');
  const link = join(home, 'kod', 'site-baglanti');
  symlinkSync(site, link);
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { token: 'okunmamalı' },
      projects: Object.fromEntries(
        [
          site,
          used,
          worktree,
          home,
          join(home, '.ssh'),
          join(home, 'kod', 'silinmis'),
          data,
          link,
          outside,
        ].map((p) => [p, { lastSessionFirstPrompt: 'okunmamalı' }]),
      ),
    }),
  );
  dir('.codex');
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    `model = "x"\n\n[projects."${api}"]\ntrust_level = "trusted"\n\n[projects."${site}"]\ntrust_level = "trusted"\n\n[projects."/"]\n`,
  );
  // Claude Code's sessions folder for the site, named after its path: its time is the site's.
  const sessions = dir('.claude', 'projects', site.replace(/[^a-zA-Z0-9]/g, '-'));
  utimesSync(sessions, new Date('2026-11-10T10:00:00Z'), new Date('2026-11-10T10:00:00Z'));
  return { root, home, site, api, used, outside, data };
}

describe('bu bilgisayardaki ajanların klasörleri', () => {
  let roots: string[] = [];
  let t: TestServer | undefined;
  afterEach(async () => {
    await t?.dispose();
    t = undefined;
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    roots = [];
  });
  const home = () => {
    const h = fakeHome();
    roots.push(h.root);
    return h;
  };

  it('araçların çalıştığı klasörleri bulur; verilemeyecek ya da kullanılanları atlar', async () => {
    const h = home();
    const found = await findProjects({ dirs: [h.used] }, { home: h.home, dataDir: h.data, tmp: '/yok' });
    expect(found).toEqual([
      { path: h.site, name: 'site', sources: ['Claude Code', 'Codex'], lastUsed: '2026-11-10T10:00:00.000Z' },
      { path: h.api, name: 'api', sources: ['Codex'], lastUsed: null },
      { path: h.outside, name: 'disari', sources: ['Claude Code'], lastUsed: null },
    ]);
    // Nothing from what was said in a session reaches the list.
    expect(JSON.stringify(found)).not.toContain('okunmamalı');
  });

  it('geçici klasördekiler sunulmaz', async () => {
    const h = home();
    expect(await findProjects({ dirs: [] }, { home: h.home, dataDir: h.data })).toEqual([]);
  });

  it('çok büyük ya da bozuk liste bir şey bulmaz, hata da vermez', async () => {
    const h = home();
    writeFileSync(join(h.home, '.claude.json'), '{ bozuk');
    writeFileSync(join(h.home, '.codex', 'config.toml'), `[projects."${h.api}"]\n${'#'.repeat(250_000)}\n`);
    expect(await findProjects({ dirs: [] }, { home: h.home, dataDir: h.data, tmp: '/yok' })).toEqual([]);
  });

  it('sunucu kişinin bilgisayarında değilse liste yoktur', async () => {
    t = await testServer({ onUserComputer: false });
    expect((await t.api('GET', '/api/setup-import/projects')).body).toEqual({
      available: false,
      projects: [],
    });
  });
});
