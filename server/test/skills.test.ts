import type { Skill, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taggedSkill } from '../src/runtime/turns';
import { testServer, type TestServer } from './helpers';

describe('beceriler', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it('oluşturulur, adı tekildir, bota açılıp kapanır ve silinir', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const add = await t.api<Skill>('POST', '/api/skills', {
      name: 'haftalik-rapor',
      description: 'Haftalık raporu yazar',
      body: 'Önce satışları topla.',
    });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({ name: 'haftalik-rapor', botIds: [] });
    const again = await t.api('POST', '/api/skills', { name: 'haftalik-rapor', description: 'x' });
    expect(again.status).toBe(409);
    expect((await t.api('POST', '/api/skills', { name: 'Büyük Harf', description: 'x' })).status).toBe(400);

    const on = await t.api<Skill>('PUT', `/api/skills/${add.body.id}/bots/${bot.id}`, { on: true });
    expect(on.body.botIds).toEqual([bot.id]);
    const off = await t.api<Skill>('PUT', `/api/skills/${add.body.id}/bots/${bot.id}`, { on: false });
    expect(off.body.botIds).toEqual([]);
    expect((await t.api('PUT', `/api/skills/${add.body.id}/bots/yok`, { on: true })).status).toBe(404);

    const edited = await t.api<Skill>('PATCH', `/api/skills/${add.body.id}`, {
      description: 'Pazartesi raporu',
    });
    expect(edited.body.description).toBe('Pazartesi raporu');
    expect((await t.api('DELETE', `/api/skills/${add.body.id}`)).status).toBe(200);
    expect((await t.api<Skill[]>('GET', '/api/skills')).body).toEqual([]);
  });

  it('açık becerinin adı istemde görünür, gövdesi araçla okunur; kapalı bota hiçbiri gelmez', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const other = await t.bot({ name: 'Gezgin' });
    await t.api<Skill>('POST', '/api/skills', {
      name: 'fatura',
      description: 'Fatura keserken',
      body: 'KDV oranını sor.',
      botIds: [bot.id],
    });

    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:skill_read {"name":"fatura"}] [araç:skill_read {"name":"yok"}]');
    await t.services.turns.idle();
    const req = t.engine.requests.at(-1)!;
    expect(req.systemPrompt).toContain('- fatura: Fatura keserken');
    expect(req.systemPrompt).not.toContain('KDV oranını');
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('KDV oranını sor.');
    expect(reply).toContain('yok adında bir becerin yok. Becerilerin: fatura');

    await t.send((await main(other.id)).id, 'merhaba');
    await t.services.turns.idle();
    const plain = t.engine.requests.at(-1)!;
    expect(plain.tools.some((x) => x.name === 'skill_read')).toBe(false);
    expect(plain.systemPrompt).not.toContain('fatura');
  });

  it('bot öğrendiği yöntemi beceri olarak kaydeder ve kendi becerisini düzeltir; başkasınınkine dokunmaz', async () => {
    const bot = await t.bot({ name: 'Katip', permissionMode: 'auto' });
    await t.api('POST', '/api/skills', { name: 'baskasi', description: 'x' });
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      '[araç:skill_save {"name":"Fatura Kesme","description":"Fatura keserken","body":"KDV sor"}] [araç:skill_save {"name":"baskasi","description":"y","body":"z"}]',
    );
    await t.services.turns.idle();
    let reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('"fatura-kesme" becerisi kaydedildi');
    expect(reply).toContain('"baskasi" adında başka bir beceri var');
    await t.send(
      thread.id,
      '[araç:skill_save {"name":"fatura-kesme","description":"Fatura keserken","body":"Önce KDV oranını sor"}]',
    );
    await t.services.turns.idle();
    reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('güncellendi');
    const saved = (await t.api<Skill[]>('GET', '/api/skills')).body.find((k) => k.name === 'fatura-kesme')!;
    expect(saved).toMatchObject({ body: 'Önce KDV oranını sor', botIds: [bot.id] });
  });

  it('mesajda $ad ile anılan beceri için bot önce okumaya yönlendirilir', async () => {
    const bot = await t.bot({ name: 'Katip' });
    await t.api('POST', '/api/skills', { name: 'fatura', description: 'Fatura', botIds: [bot.id] });
    const thread = await main(bot.id);
    await t.send(thread.id, '$fatura ile Ayşe için kes');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toMatch(/^\(Kullanıcı şu beceriyi kullanmanı istiyor: fatura\./);
    await t.send(thread.id, 'fiyat $5 ve $faturax');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toBe('fiyat $5 ve $faturax');
    expect(taggedSkill('(bkz. $fatura)', 'fatura')).toBe(true);
    expect(taggedSkill('a$fatura', 'fatura')).toBe(false);
  });
});
