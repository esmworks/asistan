import {
  DesktopExecResult,
  DesktopJob,
  type DesktopJobQuery,
  type DesktopJobStart,
  DesktopScreenshot,
  DesktopStatus,
  type ComputerErrorCode,
  type DesktopAction,
  type DesktopExec,
  type DesktopGit,
  type DesktopStart,
} from '@yumakbot/shared';
import { z } from 'zod';

export class ComputerError extends Error {
  constructor(
    readonly code: ComputerErrorCode | 'unreachable' | 'userControl',
    detail = '',
  ) {
    super(detail || code);
  }
}

/** The computer service's HTTP API (see `shared/src/computer.ts`). */
export class ComputerClient {
  constructor(
    private url: string,
    private token: string,
  ) {}

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ComputerError('unreachable', (err as Error).message);
    }
    const data = (await res.json().catch(() => null)) as { error?: string; code?: ComputerErrorCode } | null;
    if (!res.ok) throw new ComputerError(data?.code ?? 'failed', data?.error ?? `HTTP ${res.status}`);
    return schema.parse(data);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  list() {
    return this.call('GET', '/desktops', z.array(DesktopStatus));
  }

  status(id: string) {
    return this.call('GET', `/desktops/${id}`, DesktopStatus);
  }

  start(id: string, opts: DesktopStart) {
    // A first start unpacks a profile and opens the desktop; give it time.
    return this.call('POST', `/desktops/${id}/start`, DesktopStatus, opts, 90_000);
  }

  stop(id: string) {
    return this.call('POST', `/desktops/${id}/stop`, DesktopStatus, {});
  }

  exec(id: string, req: DesktopExec) {
    const wait = (req.timeoutMs ?? 120_000) + 15_000;
    return this.call('POST', `/desktops/${id}/exec`, DesktopExecResult, req, wait);
  }

  /** The GitHub key the desktop's git relay adds for this bot, or none. */
  async git(id: string, req: DesktopGit) {
    await this.call('POST', `/desktops/${id}/git`, z.unknown(), req);
  }

  /** Starts a command that keeps running after this call; its state comes from `job`. */
  startJob(id: string, req: DesktopJobStart) {
    return this.call('POST', `/desktops/${id}/jobs-start`, DesktopJob, req);
  }

  job(id: string, req: DesktopJobQuery) {
    return this.call('POST', `/desktops/${id}/jobs-status`, DesktopJob, req, (req.waitMs ?? 0) + 15_000);
  }

  screenshot(id: string) {
    return this.call('POST', `/desktops/${id}/screenshot`, DesktopScreenshot, {});
  }

  async action(id: string, action: DesktopAction) {
    await this.call('POST', `/desktops/${id}/action`, z.unknown(), action);
  }

  /** WebSocket address of a desktop's screen (RFB) or its browser (CDP). */
  socketUrl(id: string, kind: 'vnc' | 'cdp'): string {
    const u = new URL(`${this.url}/desktops/${id}/${kind}`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', this.token);
    return u.toString();
  }
}
