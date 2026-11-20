import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval, BotAction, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confinedWrite, ownBoxStep, staysOnBox } from '../src/runtime/own-box';
import { testServer, waitFor, type TestServer } from './helpers';

describe('botun kendi makinesindeki adımlar', () => {
  let dir: string;
  let group: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'own-box-'));
    group = mkdtempSync(join(tmpdir(), 'own-group-'));
    mkdirSync(join(dir, 'repo'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(group, { recursive: true, force: true });
  });
  const stays = (command: string) => staysOnBox(command, dir, [dir]);

  it('derleme, test, paket kurma ve yerel git işi makinede kalır', () => {
    for (const command of [
      'pnpm install',
      'pnpm add next@16.4.5',
      'pnpm install --ignore-scripts',
      'cd repo && pnpm typecheck && pnpm test 2>&1 | tail -40',
      'npm ci',
      'npm run test:unit',
      'git checkout -b deps/next && git add -A && git commit -m "Update next"',
      'git fetch origin && git status',
      'git clean -fdx',
      'cargo test',
      'mkdir -p out && cp a.txt out/',
      'cd repo && rm -rf node_modules',
      'tar -czf out.tgz repo',
    ]) {
      expect(stays(command), command).toBe(true);
    }
  });

  it('dışarıya ulaşan, başka program çalıştıran ya da okunamayan satır sayılmaz', () => {
    for (const command of [
      'git push origin main',
      'cd repo && git push',
      'gh pr create --fill',
      'curl https://example.com',
      'pnpm publish',
      'yarn npm publish',
      'npm version patch',
      'pnpm release',
      'npm run deploy',
      'npm exec cowsay',
      'pnpm dlx create-app',
      'npx eslint .',
      'node scripts/deploy.js',
      './deploy.sh',
      'python3 -c "print(1)"',
      'git -C /elsewhere status',
      'git config core.hooksPath x',
      'pnpm install && echo $TOKEN',
      'cat a > b',
      'find . -exec rm {} ;',
      // Options that start another program.
      'rg --pre ./steal.sh secret',
      'tar -cf x.tar --checkpoint=1 --checkpoint-action=exec=sh .',
      'tar -I ./steal.sh -cf x.tar .',
      'tar --to-command=sh -xf x.tar',
      'git grep -O./steal.sh key',
      'git rebase -x ./steal.sh main',
      'git fetch --upload-pack=./steal.sh origin',
      'sort --compress-program=./steal.sh a.txt',
      'npm install --script-shell=./steal.sh',
      // Files outside the bot's own folders.
      'rm -rf /srv/other',
      'cd .. && rm -rf x',
      'cp a.txt ../elsewhere/',
      'ln -s /etc/passwd p',
      'rm -rf ~/x',
      `rm -rf ${group}/shared.md`,
    ]) {
      expect(stays(command), command).toBe(false);
    }
  });

  it('dosya yalnızca botun kendi klasörlerinde yazılırsa sayılır', () => {
    expect(ownBoxStep('Write', { file_path: 'notes.md' }, dir, [dir])).toBe(true);
    expect(ownBoxStep('Edit', { file_path: join(dir, 'a/b.ts') }, dir, [dir])).toBe(true);
    expect(ownBoxStep('Write', { file_path: '../elsewhere.md' }, dir, [dir])).toBe(false);
    expect(ownBoxStep('Write', { file_path: '/etc/hosts' }, dir, [dir])).toBe(false);
    expect(ownBoxStep('Write', { file_path: join(group, 'shared.md') }, dir, [dir])).toBe(false);
    expect(ownBoxStep('mcp__notlar__create_note', { title: 'x' }, dir, [dir])).toBe(false);
  });

  it("on the person's computer only a write by full path inside the bot's folders counts", () => {
    expect(confinedWrite('Write', { file_path: join(dir, 'notes.md') }, [dir])).toBe(true);
    expect(confinedWrite('Edit', { file_path: join(dir, 'a/b.ts') }, [dir])).toBe(true);
    expect(confinedWrite('NotebookEdit', { notebook_path: join(dir, 'n.ipynb') }, [dir])).toBe(true);
    // A relative path depends on where the engine stands; it is not taken.
    expect(confinedWrite('Write', { file_path: 'notes.md' }, [dir])).toBe(false);
    expect(confinedWrite('Write', { file_path: join(dir, '../elsewhere.md') }, [dir])).toBe(false);
    expect(confinedWrite('Write', { file_path: '/etc/hosts' }, [dir])).toBe(false);
    expect(confinedWrite('Write', { file_path: join(group, 'shared.md') }, [dir])).toBe(false);
    expect(confinedWrite('Write', { file_path: join(dir, 'x.md') }, [])).toBe(false);
    // Commands never count here, however local they look.
    expect(confinedWrite('Bash', { command: `touch ${join(dir, 'x')}` }, [dir])).toBe(false);
    // A repository's hooks and config run code later; they still ask.
    expect(confinedWrite('Write', { file_path: join(dir, '.git/hooks/pre-commit') }, [dir])).toBe(false);
    expect(confinedWrite('Edit', { file_path: join(dir, 'repo/.git/config') }, [dir])).toBe(false);
  });

  it('a link in the folder to a file that does not exist yet is not taken as inside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'leafbot-outside-'));
    symlinkSync(join(outside, 'not-yet.plist'), join(dir, 'agent.plist'));
    symlinkSync(join(outside, 'no-folder'), join(dir, 'gone'));
    expect(confinedWrite('Write', { file_path: join(dir, 'agent.plist') }, [dir])).toBe(false);
    expect(confinedWrite('Write', { file_path: join(dir, 'gone/new.md') }, [dir])).toBe(false);
    // A link to a file that exists is judged by where it really is.
    writeFileSync(join(outside, 'real.md'), 'x');
    symlinkSync(join(outside, 'real.md'), join(dir, 'real.md'));
    expect(confinedWrite('Write', { file_path: join(dir, 'real.md') }, [dir])).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('uzak sunucuda izinler', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const run = async (botId: string, command: string) => {
    const thread = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    await t.send(thread.id, `[izin:Bash ${JSON.stringify({ command })}]`);
    return thread;
  };

  it('uzak sunucuda kendi makinesindeki iş kart açmaz; push yine sorar', async () => {
    t = await testServer({ onUserComputer: false });
    const bot = await t.bot({ permissionMode: 'ask' });
    await run(bot.id, 'pnpm install && pnpm test');
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    const thread = await run(bot.id, 'git push origin main');
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Bash' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
  });

  it('kişinin bilgisayarındaki sunucuda aynı iş eskisi gibi sorar', async () => {
    t = await testServer({ onUserComputer: true });
    const bot = await t.bot({ permissionMode: 'ask' });
    const thread = await run(bot.id, 'pnpm install && pnpm test');
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Bash' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
  });

  it('grup klasörüne yazmak uzak sunucuda da sorar', async () => {
    t = await testServer({ onUserComputer: false });
    const group = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Ekip' })).body;
    const bot = await t.bot({ permissionMode: 'ask', groupId: group.id });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const file = join(t.dataDir, 'workspaces', 'groups', group.id, 'files', 'ortak.md');
    await t.send(thread.id, `[izin:Write ${JSON.stringify({ file_path: file })}]`);
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Write' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
  });

  it('"hep sor" kuralı uzak sunucuda da sorar', async () => {
    t = await testServer({ onUserComputer: false });
    await t.api('POST', '/api/rules', { list: 'ask', pattern: 'Bash(pnpm install:*)' });
    const bot = await t.bot({ permissionMode: 'ask' });
    const thread = await run(bot.id, 'pnpm install');
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Bash' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
  });
});

