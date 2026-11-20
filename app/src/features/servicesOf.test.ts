import type { Connection } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { servicesOf } from './Connections';

const conn = (id: string, name: string, url: string, catalogId: string | null): Connection =>
  ({ id, name, url, catalogId, status: 'connected' }) as Connection;

describe('bağlantı listesi', () => {
  it('katalog servisinin hesapları tek satırda toplanır; özel sunucular ayrı kalır', () => {
    const services = servicesOf([
      conn('a', 'X default', 'https://api.x.com/mcp', 'x'),
      conn('b', 'X codezal', 'https://api.x.com/mcp/', 'x'),
      conn('c', 'Notlar', 'https://notes.example/mcp', null),
      conn('d', 'Notlar 2', 'https://notes.example/mcp', null),
      conn('e', 'X esmworks', 'https://api.x.com/mcp', 'x'),
    ]);
    expect(services.map((s) => [s.name, s.logo, s.accounts.map((a) => a.id)])).toEqual([
      ['X', 'x', ['a', 'b', 'e']],
      ['Notlar', null, ['c']],
      ['Notlar 2', null, ['d']],
    ]);
  });
});
