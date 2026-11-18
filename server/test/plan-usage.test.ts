import { planPace, type UsageReport } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventWindow, planWindows } from '../src/engine/claude';
import { testServer, type TestServer } from './helpers';

describe('Claude planının kullanım pencereleri', () => {
  it('CLI cevabındaki yüzdeleri 0–1 arasına çevirir, bilinmeyen biçimi boş sayar', () => {
    expect(
      planWindows({
        rate_limits: {
          five_hour: { utilization: 42, resets_at: '2026-11-18T05:00:00.000Z' },
          seven_day: { utilization: null, resets_at: null },
          seven_day_opus: null,
          model_scoped: [{ display_name: 'Fable', utilization: 130, resets_at: 'yok' }],
        },
      }),
    ).toEqual([
      { kind: 'five_hour', used: 0.42, resetsAt: '2026-11-18T05:00:00.000Z' },
      { kind: 'seven_day', used: null, resetsAt: null },
      { kind: 'model:Fable', label: 'Fable', used: 1, resetsAt: null },
    ]);
    expect(planWindows(null)).toEqual([]);
    expect(planWindows({ rate_limits: 'x' })).toEqual([]);
  });

  it('sınır olayından pencere çıkarır, ek kullanımı pencere saymaz', () => {
    expect(eventWindow({ rateLimitType: 'seven_day', utilization: 0.8, resetsAt: 1_800_000_000 })).toEqual({
      kind: 'seven_day',
      used: 0.8,
      resetsAt: new Date(1_800_000_000_000).toISOString(),
    });
    expect(eventWindow({ rateLimitType: 'overage', utilization: 0.5 })).toBeNull();
    expect(eventWindow({})).toBeNull();
  });

  it('çizgi pencerenin geçen kısmını gösterir', () => {
    const now = Date.parse('2026-11-18T00:00:00.000Z');
    // Five hours long, resets in one hour: four fifths have passed.
    expect(planPace({ kind: 'five_hour', resetsAt: '2026-11-18T01:00:00.000Z' }, now)).toBeCloseTo(0.8);
    expect(planPace({ kind: 'seven_day', resetsAt: '2026-11-25T00:00:00.000Z' }, now)).toBe(0);
    expect(planPace({ kind: 'five_hour', resetsAt: null }, now)).toBeNull();
  });

  describe('kullanım raporunda', () => {
    let t: TestServer;
    beforeEach(async () => {
      t = await testServer();
      t.now.value = new Date('2026-11-18T00:00:00.000Z');
    });
    afterEach(() => t.dispose());

    it('bir turun duyduğu pencere ötekileri silmez; yenilenmesi geçmiş pencere gösterilmez', async () => {
      await t.services.usage.notePlan([
        { kind: 'five_hour', used: 0.3, resetsAt: '2026-11-18T02:00:00.000Z' },
        { kind: 'seven_day', used: 0.1, resetsAt: '2026-11-20T00:00:00.000Z' },
      ]);
      await t.services.usage.notePlan([
        { kind: 'five_hour', used: 0.5, resetsAt: '2026-11-18T02:00:00.000Z' },
      ]);
      let report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
      expect(report.plan?.windows).toEqual([
        { kind: 'five_hour', used: 0.5, resetsAt: '2026-11-18T02:00:00.000Z' },
        { kind: 'seven_day', used: 0.1, resetsAt: '2026-11-20T00:00:00.000Z' },
      ]);

      t.now.value = new Date('2026-11-18T03:00:00.000Z');
      report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
      expect(report.plan?.windows.map((w) => w.kind)).toEqual(['seven_day']);
    });

    it('aynı anda çalışacak tur sayısını ayardan alır, 0 sunucunun sayısıdır', async () => {
      let report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
      expect(report.parallel?.max).toBe(0);
      expect(report.parallel?.serverDefault).toBeGreaterThan(0);
      expect((await t.api('PATCH', '/api/settings', { maxTurns: 2 })).status).toBe(200);
      report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
      expect(report.parallel?.max).toBe(2);
      expect((await t.api('PATCH', '/api/settings', { maxTurns: 99 })).status).toBe(400);
    });
  });
});
