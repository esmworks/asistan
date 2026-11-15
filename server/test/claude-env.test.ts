import { afterEach, describe, expect, it, vi } from 'vitest';

const calls: { options: Record<string, unknown> }[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
  query: (args: { options: Record<string, unknown> }) => {
    calls.push(args);
    return {
      interrupt: async () => {},
      close: () => {},
      accountInfo: async () => ({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' }),
      async *[Symbol.asyncIterator]() {
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0 };
      },
    };
  },
}));

const { ClaudeEngine } = await import('../src/engine/claude');

const request = () => ({
  turnId: 't',
  threadId: 'th',
  botId: 'b',
  model: '',
  effort: 'high' as const,
  prompt: 'merhaba',
  sessionId: null,
  systemPrompt: '',
  locale: 'tr' as const,
  sandbox: { cwd: '/tmp/x', additionalDirectories: [], writable: [], internet: true, readOnly: false },
  shell: 'sandbox' as const,
  tools: [],
  canUseTool: async () => ({ behavior: 'allow' as const }),
  onText: () => {},
  onSession: () => {},
  signal: new AbortController().signal,
});

describe('Claude motorunun ortamı', () => {
  afterEach(() => {
    calls.length = 0;
    delete process.env.ANTHROPIC_API_KEY;
  });

  const envOf = () => calls.at(-1)!.options.env as Record<string, string>;

  it('sunucunun kendi API anahtarını geçirmez; komutların ortamını temizletir', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-sunucunun';
    await new ClaudeEngine().run(request());
    expect(envOf().ANTHROPIC_API_KEY).toBeUndefined();
    expect(envOf().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(envOf().CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    // Nothing is left running in the background after the turn closes the CLI.
    expect(envOf().CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(calls.at(-1)!.options.effort).toBe('high');
  });

  it('kayıtlı belirteci ya da anahtarı tek başına geçirir', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-sunucunun';
    await new ClaudeEngine({ credential: async () => ({ kind: 'token', value: 'sk-ant-oat01-x' }) }).run(
      request(),
    );
    expect(envOf()).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' });
    expect(envOf().ANTHROPIC_API_KEY).toBeUndefined();

    await new ClaudeEngine({ credential: async () => ({ kind: 'apiKey', value: 'sk-ant-api03-y' }) }).run(
      request(),
    );
    expect(envOf()).toMatchObject({ ANTHROPIC_API_KEY: 'sk-ant-api03-y' });
    expect(envOf().CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(envOf().ANTHROPIC_BASE_URL).toBeUndefined();

    // A key set with a gateway goes there.
    await new ClaudeEngine({
      credential: async () => ({ kind: 'apiKey', value: 'sk-ant-api03-y', baseUrl: 'https://llm.ornek.com' }),
    }).run(request());
    expect(envOf()).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant-api03-y',
      ANTHROPIC_BASE_URL: 'https://llm.ornek.com',
    });
  });

  it('internet kapalıyken web araçlarını vermez; komutlara hiçbir siteyi önceden açmaz', async () => {
    await new ClaudeEngine().run(request());
    const on = calls.at(-1)!.options;
    expect(on.disallowedTools).not.toContain('WebFetch');
    expect((on.sandbox as { network: { allowedDomains: string[] } }).network.allowedDomains).toEqual([]);

    const off = request();
    off.sandbox.internet = false;
    await new ClaudeEngine().run(off);
    expect(calls.at(-1)!.options.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  });

  it('API anahtarı yalnızca Ayarlar’da seçildiyse sorun sayılmaz', async () => {
    expect(await new ClaudeEngine().account()).toMatchObject({ status: 'error', reason: 'api-key' });
    const withKey = new ClaudeEngine({
      credential: async () => ({ kind: 'apiKey', value: 'sk-ant-api03-y' }),
    });
    expect(await withKey.account()).toMatchObject({ status: 'ok' });
  });
});
