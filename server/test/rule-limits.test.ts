import type { PermissionRule } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askRuleFor, blockRuleFor, decide, limitValue, withinLimit } from '../src/services/approvals';
import { testServer, type TestServer } from './helpers';

const TOOL = 'mcp__pay__refund';

const rule = (r: Partial<PermissionRule> & Pick<PermissionRule, 'list'>): PermissionRule => ({
  id: `r-${Math.random()}`,
  pattern: TOOL,
  note: '',
  botId: null,
  field: null,
  limit: null,
  createdAt: new Date().toISOString(),
  ...r,
});

const verdict = (rules: PermissionRule[], input: Record<string, unknown>, mode: 'ask' | 'auto' = 'ask') =>
  decide({ mode, toolName: TOOL, input, rules, readOnlyTools: new Set() });

describe('amount limits on rules', () => {
  it('reads a plain number at a dotted path, without its sign', () => {
    expect(limitValue({ amount: 120 }, 'amount')).toBe(120);
    expect(limitValue({ amount: ' 99.5 ' }, 'amount')).toBe(99.5);
    expect(limitValue({ amount: -500 }, 'amount')).toBe(500);
    expect(limitValue({ refund: { amount: '40' } }, 'refund.amount')).toBe(40);
  });

  it('reads nothing it could take more than one way, or that is not there', () => {
    for (const amount of ['1.000,50', '1,000', '1e3', '', 'ten', Infinity, NaN, null, [5], { v: 1 }, true]) {
      expect(limitValue({ amount }, 'amount')).toBeNull();
    }
    expect(limitValue({}, 'amount')).toBeNull();
    expect(limitValue({ refund: 5 }, 'refund.amount')).toBeNull();
    // A field the input does not own, such as one every object inherits, is not read.
    expect(limitValue({}, 'constructor')).toBeNull();
  });

  it('lets an allow rule cover only an amount it can read at or under the limit', () => {
    const allow = rule({ list: 'allow', field: 'amount', limit: 100 });
    expect(withinLimit(allow, { amount: 100 })).toBe(true);
    expect(withinLimit(allow, { amount: 100.01 })).toBe(false);
    expect(withinLimit(allow, { amount: -150 })).toBe(false);
    expect(withinLimit(allow, { amount: '1.000,50' })).toBe(false);
    expect(withinLimit(allow, {})).toBe(false);
  });

  it('lets an ask or block rule cover an amount over the limit, or one it cannot read', () => {
    for (const list of ['ask', 'block'] as const) {
      const r = rule({ list, field: 'amount', limit: 100 });
      expect(withinLimit(r, { amount: 100 })).toBe(false);
      expect(withinLimit(r, { amount: 101 })).toBe(true);
      expect(withinLimit(r, { amount: 'a lot' })).toBe(true);
      expect(withinLimit(r, {})).toBe(true);
    }
  });

  it('asks above the allowed amount in "ask" mode', () => {
    const rules = [rule({ list: 'allow', field: 'amount', limit: 100 })];
    expect(verdict(rules, { amount: 80 })).toBe('allow');
    expect(verdict(rules, { amount: 800 })).toBe('ask');
    expect(verdict(rules, { amount: 'eighty' })).toBe('ask');
  });

  it('holds a bot that does not ask to a card above the line', () => {
    const rules = [rule({ list: 'ask', field: 'amount', limit: 1000 })];
    expect(verdict(rules, { amount: 999 }, 'auto')).toBe('allow');
    expect(verdict(rules, { amount: 1001 }, 'auto')).toBe('ask');
    expect(askRuleFor(rules, TOOL, { amount: 1001 })?.limit).toBe(1000);
  });

  it('keeps an "ask above" line even when a plain allow rule covers the tool', () => {
    const rules = [rule({ list: 'allow' }), rule({ list: 'ask', field: 'amount', limit: 1000 })];
    expect(verdict(rules, { amount: 10 })).toBe('allow');
    expect(verdict(rules, { amount: 5000 })).toBe('ask');
  });

  it('blocks only above the line', () => {
    const rules = [rule({ list: 'block', field: 'amount', limit: 50 })];
    expect(blockRuleFor(rules, TOOL, { amount: 20 })).toBeNull();
    expect(verdict(rules, { amount: 20 }, 'auto')).toBe('allow');
    expect(verdict(rules, { amount: 70 }, 'auto')).toBe('block');
  });
});

describe('amount limits through the API', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  it('keeps a rule with its limit', async () => {
    const res = await t.api<PermissionRule>('POST', '/api/rules', {
      list: 'allow',
      pattern: TOOL,
      field: 'refund.amount',
      limit: 250,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ field: 'refund.amount', limit: 250 });
    const rules = (await t.api<PermissionRule[]>('GET', '/api/rules')).body;
    expect(rules).toEqual([expect.objectContaining({ field: 'refund.amount', limit: 250 })]);
  });

  it('refuses half a limit, a negative one and a field it cannot read', async () => {
    for (const body of [
      { field: 'amount' },
      { limit: 10 },
      { field: 'amount', limit: -1 },
      { field: 'a b', limit: 10 },
    ]) {
      const res = await t.api('POST', '/api/rules', { list: 'allow', pattern: TOOL, ...body });
      expect(res.status).toBe(400);
    }
    expect((await t.api<PermissionRule[]>('GET', '/api/rules')).body).toEqual([]);
  });

  it('gives a plain rule no limit', async () => {
    const res = await t.api<PermissionRule>('POST', '/api/rules', { list: 'ask', pattern: TOOL });
    expect(res.body).toMatchObject({ field: null, limit: null });
  });
});
