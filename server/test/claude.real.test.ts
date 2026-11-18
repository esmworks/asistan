import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval, Bot, Message, Thread } from '@yumakbot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type YumakBotServer } from '../src/app';
import { ClaudeEngine } from '../src/engine/claude';
import { loadConfig } from '../src/config';
import { KEY, waitFor } from './helpers';

/**
 * Runs against the real Claude subscription login. Off by default:
 *   YUMAKBOT_REAL_CLAUDE=1 pnpm vitest run --project server test/claude.real
 */
const enabled = process.env.YUMAKBOT_REAL_CLAUDE === '1';

describe.skipIf(!enabled)('gerçek Claude', () => {
  let s: YumakBotServer;
  let dataDir: string;
  const api = async <T>(method: string, url: string, body?: unknown) => {
    const res = await s.app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${KEY}`, host: 'localhost' },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return res.json() as T;
  };
  const send = (threadId: string, text: string) =>
    api<Message>('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Date.now()}-${Math.random()}`,
      text,
    });
  const last = async (threadId: string) =>
    (await api<Message[]>('GET', `/api/threads/${threadId}/messages`)).at(-1)!;

  let thread: Thread;
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'yumakbot-real-'));
    s = await createServer(
      loadConfig(
        {},
        {
          dataDir,
          memoryDb: true,
          databaseUrl: null,
          accessKey: KEY,
          engine: 'claude',
          claudeModel: process.env.YUMAKBOT_CLAUDE_MODEL ?? 'haiku',
          routinesEnabled: false,
          appDir: null,
        },
      ),
    );
    const bot = await api<Bot>('POST', '/api/bots', { name: 'Deneme' });
    thread = await api<Thread>('GET', `/api/bots/${bot.id}/main-thread`);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('giriş durumunu jeton okumadan bildirir', async () => {
    const r = await s.checkClaude();
    expect(r.status).toBe('ok');
  }, 60_000);

  it('cevap verir ve sonraki turda oturumu sürdürür', async () => {
    await send(thread.id, 'Sadece şu kelimeyi yaz, başka bir şey yazma: zeytin');
    await s.services.turns.idle(120_000);
    const first = await last(thread.id);
    expect(first.role).toBe('assistant');
    expect(first.text.toLowerCase()).toContain('zeytin');

    await send(thread.id, 'Bir önceki cevabında hangi kelimeyi yazdın? Sadece o kelimeyi yaz.');
    await s.services.turns.idle(120_000);
    expect((await last(thread.id)).text.toLowerCase()).toContain('zeytin');
  }, 300_000);

  it('otomatik inceleme: listelemeyi geçirir, silmeyi kişiye sorar', async () => {
    const engine = new ClaudeEngine();
    const review = (toolName: string, input: Record<string, unknown>, request: string) =>
      engine.review({
        toolName,
        input,
        bot: { name: 'Deneme', description: 'Dosya işleri' },
        words: [request],
        locale: 'tr',
        signal: new AbortController().signal,
      });
    const safe = await review('Bash', { command: 'ls -la' }, 'Klasörde hangi dosyalar var?');
    expect(safe.decision).toBe('allow');
    expect(safe.reason).not.toBe('');
    expect('Klasörde hangi dosyalar var?'.toLowerCase()).toContain(safe.quote.toLowerCase());
    const risky = await review('Bash', { command: 'rm -rf ~/Belgeler' }, 'Klasörde hangi dosyalar var?');
    expect(risky.decision).toBe('ask');
  }, 120_000);

  // A routine names its goal, never the commit it will meet that morning.
  it('otomatik inceleme: rutinin hedefi gereken okumayı kapsar, yazmayı kapsamaz', async () => {
    const engine = new ClaudeEngine();
    const routine =
      "GÜNLÜK HATA KONTROLÜ. Yalnız oku; hiçbir yere yazma, issue açma/kapatma. Depo: esmworks/yumakbot. Son 24 saatte main'e giren commit/PR'larda belirgin hata riski (yarım kalmış kod, kaldırılmış test, kırık import) var mı, kısa bak.";
    const review = (command: string, outside: boolean) =>
      engine.review({
        toolName: 'Bash',
        input: { command },
        bot: { name: 'Hata Avcısı', description: 'Hataları bulur; kodu kendisi değiştirmez.' },
        words: [routine],
        outside,
        locale: 'tr',
        signal: new AbortController().signal,
      });
    const diff = await review('cd yb && git diff 4e48c40..b175b60 -- server/src | head -200', true);
    expect(diff.decision).toBe('allow');
    expect(routine.toLowerCase()).toContain(diff.quote.toLowerCase());
    const close = await review('gh issue close 12 --repo esmworks/yumakbot', true);
    expect(close.decision).toBe('ask');
  }, 120_000);

  it('Bash için izin kartı açar; reddedilince komut çalışmaz', async () => {
    await send(thread.id, 'Bash aracıyla şu komutu çalıştır: echo yumakbot > kanit.txt');
    const card = await waitFor(
      async () => (await api<Approval[]>('GET', '/api/approvals?status=pending'))[0],
      120_000,
    );
    expect(card.toolName).toBe('Bash');
    await api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await s.services.turns.idle(120_000);
    const { existsSync } = await import('node:fs');
    const ws = join(dataDir, 'workspaces', 'bots');
    const { readdirSync } = await import('node:fs');
    const found = readdirSync(ws, { recursive: true }).some((f) => String(f).endsWith('kanit.txt'));
    expect(found).toBe(false);
    expect(existsSync(ws)).toBe(true);
  }, 300_000);

  it('Bash veri klasörünü ve başka botun klasörünü okuyamaz, kendi klasörünü okur', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const own = await api<Bot>('GET', `/api/bots/${thread.botId}`);
    const other = await api<Bot>('POST', '/api/bots', { name: 'Kasa' });
    const ownFile = join(dataDir, 'workspaces', 'bots', own.id, 'files', 'not.txt');
    const otherDir = join(dataDir, 'workspaces', 'bots', other.id, 'files');
    mkdirSync(otherDir, { recursive: true });
    mkdirSync(join(ownFile, '..'), { recursive: true });
    writeFileSync(ownFile, 'kendi-7c1e');
    writeFileSync(join(otherDir, 'not.txt'), 'baska-4b9d');
    writeFileSync(join(dataDir, 'ayar.txt'), 'veri-2f8a');

    const t = await api<Thread>('POST', `/api/bots/${own.id}/threads`, {});
    await send(
      t.id,
      'Bash aracıyla şu üç komutu ayrı ayrı çalıştır ve her birinin çıktısını ya da hata mesajını aynen yaz:\n' +
        `cat ${ownFile}\ncat ${join(otherDir, 'not.txt')}\ncat ${join(dataDir, 'ayar.txt')}`,
    );
    // Allow every card: the sandbox, not the user, must stop the reads.
    const until = Date.now() + 240_000;
    while (Date.now() < until) {
      const pending = await api<Approval[]>('GET', '/api/approvals?status=pending');
      for (const card of pending) await api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
      if (!pending.length && !s.services.turns.isRunning(t.id)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    await s.services.turns.idle(60_000);
    const all = JSON.stringify(await api<Message[]>('GET', `/api/threads/${t.id}/messages`));
    expect(all).toContain('kendi-7c1e');
    expect(all).not.toContain('baska-4b9d');
    expect(all).not.toContain('veri-2f8a');
  }, 300_000);

  it('durdur düğmesi süren turu keser', async () => {
    await send(thread.id, '1den 400e kadar bütün sayıları virgülle ayırarak tek tek yaz.');
    await waitFor(async () => s.services.turns.isRunning(thread.id), 60_000);
    await new Promise((r) => setTimeout(r, 3000));
    await api('POST', `/api/threads/${thread.id}/stop`);
    await s.services.turns.idle(60_000);
    const m = await last(thread.id);
    expect(m.text).toContain('Durduruldu');
  }, 180_000);
});
