import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message, MessageFile, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fitBox, pictureSize } from '../src/tools/slides';
import { workspacePaths } from '../src/workspace';
import { testServer, type TestServer } from './helpers';

/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** The names of the files inside a zip (a .pptx is one), read from its entries' headers. */
function zipNames(zip: Buffer): string[] {
  const names: string[] = [];
  for (
    let i = zip.indexOf('PK\x01\x02', 0, 'latin1');
    i >= 0;
    i = zip.indexOf('PK\x01\x02', i + 4, 'latin1')
  ) {
    const length = zip.readUInt16LE(i + 28);
    names.push(zip.subarray(i + 46, i + 46 + length).toString('utf8'));
  }
  return names;
}

describe('the bot making a slide deck', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const make = async (threadId: string, input: Record<string, unknown>) => {
    await t.send(threadId, `[araç:slides_create ${JSON.stringify(input)}]`);
    await t.services.turns.idle();
    return t.messages(threadId);
  };
  const cards = (msgs: Message[]) =>
    msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.props.files));

  it('writes a PowerPoint file with each slide, its notes and its picture, and sends it', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const dir = workspacePaths(t.dataDir, bot.id, thread.id, bot.groupId).threadDir;
    writeFileSync(join(dir, 'grafik.png'), PNG);
    const msgs = await make(thread.id, {
      title: 'Çeyrek raporu: 3. çeyrek',
      theme: 'dark',
      accent: '#E4572E',
      caption: 'Deste hazır',
      slides: [
        { title: 'Çeyrek raporu', subtitle: 'Kasım 2026' },
        {
          title: 'Öne çıkanlar',
          bullets: ['Gelir %12 arttı', 'İki yeni müşteri'],
          notes: 'Önce geliri anlat',
        },
        { title: 'Grafik', image: 'grafik.png' },
        { layout: 'section', title: 'Sonraki adımlar' },
      ],
    });
    const [card] = cards(msgs);
    expect(card!.text).toBe('Deste hazır');
    const [file] = card!.props.files as MessageFile[];
    expect(file!.name).toBe('Çeyrek-raporu-3-çeyrek.pptx');
    const names = zipNames(readFileSync(join(t.dataDir, 'workspaces', file!.path)));
    expect(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).toHaveLength(4);
    expect(names.some((n) => n.startsWith('ppt/notesSlides/'))).toBe(true);
    expect(names.some((n) => n.startsWith('ppt/media/'))).toBe(true);
    expect(msgs.at(-1)!.text).toContain('4 slaytlık deste hazırlandı');
  });

  it('refuses a picture that is not one, or is outside the bot folders, and makes no file', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const dir = workspacePaths(t.dataDir, bot.id, thread.id, bot.groupId).threadDir;
    writeFileSync(join(dir, 'not.png'), 'merhaba');
    let msgs = await make(thread.id, { title: 'Deste', slides: [{ title: 'A', image: 'not.png' }] });
    expect(msgs.at(-1)!.text).toContain('PNG, JPEG ya da GIF resmi değil');
    msgs = await make(thread.id, { title: 'Deste', slides: [{ title: 'A', image: '/etc/hosts' }] });
    expect(cards(msgs)).toEqual([]);
  });

  it("reads a picture's size from its header and fits it in an area without stretching", () => {
    expect(pictureSize(PNG)).toEqual({ width: 1, height: 1 });
    expect(pictureSize(Buffer.from('nope'))).toBeNull();
    expect(fitBox({ width: 200, height: 100 }, { x: 0, y: 0, w: 10, h: 10 })).toEqual({
      x: 0,
      y: 2.5,
      w: 10,
      h: 5,
    });
  });
});
