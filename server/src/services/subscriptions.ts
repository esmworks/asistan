import { randomUUID } from 'node:crypto';
import type { AuthEvent, AuthPrompt, ModelAuth, OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { ProviderSignIn } from '@yumakbot/shared';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId } from '../util';
import type { VaultService } from './vault';

/**
 * Signing in to a provider with the person's own plan instead of an API key: ChatGPT through
 * OpenAI's "Sign in with ChatGPT" (made for agents to use a person's plan, with this app named on
 * the consent page), and GitHub Copilot through GitHub's device code. The sign-in runs here on the
 * server; the person only opens a page in their browser, and for ChatGPT on a server elsewhere,
 * pastes back the address the browser ended on.
 *
 * The tokens are sealed with the vault key like API keys, and refreshed here when they run out.
 */
const PREFIX = 'secret.oauth.';
const DEVICE_ID = 'install.device-id';
/** The name the person sees on the provider's consent page. */
const AGENT_NAME = 'Yumak Bot';
/** A sign-in nobody finishes is dropped after this long. */
const SIGN_IN_MS = 15 * 60 * 1000;
/** A token this close to running out is refreshed before use. */
const REFRESH_EARLY_MS = 60 * 1000;

export type SubscriptionFlows = Record<string, OAuthAuth>;

/** The plans that can be signed in to, by the provider whose models they open. */
export function defaultFlows(): SubscriptionFlows {
  // The library loads each sign-in flow from a file next to its own on first use, which the bundled
  // server does not have; this hands it the flows bundled in instead.
  registerBunOAuthFlows();
  return {
    openai: openaiProvider().auth.oauth!,
    'github-copilot': githubCopilotProvider().auth.oauth!,
  };
}

interface Session extends ProviderSignIn {
  abort: AbortController;
  paste: ((input: string) => void) | null;
  timer: NodeJS.Timeout;
}

