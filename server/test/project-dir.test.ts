import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDirProblem } from '../src/workspace';
import { testServer, type TestServer } from './helpers';

describe('proje klasörü', () => {
  const opts = { home: '/home/ayse', dataDir: '/home/ayse/.yumakbot' };
  it('kökü, ev klasörünü ve onu içerenleri, veri klasörünü reddeder', () => {
    expect(projectDirProblem('/', opts)).toBe('error.projectDirTooWide');
    expect(projectDirProblem('/home', opts)).toBe('error.projectDirTooWide');
    expect(projectDirProblem('/home/ayse', opts)).toBe('error.projectDirTooWide');
    expect(projectDirProblem('/home/ayse/.yumakbot/workspaces', opts)).toBe('error.projectDirData');
    expect(projectDirProblem('proje', opts)).toBe('error.projectDirRelative');
    expect(projectDirProblem('/home/ayse/kod/site', opts)).toBeNull();
    expect(projectDirProblem('/srv/site', opts)).toBeNull();
  });

  it('anahtar ve oturum tutan ev klasörlerini ve içlerini reddeder', () => {
    expect(projectDirProblem('/home/ayse/.ssh', opts)).toBe('error.projectDirPrivate');
    expect(projectDirProblem('/home/ayse/.aws/sso', opts)).toBe('error.projectDirPrivate');
    expect(projectDirProblem('/home/ayse/.config/gcloud', opts)).toBe('error.projectDirPrivate');
    expect(projectDirProblem('/home/ayse/.claude', opts)).toBe('error.projectDirPrivate');
    expect(projectDirProblem('/home/ayse/.sshler', opts)).toBeNull();
  });

  describe('sunucuda', () => {
    let t: TestServer;
    beforeEach(async () => {
      t = await testServer();
    });
    afterEach(() => t.dispose());
    it('bot oluşturulurken ve güncellenirken uygular', async () => {
      expect((await t.api('POST', '/api/bots', { name: 'X', projectDir: homedir() })).status).toBe(400);
      const ok = mkdtempSync(join(tmpdir(), 'yumakbot-proje-'));
      const bot = await t.bot({ projectDir: ok });
      expect(bot.projectDir).toBe(ok);
      expect((await t.api('PATCH', `/api/bots/${bot.id}`, { projectDir: t.dataDir })).status).toBe(400);
      expect((await t.api('PATCH', `/api/bots/${bot.id}`, { projectDir: null })).status).toBe(200);
    });
  });
});
