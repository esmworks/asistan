import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiSource, Approval, Thread } from '@yumakbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSpec } from '../src/services/api-sources';
import { testServer, waitFor, type TestServer } from './helpers';

const SPEC = (server: string) => ({
  openapi: '3.0.3',
  info: { title: 'Evcil Hayvan API' },
  servers: [{ url: `${server}/v1` }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'Hayvanları listele',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      },
      post: {
        operationId: 'createPet',
        summary: 'Hayvan ekle',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
      },
    },
    '/pets/{petId}': {
      parameters: [{ $ref: '#/components/parameters/PetId' }],
      get: { summary: 'Bir hayvanı getir' },
    },
  },
  components: {
    parameters: { PetId: { name: 'petId', in: 'path', required: true, schema: { type: 'string' } } },
    schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  },
});

function petService() {
  const seen: { method: string; url: string; key?: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, key: req.headers['x-api-key'] as string, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  return {
    seen,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('OpenAPI belgeleri', () => {
  let t: TestServer;
  let svc: ReturnType<typeof petService>;
  let origin: string;
  beforeEach(async () => {
    t = await testServer();
    svc = petService();
    origin = await svc.start();
  });
  afterEach(async () => {
    await t.dispose();
    await svc.close();
  });

  it('belgedeki işlemleri, parametreleri ve gövde şemasını okur', () => {
    const read = readSpec(SPEC('https://api.example.com'));
    expect(read.title).toBe('Evcil Hayvan API');
    expect(read.server).toBe('https://api.example.com/v1');
    expect(read.operations.map((o) => `${o.id} ${o.method} ${o.path}`)).toEqual([
      'listPets GET /pets',
      'createPet POST /pets',
      'get_pets_petId GET /pets/{petId}',
    ]);
    expect(read.operations[2]!.params).toEqual([
      { name: 'petId', in: 'path', required: true, type: 'string' },
    ]);
    expect(JSON.parse(read.operations[1]!.body)).toMatchObject({ properties: { name: { type: 'string' } } });
  });

  it('bot işlemleri listeler ve anahtarla çağırır; değiştiren işlem onay ister', async () => {
    const bot = await t.bot({ name: 'Veteriner' });
    await t.services.apiCredentials.create(
      {
        name: 'pets',
        origin,
        auth: { type: 'header', header: 'X-API-Key' },
        value: 'anahtar-123456',
      },
      null,
    );
    const made = await t.api<ApiSource>('POST', '/api/api-sources', {
      name: 'evcil',
      spec: JSON.stringify(SPEC(origin)),
      credential: 'pets',
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ name: 'evcil', baseUrl: `${origin}/v1`, operations: 3 });

    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const call = async (tool: string, input: unknown) => {
      await t.send(thread.id, `[araç:${tool} ${JSON.stringify(input)}]`);
      await t.services.turns.idle();
      return (await t.messages(thread.id)).at(-1)!.text;
    };
    expect(await call('api_operations', {})).toContain('evcil: Evcil Hayvan API');
    const listed = await call('api_operations', { api: 'evcil' });
    expect(listed).toContain('get_pets_petId: GET /pets/{petId}');
    expect(listed).toContain('petId* (path, string)');

    const got = await call('api_call', {
      api: 'evcil',
      operation: 'get_pets_petId',
      params: { petId: 'a/b' },
    });
    expect(got).toContain('HTTP 200');
    expect(svc.seen.at(-1)).toMatchObject({ method: 'GET', url: '/v1/pets/a%2Fb', key: 'anahtar-123456' });
    expect(await call('api_call', { api: 'evcil', operation: 'get_pets_petId' })).toContain('petId');

    await t.send(
      thread.id,
      `[araç:api_call ${JSON.stringify({ api: 'evcil', operation: 'createPet', body: { name: 'Pamuk' } })}]`,
    );
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(svc.seen.at(-1)).toMatchObject({ method: 'POST', url: '/v1/pets' });
    expect(JSON.parse(svc.seen.at(-1)!.body)).toEqual({ name: 'Pamuk' });
  });

  it('JSON olmayan ya da işlemsiz belge, düz http dış adres reddedilir', async () => {
    expect((await t.api('POST', '/api/api-sources', { name: 'a', spec: 'openapi: 3' })).status).toBe(400);
    expect((await t.api('POST', '/api/api-sources', { name: 'b', spec: '{"paths":{}}' })).status).toBe(400);
    const plain = await t.api('POST', '/api/api-sources', {
      name: 'c',
      spec: JSON.stringify(SPEC('http://api.example.com')),
    });
    expect(plain.status).toBe(400);
  });
});
