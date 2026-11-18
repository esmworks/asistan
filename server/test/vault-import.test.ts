import type { ApiCredential, ApiKeyImportResult, VaultImportResult, VaultLogin } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyNameOf } from '../src/services/api-credentials';
import { csvRows, envEntries, loginsFromCsv } from '../src/services/vault-import';
import { testServer, type Person, type TestServer } from './helpers';

const TOTP = 'JBSWY3DPEHPK3PXP';

describe('içe aktarılan dosyaları okuma', () => {
  it('CSV tırnaklı alanları, satır içi virgül ve satır sonlarını, BOM işaretini okur', () => {
    const rows = csvRows('\uFEFFa,b,c\r\n"x, y","çok\nsatır","tırnak ""iç"""\r\n\r\nson,,\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'çok\nsatır', 'tırnak "iç"'],
      ['son', '', ''],
    ]);
  });

  it('tarayıcıların ve parola yöneticilerinin sütun adlarını tanır', () => {
    // A browser's export: name, url, username, password, note.
    const browser = loginsFromCsv(
      'name,url,username,password,note\nGitHub,https://github.com/login,ayse,s1fre!,\n',
    );
    expect(browser.logins).toEqual([
      { line: 2, url: 'https://github.com/login', username: 'ayse', password: 's1fre!', totp: null },
    ]);
    // A manager's export with item kinds: only sign-ins are taken; its authenticator column is read.
    const manager = loginsFromCsv(
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
        `,,login,Banka,,,0,https://banka.example,ayse,parola-1,${TOTP}\n` +
        ',,note,Not,gizli not,,0,,,,\n' +
        ',,login,Boş,,,0,https://bos.example,ayse,,\n',
    );
    expect(manager.logins).toEqual([
      { line: 2, url: 'https://banka.example', username: 'ayse', password: 'parola-1', totp: TOTP },
    ]);
    expect(manager.skipped.map((s) => [s.line, s.reason])).toEqual([
      [3, 'notLogin'],
      [4, 'noPassword'],
    ]);
    // Title, Url, Username, Password, OTPAuth: the authenticator as an otpauth link.
    const titled = loginsFromCsv(
      `Title,Url,Username,Password,OTPAuth\nPosta,posta.example,a@b.c,p,otpauth://totp/x?secret=${TOTP}\n`,
    );
    expect(titled.logins[0]).toMatchObject({ url: 'posta.example', totp: `otpauth://totp/x?secret=${TOTP}` });
    // An export that keeps the address the account was made with beside an empty username.
    const withEmail = loginsFromCsv(
      'type,name,url,email,username,password\nlogin,X,https://x.example,a@b.c,,p\n',
    );
    expect(withEmail.logins[0]!.username).toBe('a@b.c');
    expect(loginsFromCsv('ad,soyad\nA,B\n').unknown).toBe(true);
  });

  it('.env dosyasının girdilerini ve önerilen anahtar adlarını çıkarır', () => {
    const entries = envEntries(
      '# yorum\nexport OPENWEATHER_API_KEY="abc def"\nGITHUB_TOKEN=ghp_123 # not\nBOS=\nTEKRAR=1\nTEKRAR=2\n',
    );
    expect(entries.map((e) => [e.name, e.value])).toEqual([
      ['OPENWEATHER_API_KEY', 'abc def'],
      ['GITHUB_TOKEN', 'ghp_123'],
      ['TEKRAR', '2'],
    ]);
    expect(keyNameOf('OPENWEATHER_API_KEY')).toBe('openweather');
    expect(keyNameOf('GITHUB_TOKEN')).toBe('github');
    expect(keyNameOf('STRIPE_SECRET')).toBe('stripe');
    expect(keyNameOf('API_KEY')).toBe('api_key');
  });
});

