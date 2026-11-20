import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, isAbsolute } from 'node:path';
import {
  addressKey,
  ConnectionUrl,
  parseSkillFile,
  SkillName,
  skillWarnings,
  type SkillWarning,
} from '@leafbot/shared';
import { projectDirProblem } from '../workspace';

/** A skill another AI tool on this computer has, not yet among LeafBot's. */
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

function readSmall(home: string, path: string, max = MAX_FILE): string | null {
  try {
    if (!insideHome(home, path)) return null;
    const info = lstatSync(path);
    if (!info.isFile() && !info.isSymbolicLink()) return null;
    if (statSync(path).size > max) return null;
    const text = readFileSync(path, 'utf8');
    return text.length > max ? null : text;
  } catch {
    return null;
  }
}

/**
 * The skills and remote MCP servers the person's other AI tools have on this computer, leaving out
 * what LeafBot already has. Only SKILL.md files and the tools' server lists are read: never their
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

/** A folder another coding tool on this computer has worked in, which a bot could work in too. */
export interface FoundProject {
  path: string;
  /** The folder's own name, which a bot made for it starts with. */
  name: string;
  /** The tools that worked there, as the person knows them. */
  sources: string[];
  /** When that work last changed, if the tool keeps it apart from what was said. */
  lastUsed: string | null;
}

/** Claude Code's settings file holds every folder it was opened in; it grows past the skills' limit. */
const PROJECT_LIST_MAX = 5_000_000;
/** Folders read from one tool's list, and folders offered, at most. */
const MAX_LISTED = 2_000;
const MAX_FOUND = 100;
/** A Claude Code worktree is a passing copy of a folder listed on its own. */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]/;

/**
 * The folders the person's coding tools have worked in, for a bot to work in too. Only the tools'
 * lists of folders are read, and the time a folder's sessions last changed is taken from the
 * folder that holds them, never from what was said in them. A folder a bot could not be given (the
 * home folder, a private or temporary one, LeafBot's own data) or one a bot already works in is
 * left out; so is one that is gone.
 */
export async function findProjects(
  have: { dirs: string[] },
  /** `tmp`: the temporary folders to leave out, when not the system's. */
  opts: { dataDir: string; home?: string; tmp?: string },
): Promise<FoundProject[]> {
  const home = opts.home ?? homedir();
  const temps = (
    await Promise.all((opts.tmp ? [opts.tmp] : [tmpdir(), '/tmp', '/var/folders']).map(real))
  ).filter((d): d is string => !!d);
  const used = new Set((await Promise.all(have.dirs.map(real))).filter(Boolean));

  // What each tool lists, read first; the folders are looked at afterwards, a batch at a time.
  const listed: { dir: string; source: string }[] = [];
  const claude = await readSmallAsync(home, join(home, '.claude.json'), PROJECT_LIST_MAX);
  if (claude) {
    let projects: unknown;
    try {
      projects = (JSON.parse(claude) as { projects?: unknown }).projects;
    } catch {
      projects = null;
    }
    if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
      for (const dir of Object.keys(projects).slice(0, MAX_LISTED))
        listed.push({ dir, source: 'Claude Code' });
    }
  }
  const codex = await readSmallAsync(home, join(home, '.codex/config.toml'), MAX_FILE);
  if (codex) {
    let n = 0;
    for (const m of codex.matchAll(/^\s*\[projects\."((?:[^"\\]|\\.)*)"\]/gm)) {
      if (++n > MAX_LISTED) break;
      listed.push({ dir: m[1]!.replace(/\\(["\\])/g, '$1'), source: 'Codex' });
    }
  }

  const found = new Map<string, FoundProject & { time: number }>();
  const candidates = listed.filter(({ dir }) => isAbsolute(dir) && dir.length <= 1000 && !WORKTREE.test(dir));
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = await Promise.all(
      candidates.slice(i, i + BATCH).map(async ({ dir, source }) => {
        const target = await real(dir);
        if (!target || used.has(target) || temps.some((t) => inside(t, target))) return null;
        const isDir = await stat(target).then(
          (st) => st.isDirectory(),
          () => false,
        );
        if (!isDir) return null;
        const time = source === 'Claude Code' ? await claudeSessionsTime(home, dir) : 0;
        return { dir, source, target, time };
      }),
    );
    for (const c of batch) {
      if (!c) continue;
      const known = found.get(c.target);
      if (known) {
        if (!known.sources.includes(c.source)) known.sources.push(c.source);
        known.time = Math.max(known.time, c.time);
        continue;
      }
      if (projectDirProblem(c.dir, { home, dataDir: opts.dataDir })) continue;
      found.set(c.target, {
        path: c.dir,
        name: basename(c.target),
        sources: [c.source],
        lastUsed: null,
        time: c.time,
      });
    }
  }
  return [...found.values()]
    .sort((a, b) => b.time - a.time || a.name.localeCompare(b.name))
    .slice(0, MAX_FOUND)
    .map(({ time, ...p }) => ({ ...p, lastUsed: time ? new Date(time).toISOString() : null }));
}

/** Folders looked at together: enough to be quick, few enough not to crowd the disk. */
const BATCH = 32;

/** Like `readSmall`, without holding up the server while the disk answers. */
async function readSmallAsync(home: string, path: string, max: number): Promise<string | null> {
  try {
    const [realHome, target] = await Promise.all([realpath(home), realpath(path)]);
    const rel = relative(realHome, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    const info = await stat(target);
    if (!info.isFile() || info.size > max) return null;
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * When Claude Code's sessions in a folder last changed: the time on the folder it keeps them in,
 * named after the path with every other character than a letter or digit as "-".
 */
async function claudeSessionsTime(home: string, dir: string): Promise<number> {
  try {
    return (await stat(join(home, '.claude', 'projects', dir.replace(/[^a-zA-Z0-9]/g, '-')))).mtimeMs;
  } catch {
    return 0;
  }
}

async function real(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
