import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageFile, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('botlar arası işle dosya verme', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const threadDir = (botId: string, threadId: string) => {
    const dir = join(t.dataDir, 'workspaces', 'bots', botId, 'threads', threadId);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const peer = async (botId: string) =>
    (await t.api<Thread[]>('GET', `/api/bots/${botId}/threads`)).body.find((x) => x.kind === 'bot')!;
  const call = (tool: string, input: unknown) => `[araç:${tool} ${JSON.stringify(input)}]`;

  it('işle giden dosyanın kopyası hedef botun sohbet klasörüne gelir; hedef nerede olduğunu okur', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    writeFileSync(join(threadDir(a.id, ta.id), 'rapor.txt'), 'ilk taslak');
    await t.send(ta.id, call('bot_send', { bot: 'Ayşe', message: 'buna bak', files: ['rapor.txt'] }));
    await t.services.turns.idle();

    const tb = await peer(b.id);
    const copy = join(threadDir(b.id, tb.id), 'received', 'Ali', 'rapor.txt');
    expect(readFileSync(copy, 'utf8')).toBe('ilk taslak');
    const request = (await t.messages(tb.id)).find((m) => m.role === 'user')!;
    expect((request.props.files as MessageFile[]).map((f) => f.name)).toEqual(['rapor.txt']);
    const prompt = t.engine.requests.find((r) => r.botId === b.id)!.prompt;
    expect(prompt).toContain('received/Ali/rapor.txt');

    // A later edit of the sender's file does not change the copy that was handed over.
    writeFileSync(join(threadDir(a.id, ta.id), 'rapor.txt'), 'değişti');
    expect(readFileSync(copy, 'utf8')).toBe('ilk taslak');
  });

  it('bot klasörlerinin dışındaki dosya verilemez; iş de gönderilmez', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    await t.send(ta.id, call('bot_send', { bot: 'Ayşe', message: 'buna bak', files: ['/etc/hosts'] }));
    await t.services.turns.idle();
    expect(t.engine.requests.some((r) => r.botId === b.id)).toBe(false);
    expect((await t.messages(ta.id)).some((m) => m.role === 'marker')).toBe(false);
  });

  it('hedef bot cevabıyla dosya döndürür; kopyası soran botun klasörüne gelir ve cevapta yazar', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    writeFileSync(join(threadDir(a.id, ta.id), 'veri.csv'), 'a,b');
    // Ayşe's turn reads the request and runs the call in it: the handed file goes straight back.
    const message = `düzelt ${call('reply_files', { paths: ['received/Ali/veri.csv'] })}`;
    await t.send(ta.id, call('bot_send', { bot: 'Ayşe', message, files: ['veri.csv'] }));
    await t.services.turns.idle();

    const back = join(threadDir(a.id, ta.id), 'received', 'Ayşe', 'veri.csv');
    expect(existsSync(back)).toBe(true);
    const delivered = t.engine.requests.filter((r) => r.botId === a.id).at(-1)!.prompt;
    expect(delivered).toContain('Ayşe cevap verdi');
    expect(delivered).toContain('received/Ayşe/veri.csv');
  });

  it('reply_files yalnız bir işi cevaplayan turda vardır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const ta = await main(a.id);
    await t.send(ta.id, call('reply_files', { paths: ['x.txt'] }));
    await t.services.turns.idle();
    const tools = t.engine.requests.at(-1)!.tools.map((x) => x.name);
    expect(tools).not.toContain('reply_files');
  });
});
