import { describe, expect, it } from 'vitest';
import type { DesktopStart } from '@yumakbot/shared';
import { bwrapArgs, checkSessionPath, collectBinds, sessionEnv, type SandboxOptions } from '../src/sandbox';

const W = '/data/workspaces';
const start = (over: Partial<DesktopStart> = {}): DesktopStart => ({
  internet: true,
  locale: 'tr',
  home: `${W}/b1/home`,
  workdir: `${W}/b1/work`,
  folders: [
    { path: `${W}/b1/work`, writable: true },
    { path: `${W}/shared/docs`, writable: false },
  ],
  ...over,
});
const opts = (s: DesktopStart): SandboxOptions => ({
  start: s,
  display: 7,
  ctlDir: '/run/computer/b1',
  workspacesRoot: W,
  stateRoot: '/run/computer',
  node: '/usr/local/bin/node',
  helperScript: '/srv/computer/dist/session.mjs',
  sessionScript: '/srv/computer/session.sh',
});

/** The triples after `flag`, e.g. every [src, dest] of --bind. */
const pairs = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [[args[i + 1], args[i + 2]]] : []));

describe('bwrapArgs', () => {
  it('shares the network with internet on and cuts it off with internet off', () => {
    expect(bwrapArgs(opts(start()))).not.toContain('--unshare-net');
    expect(bwrapArgs(opts(start({ internet: false })))).toContain('--unshare-net');
  });

  it('isolates processes, never leaks the environment and dies with its parent', () => {
    const a = bwrapArgs(opts(start()));
    for (const f of ['--unshare-pid', '--unshare-ipc', '--die-with-parent', '--clearenv']) {
      expect(a).toContain(f);
    }
    expect(a.indexOf('--clearenv')).toBeLessThan(a.indexOf('--setenv'));
    expect(a.join(' ')).not.toContain('TOKEN');
  });

  it('read-only root, then tmpfs over the workspaces root before any bind into it', () => {
    const a = bwrapArgs(opts(start()));
    expect(a.slice(a.indexOf('--ro-bind'), a.indexOf('--ro-bind') + 3)).toEqual(['--ro-bind', '/', '/']);
    const tmpfs = pairs(a, '--tmpfs').map((p) => p[0]);
    expect(tmpfs).toEqual(['/tmp', '/home', '/run', W]);
    const root = a.findIndex((x, i) => x === '--tmpfs' && a[i + 1] === W);
    expect(root).toBeLessThan(a.indexOf('--bind', root));
    expect(root).toBeLessThan(a.indexOf('--ro-bind', root));
  });

  it('binds the folders at the same absolute paths, read-only or writable', () => {
    const a = bwrapArgs(opts(start()));
    expect(pairs(a, '--bind')).toContainEqual([`${W}/b1/home`, `${W}/b1/home`]);
    expect(pairs(a, '--bind')).toContainEqual([`${W}/b1/work`, `${W}/b1/work`]);
    expect(pairs(a, '--ro-bind')).toContainEqual([`${W}/shared/docs`, `${W}/shared/docs`]);
    expect(pairs(a, '--bind')).not.toContainEqual([`${W}/shared/docs`, `${W}/shared/docs`]);
  });

  it('gives the session only its own control directory, at /run/ctl', () => {
    const a = bwrapArgs(opts(start()));
    expect(pairs(a, '--bind')).toContainEqual(['/run/computer/b1', '/run/ctl']);
    expect(a.join(' ')).not.toContain('/run/computer/b2');
  });

  it('hides a state root outside the usual tmpfs paths', () => {
    const o = { ...opts(start()), stateRoot: '/var/lib/computer' };
    expect(pairs(bwrapArgs(o), '--tmpfs').map((p) => p[0])).toContain('/var/lib/computer');
  });

  it('starts the session script in the workdir', () => {
    const a = bwrapArgs(opts(start()));
    expect(a.slice(-5)).toEqual(['--chdir', `${W}/b1/work`, '--', '/bin/sh', '/srv/computer/session.sh']);
  });
});

describe('collectBinds', () => {
  it('lists parents before the paths inside them', () => {
    const binds = collectBinds(
      start({
        folders: [
          { path: `${W}/b1/home/deep/er`, writable: false },
          { path: `${W}/b1/home/deep`, writable: true },
        ],
      }),
    );
    expect(binds.map((b) => b.path)).toEqual([
      `${W}/b1/home`,
      `${W}/b1/work`,
      `${W}/b1/home/deep`,
      `${W}/b1/home/deep/er`,
    ]);
  });

  it('does not bind the workdir again when a folder or home already covers it', () => {
    const inRo = collectBinds(
      start({ workdir: `${W}/shared/docs/sub`, folders: [{ path: `${W}/shared/docs`, writable: false }] }),
    );
    expect(inRo.find((b) => b.path === `${W}/shared/docs/sub`)).toBeUndefined();
    expect(inRo.find((b) => b.path === `${W}/shared/docs`)?.writable).toBe(false);
    const inHome = collectBinds(start({ workdir: `${W}/b1/home/work`, folders: [] }));
    expect(inHome.map((b) => b.path)).toEqual([`${W}/b1/home`]);
  });

  it('home is always writable, and a path listed twice is writable if either is', () => {
    const binds = collectBinds(
      start({
        folders: [
          { path: `${W}/x`, writable: false },
          { path: `${W}/x`, writable: true },
          { path: `${W}/b1/home`, writable: false },
        ],
      }),
    );
    expect(binds.find((b) => b.path === `${W}/x`)?.writable).toBe(true);
    expect(binds.find((b) => b.path === `${W}/b1/home`)?.writable).toBe(true);
  });
});

describe('sessionEnv', () => {
  it("hands the browser the controller's proxy only when the session has internet", () => {
    const proxy = 'socks5://127.0.0.1:4321';
    expect(sessionEnv({ ...opts(start()), proxy }).YUMAKBOT_PROXY).toBe(proxy);
    expect(sessionEnv({ ...opts(start({ internet: false })), proxy }).YUMAKBOT_PROXY).toBeUndefined();
    expect(sessionEnv(opts(start())).YUMAKBOT_PROXY).toBeUndefined();
  });

  it('sets language, display and the workdir', () => {
    const tr = sessionEnv(opts(start()));
    expect(tr).toMatchObject({
      LANG: 'tr_TR.UTF-8',
      LC_ALL: 'tr_TR.UTF-8',
      LANGUAGE: 'tr_TR:tr',
      DISPLAY: ':7',
      XAUTHORITY: '/run/ctl/xauth',
      YUMAKBOT_WORKDIR: `${W}/b1/work`,
      XDG_CONFIG_HOME: `${W}/b1/home/.config`,
    });
    expect(sessionEnv(opts(start({ locale: 'en' }))).LANG).toBe('en_US.UTF-8');
  });
});

describe('checkSessionPath', () => {
  it('accepts paths inside the workspaces root', () => {
    expect(checkSessionPath(`${W}/b1/home`, W)).toBe(`${W}/b1/home`);
  });
  it('refuses the root itself, outsiders, traversal and odd forms', () => {
    for (const p of [
      W,
      '/etc',
      '/data/workspaces-evil/x',
      `${W}/../secret`,
      `${W}/a//b`,
      `${W}/a/`,
      `${W}/./a`,
    ]) {
      expect(checkSessionPath(p, W)).toBeNull();
    }
  });
});
