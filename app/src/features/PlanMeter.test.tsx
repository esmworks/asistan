import type { UsageReport } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PlanMeter } from './PlanMeter';

function show(plan: UsageReport['plan'] | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['plan-usage'], plan);
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <PlanMeter />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe('sohbetteki plan göstergesi', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-18T00:00:00.000Z'), toFake: ['Date'] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('dolu pencerenin kalanını gösterir, tıklayınca her pencereyi yenilenmesiyle açar', () => {
    const view = show({
      at: '2026-11-17T23:50:00.000Z',
      windows: [
        { kind: 'five_hour', used: 0.42, resetsAt: '2026-11-18T02:00:00.000Z' },
        { kind: 'seven_day', used: 0.12, resetsAt: '2026-11-21T00:00:00.000Z' },
        { kind: 'seven_day_opus', used: 0.95, resetsAt: '2026-11-21T00:00:00.000Z' },
      ],
    });
    const button = screen.getByRole('button', { name: 'Claude plan: 42% used (5-hour window)' });
    expect(button.textContent).toBe('42% used');
    expect(button.dataset.planMeter).toBe('fine');
    expect(view.container.querySelector('[data-plan-row]')).toBeNull();

    fireEvent.click(button);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-plan-row]')];
    expect(rows.map((r) => r.dataset.planRow)).toEqual(['five_hour', 'seven_day', 'seven_day_opus']);
    expect(rows[0]!.textContent).toContain('42% used');
    expect(rows[0]!.textContent).toContain('Resets');
    expect(rows[2]!.textContent).toContain('95% used');
    // The bars fill up as the plan is used, like the ring and the words.
    const bars = rows.map((r) => r.querySelector<HTMLElement>('[data-plan-bar]')!.style.width);
    expect(bars).toEqual(['42%', '12%', '95%']);
  });

  it('sınırdaki pencereyi kırmızı ve “sınıra ulaşıldı” diye gösterir', () => {
    show({
      at: '2026-11-17T23:50:00.000Z',
      windows: [{ kind: 'seven_day', used: 1, resetsAt: '2026-11-19T00:00:00.000Z' }],
    });
    const button = screen.getByRole('button', { name: 'Claude plan: 100% used (Weekly)' });
    expect(button.dataset.planMeter).toBe('near');
    fireEvent.click(button);
    expect(document.querySelector('[data-plan-row="seven_day"]')?.textContent).toContain('Limit reached');
  });

  it('planın kullanımı bilinmezken ya da pencereler yenilenmişken hiçbir şey göstermez', () => {
    expect(show(null).container.innerHTML).toBe('');
    cleanup();
    const stale = show({
      at: '2026-11-17T10:00:00.000Z',
      windows: [{ kind: 'five_hour', used: 0.8, resetsAt: '2026-11-17T15:00:00.000Z' }],
    });
    expect(stale.container.innerHTML).toBe('');
  });
});
