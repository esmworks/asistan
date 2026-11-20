import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TailscaleState } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TailscaleService, type TailscaleRun } from '../src/services/tailscale';
import { AUTH, testServer, type TestServer } from './helpers';

const NAME = 'laptop.tail1234.ts.net';

/** Answers like the Tailscale command line; `serving` says whether the server's port is shared. */
function fakeTailscale(o: { installed?: boolean; running?: boolean; port: number; fail?: string }) {
  const calls: string[][] = [];
  let serving = false;
  const run: TailscaleRun = async (args) => {
    calls.push(args);
    if (o.installed === false) return 'missing';
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'status')
      return ok(
        JSON.stringify({
          BackendState: o.running === false ? 'Stopped' : 'Running',
          Self: { DNSName: `${NAME}.` },
        }),
      );
    if (args.join(' ') === 'serve status --json')
      return ok(
        serving
          ? JSON.stringify({
              Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${o.port}` } } } },
            })
          : '{}',
      );
    if (args[0] === 'serve' && args.includes('--bg')) {
      if (o.fail) return { code: 1, stdout: '', stderr: o.fail };
      serving = true;
      return ok('');
    }
    if (args.join(' ') === 'serve --https=443 off') {
      serving = false;
      return ok('');
    }
    return { code: 1, stdout: '', stderr: 'unknown' };
  };
  return { run, calls };
}

describe('sharing the server on Tailscale', () => {
  it('runs nothing until asked, and remembers the address it is shared at across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'));
    const ts = fakeTailscale({ port: 4319 });
    const service = new TailscaleService(dir, 4319, ts.run);
    expect(service.hosts()).toEqual([]);
    expect(ts.calls).toEqual([]);

    expect(await service.state()).toEqual({
      installed: true,
      running: true,
      name: NAME,
      sharing: false,
      url: null,
    });
    const on = await service.share(true);
    expect(ts.calls).toContainEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:4319']);
    expect(on).toMatchObject({ sharing: true, url: `https://${NAME}` });
    expect(service.hosts()).toEqual([NAME]);
    expect(new TailscaleService(dir, 4319, ts.run).hosts()).toEqual([NAME]);

    expect((await service.share(false)).sharing).toBe(false);
    expect(service.hosts()).toEqual([]);
    expect(existsSync(join(dir, 'tailscale.json'))).toBe(false);
  });

  it('says when Tailscale is missing or stopped, and passes on why sharing failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'));
    const missing = new TailscaleService(dir, 1, fakeTailscale({ installed: false, port: 1 }).run);
    expect((await missing.state()).installed).toBe(false);
    await expect(missing.share(true)).rejects.toMatchObject({ status: 400, key: 'error.tailscaleMissing' });
    const stopped = new TailscaleService(dir, 1, fakeTailscale({ running: false, port: 1 }).run);
    await expect(stopped.share(true)).rejects.toMatchObject({ key: 'error.tailscaleStopped' });
    const refused = new TailscaleService(
      dir,
      1,
      fakeTailscale({ port: 1, fail: 'Serve is not enabled on your tailnet.' }).run,
    );
    await expect(refused.share(true)).rejects.toMatchObject({
      status: 502,
      params: { message: 'Serve is not enabled on your tailnet.' },
    });
    expect(refused.hosts()).toEqual([]);
  });
});

describe('the server at its Tailscale address', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    const ts = fakeTailscale({ port: t.services.ctx.config.port });
    (t.services as { tailscale: TailscaleService }).tailscale = new TailscaleService(
      t.dataDir,
      t.services.ctx.config.port,
      ts.run,
    );
  });
  afterEach(() => t.dispose());

  const atTailnet = () => t.app.inject({ method: 'GET', url: '/api/bots', headers: { ...AUTH, host: NAME } });

  it('answers there only while it is shared, and only the owner turns it on', async () => {
    expect((await atTailnet()).statusCode).toBe(403);
    const on = await t.api<TailscaleState>('POST', '/api/tailscale', { on: true });
    expect(on.body.url).toBe(`https://${NAME}`);
    expect((await atTailnet()).statusCode).toBe(200);
    await t.api('POST', '/api/tailscale', { on: false });
    expect((await atTailnet()).statusCode).toBe(403);
  });
});
