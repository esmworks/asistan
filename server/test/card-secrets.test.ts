import type { Approval } from '@yumakbot/shared';
import { describe, expect, it } from 'vitest';
import { cardView } from '../src/channels/common';
import { translator } from '../src/i18n';
import { rememberedPattern, rememberedSteps } from '../src/services/approvals';

const KEY = `sk-ant-api03-${'k'.repeat(40)}`;
const CURL = `curl -H "Authorization: Bearer ${KEY}" https://api.example.com/v1/items`;
const bash = (command: string) => ({ command });

describe('kart metnindeki sırlar', () => {
  it('sohbet uygulamasındaki kart adımın kendisini gösterir, anahtarı göstermez', () => {
    const tr = translator('tr');
    const card = (toolName: string, input: Record<string, unknown>) =>
      ({ id: 'a1', kind: 'tool', toolName, input, summary: 'Bot 1 bir şey yapmak istiyor.' }) as Approval;
    const view = cardView(
      card('Bash', bash(CURL)),
      { reviewReason: `Komut ${KEY} anahtarını gönderiyor` },
      tr,
    );
    expect(view.text).toContain('Bot 1 bir şey yapmak istiyor.');
    expect(view.text).toContain('curl -H');
    expect(view.text).toContain('https://api.example.com/v1/items');
    expect(view.text).not.toContain(KEY);
    expect(view.text).toContain(tr('memory.redacted'));
    // A connection's tool shows what it is sent; a long one is cut.
    const app = cardView(
      card('mcp__notlar__create_note', { title: 'Alışveriş', body: 'x'.repeat(5000) }),
      {},
      tr,
    );
    expect(app.text).toContain('"title":"Alışveriş"');
    expect(app.text.length).toBeLessThan(1000);
    // A step with nothing to show says only what it is.
    expect(cardView(card('mcp__yumakbot__bot_list', {}), {}, tr).text).toBe(
      '🔐 Bot 1 bir şey yapmak istiyor.',
    );
  });

  it('"hep izin ver" sır taşıyan bir adımı kurala yazmaz, bu seferlik sayar', () => {
    expect(rememberedSteps('Bash', bash(CURL))).toBeNull();
    expect(rememberedSteps('Bash', bash(`cd repo && ${CURL} | head -5`))).toBeNull();
    expect(rememberedPattern('Bash', bash(CURL))).toBeNull();
    // A rule that keeps only the command's first words keeps no secret: it is written as before.
    expect(
      rememberedSteps('Bash', bash(`git push https://x:ghp_${'a'.repeat(36)}@github.com/o/r`))?.map(
        (s) => s.pattern,
      ),
    ).toEqual(['Bash(git push:*)']);
    // Without a secret the same steps are kept as before.
    expect(
      rememberedSteps('Bash', bash('curl https://api.example.com/v1/items'))?.map((s) => s.pattern),
    ).toEqual(['Bash(curl https://api.example.com/v1/items)']);
    expect(rememberedSteps('Bash', bash('git push origin main'))?.map((s) => s.pattern)).toEqual([
      'Bash(git push:*)',
    ]);
  });
});
