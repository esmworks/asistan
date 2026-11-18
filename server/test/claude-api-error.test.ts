import { describe, expect, it, vi } from 'vitest';
import type { TurnRequest } from '../src/engine/types';

const frames: { current: unknown[] | 'hang' } = { current: [] };
type Hook = (input: Record<string, unknown>) => Promise<unknown>;
const last: { hooks?: Record<string, { hooks: Hook[] }[]> } = {};
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ options }: { options: { hooks: Record<string, { hooks: Hook[] }[]> } }) => {
    last.hooks = options.hooks;
    // 'hang': a CLI that ignores the interrupt; only closing it ends the stream.
    let close = () => {};
    const closed = new Promise<void>((r) => (close = r));
    return {
      interrupt: async () => {},
      close: () => close(),
      async *[Symbol.asyncIterator]() {
        if (frames.current === 'hang') await closed;
        else yield* frames.current;
      },
    };
  },
}));

const { ClaudeEngine, STOP_GRACE_MS } = await import('../src/engine/claude');

const run = (onActivity?: TurnRequest['onActivity'], signal = new AbortController().signal) =>
  new ClaudeEngine({ credential: async () => null }).run({
    onActivity,
    turnId: 't',
    threadId: 'th',
    botId: 'b',
    model: 'haiku',
    prompt: 'merhaba',
    sessionId: null,
    systemPrompt: '',
    locale: 'tr',
    sandbox: {
      cwd: '/tmp',
      additionalDirectories: [],
      writable: ['/tmp'],
      internet: true,
      readOnly: false,
    },
    shell: 'sandbox',
    tools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'hayır' }),
    onText: () => {},
    onSession: () => {},
    signal,
  });

const apiError = (error: string, text: string) => ({
  type: 'assistant',
  error,
  message: { content: [{ type: 'text', text }] },
});

describe('Claude API hatası', () => {
  it('hatanın metnini bot yanıtı saymaz, nedenini anlaşılır sözlerle söyler', async () => {
    const said =
      'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Credit balance is too low"}}';
    frames.current = [
      apiError('billing_error', said),
      { type: 'result', subtype: 'success', is_error: true, result: said },
    ];
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.text).toBe('');
    if (!out.ok) {
      expect(out.message).toContain('bakiye');
      expect(out.message).toContain('Credit balance is too low');
      expect(out.message).not.toContain('{');
    }
  });

  it('sonradan başarıyla biten tur başarılı sayılır', async () => {
    frames.current = [
      apiError('server_error', 'API Error: 500'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'tamam' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'tamam' },
    ];
    expect(await run()).toMatchObject({ ok: true, text: 'tamam' });
  });

  it('hızlı cevaplarla birlikte yazılan yanıt, aramadan sonraki kısa satırla kaybolmaz', async () => {
    // The CLI sends each block of one API message apart, under the same message id.
    const block = (id: string, block: object) => ({ type: 'assistant', message: { id, content: [block] } });
    const done = (id: string) => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
    const close = 'Hangisini istersen başlatırım.';
    frames.current = [
      block('m1', { type: 'text', text: 'Bakıyorum.' }),
      block('m1', { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }),
      done('u1'),
      block('m2', { type: 'text', text: 'Uzun rapor.' }),
      block('m2', { type: 'tool_use', id: 'u2', name: 'mcp__yumakbot__quick_replies', input: {} }),
      done('u2'),
      block('m3', { type: 'text', text: close }),
      { type: 'result', subtype: 'success', is_error: false, result: close },
    ];
    expect(await run()).toMatchObject({ ok: true, text: `Uzun rapor.\n\n${close}` });

    // Text before a working tool stays an interim step.
    frames.current = [
      block('m1', { type: 'text', text: 'Bakıyorum.' }),
      block('m1', { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }),
      done('u1'),
      block('m2', { type: 'text', text: 'Sonuç.' }),
      { type: 'result', subtype: 'success', is_error: false, result: 'Sonuç.' },
    ];
    expect(await run()).toMatchObject({ ok: true, text: 'Sonuç.' });
  });

  it('adım sınırında boş hata listesi yerine sınırı söyler', async () => {
    frames.current = [{ type: 'result', subtype: 'error_max_turns', errors: [], total_cost_usd: 0.8 }];
    const out = await run();
    // What the failed turn spent still counts.
    expect(out).toMatchObject({ ok: false, kind: 'engine', costUsd: 0.8, stepLimit: true });
    if (!out.ok) expect(out.message).toContain('50');
  });

  it('her çerçevede ve her araç başlayıp bittiğinde canlılık işareti verir', async () => {
    const seen: (string | undefined)[] = [];
    const onActivity: TurnRequest['onActivity'] = (tool) =>
      seen.push(tool && `${tool.running ? '+' : '-'}${tool.id}${tool.name ? `:${tool.name}` : ''}`);
    frames.current = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'bitti' },
    ];
    expect(await run(onActivity)).toMatchObject({ ok: true });
    expect(seen).toEqual([undefined, undefined, '-u1', undefined]);

    seen.length = 0;
    const call = (event: string) =>
      last.hooks![event]![0]!.hooks[0]!({
        hook_event_name: event,
        tool_use_id: 'u2',
        tool_name: 'Bash',
        error: 'x',
      });
    await call('PreToolUse');
    await call('PostToolUse');
    await call('PostToolUseFailure');
    expect(seen).toEqual(['+u2:Bash', '-u2:Bash', '-u2:Bash']);
  });

  it('durdurmaya yanıt vermeyen CLI kısa bir süre sonra kapatılır; tur durmuş olarak biter', async () => {
    frames.current = 'hang';
    const stop = new AbortController();
    const started = Date.now();
    const out = run(undefined, stop.signal);
    setTimeout(() => stop.abort(), 50);
    expect(await out).toMatchObject({ ok: false, kind: 'interrupted' });
    expect(Date.now() - started).toBeLessThan(STOP_GRACE_MS + 2_000);
  });
});
