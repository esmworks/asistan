import type { OutsideTrigger } from '@yumakbot/shared';
import { getDomain, getDomainWithoutSuffix } from 'tldts';
import { toolPermName, type AppTool, type ToolResult } from '../engine/types';
import type { T } from '../i18n';
import { runsInlineCode } from './safety';

/**
 * The app's own tools a run started by outside text may use without a card, besides reads: they
 * talk to the person, show the turn's progress or end the routine's run, and leave nothing behind
 * that the text could have chosen. Every other tool, including one added later, asks first.
 */
export const OUTSIDE_FREE_TOOLS: ReadonlySet<string> = new Set(
  [
    'ask_user',
    'react',
    'quick_replies',
    'plan_update',
    'send_file',
    'show_page',
    'routine_failed',
    'routine_stop',
    'command_status',
  ].map((name) => toolPermName({ name })),
);

/**
 * What a run started by outside text uses without a card: reads that stay on this server or with
 * the person's connected apps, and the tools above. The app's own tools that change something,
 * and reaching the web, where a page address could carry what the bot read away, ask first. A
 * connected app's tool the app itself calls read-only goes without a card too: a card for every
 * sheet, order or row a bot looks up buries the cards that matter. Only one that takes an address
 * waits for the person to mark it a read, since an app may call its own fetch tool read-only and
 * the address it is given could carry the text away. What is accepted: an app's read-only search
 * that sends its query to an outside service runs without a card, and the query could carry some
 * of what the bot read; the person can mark such a tool "changes" to make it ask again.
 */
export function outsideFreeTools(tools: readonly AppTool[]): Set<string> {
  const free = new Set(OUTSIDE_FREE_TOOLS);
  for (const tool of tools) {
    if (tool.readOnly && !(tool.readOnlyClaimed && takesAddress(tool.jsonSchema)))
      free.add(toolPermName(tool));
  }
  return free;
}

/** Programs that talk to another host, or an address written into a command. */
const NETWORK_COMMAND =
  /(?:^|[^\w-])(?:curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|ftp|telnet|http|https|xh)(?=$|[^\w-])|\b[a-z][\w+.-]*:\/\//i;

/**
 * Whether a step can reach another host: a web search or page, the browser, an API call, an app
 * tool that takes an address, or a command naming a network program or an address, or handing an
 * interpreter code inline. A script the bot runs by name is not caught here; the review judges it. In a run that
 * read outside text, such a step is the way out for what the text asks (sending the person's data
 * to the writer's host), so it is never the reviewer's to pass; the person decides.
 */
export function reachesOut(toolName: string, input: Record<string, unknown>, tool?: AppTool): boolean {
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return true;
  if (toolName === 'Bash') {
    const command = input.command;
    // Code handed straight to an interpreter can open a connection without naming a program.
    return typeof command !== 'string' || NETWORK_COMMAND.test(command) || runsInlineCode(command);
  }
  if (!tool) return false;
  if (!tool.server && (tool.name.startsWith('browser_') || tool.name.startsWith('api_'))) return true;
  return takesAddress(tool.jsonSchema);
}

/**
 * Whether a step only looks something up on the web: a search, a page, the bot's browser. After
 * outside text it still goes to the review, which is told the text was read and holds anything
 * that sends data out; a card for every page a routine whose job is browsing opens buried the
 * cards that matter. A command or an API call, which can send anything anywhere, stays with the
 * person.
 */
export function browses(toolName: string, tool?: AppTool): boolean {
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return true;
  return !!tool && !tool.server && tool.name.startsWith('browser_');
}

/** Text compared without case or accents, so "Facebook'ta" and "İnstagram" match a site's name. */
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * Whether the person's own words name the site of a page address: its domain ("facebook.com"),
 * or its name at the start of a word ("Facebook'taki grup"). A name shorter than four letters
 * counts only as the whole domain, since "x" or "ok" turn up in any sentence. Opening a page
 * there is what they asked for, whatever text the run has read since.
 */
export function namesSite(url: unknown, words: readonly string[]): boolean {
  if (typeof url !== 'string') return false;
  let host: string;
  try {
    const u = new URL(/^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    host = u.hostname;
  } catch {
    return false;
  }
  const domain = getDomain(host);
  const name = getDomainWithoutSuffix(host);
  if (!domain || !name) return false;
  const said = fold(words.join('\n'));
  if (said.includes(fold(domain))) return true;
  if (name.length < 4) return false;
  const escaped = fold(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, 'u').test(said);
}

/** Words in an input's name that make it a place to send to: a page, a host, a hook. */
const ADDRESS_WORDS = new Set([
  'url',
  'urls',
  'uri',
  'uris',
  'href',
  'link',
  'links',
  'endpoint',
  'webhook',
  'callback',
  'host',
  'hostname',
  'domain',
]);

/**
 * Whether a tool's input names an address anywhere in it (`url`, `callbackUrl`, `target_host`, a
 * string in `uri` format). A schema that cannot be walked counts as one, so the tool still asks.
 */
export function takesAddress(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false;
  const seen = new Set<unknown>();
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(visit);
    const obj = node as Record<string, unknown>;
    if (obj.format === 'uri' || obj.format === 'url' || obj.format === 'uri-reference') return true;
    const props = obj.properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props)) {
        const words = key
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase()
          .split(/[^a-z0-9]+/);
        if (words.some((w) => ADDRESS_WORDS.has(w))) return true;
      }
    }
    return Object.values(obj).some(visit);
  };
  try {
    return visit(schema);
  } catch {
    return true;
  }
}

/** The app's own tools that show text kept here which may have come from outside before. */
const STORED_READS: ReadonlySet<string> = new Set(['ticket_read', 'tickets_list', 'table_rows']);

/**
 * What outside text a tool's result brings into the run, if any: a mail, or a page or an API's
 * answer (`fromOutside`, see `outsideSource`). A connected app's answer is the person's own
 * business data (orders, sheets, records), and counting it as a stranger's words held every bot
 * that looked something up, and every bot it handed work to, to a card for each step whatever its
 * level. Its answer is still marked as data for the model; only a tool that takes an address,
 * which can bring back any page, counts as reading the web. Tickets and tables keep no record of
 * who wrote each line, and a bot that read outside text may have written one: with nobody
 * watching, reading them counts as reading stored outside text. Messages say where they came
 * from, so the tools that read them report it themselves.
 */
export function outsideRead(tool: AppTool, fromOutside: boolean, present: boolean): OutsideTrigger | null {
  if (tool.name === 'email_inbox' || tool.name === 'email_read') return 'email';
  if (tool.server) return takesAddress(tool.jsonSchema) ? 'web' : null;
  if (fromOutside) return 'web';
  if (!tool.server && !present && STORED_READS.has(tool.name)) return 'stored';
  return null;
}

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
  if (tool.name === 'api_request' || tool.name === 'api_call') return t('outside.api');
  if (tool.name === 'email_inbox' || tool.name === 'email_read') return t('outside.email');
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
