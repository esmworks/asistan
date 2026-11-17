import { describe, expect, it } from 'vitest';
import { parseFilter, passesFilter } from './webhook-filter';

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

  it('~= büyük küçük harfe bakmadan içerip içermediğine bakar', () => {
    const mail = JSON.stringify({ from: 'fatura@ornek.com', subject: 'Kasım FATURANIZ hazır' });
    expect(passesFilter('subject~=faturanız', mail)).toBe(true);
    expect(passesFilter('subject~=İade', mail)).toBe(false);
    expect(passesFilter('from~=@ornek.com\nsubject~=hazır', mail)).toBe(true);
    expect(parseFilter('a~=b')).toEqual([{ path: ['a'], op: 'contains', value: 'b' }]);
  });
});
