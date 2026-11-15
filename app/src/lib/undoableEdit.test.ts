import { describe, expect, it } from 'vitest';
import { changedRange } from './undoableEdit';

describe('changedRange', () => {
  it('yalnızca değişen parçayı bulur', () => {
    expect(changedRange('- a', '- a\n- ')).toEqual({ start: 3, end: 3, insert: '\n- ' });
    expect(changedRange('x\n- \ny', 'x\n\ny')).toEqual({ start: 2, end: 4, insert: '' });
    expect(changedRange('bunu $fa ile', 'bunu $fatura ile')).toEqual({ start: 8, end: 8, insert: 'tura' });
    expect(changedRange('aynı', 'aynı')).toEqual({ start: 4, end: 4, insert: '' });
  });
});
