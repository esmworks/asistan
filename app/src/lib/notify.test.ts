import { describe, expect, it } from 'vitest';
import { isMuted, muteUntil, wanted } from './notify';

describe('bildirimler', () => {
  const away = { focused: false, botId: null };
  it('düzeye göre süzer', () => {
    expect(wanted({ kind: 'reply', botId: 'a' }, 'all', away)).toBe(true);
    expect(wanted({ kind: 'reply', botId: 'a' }, 'needsYou', away)).toBe(false);
    expect(wanted({ kind: 'needsYou', botId: 'a' }, 'needsYou', away)).toBe(true);
    expect(wanted({ kind: 'error', botId: 'a' }, 'needsYou', away)).toBe(true);
    expect(wanted({ kind: 'needsYou', botId: 'a' }, 'off', away)).toBe(false);
  });

  it('sessize alınan bot bildirim vermez', () => {
    expect(wanted({ kind: 'needsYou', botId: 'a' }, 'all', away, ['a'])).toBe(false);
    expect(wanted({ kind: 'needsYou', botId: 'b' }, 'all', away, ['a'])).toBe(true);
  });

  it('o bota bakan kişiyi rahatsız etmez; başka bota bakarken bildirir', () => {
    expect(wanted({ kind: 'needsYou', botId: 'a' }, 'all', { focused: true, botId: 'a' })).toBe(false);
    expect(wanted({ kind: 'needsYou', botId: 'a' }, 'all', { focused: true, botId: 'b' })).toBe(true);
    expect(wanted({ kind: 'reply', botId: 'a' }, 'all', { focused: false, botId: 'a' })).toBe(true);
  });
});

describe('süreli sessiz', () => {
  it('süresi geçen sessiz sayılmaz; süresiz olan açılana kadar sürer', () => {
    const now = Date.UTC(2026, 10, 14, 12);
    const mutes = { a: now + 1000, b: now - 1000, c: null };
    expect(isMuted(mutes, 'a', now)).toBe(true);
    expect(isMuted(mutes, 'b', now)).toBe(false);
    expect(isMuted(mutes, 'c', now)).toBe(true);
    expect(isMuted(mutes, 'd', now)).toBe(false);
  });

  it('seçeneklerin bitişini hesaplar', () => {
    const evening = new Date(2026, 10, 14, 21, 30);
    expect(muteUntil('hour', evening)).toBe(evening.getTime() + 3_600_000);
    expect(new Date(muteUntil('morning', evening)!).toString()).toBe(new Date(2026, 10, 15, 8, 0).toString());
    const early = new Date(2026, 10, 14, 6, 0);
    expect(muteUntil('morning', early)).toBe(new Date(2026, 10, 14, 8, 0).getTime());
    expect(muteUntil('always', evening)).toBeNull();
  });
});

describe('cevaplanan kart bildirimi', () => {
  it('kartı kalmayan sohbetin bekleme bildirimini kapatır', async () => {
    const closed: string[] = [];
    class FakeNotification {
      static permission = 'granted';
      onclose: (() => void) | null = null;
      onclick: (() => void) | null = null;
      constructor(
        public title: string,
        public opts: { tag: string },
      ) {}
      close() {
        closed.push(this.opts.tag);
        this.onclose?.();
      }
    }
    const was = (globalThis as { Notification?: unknown }).Notification;
    (globalThis as { Notification?: unknown }).Notification = FakeNotification;
    try {
      const { closeAnswered, notice, testNotification } = await import('./notify');
      const { QueryClient } = await import('@tanstack/react-query');
      const qc = new QueryClient();
      testNotification();
      const ask = { kind: 'needsYou' as const, text: 'Onay', botId: 'b1' };
      notice(qc, { ...ask, threadId: 't1' });
      notice(qc, { ...ask, threadId: 't2' });
      closeAnswered(new Set(['t2']));
      expect(closed).toEqual(['needsYou:t1']);
    } finally {
      (globalThis as { Notification?: unknown }).Notification = was;
    }
  });
});
