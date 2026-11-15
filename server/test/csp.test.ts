import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appPolicy, inlineScriptHashes } from '../src/csp';
import { OAUTH_CALLBACK_PATH } from '../src/services/connections';
import { testServer, type TestServer } from './helpers';

const THEME = "\n      document.documentElement.classList.add('dark');\n    ";
const PAGE = `<!doctype html><html><head><script>${THEME}</script>
<script type="module" crossorigin src="/assets/index.js"></script></head><body></body></html>`;
const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

describe('içerik güvenlik politikası', () => {
  it('satır içi betiklerin özetini çıkarır; dosyadan yüklenen betiği saymaz', () => {
    expect(inlineScriptHashes(PAGE)).toEqual([sha(THEME)]);
    const policy = appPolicy(PAGE);
    expect(policy).toContain(`script-src 'self' ${sha(THEME)}`);
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('https:');
  });

  describe('sunucu', () => {
    let t: TestServer;
    let appDir: string;
    beforeEach(async () => {
      appDir = mkdtempSync(join(tmpdir(), 'yumakbot-app-'));
      mkdirSync(join(appDir, 'assets'));
      writeFileSync(join(appDir, 'index.html'), PAGE);
      writeFileSync(join(appDir, 'assets', 'index.js'), 'export {};');
      t = await testServer({ appDir });
    });
    afterEach(async () => {
      await t.dispose();
      rmSync(appDir, { recursive: true, force: true });
    });

    const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { host: 'localhost' } });

    it('sayfayı ve uygulama içi adresleri politikayla gönderir', async () => {
      for (const url of ['/', '/index.html', '/bot/abc']) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-security-policy'], url).toBe(appPolicy(PAGE));
      }
      expect((await get('/assets/index.js')).headers['content-security-policy']).toBeUndefined();
    });

    it('adı içeriğinden gelen dosyaları kalıcı, sayfayı her seferinde doğrulanacak biçimde önbelleğe verir', async () => {
      expect((await get('/assets/index.js')).headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect((await get('/')).headers['cache-control']).toBe('no-cache');
      expect((await get('/bot/abc')).headers['cache-control']).toBe('no-cache');
    });

    it('bağlantı dönüş sayfası betik çalıştıramaz', async () => {
      const res = await get(OAUTH_CALLBACK_PATH);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });
  });
});
