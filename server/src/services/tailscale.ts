import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TailscaleState } from '@yumakbot/shared';
import { HttpError } from '../util';

/** Runs the Tailscale command line; `missing` when it is not installed. */
export type TailscaleRun = (
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string } | 'missing'>;

/** Where the command line is: on the PATH, or inside the Mac app. */
const PROGRAMS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const TIMEOUT_MS = 20_000;
const STATE_FILE = 'tailscale.json';

/** The real command line, tried at each place it may be. */
export const runTailscale: TailscaleRun = async (args) => {
  for (const program of PROGRAMS) {
    const out = await new Promise<{ code: number; stdout: string; stderr: string } | 'missing'>((resolve) => {
      execFile(program, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve('missing');
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
    if (out !== 'missing') return out;
  }
  return 'missing';
};

/**
 * Reaching this server from the person's other devices over their Tailscale network, without
 * opening it to the internet: `tailscale serve` puts it at https://<this machine>.<tailnet>.ts.net
 * for the devices on that network only, and signing in is still needed there. Nothing runs, and
 * nothing changes for the server, until the person turns it on; Tailscale keeps the setting across
 * restarts, and the server remembers the address it is shared at so it answers there.
 */
export class TailscaleService {
  private host: string | null;

  constructor(
    private dataDir: string,
    private port: number,
    private run: TailscaleRun = runTailscale,
  ) {
    this.host = this.remembered();
  }

  /** The tailnet address the server answers at while it is shared there; none otherwise. */
  hosts(): string[] {
    return this.host ? [this.host] : [];
  }

  async state(): Promise<TailscaleState> {
    const status = await this.run(['status', '--json']);
    if (status === 'missing')
      return { installed: false, running: false, name: null, sharing: false, url: null };
    let self: { DNSName?: string } | undefined;
    let backend = '';
    try {
      const parsed = JSON.parse(status.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
      backend = parsed.BackendState ?? '';
      self = parsed.Self;
    } catch {
      // A stopped Tailscale may print words instead of JSON.
    }
    const name = self?.DNSName?.replace(/\.$/, '').toLowerCase() || null;
    const running = backend === 'Running' && !!name;
    const sharing = running ? await this.serving() : false;
    this.remember(sharing ? name : null);
    return { installed: true, running, name, sharing, url: sharing && name ? `https://${name}` : null };
  }

  /** Turns sharing on this server's port on or off. */
  async share(on: boolean): Promise<TailscaleState> {
    const before = await this.state();
    if (!before.installed) throw new HttpError(400, 'error.tailscaleMissing');
    if (on && !before.running) throw new HttpError(400, 'error.tailscaleStopped');
    const out = on
      ? await this.run(['serve', '--bg', '--https=443', `http://127.0.0.1:${this.port}`])
      : await this.run(['serve', '--https=443', 'off']);
    if (out === 'missing') throw new HttpError(400, 'error.tailscaleMissing');
    if (out.code !== 0) {
      const message = (out.stderr || out.stdout).trim().slice(0, 500);
      throw new HttpError(502, 'error.tailscaleFailed', { message });
    }
    return this.state();
  }

  /** Whether `tailscale serve` sends https on 443 to this server's port. */
  private async serving(): Promise<boolean> {
    const out = await this.run(['serve', 'status', '--json']);
    if (out === 'missing' || out.code !== 0) return false;
    try {
      const config = JSON.parse(out.stdout || '{}') as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      };
      const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${this.port}/?$`);
      return Object.entries(config.Web ?? {}).some(
        ([where, site]) =>
          where.endsWith(':443') &&
          Object.values(site.Handlers ?? {}).some((h) => target.test(h.Proxy ?? '')),
      );
    } catch {
      return false;
    }
  }

  private remembered(): string | null {
    const file = join(this.dataDir, STATE_FILE);
    if (!existsSync(file)) return null;
    try {
      const host = (JSON.parse(readFileSync(file, 'utf8')) as { host?: unknown }).host;
      return typeof host === 'string' && /^[a-z0-9.-]+\.ts\.net$/.test(host) ? host : null;
    } catch {
      return null;
    }
  }

  private remember(host: string | null) {
    if (host === this.host) return;
    this.host = host;
    const file = join(this.dataDir, STATE_FILE);
    if (host) writeFileSync(file, JSON.stringify({ host }), { mode: 0o600 });
    else rmSync(file, { force: true });
  }
}
