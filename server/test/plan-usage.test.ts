import {
  currentPlanWindows,
  planHeadline,
  planUsedPercent,
  planPace,
  planTone,
  type PlanWindow,
  type UsageReport,
} from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventWindow, eventWindows, planWindows } from '../src/engine/claude';
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

  it('her sınır olayındaki 5 saatlik ve haftalık pencereleri okur, belirteçle bağlı hesapta da', () => {
    // An ordinary event of an account far from its limits: the event's own window says no use.
    const windows = eventWindows({
      status: 'allowed',
      unifiedWindows: {
        five_hour: { utilization: 0.37, resetsAt: 1_800_000_000, status: 'allowed' },
        seven_day: { utilization: 0.12, resetsAt: 1_800_400_000 },
        seven_day_overage_included: { utilization: 0.5, resetsAt: 1_800_400_000 },
      },
    } as Parameters<typeof eventWindows>[0]);
    expect(windows).toEqual([
      { kind: 'five_hour', used: 0.37, resetsAt: new Date(1_800_000_000_000).toISOString() },
      { kind: 'seven_day', used: 0.12, resetsAt: new Date(1_800_400_000_000).toISOString() },
    ]);
  });

  it('olayın kendi penceresini de katar, kullanımı bilinmeyeni ve bozuk biçimi almaz', () => {
    expect(
      eventWindows({
        rateLimitType: 'seven_day_opus',
        utilization: 0.91,
        resetsAt: 1_800_000_000,
        unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1_800_000_000 }, seven_day: 'x' },
      } as Parameters<typeof eventWindows>[0]).map((w) => [w.kind, w.used]),
    ).toEqual([
      ['five_hour', 0.2],
      ['seven_day_opus', 0.91],
    ]);
    expect(eventWindows({ rateLimitType: 'five_hour' })).toEqual([]);
    expect(eventWindows({ unifiedWindows: null } as Parameters<typeof eventWindows>[0])).toEqual([]);
  });

  it('çizgi pencerenin geçen kısmını gösterir', () => {
    const now = Date.parse('2026-11-18T00:00:00.000Z');
    // Five hours long, resets in one hour: four fifths have passed.
    expect(planPace({ kind: 'five_hour', resetsAt: '2026-11-18T01:00:00.000Z' }, now)).toBeCloseTo(0.8);
    expect(planPace({ kind: 'seven_day', resetsAt: '2026-11-25T00:00:00.000Z' }, now)).toBe(0);
    expect(planPace({ kind: 'five_hour', resetsAt: null }, now)).toBeNull();
  });

  it('sohbetteki gösterge 5 saatlik ve haftalık pencereden dolu olanı alır, model penceresini ve süresi geçeni almaz', () => {
    const now = Date.parse('2026-11-18T00:00:00.000Z');
    const windows: PlanWindow[] = [
      { kind: 'five_hour', used: 0.3, resetsAt: '2026-11-18T02:00:00.000Z' },
      { kind: 'seven_day', used: 0.55, resetsAt: '2026-11-20T00:00:00.000Z' },
      { kind: 'seven_day_opus', used: 0.99, resetsAt: '2026-11-20T00:00:00.000Z' },
      { kind: 'model:Fable', label: 'Fable', used: 1, resetsAt: null },
    ];
    expect(planHeadline(windows, now)?.kind).toBe('seven_day');
    // Once both windows have reset, nothing is known of what is left.
    expect(planHeadline(windows, Date.parse('2026-11-20T00:00:00.000Z'))).toBeNull();
    expect(planHeadline(windows, Date.parse('2026-11-19T00:00:00.000Z'))?.kind).toBe('seven_day');
    expect(currentPlanWindows(windows, Date.parse('2026-11-18T02:00:00.000Z')).map((w) => w.kind)).toEqual([
      'seven_day',
      'seven_day_opus',
      'model:Fable',
    ]);
    expect(planHeadline([{ kind: 'five_hour', used: null, resetsAt: null }], now)).toBeNull();
    expect(planUsedPercent({ used: 0.424 })).toBe(42);
    expect(planUsedPercent({ used: 1 })).toBe(100);
    expect(planUsedPercent({ used: null })).toBe(0);
  });

  it('rengi doluluğa ve pencerenin geçen kısmına göre verir; pencerenin başındaki az kullanım uyarı sayılmaz', () => {
    const now = Date.parse('2026-11-18T00:00:00.000Z');
    // Five hours long, resets in four and a half: a tenth has passed.
    const early = { kind: 'five_hour', resetsAt: '2026-11-18T04:30:00.000Z' };
    expect(planTone({ ...early, used: 0.2 }, now)).toBe('fine');
    expect(planTone({ ...early, used: 0.6 }, now)).toBe('ahead');
    expect(planTone({ ...early, used: 0.9 }, now)).toBe('near');
    // Four fifths have passed: 60% used is behind the window's time.
    expect(planTone({ kind: 'five_hour', used: 0.6, resetsAt: '2026-11-18T01:00:00.000Z' }, now)).toBe(
      'fine',
    );
    expect(planTone({ kind: 'five_hour', used: 0.7, resetsAt: null }, now)).toBe('fine');
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

    it('planın pencereleri, raporu göremeyen bir üyeye de sohbetteki gösterge için verilir', async () => {
      const member = await t.person('uye');
      expect((await member.api('GET', '/api/usage?days=7')).status).toBe(403);
      expect((await member.api<{ plan: unknown }>('GET', '/api/usage/plan')).body).toEqual({ plan: null });
      await t.services.usage.notePlan([
        { kind: 'five_hour', used: 0.25, resetsAt: '2026-11-18T02:00:00.000Z' },
      ]);
      const res = await member.api<{ plan: UsageReport['plan'] }>('GET', '/api/usage/plan');
      expect(res.status).toBe(200);
      expect(res.body.plan?.windows).toEqual([
        { kind: 'five_hour', used: 0.25, resetsAt: '2026-11-18T02:00:00.000Z' },
      ]);
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
