import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import {
  addressKey,
  ConnectionUrl,
  parseSkillFile,
  SkillName,
  skillWarnings,
  type SkillWarning,
} from '@yumakbot/shared';

/** A skill another AI tool on this computer has, not yet among YumakBot's. */
export interface FoundSkill {
  name: string;
  description: string;
  body: string;
  /** Which tool it came from, as the person knows it. */
  source: string;
  warnings: SkillWarning[];
}

/** A remote MCP server another AI tool on this computer is set up with. */
export interface FoundServer {
  name: string;
  url: string;
  source: string;
}

const MAX_FILE = 200_000;

/** Where other AI tools keep their skills, under the home folder. */
const SKILL_DIRS: { dir: string; source: string }[] = [
  { dir: '.claude/skills', source: 'Claude Code' },
  { dir: '.codex/skills', source: 'Codex' },
];

/** Where other AI tools keep their MCP servers; only their server lists are read. */
const SERVER_FILES: { file: string; source: string }[] = [
  { file: '.claude.json', source: 'Claude Code' },
  { file: 'Library/Application Support/Claude/claude_desktop_config.json', source: 'Claude Desktop' },
  { file: '.config/Claude/claude_desktop_config.json', source: 'Claude Desktop' },
  { file: 'AppData/Roaming/Claude/claude_desktop_config.json', source: 'Claude Desktop' },
  { file: '.cursor/mcp.json', source: 'Cursor' },
  { file: '.gemini/settings.json', source: 'Gemini CLI' },
];

/** A file or folder inside the home folder, never through a link that leads out of it. */
function insideHome(home: string, path: string): boolean {
  try {
    const real = realpathSync(path);
    const rel = relative(realpathSync(home), real);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function readSmall(home: string, path: string): string | null {
  try {
    if (!insideHome(home, path)) return null;
    const info = lstatSync(path);
    if (!info.isFile() && !info.isSymbolicLink()) return null;
    const text = readFileSync(path, 'utf8');
    return text.length > MAX_FILE ? null : text;
  } catch {
    return null;
  }
}

/**
 * The skills and remote MCP servers the person's other AI tools have on this computer, leaving out
 * what YumakBot already has. Only SKILL.md files and the tools' server lists are read: never their
 * credential, session or history files. A broken entry is skipped, not the whole source.
 */
export function findSetup(
  have: { skills: string[]; urls: string[] },
  home = homedir(),
): { skills: FoundSkill[]; servers: FoundServer[] } {
  const knownSkills = new Set(have.skills);
  const knownUrls = new Set(have.urls.map(addressKey));
  const skills: FoundSkill[] = [];
  for (const { dir, source } of SKILL_DIRS) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(home, dir));
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, 200)) {
      const text = readSmall(home, join(home, dir, entry, 'SKILL.md'));
      if (!text) continue;
      const parsed = parseSkillFile(text, entry);
      if (!SkillName.safeParse(parsed.name).success || !parsed.description) continue;
      if (knownSkills.has(parsed.name) || skills.some((s) => s.name === parsed.name)) continue;
      const warnings = skillWarnings(`${parsed.description}\n${parsed.body}`);
      skills.push({ ...parsed, body: parsed.body.slice(0, 50_000), source, warnings });
    }
  }
  const servers: FoundServer[] = [];
  for (const { file, source } of SERVER_FILES) {
    const text = readSmall(home, join(home, file));
    if (!text) continue;
    let list: unknown;
    try {
      list = (JSON.parse(text) as { mcpServers?: unknown }).mcpServers;
    } catch {
      continue;
    }
    if (!list || typeof list !== 'object') continue;
    for (const [name, raw] of Object.entries(list as Record<string, unknown>)) {
      // Only servers reached by address: a command another tool runs is that tool's to run.
      const url = (raw as { url?: unknown; serverUrl?: unknown; httpUrl?: unknown } | null) ?? {};
      const address = [url.url, url.serverUrl, url.httpUrl].find((v) => typeof v === 'string');
      if (!address || !ConnectionUrl.safeParse(address).success) continue;
      const key = addressKey(address as string);
      if (knownUrls.has(key) || servers.some((s) => addressKey(s.url) === key)) continue;
      servers.push({ name: name.slice(0, 80) || 'MCP', url: address as string, source });
    }
  }
  return { skills, servers };
}
