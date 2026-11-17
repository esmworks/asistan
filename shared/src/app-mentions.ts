import { addressKey, CONNECTION_CATALOG, type CatalogEntry, type Connection } from './connections';

/**
 * Apps named after an everyday English word: an instruction that starts a sentence with "Close",
 * "Make" or "Box" is not about the app, so these are never taken as one.
 */
const EVERYDAY_WORDS = new Set([
  'Box',
  'Buffer',
  'Clerk',
  'Close',
  'Fathom',
  'Gamma',
  'Guru',
  'Hex',
  'Hunter',
  'Instantly',
  'Jam',
  'Lucid',
  'Make',
  'Mercury',
  'Mural',
  'Neon',
  'Railway',
  'Ramp',
  'Remote',
  'Resend',
  'Sanity',
  'Shortcut',
  'Square',
  'Tally',
]);

/**
 * The names an app goes by in a text: its catalog name, the products a name lists in brackets
 * ("Atlassian (Jira, Confluence)"), and a web address name without its ending when that is a
 * name of its own ("WordPress.com" → "WordPress").
 */
function aliases(entry: CatalogEntry): string[] {
  const out = new Set<string>();
  const bracket = /^(.*?)\s*\((.*)\)\s*$/.exec(entry.name);
  if (bracket) {
    out.add(bracket[1]!.trim());
    for (const part of bracket[2]!.split(',')) if (part.trim()) out.add(part.trim());
  } else {
    out.add(entry.name);
  }
  for (const name of [...out]) {
    const domain = /^([A-Za-z]+[A-Z][A-Za-z]*)\.(com|io|ai)$/.exec(name);
    if (domain) out.add(domain[1]!);
  }
  return [...out].filter((n) => !EVERYDAY_WORDS.has(n));
}

/**
 * A plain one-word name ("Notion", "Linear") is matched only as written, capital and all; a name
 * that cannot be an ordinary word (a space, a dot, a digit, a capital inside: "Google Docs",
 * "monday.com", "ClickUp") in any case.
 */
function pattern(name: string): RegExp {
  const distinctive = /[\s.\d]/.test(name) || /.[A-Z]/.test(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, distinctive ? 'iu' : 'u');
}

const MATCHERS = CONNECTION_CATALOG.map((entry) => ({ entry, patterns: aliases(entry).map(pattern) }));

/** The catalog apps a text names, in catalog order, each once. */
export function mentionedApps(text: string): CatalogEntry[] {
  if (!text.trim()) return [];
  const found = MATCHERS.filter((m) => m.patterns.some((p) => p.test(text))).map((m) => m.entry);
  // "Cloudflare Docs" also reads as "Cloudflare": the longer name wins.
  return found.filter(
    (e) => !found.some((o) => o !== e && o.name.length > e.name.length && pattern(e.name).test(o.name)),
  );
}

/**
 * The apps a text names that the bot cannot use: not connected, not signed in, or not open to it.
 * An API added by hand under the app's name counts as connected.
 */
export function missingApps(
  text: string,
  botId: string | null,
  connections: readonly Pick<Connection, 'catalogId' | 'url' | 'status' | 'allBots' | 'botIds'>[],
  apis: readonly { name: string; title: string; botIds: string[] | null }[] = [],
): CatalogEntry[] {
  const open = (c: { allBots: boolean; botIds: string[] }) => !botId || c.allBots || c.botIds.includes(botId);
  return mentionedApps(text).filter((entry) => {
    const key = addressKey(entry.url);
    const connected = connections.some(
      (c) => (c.catalogId === entry.id || addressKey(c.url) === key) && c.status === 'connected' && open(c),
    );
    if (connected) return false;
    const names = aliases(entry).map((n) => n.toLowerCase());
    return !apis.some(
      (a) =>
        (!botId || a.botIds === null || a.botIds.includes(botId)) &&
        names.some((n) => a.name.toLowerCase().includes(n) || a.title.toLowerCase().includes(n)),
    );
  });
}
