import { describe, expect, it } from 'vitest';
import { selectorLines, ToolSelection, toolPicker } from './tool-selection';

describe('toolPicker', () => {
  it('gives every tool by default', () => {
    expect(toolPicker(null)('Bash')).toBe(true);
    expect(toolPicker(ToolSelection.parse({}))('mcp__gmail__send')).toBe(true);
  });

  it('keeps only the listed tools, with a * at the end for a whole app', () => {
    const pick = toolPicker({ only: true, allow: ['Read', 'mcp__gmail__*'], exclude: ['mcp__gmail__send'] });
    expect(pick('Read')).toBe(true);
    expect(pick('Bash')).toBe(false);
    expect(pick('mcp__gmail__search')).toBe(true);
    // Exclude wins over allow.
    expect(pick('mcp__gmail__send')).toBe(false);
  });

  it('leaves out only the excluded tools without "only"', () => {
    const pick = toolPicker({ only: false, allow: [], exclude: ['Bash', 'mcp__leafbot__browser_*'] });
    expect(pick('Read')).toBe(true);
    expect(pick('Bash')).toBe(false);
    expect(pick('mcp__leafbot__browser_open')).toBe(false);
    expect(pick('mcp__leafbot__memory_write')).toBe(true);
  });

  it('takes names one per line and refuses a * anywhere but the end', () => {
    expect(selectorLines(' Read \n\nmcp__a__*\nRead')).toEqual(['Read', 'mcp__a__*']);
    expect(ToolSelection.safeParse({ allow: ['mc*p'] }).success).toBe(false);
    expect(ToolSelection.safeParse({ allow: ['mcp__a b'] }).success).toBe(false);
  });
});
