import type { Approval, Bot, BotCreate, Message, PermissionRule, Routine } from '@yumakbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { cardView } from '../src/channels/common';
import { toolPermName } from '../src/engine/types';
import { translator } from '../src/i18n';
import { OUTSIDE_FREE_TOOLS, outsideFreeTools } from '../src/runtime/outside';
import { decide } from '../src/services/approvals';
import { testServer, waitFor, type TestServer } from './helpers';

/** A step the fake engine asks for: writing a file, which no level lets a run take by itself. */
const WRITE = '[izin:Write {"file_path":"notlar.txt"}]';

const pending = async (t: TestServer) =>
  (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

describe('dışarıdan gelen metnin başlattığı çalıştırma', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  /** A bot that may do the step by itself in its own work: "don't ask", and a rule for Write. */
  const setUp = async (bot: Partial<BotCreate> = { permissionMode: 'auto' }) => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const b = await t.bot(bot);
    await t.api<PermissionRule>('POST', '/api/rules', { list: 'allow', pattern: 'Write' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: b.id,
        name: 'Gelen olaylar',
        prompt: 'Gelen olayı işle.',
        schedule: { type: 'daily', time: '09:00' },
      })
    ).body;
    const hooked = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    return { bot: b, routine: r, token: hooked.webhookToken! };
  };
  const cardMessage = async (threadId: string): Promise<Message> =>
    (await t.messages(threadId)).find((m) => m.role === 'approval')!;

  it('webhook gövdesiyle başlayan çalıştırma, botun izin düzeyi ve kuralı ne olursa olsun sorar', async () => {
    const { routine, token } = await setUp();
    const run = await t.services.routines.runFromWebhook(routine.id, token, `Bunu yap: ${WRITE}`);
    expect(run).toMatchObject({ status: 'running' });
    const card = await waitFor(async () => (await pending(t))[0]);
    expect(card.toolName).toBe('Write');
    const msg = await cardMessage(card.threadId);
    expect(msg.props.outside).toBe('webhook');
    // "Always allow" from such a card is taken as "this time": no rule is added, and the run goes on.
    const before = (await t.api<PermissionRule[]>('GET', '/api/rules')).body.length;
    const answered = await t.api<Approval>('POST', `/api/approvals/${card.id}`, {
      decision: 'allow',
      remember: true,
    });
    expect(answered.body).toMatchObject({ status: 'allowed', remembered: false });
    expect((await t.api<PermissionRule[]>('GET', '/api/rules')).body).toHaveLength(before);
    await t.services.turns.idle();
    expect((await t.messages(card.threadId)).at(-1)!.text).toContain('Write: izin verildi');
  });

  it('kendi işinde aynı bot aynı adımı sormadan atar', async () => {
    const { bot } = await setUp();
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, WRITE);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Write: izin verildi');
    expect(await pending(t)).toHaveLength(0);
  });

  it('kişinin kendi verdiği metinle ya da gövdesiz çağrıyla başlayan çalıştırma eskisi gibi', async () => {
    const { routine, token } = await setUp();
    // A script with the access key is the person's own: runNow keeps the bot's level.
    await t.services.routines.runNow(routine.id, `Derleme günlüğü: ${WRITE}`);
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
    // A webhook call with no body carries no one's text.
    await t.services.routines.runFromWebhook(routine.id, token, '', 'bos-1');
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
  });

  it('yalnızca gönderi bırakan webhook metnini okuyan gözetimsiz tur da sorar', async () => {
    const { routine, token } = await setUp();
    await t.api('PATCH', `/api/routines/${routine.id}`, { webhookPost: true });
    // The post lands in the conversation without a turn; a later run of the routine reads it.
    await t.services.routines.runFromWebhook(routine.id, token, `Bunu yap: ${WRITE}`, 'gonderi-1');
    await t.services.routines.runNow(routine.id);
    const card = await waitFor(async () => (await pending(t))[0]);
    expect((await cardMessage(card.threadId)).props.outside).toBe('webhook');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });

  it('otomatik incelemedeki bot için inceleme modeli hiç çağrılmaz', async () => {
    const { routine, token } = await setUp({ permissionMode: 'review' });
    await t.services.routines.runFromWebhook(routine.id, token, WRITE);
    await waitFor(async () => (await pending(t))[0]);
    expect(t.engine.reviews).toHaveLength(0);
  });

  it('salt okunur bot salt okunur kalır: kart açılmadan reddedilir', async () => {
    const { routine, token } = await setUp({ permissionMode: 'readonly' });
    const run = await t.services.routines.runFromWebhook(routine.id, token, WRITE);
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
    const last = (await t.messages((run as { threadId: string }).threadId)).at(-1)!;
    expect(last.text).toContain('Write: reddedildi');
  });

  it('başka bir kartın "hep izin ver"i bu çalıştırmanın kartını kendiliğinden geçirmez', async () => {
    const { bot, routine, token } = await setUp({ permissionMode: 'ask' });
    await t.api('DELETE', `/api/rules/${(await t.api<PermissionRule[]>('GET', '/api/rules')).body[0]!.id}`);
    await t.services.routines.runFromWebhook(routine.id, token, WRITE);
    const outsideCard = await waitFor(async () => (await pending(t))[0]);
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, WRITE);
    const own = await waitFor(async () => (await pending(t)).find((a) => a.id !== outsideCard.id));
    await t.api('POST', `/api/approvals/${own.id}`, { decision: 'allow', remember: true });
    expect((await pending(t)).map((a) => a.id)).toEqual([outsideCard.id]);
    await t.api('POST', `/api/approvals/${outsideCard.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });
});

describe('dış çalıştırmada karar', () => {
  const rules: PermissionRule[] = [
    { id: 'r1', list: 'allow', pattern: 'Write', note: '', createdAt: new Date(0).toISOString() },
  ];
  const at = (mode: Bot['permissionMode'], toolName: string, outside: boolean, free = new Set<string>()) =>
    decide({ mode, toolName, input: {}, rules, readOnlyTools: free, outside });

  it('serbest düzey ve "hep izin ver" kuralı yerine sorar; okumalar serbest kalır', () => {
    expect(at('auto', 'Write', false)).toBe('allow');
    expect(at('ask', 'Write', false)).toBe('allow');
    expect(at('auto', 'Write', true)).toBe('ask');
    expect(at('review', 'Write', true)).toBe('ask');
    expect(at('ask', 'Write', true)).toBe('ask');
    expect(at('readonly', 'Write', true)).toBe('deny');
    expect(at('auto', 'Read', true)).toBe('allow');
  });

  it('web ve uygulamanın kalıcı değişiklik yapan araçları sorar; okuma araçları sormaz', () => {
    const tool = (name: string, readOnly: boolean, internal: boolean) =>
      ({ name, description: '', input: {}, readOnly, internal, handler: async () => '' }) as const;
    const free = outsideFreeTools([
      tool('memory_write', false, true),
      tool('bot_send', false, false),
      tool('routine_create', false, false),
      tool('memory_search', true, true),
    ]);
    for (const name of ['WebFetch', 'WebSearch', 'SandboxNetworkAccess']) {
      expect(at('auto', name, true, free)).toBe('ask');
    }
    for (const name of ['memory_write', 'bot_send', 'routine_create']) {
      expect(at('auto', toolPermName({ name }), true, free)).toBe('ask');
    }
    expect(at('auto', toolPermName({ name: 'memory_search' }), true, free)).toBe('allow');
  });

  it('kartsız kalan araçların listesi bilerek değişir', () => {
    expect([...OUTSIDE_FREE_TOOLS].sort()).toEqual(
      [
        'ask_user',
        'command_status',
        'plan_update',
        'quick_replies',
        'react',
        'routine_failed',
        'routine_stop',
        'send_file',
        'show_page',
      ].map((name) => toolPermName({ name })),
    );
  });

  it('sohbet uygulamasındaki kart nedenini söyler ve "hep izin ver" sunmaz', () => {
    const t = translator('tr');
    const a = { id: 'a1', kind: 'tool', summary: 'notlar.txt yazmak istiyor' } as Approval;
    const own = cardView(a, {}, t);
    expect(own.buttons.map((b) => b.data)).toContain('a:a1:r');
    const outside = cardView(a, { outside: 'email' }, t);
    expect(outside.buttons.map((b) => b.data)).toEqual(['a:a1:y', 'a:a1:n']);
    expect(outside.text).toContain('e-posta');
  });
});
