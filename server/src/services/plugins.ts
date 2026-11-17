import {
  parseSkillFile,
  skillWarnings,
  type PluginInstall,
  type PluginInstallResult,
  type PluginPlan,
  type SkillFile,
} from '@yumakbot/shared';
import { HttpError } from '../util';
import { fetchPublicText } from './skill-link';
import type { Services } from './index';

/** A plugin's files: one MCP config and up to this many skills are read. */
const MAX_SKILLS = 50;
const JSON_MAX = 64 * 1024;

interface Source {
  /** Where a file of the plugin is read from, by its path in the plugin. */
  file(path: string): URL;
  /** The entries of a folder in the plugin; null where folders cannot be listed. */
  list?(path: string): Promise<{ name: string; type: 'file' | 'dir' }[] | null>;
}

/**
 * A plugin's address as a person pastes it: a GitHub repository or a folder in one, or any https
 * address of the folder that holds `plugin.json`. GitHub folders can be listed, so their skills
 * are found; elsewhere only what the manifest names is read.
 */
export function pluginSource(raw: string, fetchText = fetchPublicText): Source {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, 'error.skillLinkInvalid');
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'error.skillLinkHttps');
  if (url.hostname === 'github.com') {
    const [owner, repo, kind, ref, ...rest] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo) throw new HttpError(400, 'error.skillLinkInvalid');
    const name = repo.replace(/\.git$/, '');
    const branch = kind === 'tree' && ref ? ref : 'HEAD';
    const base = kind === 'tree' ? rest.join('/') : '';
    const at = (p: string) => [base, p].filter(Boolean).join('/');
    return {
      file: (p) => new URL(`https://raw.githubusercontent.com/${owner}/${name}/${branch}/${at(p)}`),
      async list(p) {
        const api = new URL(`https://api.github.com/repos/${owner}/${name}/contents/${at(p)}`);
        if (branch !== 'HEAD') api.searchParams.set('ref', branch);
        const text = await fetchText(api, 512 * 1024).catch(() => null);
        if (!text) return null;
        const list = JSON.parse(text) as unknown;
        if (!Array.isArray(list)) return null;
        return list
          .filter((e): e is { name: string; type: string } => typeof e?.name === 'string')
          .map((e) => ({ name: e.name, type: e.type === 'dir' ? ('dir' as const) : ('file' as const) }));
      },
    };
  }
  const base = url.toString().replace(/\/?$/, '/');
  return { file: (p) => new URL(p, base) };
}

interface McpEntry {
  type?: string;
  url?: string;
  command?: string;
  headers?: Record<string, string>;
}

interface Read {
  plan: PluginPlan;
  /** The servers as they will be connected. */
  servers: { name: string; url: string; needsToken: boolean }[];
  skills: SkillFile[];
}

/**
 * Plugins in the shared plugin format (`plugin.json` with `mcp.json`, or Claude Code's
 * `.claude-plugin/plugin.json` with `.mcp.json` and `skills/`). They install as ordinary
 * connections and skills, so sign-in, approvals and per-bot choices work as for anything else.
 * Parts that would run the plugin's own code here — hooks, local (stdio) MCP servers, commands,
 * agents, language servers — are not installed and are named instead: a plugin is read, never run.
 */
export class PluginService {
  constructor(
    private services: Services,
    private fetchText: typeof fetchPublicText = fetchPublicText,
  ) {}

  private async json(src: Source, path: string): Promise<Record<string, unknown> | null> {
    const text = await this.fetchText(src.file(path), JSON_MAX).catch(() => null);
    if (text === null) return null;
    try {
      const v = JSON.parse(text) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      throw new HttpError(400, 'error.pluginFormat', { file: path });
    }
  }

