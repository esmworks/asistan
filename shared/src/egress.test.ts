import { once } from 'node:events';
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockedAddress,
  dialPublic,
  EgressError,
  EgressMux,
  join,
  socksAccept,
  socksReply,
  SOCKS_REPLY,
} from './egress';

/** Two muxes wired back to back, as over one channel; frames cross asynchronously like a socket. */
function pair(dial?: (host: string, port: number) => Promise<Duplex>) {
  const ends: { exit?: EgressMux } = {};
  const entry = new EgressMux({ send: (f) => setImmediate(() => ends.exit!.receive(f)) });
  const exit = new EgressMux({ send: (f) => setImmediate(() => entry.receive(f)), ...(dial && { dial }) });
  ends.exit = exit;
  return { entry, exit };
}

const read = async (s: Duplex) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(handler: (s: Socket) => void): Promise<number> {
  const server = createServer({ allowHalfOpen: true }, handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

describe('EgressMux', () => {
  it('carries both directions and ends cleanly', async () => {
    const seen: string[] = [];
    const { entry } = pair(async (host, port) => {
      seen.push(`${host}:${port}`);
      // The far end reads everything, then answers it in upper case and ends.
      const incoming = new PassThrough();
      const far: Duplex = new Duplex({
        write: (c, _e, cb) => void incoming.write(c, cb),
        final: (cb) => {
          incoming.end();
          cb();
        },
        read: () => {},
      });
      void read(incoming).then((t) => {
        far.push(t.toUpperCase());
        far.push(null);
      });
      return far;
    });
    const conn = await entry.open('example.com', 443);
    conn.end('hello');
    expect(await read(conn)).toBe('HELLO');
    expect(seen).toEqual(['example.com:443']);
  });

  it('reports why an open failed', async () => {
    const { entry } = pair(() => Promise.reject(new EgressError('refused')));
    await expect(entry.open('10.0.0.1', 80)).rejects.toMatchObject({ code: 'refused' });
    expect(entry.size).toBe(0);
  });

  it('answers unavailable when the far side has no exit', async () => {
    const { entry } = pair();
    await expect(entry.open('example.com', 443)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('ends every stream when the channel goes away', async () => {
    let far!: PassThrough;
    const { entry, exit } = pair(async () => (far = new PassThrough()));
    const conn = await entry.open('example.com', 443);
    const closed = new Promise((r) => conn.on('close', r));
    entry.close();
    exit.close();
    await closed;
    expect(conn.destroyed).toBe(true);
    expect(far.destroyed).toBe(true);
    await expect(entry.open('example.com', 443)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('carries a large transfer whole, with the reader slower than the writer', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 'x');
    const port = await listen((s) => s.end(big));
    const { entry } = pair((h, p) => dialPublic(h, p, { allowHosts: ['127.0.0.1'] }));
    const conn = await entry.open('127.0.0.1', port);
    conn.end();
    let total = 0;
    for await (const c of conn) {
      total += (c as Buffer).length;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(total).toBe(big.length);
  });
  it('holds the far writer back while the link is slow, instead of piling frames up', async () => {
    // A link that carries one frame per millisecond towards the entry, like a home upload.
    const queue: Buffer[] = [];
    let queued = 0;
    let most = 0;
    const ends: { entry?: EgressMux } = {};
    const big = Buffer.alloc(4 * 1024 * 1024, 'y');
    let at = 0;
    const exit = new EgressMux({
      send: (f) => {
        queue.push(f);
        queued += f.length;
        most = Math.max(most, queued);
      },
      dial: async () =>
        new Duplex({
          read() {
            const next = big.subarray(at, at + 16 * 1024);
            at += next.length;
            this.push(next.length ? next : null);
          },
          write: (_c, _e, cb) => cb(),
        }),
    });
    const pump = setInterval(() => {
      const f = queue.shift();
      if (!f) return;
      queued -= f.length;
      ends.entry!.receive(f);
    }, 1);
    ends.entry = new EgressMux({ send: (f) => setImmediate(() => exit.receive(f)) });
    try {
      const conn = await ends.entry.open('example.com', 443);
      conn.end();
      let total = 0;
      for await (const c of conn) total += (c as Buffer).length;
      expect(total).toBe(big.length);
      // One window and the frame that crossed it, never the whole transfer.
      expect(most).toBeLessThan(400 * 1024);
    } finally {
      clearInterval(pump);
    }
  });
});

describe('socksAccept', () => {
  it('reads a CONNECT by name and joins it to a connection', async () => {
    const target = await listen((s) => s.end('from target'));
    const proxy = await listen((client) => {
      void socksAccept(client).then(async ({ host, port }) => {
        expect(host).toBe('localhost');
        const up = await dialPublic('127.0.0.1', port, { allowHosts: ['127.0.0.1'] });
        socksReply(client, SOCKS_REPLY.ok);
        join(client, up);
      });
    });
    const c = connect(proxy, '127.0.0.1');
    await once(c, 'connect');
    c.write(Buffer.from([5, 1, 0]));
    const name = Buffer.from('localhost');
    c.write(
      Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([target >> 8, target & 255])]),
    );
    const got = await read(c);
    // Method choice (2 bytes) and the reply (10 bytes) come before the data.
    expect(got.slice(12)).toBe('from target');
  });

  it('refuses anything but CONNECT', async () => {
    const result = new Promise<Error>((resolve) => {
      void listen((client) => void socksAccept(client).catch(resolve)).then(async (port) => {
        const c = connect(port, '127.0.0.1');
        c.on('error', () => {});
        await once(c, 'connect');
        c.write(Buffer.from([5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]));
      });
    });
    expect((await result).message).toBe('only CONNECT');
  });
});

describe('blockedAddress', () => {
  it('blocks this machine, private networks and their IPv6 forms', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.100.1.1',
      '0.0.0.0',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fd00::1',
      'fe80::1',
      'ff02::1',
      '::ffff:192.168.1.1',
      '::ffff:c0a8:101',
      '64:ff9b::a00:1',
      '2002:c0a8:101::1',
      'not-an-ip',
    ]) {
      expect(blockedAddress(ip), ip).toBe(true);
    }
  });

  it('blocks private IPv4 carried inside every IPv6 form, and reserved ranges', () => {
    for (const ip of [
      // IPv4-compatible, IPv4-mapped and IPv4-translated loopback and private addresses
      '::127.0.0.1',
      '::a00:1',
      '::ffff:0:a00:1',
      '::ffff:0:127.0.0.1',
      // NAT64 and 6to4 wrapped around loopback and the cloud metadata address
      '64:ff9b::7f00:1',
      '64:ff9b::169.254.169.254',
      '2002:7f00:1::',
      '2002:a9fe:a9fe::1',
      // NAT64 of the operator's own network, Teredo, site-local, multicast, documentation
      '64:ff9b:1::808:808',
      '2001:0:4136:e378::1',
      'fec0::1',
      'ff05::1',
      '2001:db8::1',
      '100::1',
      // IETF protocol assignments, benchmarking, documentation, reserved
      '192.0.0.8',
      '198.19.255.255',
      '192.0.2.1',
      '198.51.100.7',
      '203.0.113.5',
      '240.0.0.1',
    ]) {
      expect(blockedAddress(ip), ip).toBe(true);
    }
  });

  it('lets public addresses through', () => {
    for (const ip of [
      '104.244.42.1',
      '8.8.8.8',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '2a03:2880:f12f::1',
      '64:ff9b::808:808',
      '2002:808:808::1',
    ]) {
      expect(blockedAddress(ip), ip).toBe(false);
    }
  });
});

describe('dialPublic', () => {
  it('refuses other ports, private names and private addresses', async () => {
    await expect(dialPublic('example.com', 22, { ports: [80, 443] })).rejects.toMatchObject({
      code: 'refused',
    });
    await expect(dialPublic('localhost', 443)).rejects.toMatchObject({ code: 'refused' });
    await expect(dialPublic('192.168.1.1', 443)).rejects.toMatchObject({ code: 'refused' });
    await expect(
      dialPublic('home.example', 443, {
        lookup: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.2' }],
      }),
    ).rejects.toMatchObject({ code: 'refused' });
  });

  it('connects to the address it looked up, not the name', async () => {
    const asked: string[] = [];
    const sock = await dialPublic('x.com', 443, {
      lookup: async () => [{ address: '104.244.42.1' }],
      connect: (address, port) => {
        asked.push(`${address}:${port}`);
        const s = new PassThrough() as unknown as Socket;
        setImmediate(() => s.emit('connect'));
        return s;
      },
    });
    expect(asked).toEqual(['104.244.42.1:443']);
    sock.destroy();
  });
});
