import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeEngine } from '../src/engine/claude';

/**
 * Proves that a bot's shell cannot read the Claude token or API key handed to the CLI, while the
 * sandboxed shell keeps working. Uses the machine's Claude login; off by default:
 *   LEAFBOT_REAL_CLAUDE=1 pnpm vitest run --project server test/claude-scrub.real
 */
const enabled = process.env.LEAFBOT_REAL_CLAUDE === '1';

describe.skipIf(!enabled)('gerçek Claude: komut ortamı', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leafbot-scrub-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('Bash, CLI’ya verilen kimlik değişkenini görmez; sıradan değişkeni görür', async () => {
    // A name from the CLI's credential list that does not change how it signs in, and a control.
    const engine = new ClaudeEngine({
      env: { CLAUDE_CODE_SLACK_TAG_TOKEN: 'gizli-91f3', LEAFBOT_SCRUB_CONTROL: 'gorunur-5d2a' },
    });
    const commands: string[] = [];
    const out = await engine.run({
      turnId: 't',
      threadId: 'th',
      botId: 'b',
      model: 'haiku',
      prompt:
        'Bash aracıyla tam olarak şu komutu çalıştır ve yalnızca çıktısını aynen yaz:\n' +
        'echo "A=${CLAUDE_CODE_SLACK_TAG_TOKEN:-yok} B=${LEAFBOT_SCRUB_CONTROL:-yok}"',
      sessionId: null,
      systemPrompt: '',
      locale: 'tr',
      sandbox: { cwd: dir, additionalDirectories: [], writable: [dir], internet: true, readOnly: false },
      shell: 'sandbox',
      tools: [],
      canUseTool: async (ask) => {
        commands.push(String(ask.input.command ?? ''));
        return { behavior: 'allow' };
      },
      onText: () => {},
      onSession: () => {},
      signal: new AbortController().signal,
    });
    expect(out.ok).toBe(true);
    expect(commands.some((c) => c.includes('LEAFBOT_SCRUB_CONTROL'))).toBe(true);
    expect(out.text).toContain('B=gorunur-5d2a');
    expect(out.text).toContain('A=yok');
    expect(out.text).not.toContain('gizli-91f3');
  }, 180_000);
});
