import { describe, expect, it } from 'vitest';
import { passesFilter } from './webhook-filter';

const body = JSON.stringify({
  action: 'opened',
  pull_request: { draft: false, labels: [{ name: 'bug' }] },
  n: 3,
});

describe('webhook süzgeci', () => {
  it('boş süzgeç her şeyi geçirir', () => {
    expect(passesFilter('', 'düz metin')).toBe(true);
    expect(passesFilter('  \n# yorum\n', body)).toBe(true);
  });

  it('eşit, eşit değil ve var koşullarının hepsini arar', () => {
    expect(passesFilter('action=opened', body)).toBe(true);
    expect(passesFilter('action=closed', body)).toBe(false);
    expect(passesFilter('action!=closed\nn=3', body)).toBe(true);
    expect(passesFilter('pull_request.labels.0.name="bug"', body)).toBe(true);
    expect(passesFilter('pull_request.draft', body)).toBe(false);
    expect(passesFilter('pull_request', body)).toBe(true);
    expect(passesFilter('eksik', body)).toBe(false);
  });

  it('süzgeç varken JSON olmayan gövdeyi geçirmez', () => {
    expect(passesFilter('action=opened', 'düz metin')).toBe(false);
  });
});