export class SubscriptionService {
  private sessions = new Map<string, Session>();
  /** One refresh at a time per provider: a refresh token may only be spent once. */
  private refreshing = new Map<string, Promise<OAuthCredential | null>>();

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
    private flows: SubscriptionFlows = defaultFlows(),
  ) {}

  providers(): string[] {
    return Object.keys(this.flows);
  }

  private flow(provider: string): OAuthAuth {
    const flow = this.flows[provider];
    if (!flow) throw new HttpError(404, 'error.unknownProvider');
    return flow;
  }

  /** The stored sign-in, or null. One that cannot be opened (the vault key changed) reads as none. */
  async credential(provider: string): Promise<OAuthCredential | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.kv)
      .where(eq(schema.kv.key, PREFIX + provider))
      .limit(1);
    if (!row) return null;
    try {
      return JSON.parse(this.vault.open(String(row.value))) as OAuthCredential;
    } catch {
      return null;
    }
  }

  private async save(provider: string, credential: OAuthCredential) {
    const value = this.vault.seal(JSON.stringify(credential));
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: PREFIX + provider, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
  }

  async signedIn(provider: string): Promise<boolean> {
    return !!(await this.credential(provider));
  }

  async signOut(provider: string) {
    this.flow(provider);
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, PREFIX + provider));
    this.ctx.bus.refresh({ scope: 'info' });
  }

  /**
   * What a request to the provider carries: the token (refreshed first when it is about to run
   * out), and for Copilot the address of the person's own plan. Null when not signed in, or when
   * the provider no longer takes the sign-in (it was revoked): the person signs in again.
   */
  async auth(provider: string): Promise<ModelAuth | null> {
    const flow = this.flows[provider];
    if (!flow) return null;
    let credential = await this.credential(provider);
    if (!credential) return null;
    if (credential.expires - REFRESH_EARLY_MS <= Date.now()) {
      credential = await this.refresh(provider, flow, credential);
      if (!credential) return null;
    }
    return flow.toAuth(credential);
  }

  private refresh(provider: string, flow: OAuthAuth, stale: OAuthCredential) {
    const running = this.refreshing.get(provider);
    if (running) return running;
    const work = (async () => {
      try {
        const fresh = await flow.refresh({ ...stale, type: 'oauth' }, AbortSignal.timeout(30_000));
        await this.save(provider, fresh);
        return fresh;
      } catch (err) {
        console.warn(`Refreshing the ${provider} sign-in failed: ${String(err)}`);
        return null;
      } finally {
        this.refreshing.delete(provider);
      }
    })();
    this.refreshing.set(provider, work);
    return work;
  }

  /** The models a Copilot plan opens; null when the plan does not say (every listed model). */
  async availableModels(provider: string): Promise<Set<string> | null> {
    const ids = (await this.credential(provider))?.availableModelIds;
    return Array.isArray(ids) && ids.every((x) => typeof x === 'string') ? new Set(ids as string[]) : null;
  }

  /** This installation's own id, which OpenAI names it by on the consent page and in its records. */
  private async deviceId(): Promise<string> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, DEVICE_ID)).limit(1);
    if (typeof row?.value === 'string') return row.value;
    const id = randomUUID();
    await this.ctx.db.insert(schema.kv).values({ key: DEVICE_ID, value: id }).onConflictDoNothing();
    const [again] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, DEVICE_ID)).limit(1);
    return String(again!.value);
  }

  /** Starts signing in; the app follows it with `status` until it is done. */
  async start(provider: string, opts: { enterprise?: string } = {}): Promise<ProviderSignIn> {
    const flow = this.flow(provider);
    // One sign-in per provider at a time: ChatGPT's waits on a fixed local port.
    for (const s of this.sessions.values()) if (s.provider === provider) this.end(s, 'cancelled');
    const deviceId = await this.deviceId();
    const session: Session = {
      id: newId(),
      provider,
      status: 'starting',
      url: null,
      userCode: null,
      needsPaste: false,
      error: null,
      abort: new AbortController(),
      paste: null,
      timer: setTimeout(() => this.end(session, 'cancelled'), SIGN_IN_MS),
    };
    session.timer.unref();
    this.sessions.set(session.id, session);
    const interaction = {
      signal: session.abort.signal,
      notify: (e: AuthEvent) => {
        if (e.type === 'auth_url') session.url = e.url;
        else if (e.type === 'device_code') {
          session.url = e.verificationUri;
          session.userCode = e.userCode;
        }
        if (session.status === 'starting' && (session.url || session.userCode)) session.status = 'waiting';
      },
      prompt: (p: AuthPrompt): Promise<string> => {
        // Copilot asks for an Enterprise domain first; empty means github.com.
        if (p.type === 'text') return Promise.resolve(opts.enterprise ?? '');
        // A sign-in that can finish by itself or by a pasted address waits for whichever comes first.
        if (p.type === 'manual_code') {
          return new Promise<string>((resolve, reject) => {
            session.paste = resolve;
            session.needsPaste = true;
            const stop = () => reject(new Error('cancelled'));
            p.signal?.addEventListener('abort', stop, { once: true });
            session.abort.signal.addEventListener('abort', stop, { once: true });
          });
        }
        // Only the device-code way works whichever computer the browser is on.
        if (p.type === 'select') {
          const device = p.options.find((o) => /device/i.test(o.id));
          return Promise.resolve((device ?? p.options[0])!.id);
        }
        return Promise.reject(new Error(`Unsupported sign-in step: ${p.type}`));
      },
    };
    void flow
      .login(interaction, { agentName: AGENT_NAME, getDeviceId: () => deviceId })
      .then(async (credential) => {
        if (session.status === 'cancelled') return;
        await this.save(provider, credential);
        this.end(session, 'done');
        this.ctx.bus.refresh({ scope: 'info' });
      })
      .catch((err: unknown) => {
        if (session.status === 'cancelled') return;
        session.error = err instanceof Error ? err.message : String(err);
        this.end(session, 'error');
      });
    return this.view(session);
  }

  private end(session: Session, status: 'done' | 'error' | 'cancelled') {
    session.status = status;
    session.needsPaste = false;
    session.paste = null;
    clearTimeout(session.timer);
    if (status === 'cancelled') session.abort.abort();
    // Kept a little longer so the app can read how it ended.
    setTimeout(() => this.sessions.delete(session.id), 60_000).unref();
  }

  private view(s: Session): ProviderSignIn {
    return {
      id: s.id,
      provider: s.provider,
      status: s.status,
      url: s.url,
      userCode: s.userCode,
      needsPaste: s.needsPaste,
      error: s.error,
    };
  }

  status(id: string): ProviderSignIn {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, 'error.notFound');
    return this.view(s);
  }

  /** The address the browser ended on, for a sign-in that could not come back by itself. */
  paste(id: string, input: string): ProviderSignIn {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, 'error.notFound');
    if (!s.paste) throw new HttpError(409, 'error.signInNoPaste');
    s.paste(input.trim());
    s.paste = null;
    s.needsPaste = false;
    return this.view(s);
  }

  cancel(id: string) {
    const s = this.sessions.get(id);
    if (s && (s.status === 'starting' || s.status === 'waiting')) this.end(s, 'cancelled');
  }

  /** Ends sign-ins under way, as the server stops. */
  stop() {
    for (const s of this.sessions.values()) {
      if (s.status === 'starting' || s.status === 'waiting') this.end(s, 'cancelled');
    }
  }
}
