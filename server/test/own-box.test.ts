import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Approval, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownBoxStep, staysOnBox } from '../src/runtime/own-box';
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
