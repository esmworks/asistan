import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';

/** The tag outside content is wrapped in; the model is told what it means in the system prompt. */
const TAG = 'outside-data';

/**
 * Where a tool's results come from when that is outside this server: a connected app (by its
 * name) or a web page in the bot's browser. Null for the app's own tools, whose results the
 * server writes itself.
 */
export function outsideSource(tool: AppTool, apps: ReadonlyMap<string, string>, t: T): string | null {
  if (tool.server) return apps.get(tool.server) ?? tool.server;
  if (tool.name.startsWith('browser_')) return t('outside.browser');
  if (tool.name === 'api_request') return t('outside.api');
  return null;
}

/**
 * Text from outside, marked as data: one block that says where it came from and that nothing in
 * it is an instruction. A tag in the text that could end the block early, or start another, is
 * broken up so the text stays inside.
 */
export function asOutsideData(source: string, text: string, t: T): string {
  const name = source
    .replace(/["<>\r\n]/g, ' ')
    .trim()
    .slice(0, 80);
  const body = text.replace(new RegExp(`<(\\s*/?\\s*${TAG})`, 'gi'), '‹$1');
  return `${t('outside.header', { source: name })}\n<${TAG} source="${name}">\n${body}\n</${TAG}>`;
}

/** The tool with its results marked as outside data, when they come from outside. */
export function markedOutside(tool: AppTool, source: string | null, t: T): AppTool {
  if (!source) return tool;
  const mark = (r: ToolResult): ToolResult =>
    typeof r === 'string' ? asOutsideData(source, r, t) : { ...r, text: asOutsideData(source, r.text, t) };
  return { ...tool, handler: async (args) => mark(await tool.handler(args)) };
}