  private async read(url: string): Promise<Read> {
    const src = pluginSource(url, this.fetchText);
    const manifest =
      (await this.json(src, 'plugin.json')) ?? (await this.json(src, '.claude-plugin/plugin.json'));
    if (!manifest || typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new HttpError(400, 'error.pluginNoManifest');
    }
    const leftOut: PluginPlan['leftOut'] = [];

    // MCP servers: in the manifest, or in its own file.
    let mcp: Record<string, unknown> | null = null;
    if (manifest.mcpServers && typeof manifest.mcpServers === 'object')
      mcp = { mcpServers: manifest.mcpServers };
    else if (typeof manifest.mcpServers === 'string')
      mcp = await this.json(src, manifest.mcpServers.replace(/^\.\//, ''));
    mcp ??= (await this.json(src, 'mcp.json')) ?? (await this.json(src, '.mcp.json'));
    const entries = (mcp?.mcpServers ?? {}) as Record<string, McpEntry>;
    const existing = await this.services.connections.list();
    const servers: Read['servers'] = [];
    for (const [name, e] of Object.entries(entries)) {
      if (!e || typeof e !== 'object') continue;
      if (e.command || e.type === 'stdio') {
        leftOut.push({ part: `MCP: ${name}`, why: 'runsCode' });
        continue;
      }
      const remote = !e.type || ['http', 'streamable-http', 'sse'].includes(e.type);
      let ok = false;
      try {
        const u = new URL(e.url ?? '');
        ok = remote && u.protocol === 'https:';
      } catch {
        ok = false;
      }
      if (!ok) {
        leftOut.push({ part: `MCP: ${name}`, why: remote ? 'local' : 'unsupported' });
        continue;
      }
      const auth = Object.entries(e.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization');
      servers.push({ name: name.slice(0, 80), url: e.url!, needsToken: !!auth });
    }

    // Skills: the folder the manifest names, or skills/; found by listing where that works.
    const skills: SkillFile[] = [];
    const skillDir =
      typeof manifest.skills === 'string' ? manifest.skills.replace(/^\.\/|\/$/g, '') : 'skills';
    const named = Array.isArray(manifest.skills)
      ? manifest.skills
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.replace(/^\.\/|\/$/g, ''))
      : [];
    const folders = named.length
      ? named
      : ((await src.list?.(skillDir)) ?? [])
          .filter((e) => e.type === 'dir')
          .map((e) => `${skillDir}/${e.name}`);
    for (const folder of folders.slice(0, MAX_SKILLS)) {
      const path = folder.endsWith('.md') ? folder : `${folder}/SKILL.md`;
      const text = await this.fetchText(src.file(path)).catch(() => null);
      if (!text) continue;
      const skill = parseSkillFile(
        text,
        folder
          .split('/')
          .filter((p) => p !== 'SKILL.md')
          .pop() ?? '',
      );
      if (skill.name && skill.description) skills.push(skill);
    }

    // What would run code here, found at the plugin's root where it can be listed.
    const root = (await src.list?.('')) ?? [];
    const has = (n: string) => root.some((e) => e.name === n);
    if (manifest.hooks || has('hooks')) leftOut.push({ part: 'hooks', why: 'runsCode' });
    if (manifest.commands || has('commands')) leftOut.push({ part: 'commands', why: 'unsupported' });
    if (manifest.agents || has('agents')) leftOut.push({ part: 'agents', why: 'unsupported' });
    if (manifest.lspServers || has('.lsp.json')) leftOut.push({ part: 'LSP', why: 'runsCode' });

    const savedSkills = new Set((await this.services.skills.list()).map((k) => k.name));
    return {
      servers,
      skills,
      plan: {
        name: String(manifest.name).slice(0, 80),
        version: typeof manifest.version === 'string' ? manifest.version.slice(0, 40) : '',
        description: typeof manifest.description === 'string' ? manifest.description.slice(0, 500) : '',
        servers: servers.map((sv) => ({ ...sv, exists: existing.some((c) => c.url === sv.url) })),
        skills: skills.map((k) => ({
          name: k.name,
          description: k.description,
          exists: savedSkills.has(k.name),
          warnings: skillWarnings(k.body),
        })),
        leftOut,
      },
    };
  }

  async preview(url: string): Promise<PluginPlan> {
    return (await this.read(url)).plan;
  }

  /**
   * Installs what the plugin adds, minus what the person left out. Skills come in switched off,
   * as from any link; a server already connected at the same address is left as it is. A server
   * whose entry sends a token is connected only when the person gave one.
   */
  async install(
    input: PluginInstall & { tokens: Record<string, string>; skip: string[] },
  ): Promise<PluginInstallResult> {
    const { servers, skills, plan } = await this.read(input.url);
    const skip = new Set(input.skip);
    let made = 0;
    for (const sv of plan.servers) {
      if (skip.has(sv.name) || sv.exists) continue;
      const token = input.tokens[sv.name]?.trim();
      if (sv.needsToken && !token) continue;
      const conn = await this.services.connections.create({
        name: sv.name,
        url: servers.find((x) => x.name === sv.name)!.url,
        auth: token ? 'token' : 'none',
        token,
        catalogId: null,
        allBots: false,
        botIds: [],
      });
      // A server that turns away a call without sign-in signs in through OAuth instead.
      if (!token && conn.status !== 'connected')
        await this.services.connections.update(conn.id, { auth: 'oauth' });
      made++;
    }
    let added = 0;
    for (const k of skills) {
      if (skip.has(k.name) || plan.skills.find((x) => x.name === k.name)?.exists) continue;
      await this.services.skills.create({
        name: k.name,
        description: k.description,
        body: k.body,
        botIds: [],
      });
      added++;
    }
    return { servers: made, skills: added };
  }
}
