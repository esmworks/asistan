import type { Thread } from '@yumakbot/shared';
import { like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

const TOKEN = `sk-ant-oat01-${'a1b2'.repeat(20)}tokn`;
const KEY = `sk-ant-api03-${'c3d4'.repeat(20)}akey`;

describe('Claude bağlantısı', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('varsayılan olarak makinedeki girişi kullanır', async () => {
    expect((await t.api('GET', '/api/claude/auth')).body).toEqual({ kind: 'login', hint: null });
  });

  it('belirteci kaydeder, yalnızca ipucunu gösterir ve şifreli saklar', async () => {
    // A token copied from a wrapped terminal line.
    const pasted = `${TOKEN.slice(0, 30)}\n  ${TOKEN.slice(30)}`;
    const r = await t.api<{ status: string; auth: string }>('PUT', '/api/claude/auth', {
      kind: 'token',
      value: pasted,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', auth: 'token' });
    expect((await t.api('GET', '/api/claude/auth')).body).toEqual({ kind: 'token', hint: '…tokn' });
    expect(await t.services.claudeAuth.credential()).toEqual({ kind: 'token', value: TOKEN });

    for (const url of ['/api/claude/auth', '/api/settings', '/api/info']) {
      expect(JSON.stringify((await t.api('GET', url)).body)).not.toContain(TOKEN.slice(20));
    }
    const rows = await t.db.db.select().from(schema.kv).where(like(schema.kv.key, 'secret.claude%'));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.value)).not.toContain(TOKEN.slice(20));
  });

  it('API anahtarını kaydeder; kaldırınca makinedeki girişe döner', async () => {
    expect((await t.api('PUT', '/api/claude/auth', { kind: 'apiKey', value: KEY })).status).toBe(200);
    expect((await t.api('GET', '/api/claude/auth')).body).toEqual({ kind: 'apiKey', hint: '…akey' });
    const r = await t.api<{ auth: string }>('DELETE', '/api/claude/auth');
    expect(r.body.auth).toBe('login');
    expect(await t.services.claudeAuth.credential()).toBeNull();
  });

  it('API anahtarını bir ağ geçidine yönlendirir; anahtarı düz http ile başka bilgisayara göndermez', async () => {
    const put = (body: object) => t.api('PUT', '/api/claude/auth', body);
    expect((await put({ kind: 'apiKey', value: KEY, baseUrl: 'http://10.0.0.5:4000' })).status).toBe(400);
    expect((await put({ kind: 'token', value: TOKEN, baseUrl: 'https://llm.ornek.com' })).status).toBe(400);
    expect((await put({ kind: 'apiKey', value: KEY, baseUrl: 'https://llm.ornek.com/' })).status).toBe(200);
    expect((await t.api('GET', '/api/claude/auth')).body).toEqual({
      kind: 'apiKey',
      hint: '…akey',
      baseUrl: 'https://llm.ornek.com',
    });
    expect((await put({ kind: 'apiKey', value: KEY, baseUrl: 'http://127.0.0.1:4000' })).status).toBe(200);
  });

  it('yanlış türdeki değeri reddeder', async () => {
    expect((await t.api('PUT', '/api/claude/auth', { kind: 'token', value: KEY })).status).toBe(400);
    expect((await t.api('PUT', '/api/claude/auth', { kind: 'apiKey', value: TOKEN })).status).toBe(400);
    expect((await t.api('PUT', '/api/claude/auth', { kind: 'apiKey', value: 'kisa' })).status).toBe(400);
    expect((await t.api('GET', '/api/claude/auth')).body).toEqual({ kind: 'login', hint: null });
  });

  it('modelleri listeler; motor listeleyemezse bilinen modelleri verir', async () => {
    const models = (await t.api<{ value: string; efforts: string[] }[]>('GET', '/api/claude/models')).body;
    expect(models.map((m) => m.value)).toEqual(['sonnet', 'opus', 'haiku']);
  });

  it('başka sağlayıcıdaki bot kendi modeliyle çalışır; Claude varsayılanları ona geçmez', async () => {
    await t.api('PATCH', '/api/settings', {
      defaultModel: 'opus',
      effort: 'high',
      defaultEngine: 'pi',
      piModel: 'openai/gpt-4o-mini',
    });
    const bot = await t.bot({ engine: 'pi', model: 'openai/gpt-4o-mini' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const req = t.engine.requests.at(-1)!;
    expect(req.model).toBe('openai/gpt-4o-mini');
    expect(req.effort).toBeUndefined();
  });

  it('varsayılan model ve effort Claude botlarının turuna gider', async () => {
    await t.api('PATCH', '/api/settings', { defaultModel: 'opus', effort: 'high' });
    const run = async (model: string) => {
      const bot = await t.bot({ model });
      const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
      await t.send(thread.id, 'merhaba');
      await t.services.turns.idle();
      return t.engine.requests.at(-1)!;
    };
    expect(await run('')).toMatchObject({ model: 'opus', effort: 'high' });
    expect(await run('haiku')).toMatchObject({ model: 'haiku', effort: 'high' });

    await t.api('PATCH', '/api/settings', { effort: '' });
    expect((await run('')).effort).toBeUndefined();
    expect((await t.api('PATCH', '/api/settings', { effort: 'extreme' })).status).toBe(400);
  });
});
