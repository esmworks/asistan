import type { ClaudeAuthSet, ClaudeAuthStatus } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { ClaudeCredential } from '../engine/claude';
import { HttpError } from '../util';
import { endpointUrl, keySafeAt } from './keys';
import type { VaultService } from './vault';

const KEY = 'secret.claude';

/**
 * How Claude bots sign in: the Claude login of the machine the server runs on (the default),
 * a subscription token from `claude setup-token`, or an Anthropic API key (billed per use).
 * The token or key is encrypted with the vault key; the API returns only a hint.
 */
export class ClaudeAuthService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  async credential(): Promise<ClaudeCredential | null> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, KEY)).limit(1);
    if (!row) return null;
    try {
      const c = JSON.parse(this.vault.open(String(row.value))) as ClaudeCredential;
      return (c.kind === 'token' || c.kind === 'apiKey') && c.value ? c : null;
    } catch {
      // A data folder restored without its vault key: fall back to the machine's login.
      return null;
    }
  }

  async status(): Promise<ClaudeAuthStatus> {
    const c = await this.credential();
    return c
      ? { kind: c.kind, hint: `…${c.value.slice(-4)}`, ...(c.baseUrl && { baseUrl: c.baseUrl }) }
      : { kind: 'login', hint: null };
  }

  async set(input: ClaudeAuthSet): Promise<void> {
    // Terminals wrap long tokens; pasted line breaks and spaces are never part of one.
    const value = input.value.replace(/\s+/g, '');
    if (input.kind === 'token' && !value.startsWith('sk-ant-oat')) {
      throw new HttpError(400, 'error.notClaudeToken');
    }
    if (input.kind === 'apiKey' && (value.startsWith('sk-ant-oat') || value.length < 20)) {
      throw new HttpError(400, 'error.notAnthropicKey');
    }
    // A gateway gets the key with every request: only over https, or plain http on this computer.
    let baseUrl: string | undefined;
    if (input.baseUrl) {
      if (input.kind !== 'apiKey') throw new HttpError(400, 'error.gatewayKeyOnly');
      const url = endpointUrl(input.baseUrl);
      if (!url) throw new HttpError(400, 'error.endpointUrl');
      if (!keySafeAt(url)) throw new HttpError(400, 'error.endpointKeyHttp');
      baseUrl = url;
    }
    const sealed = this.vault.seal(JSON.stringify({ kind: input.kind, value, ...(baseUrl && { baseUrl }) }));
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: KEY, value: sealed })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: sealed } });
  }

  async clear(): Promise<void> {
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, KEY));
  }
}
