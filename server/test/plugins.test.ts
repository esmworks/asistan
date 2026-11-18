import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginService, pluginSource } from '../src/services/plugins';
import { testServer, type TestServer } from './helpers';
import { OWNER_ID } from '../src/users';

/** A plugin on GitHub, in Claude Code's layout, served by address. */
const FILES: Record<string, string> = {
  'https://raw.githubusercontent.com/acme/tools/HEAD/.claude-plugin/plugin.json': JSON.stringify({
    name: 'acme-tools',
    version: '1.2.0',
    description: 'Acme servisleri ve yazım kuralları',
    hooks: './hooks/hooks.json',
  }),
  'https://raw.githubusercontent.com/acme/tools/HEAD/.mcp.json': JSON.stringify({
    mcpServers: {
      docs: { type: 'http', url: 'https://mcp.acme.invalid/mcp' },
      crm: {
        type: 'http',
        url: 'https://crm.acme.invalid/mcp',
        headers: { Authorization: 'Bearer ${CRM_TOKEN}' },
      },
      yerel: { command: 'npx', args: ['acme-mcp'] },
    },
  }),
  'https://api.github.com/repos/acme/tools/contents/skills': JSON.stringify([
    { name: 'rapor-yaz', type: 'dir' },
    { name: 'README.md', type: 'file' },
  ]),
  'https://api.github.com/repos/acme/tools/contents/': JSON.stringify([
    { name: '.claude-plugin', type: 'dir' },
    { name: 'skills', type: 'dir' },
    { name: 'hooks', type: 'dir' },
    { name: 'commands', type: 'dir' },
  ]),
  'https://raw.githubusercontent.com/acme/tools/HEAD/skills/rapor-yaz/SKILL.md':
    '---\nname: rapor-yaz\ndescription: Haftalık raporu şirket biçiminde yaz\n---\n\n1. Başlık koy.\n2. Özetle.',
};

const fetchText = async (url: URL) => {
  const text = FILES[url.toString()];
  if (text === undefined) throw new Error(`404 ${url.toString()}`);
  return text;
};

describe('eklentiler', () => {
  let t: TestServer;
  let plugins: PluginService;
  beforeEach(async () => {
    t = await testServer();
    plugins = new PluginService(t.services, fetchText);
  });
  afterEach(async () => {
    await t.dispose();
  });

  it('GitHub adresinden ham dosya ve klasör adresleri çıkarır', () => {
    const src = pluginSource('https://github.com/acme/tools/tree/main/plugins/x');
    expect(src.file('plugin.json').toString()).toBe(
      'https://raw.githubusercontent.com/acme/tools/main/plugins/x/plugin.json',
    );
    expect(pluginSource('https://example.com/p').file('mcp.json').toString()).toBe(
      'https://example.com/p/mcp.json',
    );
    expect(() => pluginSource('http://example.com/p')).toThrow();
  });

  it('önce ne ekleyeceğini gösterir; kod çalıştıran parçaları kurmaz, adını söyler', async () => {
    const plan = await plugins.preview('https://github.com/acme/tools');
    expect(plan).toMatchObject({ name: 'acme-tools', version: '1.2.0' });
    expect(plan.servers).toEqual([
      { name: 'docs', url: 'https://mcp.acme.invalid/mcp', needsToken: false, exists: false },
      { name: 'crm', url: 'https://crm.acme.invalid/mcp', needsToken: true, exists: false },
    ]);
    expect(plan.skills).toEqual([
      { name: 'rapor-yaz', description: 'Haftalık raporu şirket biçiminde yaz', exists: false, warnings: [] },
    ]);
    expect(plan.leftOut).toEqual(
      expect.arrayContaining([
        { part: 'MCP: yerel', why: 'runsCode' },
        { part: 'hooks', why: 'runsCode' },
        { part: 'commands', why: 'unsupported' },
      ]),
    );
  });

  it('kurulum bağlantıları ve becerileri ekler; anahtarı verilmeyen sunucuyu ve tekrarları atlar', async () => {
    const r = await plugins.install({ url: 'https://github.com/acme/tools', tokens: {}, skip: [] }, OWNER_ID);
    expect(r).toEqual({ servers: 1, skills: 1 });
    const conns = await t.services.connections.list();
    expect(conns.map((c) => c.url)).toEqual(['https://mcp.acme.invalid/mcp']);
    // Not reachable without signing in: it waits for an OAuth sign-in.
    expect(conns[0]!.auth).toBe('oauth');
    const skills = await t.services.skills.list();
    expect(skills.map((k) => [k.name, k.botIds])).toEqual([['rapor-yaz', []]]);

    const again = await plugins.install(
      {
        url: 'https://github.com/acme/tools',
        tokens: { crm: 'tok-123' },
        skip: [],
      },
      OWNER_ID,
    );
    expect(again).toEqual({ servers: 1, skills: 0 });
    const crm = (await t.services.connections.list()).find((c) => c.name === 'crm')!;
    expect(crm.auth).toBe('token');
    expect((await plugins.preview('https://github.com/acme/tools')).skills[0]!.exists).toBe(true);
  });

  it('bildirimi olmayan adres eklenti sayılmaz', async () => {
    await expect(plugins.preview('https://github.com/acme/yok')).rejects.toThrow();
  });
});
