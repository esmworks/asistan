import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/auth.js', () => ({ auth: (...a: unknown[]) => auth(...a) }));

const { fetchSignedIn, ConnectionClientError } = await import('./client');
type Secrets = Parameters<typeof fetchSignedIn>[0] extends { store: { get(): infer S } } ? S : never;

function targetWith(token: string) {
  let secrets: Secrets = {
    oauth: {
      redirectUrl: 'https://leaf.example/cb',
      tokens: { access_token: token, token_type: 'Bearer', refresh_token: 'r' },
    },
  };
  return {
    id: `c-${token}`,
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: 'oauth' as const,
    version: '1',
    store: {
      get: () => secrets,
      save: async (next: Secrets) => {
        secrets = next;
      },
    },
  };
}

const seen: string[] = [];
afterEach(() => {
  auth.mockReset();
  vi.unstubAllGlobals();
  seen.length = 0;
});

/** A service that takes only the token `good`. */
function service() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const header = new Headers(init.headers).get('Authorization') ?? '';
      seen.push(header);
      return new Response(header === 'Bearer good' ? '{}' : 'no', {
        status: header === 'Bearer good' ? 200 : 401,
      });
    }),
  );
}

describe('fetchSignedIn', () => {
  it('sends the access token as it is when the service takes it', async () => {
    service();
    const r = await fetchSignedIn(targetWith('good'), 'https://gmail.googleapis.com/x', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(auth).not.toHaveBeenCalled();
  });

  it('renews a refused token once and tries again', async () => {
    service();
    const target = targetWith('old');
    auth.mockImplementation(async (provider: { saveTokens(t: object): Promise<void> }) => {
      await provider.saveTokens({ access_token: 'good', token_type: 'Bearer' });
      return 'AUTHORIZED';
    });
    const r = await fetchSignedIn(target, 'https://gmail.googleapis.com/x');
    expect(r.status).toBe(200);
    expect(seen).toEqual(['Bearer old', 'Bearer good']);
    // The refresh token the renewal left out stays.
    expect(target.store.get().oauth?.tokens?.refresh_token).toBe('r');
  });

  it('asks for a new sign-in when the renewed token is refused too', async () => {
    service();
    auth.mockResolvedValue('AUTHORIZED');
    await expect(fetchSignedIn(targetWith('old'), 'https://gmail.googleapis.com/x')).rejects.toBeInstanceOf(
      ConnectionClientError,
    );
  });
});
