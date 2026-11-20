import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeEngine } from '../src/engine/claude';

/**
 * The real CLI, asked to resume a session it has no transcript for. It stops before signing in
 * or calling the API, so this needs no Claude login and makes no request.
 */
describe('gerçek Claude CLI: kayıp oturum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leafbot-lost-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('kaydı olmayan oturumu ayrı bir sonuç olarak bildirir', { timeout: 60_000 }, async () => {
    const cwd = join(dir, 'is');
    mkdirSync(cwd);
    const engine = new ClaudeEngine({
      configDir: join(dir, 'ayar'),
      credential: async () => ({ kind: 'apiKey', value: 'sk-ant-gecersiz-deneme' }),
    });
    const out = await engine.run({
      turnId: 't',
      threadId: 'th',
      botId: 'b',
      model: 'haiku',
      prompt: 'merhaba',
      sessionId: '11111111-2222-3333-4444-555555555555',
      systemPrompt: '',
      locale: 'tr',
      sandbox: { cwd, additionalDirectories: [], writable: [cwd], internet: true, readOnly: false },
      shell: 'sandbox',
      tools: [],
      canUseTool: async () => ({ behavior: 'deny', message: 'hayır' }),
      onText: () => {},
      onSession: () => {},
      signal: new AbortController().signal,
    });
    expect(out).toMatchObject({ ok: false, kind: 'lostSession', sessionId: null });
  });
});