describe("on the person's computer", () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const write = async (botId: string, file: string) => {
    const thread = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    await t.send(thread.id, `[izin:Write ${JSON.stringify({ file_path: file })}]`);
    return thread;
  };
  const threadDir = (botId: string, threadId: string) =>
    join(t.dataDir, 'workspaces', 'bots', botId, 'threads', threadId);

  it('a bot that asks first writes in its own folders without a card, and that is all', async () => {
    t = await testServer({ onUserComputer: true });
    const bot = await t.bot({ permissionMode: 'ask' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await write(bot.id, join(threadDir(bot.id, thread.id), 'notes.md'));
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    const done = (await t.api<BotAction[]>('GET', `/api/bots/${bot.id}/actions`)).body;
    expect(done.find((a) => a.toolName === 'Write')).toMatchObject({ how: 'review' });

    // Outside its folders it asks.
    await write(bot.id, join(t.dataDir, 'elsewhere.md'));
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Write' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
  });

  it('an "always ask" rule still asks for a write in the bot\'s folders', async () => {
    t = await testServer({ onUserComputer: true });
    await t.api('POST', '/api/rules', { list: 'ask', pattern: 'Write' });
    const bot = await t.bot({ permissionMode: 'ask' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await write(bot.id, join(threadDir(bot.id, thread.id), 'notes.md'));
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Write' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
  });

  it("a project folder the bot was pointed at is the person's own, so a write there still asks", async () => {
    t = await testServer({ onUserComputer: true });
    const project = mkdtempSync(join(tmpdir(), 'leafbot-project-'));
    const bot = await t.bot({ permissionMode: 'ask', projectDir: project });
    expect(bot.projectDir).toBe(project);
    const thread = await write(bot.id, join(project, 'package.json'));
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Write' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
    rmSync(project, { recursive: true, force: true });
  });

  it("the group's shared folder still asks", async () => {
    t = await testServer({ onUserComputer: true });
    const group = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Ekip' })).body;
    const bot = await t.bot({ permissionMode: 'ask', groupId: group.id });
    const thread = await write(
      bot.id,
      join(t.dataDir, 'workspaces', 'groups', group.id, 'files', 'ortak.md'),
    );
    expect(await waitFor(async () => (await pending())[0])).toMatchObject({ toolName: 'Write' });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
  });
});
