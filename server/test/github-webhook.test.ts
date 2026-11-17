import { createHmac } from 'node:crypto';
import type { Routine, RoutineRun } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('GitHub olaylarıyla çalışan rutin', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const setUp = async (filter = '') => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'PR incelemesi',
        prompt: 'Açılan PR’ı incele.',
        schedule: { type: 'daily', time: '09:00' },
      })
    ).body;
    const hooked = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    if (filter) await t.api('PATCH', `/api/routines/${r.id}`, { webhookFilter: filter });
    return { r, token: hooked.webhookToken! };
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  /** A delivery as GitHub sends it: the event in a header, the body signed with the secret. */
  const deliver = (
    r: Routine,
    token: string,
    event: string,
    body: object,
    opts: { secret?: string; id?: string } = {},
  ) => {
    const raw = JSON.stringify(body);
    const sig = `sha256=${createHmac('sha256', opts.secret ?? token)
      .update(raw)
      .digest('hex')}`;
    return t.app.inject({
      method: 'POST',
      url: `/api/hooks/routines/${r.id}/${token}`,
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': opts.id ?? `${event}-${Math.random()}`,
        'x-hub-signature-256': sig,
      },
      payload: raw,
    });
  };

  it('ping rutini çalıştırmaz; imzası tutmayan çağrı reddedilir', async () => {
    const { r, token } = await setUp();
    const ping = await deliver(r, token, 'ping', { zen: 'Keep it logically awesome.' });
    expect(ping.statusCode).toBe(200);
    expect(ping.json()).toMatchObject({ status: 'ping' });
    const forged = await deliver(r, token, 'push', { ref: 'refs/heads/main' }, { secret: 'baska-anahtar' });
    expect(forged.statusCode).toBe(401);
    expect(await runs(r.id)).toHaveLength(0);
  });

  it('süzgeç olay türünü event olarak okur; bot olayın türünü de görür', async () => {
    const { r, token } = await setUp('event=pull_request\naction=opened');
    expect((await deliver(r, token, 'push', { action: 'opened' })).json()).toMatchObject({
      status: 'filtered',
    });
    expect((await deliver(r, token, 'pull_request', { action: 'closed' })).json()).toMatchObject({
      status: 'filtered',
    });
    const ok = await deliver(r, token, 'pull_request', { action: 'opened', number: 7 });
    expect(ok.statusCode).toBe(202);
    await t.services.turns.idle();
    expect(await runs(r.id)).toHaveLength(1);
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('Olay: pull_request');
    expect(prompt).toContain('"number": 7');
  });

  // The secret is in the address: a call without it is turned away before its body is read, so
  // it cannot make the server hold megabytes for nothing. A body over the limit shows the order.
  it('adresteki anahtar gövde okunmadan denetlenir', async () => {
    const { r, token } = await setUp();
    const huge = JSON.stringify({ x: 'x'.repeat(6 * 1024 * 1024) });
    const post = (url: string) =>
      t.app.inject({
        method: 'POST',
        url,
        headers: { host: 'localhost', 'content-type': 'application/json' },
        payload: huge,
      });
    expect((await post(`/api/hooks/routines/${r.id}/yanlis-anahtar`)).statusCode).toBe(404);
    expect((await post(`/api/hooks/routines/yok/${token}`)).statusCode).toBe(404);
    expect((await post(`/api/hooks/routines/${r.id}/${token}`)).statusCode).toBe(413);
    // However the address is spelled, it is the same route and the same check.
    expect((await post(`/%61pi/hooks/routines/${r.id}/yanlis-anahtar`)).statusCode).toBe(404);
    expect(await runs(r.id)).toHaveLength(0);
  });

  it('imzasız çağrılar eskisi gibi adresteki anahtarla çalışır', async () => {
    const { r, token } = await setUp();
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/hooks/routines/${r.id}/${token}`,
      headers: { host: 'localhost' },
      payload: { alarm: 'disk dolu' },
    });
    expect(res.statusCode).toBe(202);
    await t.services.turns.idle();
    expect(await runs(r.id)).toHaveLength(1);
  });
});
