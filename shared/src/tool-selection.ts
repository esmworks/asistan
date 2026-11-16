import { z } from 'zod';

/**
 * Which tools a bot is given. Narrowing the list keeps a small local model's context free for the
 * work, and keeps a bot to the tools its job needs.
 *
 * Tools are named as approval cards and permission rules name them: a built-in tool by its own
 * name (`Read`, `Bash`, `WebFetch`), a connected app's tool as `mcp__<app>__<tool>`, and Yumak
 * Bot's own tools as `mcp__yumakbot__<tool>`. A name ending in `*` takes every tool it starts
 * (`mcp__gmail__*`). With `only`, the bot gets just the tools in `allow`; without it, every tool
 * but those in `exclude`. `exclude` wins over `allow`.
 */
const Selector = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9_.-]*\*?$/, 'validation.toolSelector');

export const ToolSelection = z.object({
  only: z.boolean().default(false),
  allow: z.array(Selector).max(256).default([]),
  exclude: z.array(Selector).max(256).default([]),
});
export type ToolSelection = z.infer<typeof ToolSelection>;

export const ALL_TOOLS: ToolSelection = { only: false, allow: [], exclude: [] };

function matches(selector: string, name: string): boolean {
  return selector.endsWith('*') ? name.startsWith(selector.slice(0, -1)) : selector === name;
}

/** Whether a selection changes anything: the default gives every tool. */
export function selectsTools(s: ToolSelection | null | undefined): boolean {
  return !!s && (s.only || s.exclude.length > 0);
}

/** Whether the bot gets the tool of this name under its selection. */
export function toolPicker(s: ToolSelection | null | undefined): (name: string) => boolean {
  if (!selectsTools(s)) return () => true;
  return (name) =>
    !s!.exclude.some((x) => matches(x, name)) && (!s!.only || s!.allow.some((x) => matches(x, name)));
}

/** A selection from the lines a person typed: one name per line, blank lines and spaces dropped. */
export function selectorLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}
