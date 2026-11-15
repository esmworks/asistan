/** What a pasted MCP setup gives: the server's address, a name for it, and a token if it carries one. */
export interface McpSetup {
  url: string;
  name?: string;
  token?: string;
}

const bearer = (header: string | undefined) =>
  /^\s*(?:authorization\s*:\s*)?bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];

function fromConfig(name: string | undefined, entry: unknown): McpSetup | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as { url?: unknown; serverUrl?: unknown; headers?: Record<string, unknown> };
  const url = typeof e.url === 'string' ? e.url : typeof e.serverUrl === 'string' ? e.serverUrl : null;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const auth = e.headers && Object.entries(e.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
  const token = typeof auth === 'string' ? bearer(auth) : undefined;
  return { url, ...(name ? { name } : {}), ...(token ? { token } : {}) };
}

/** Words of a command line, with quoted parts kept whole. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
}

/**
 * Reads what people paste when told how to add an MCP server: a bare address, a JSON config
 * (`mcpServers`, `servers`, or a single server), or a command such as
 * `claude mcp add --transport http notion https://mcp.notion.com/mcp`. Null when it holds no
 * http(s) address of a remote server.
 */
export function parseMcpSetup(text: string): McpSetup | null {
  const raw = text.trim();
  if (!raw) return null;
  if (/^https?:\/\/\S+$/i.test(raw)) return { url: raw };
  if (raw.startsWith('{')) {
    try {
      const json = JSON.parse(raw) as Record<string, unknown>;
      const group = (json.mcpServers ?? json.servers ?? json.mcp) as Record<string, unknown> | undefined;
      if (group && typeof group === 'object') {
        for (const [name, entry] of Object.entries(group)) {
          const found = fromConfig(name, entry);
          if (found) return found;
        }
      }
      return fromConfig(undefined, json);
    } catch {
      return null;
    }
  }
  const parts = words(raw.replace(/\\\n/g, ' '));
  const url = parts.find((w) => /^https?:\/\//i.test(w));
  if (!url) return null;
  let name: string | undefined;
  let token: string | undefined;
  const add = parts.indexOf('add');
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i]!;
    if (/^(--header|-H)$/.test(w)) token = bearer(parts[i + 1]) ?? token;
    // The name is the first plain word after `add`; flags and their values are skipped.
    if (add >= 0 && i > add && !name && !w.startsWith('-') && w !== url) {
      const prev = parts[i - 1]!;
      const takesValue = /^(--transport|-t|--scope|-s|--header|-H|--env|-e)$/.test(prev);
      if (!takesValue) name = w;
    }
  }
  return { url, ...(name ? { name } : {}), ...(token ? { token } : {}) };
}
