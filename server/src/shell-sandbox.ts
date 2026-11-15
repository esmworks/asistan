import { execFile } from 'node:child_process';
import type { ServerInfo } from '@yumakbot/shared';

export type ShellSandboxStatus = ServerInfo['shellSandbox'];

/** Namespaces the Claude sandbox opens on Linux; if these fail, Claude bots cannot run Bash. */
const PROBE = [
  '--new-session',
  '--die-with-parent',
  '--unshare-user',
  '--unshare-pid',
  '--unshare-net',
  '--unshare-ipc',
  '--unshare-uts',
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--tmpfs',
  '/tmp',
  '--',
  'true',
];

function run(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      resolve({
        ok: !err,
        out: code === 'ENOENT' ? 'ENOENT' : (`${stderr}${stdout}`.trim().split('\n').at(-1) ?? ''),
      });
    });
  });
}

/**
 * Checks once at startup whether shell commands can be sandboxed here. macOS has its own
 * sandbox; on Linux bubblewrap needs user namespaces, which containers often refuse.
 */
export async function probeShellSandbox(platform = process.platform): Promise<ShellSandboxStatus> {
  if (platform === 'darwin') return { status: 'ok', detail: null };
  if (platform !== 'linux') return { status: 'unavailable', reason: 'platform', detail: platform };
  const socat = await run('socat', ['-V']);
  if (socat.out === 'ENOENT') return { status: 'unavailable', reason: 'no-socat', detail: null };
  const bwrap = await run('bwrap', PROBE);
  if (bwrap.out === 'ENOENT') return { status: 'unavailable', reason: 'no-bwrap', detail: null };
  return bwrap.ok
    ? { status: 'ok', detail: null }
    : { status: 'unavailable', reason: 'bwrap-failed', detail: bwrap.out || null };
}