describe('kasaya içe aktarma', () => {
  let t: TestServer;
  let ayse: Person;
  beforeEach(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
  });
  afterEach(() => t.dispose());

  const CSV =
    'name,url,username,password,totp\n' +
    `Giriş,https://accounts.ornek.com/login,ayse,sifre-1,${TOTP}\n` +
    'Düz,http://duz.example,ayse,sifre-2,\n' +
    'Uygulama,android://com.example.app,ayse,sifre-3,\n' +
    'Tekrar,https://ornek.com,ayse,sifre-4,\n' +
    'Var,https://var.example,ayse,sifre-5,\n' +
    'Bozuk kod,https://kod.example,ayse,sifre-6,bu-bir-kod-degil!\n';

  it('önce önizler, onaydan sonra kaydeder; https olmayanı, yineleneni ve kasada olanı atlar', async () => {
    await ayse.api('POST', '/api/vault', { site: 'var.example', username: 'ayse', password: 'eski-sifre' });
    const preview = await ayse.api<VaultImportResult>('POST', '/api/vault/import', { csv: CSV });
    expect(preview.status).toBe(200);
    expect(preview.body.saved).toBe(0);
    // Saved under the registrable domain, as a sign-in typed on a card is.
    expect(preview.body.add).toEqual([
      { line: 2, site: 'ornek.com', username: 'ayse', hasTotp: true },
      { line: 7, site: 'kod.example', username: 'ayse', hasTotp: false },
    ]);
    expect(preview.body.skipped.map((s) => [s.line, s.reason])).toEqual([
      [3, 'notHttps'],
      [4, 'noSite'],
      [5, 'duplicate'],
      [6, 'exists'],
    ]);
    expect(preview.body.totpDropped).toBe(1);
    // Nothing is saved by a preview, and no password comes back.
    expect((await ayse.api<VaultLogin[]>('GET', '/api/vault')).body).toHaveLength(1);
    expect(JSON.stringify(preview.body)).not.toContain('sifre-1');

    const done = await ayse.api<VaultImportResult>('POST', '/api/vault/import', { csv: CSV, apply: true });
    expect(done.body.saved).toBe(2);
    const mine = (await ayse.api<VaultLogin[]>('GET', '/api/vault')).body;
    expect(mine.map((l) => [l.site, l.userId, l.hasTotp]).sort()).toEqual(
      [
        ['kod.example', 'ayse', false],
        ['ornek.com', 'ayse', true],
        ['var.example', 'ayse', false],
      ].sort(),
    );
    // The imported password is typed on the site and its subdomains, like any saved one.
    const typed = await t.services.vault.forHost('mail.ornek.com', undefined, 'ayse');
    expect(typed.map((c) => [c.password, c.totp])).toEqual([['sifre-1', TOTP]]);
    // The one already in the vault kept its own password.
    expect((await t.services.vault.forHost('var.example', undefined, 'ayse'))[0]!.password).toBe(
      'eski-sifre',
    );

    // A second run adds nothing.
    const again = await ayse.api<VaultImportResult>('POST', '/api/vault/import', { csv: CSV, apply: true });
    expect(again.body.saved).toBe(0);
    // A member imports for the team only if they look after the server.
    expect((await ayse.api('POST', '/api/vault/import', { csv: CSV, team: true })).status).toBe(403);
    expect((await ayse.api('POST', '/api/vault/import', { csv: 'a,b\n1,2\n' })).status).toBe(400);
  });

  it('.env dosyasından seçilen anahtarları kaydeder; değerleri hiç geri vermez', async () => {
    const env = 'OPENWEATHER_API_KEY=hava-anahtari-123\nGITHUB_TOKEN=ghp_gizli_456\n';
    const look = await ayse.api<ApiKeyImportResult>('POST', '/api/api-keys/import', { env });
    expect(look.body.entries).toEqual([
      { line: 1, env: 'OPENWEATHER_API_KEY', name: 'openweather' },
      { line: 2, env: 'GITHUB_TOKEN', name: 'github' },
    ]);
    expect(look.body.saved).toEqual([]);
    expect(JSON.stringify(look.body)).not.toContain('hava-anahtari');

    const done = await ayse.api<ApiKeyImportResult>('POST', '/api/api-keys/import', {
      env,
      keys: [
        {
          env: 'OPENWEATHER_API_KEY',
          name: 'hava',
          origin: 'api.openweather.example',
          auth: { type: 'query', param: 'appid' },
        },
        { env: 'YOK', name: 'yok', origin: 'https://yok.example' },
      ],
    });
    expect(done.body.saved).toEqual(['hava']);
    expect(done.body.skipped).toEqual([{ env: 'YOK', reason: 'missing' }]);
    const keys = (await ayse.api<ApiCredential[]>('GET', '/api/api-keys')).body;
    expect(keys).toEqual([
      expect.objectContaining({
        name: 'hava',
        origin: 'https://api.openweather.example',
        userId: 'ayse',
        auth: { type: 'query', param: 'appid' },
      }),
    ]);
    const twice = await ayse.api<ApiKeyImportResult>('POST', '/api/api-keys/import', {
      env,
      keys: [{ env: 'OPENWEATHER_API_KEY', name: 'hava', origin: 'api.openweather.example' }],
    });
    expect(twice.body.skipped).toEqual([{ env: 'OPENWEATHER_API_KEY', reason: 'exists' }]);
  });
});
