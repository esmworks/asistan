import {
  isLocale,
  pushWanted,
  type ApnsSet,
  type ApnsStatus,
  type NoticeEvent,
  type PushDeviceSet,
} from '@yumakbot/shared';
import { eq, inArray } from 'drizzle-orm';
import { hashSession } from '../auth';
import type { Ctx } from '../context';
import { schema } from '../db';
import { translator } from '../i18n';
import { HttpError } from '../util';
import {
  alertRequest,
  ApnsToken,
  http2Transport,
  readableKey,
  type ApnsAlert,
  type ApnsCredentials,
  type ApnsTransport,
} from './apns';
import type { VaultService } from './vault';
import { OWNER_ID } from '../users';

const KEY = 'secret.apns';
/** Long replies are cut; the phone shows only the first lines anyway. */
const BODY_MAX = 240;

/** A device and the person it was signed in as; the access key stands for the owner. */
type Device = typeof schema.pushDevices.$inferSelect & { userId: string };

/**
 * Notifications on phones while the app is closed. The phone app registers its push token with
 * its own choices; each notice from the bots is sent to the devices that want it, through Apple's
 * service with the key saved here (sealed with the vault key).
 */
export class PushService {
  private h2 = http2Transport();
  /** How requests reach Apple; tests replace it. */
  transport: ApnsTransport = this.h2;
  private token: { creds: ApnsCredentials; signer: ApnsToken } | null = null;

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  async register(input: PushDeviceSet, sessionToken: string | undefined): Promise<void> {
    const values = {
      platform: input.platform,
      locale: input.locale,
      level: input.level,
      mutes: input.mutes,
      sessionId: sessionToken ? hashSession(sessionToken) : null,
      updatedAt: new Date(),
    };
    await this.ctx.db
      .insert(schema.pushDevices)
      .values({ token: input.token.toLowerCase(), ...values })
      .onConflictDoUpdate({ target: schema.pushDevices.token, set: values });
  }

  async unregister(token: string): Promise<void> {
    await this.ctx.db.delete(schema.pushDevices).where(eq(schema.pushDevices.token, token.toLowerCase()));
  }

  async apnsStatus(): Promise<ApnsStatus> {
    const c = await this.credentials();
    return c
      ? { configured: true, teamId: c.teamId, keyId: c.keyId, bundleId: c.bundleId }
      : { configured: false, teamId: null, keyId: null, bundleId: null };
  }

  async setApns(input: ApnsSet): Promise<void> {
    const key = input.key.trim();
    if (!readableKey(key)) throw new HttpError(400, 'error.apnsKey');
    const sealed = this.vault.seal(JSON.stringify({ ...input, key }));
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: KEY, value: sealed })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: sealed } });
    this.token = null;
  }

  async clearApns(): Promise<void> {
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, KEY));
    this.token = null;
  }

  /** Lets go of the open connections to Apple. */
  stop() {
    this.h2.close();
  }

  /** Sends a notice to every phone that wants it; failures are logged, never thrown. */
  /** Tells the devices of `users` (everyone's without it) about a reply, a card or a failure. */
  async notice(e: NoticeEvent, users?: string[]): Promise<void> {
    try {
      const devices = (await this.liveDevices()).filter(
        (d) => pushWanted(e, d.level, d.mutes) && (!users || users.includes(d.userId)),
      );
      if (!devices.length) return;
      const [bot] = await this.ctx.db
        .select({ name: schema.bots.name })
        .from(schema.bots)
        .where(eq(schema.bots.id, e.botId))
        .limit(1);
      await Promise.all(
        devices.map((d) => {
          const t = translator(isLocale(d.locale) ? d.locale : 'tr');
          const name = bot?.name ?? t('push.bot');
          const title =
            e.kind === 'needsYou'
              ? t('push.needsYou', { name })
              : e.kind === 'error'
                ? t('push.error', { name })
                : name;
          const text = e.text.length > BODY_MAX ? `${e.text.slice(0, BODY_MAX - 1)}…` : e.text;
          return this.send(d, {
            title,
            body: text,
            threadId: e.threadId,
            collapseId: `${e.kind}:${e.threadId}`,
            data: { kind: e.kind, botId: e.botId, threadId: e.threadId },
          });
        }),
      );
    } catch (err) {
      console.warn('push notice', err);
    }
  }

  /** A notification to one registered phone right now, so the person sees what they will get. */
  async test(token: string): Promise<void> {
    const [device] = await this.ctx.db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.token, token.toLowerCase()))
      .limit(1);
    if (!device) throw new HttpError(404, 'error.pushDeviceUnknown');
    const t = translator(isLocale(device.locale) ? device.locale : 'tr');
    const result = await this.send(device, {
      title: t('push.testTitle'),
      body: t('push.testBody'),
      threadId: 'test',
      collapseId: 'test',
      data: { kind: 'test' },
    });
    if (result === 'unconfigured') throw new HttpError(409, 'error.apnsUnconfigured');
    if (result === 'refused') throw new HttpError(502, 'error.apnsRefused');
    if (result === 'gone') throw new HttpError(410, 'error.pushDeviceGone');
  }

  /** Devices whose registering session is still signed in; the rest are let go. */
  private async liveDevices(): Promise<Device[]> {
    const devices = await this.ctx.db.select().from(schema.pushDevices);
    const sessionIds = [...new Set(devices.map((d) => d.sessionId).filter((s): s is string => !!s))];
    const people = new Map(
      sessionIds.length
        ? (
            await this.ctx.db
              .select({ id: schema.sessions.id, userId: schema.sessions.userId })
              .from(schema.sessions)
              .where(inArray(schema.sessions.id, sessionIds))
          ).map((r) => [r.id, r.userId])
        : [],
    );
    const live = new Set(people.keys());
    const ended = devices.filter((d) => d.sessionId && !live.has(d.sessionId)).map((d) => d.token);
    if (ended.length) {
      await this.ctx.db.delete(schema.pushDevices).where(inArray(schema.pushDevices.token, ended));
    }
    return devices
      .filter((d) => !d.sessionId || live.has(d.sessionId))
      .map((d) => ({ ...d, userId: d.sessionId ? people.get(d.sessionId)! : OWNER_ID }));
  }

  private async credentials(): Promise<ApnsCredentials | null> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, KEY)).limit(1);
    if (!row) return null;
    try {
      return JSON.parse(this.vault.open(String(row.value))) as ApnsCredentials;
    } catch {
      // A data folder restored without its vault key.
      return null;
    }
  }

  /**
   * One notification to one device. A build run from Xcode gets its token from Apple's test
   * service, an installed one from the real one; which a device uses is learnt from the answer.
   */
  private async send(
    d: typeof schema.pushDevices.$inferSelect,
    alert: ApnsAlert,
  ): Promise<'sent' | 'gone' | 'refused' | 'unconfigured'> {
    const creds = await this.credentials();
    if (!creds) return 'unconfigured';
    if (!this.token || JSON.stringify(this.token.creds) !== JSON.stringify(creds)) {
      this.token = { creds, signer: new ApnsToken(creds) };
    }
    const tries = d.sandbox === null ? [false, true] : [d.sandbox];
    for (const sandbox of tries) {
      const req = alertRequest(d.token, sandbox, this.token.signer.get(), creds.bundleId, alert);
      let res;
      try {
        res = await this.transport(req);
      } catch (err) {
        console.warn('push send', err);
        return 'refused';
      }
      if (res.status === 200) {
        if (d.sandbox !== sandbox) {
          await this.ctx.db
            .update(schema.pushDevices)
            .set({ sandbox })
            .where(eq(schema.pushDevices.token, d.token));
        }
        return 'sent';
      }
      // The app was removed from the phone, or the token belongs to the other service.
      if (res.status === 410 || (res.reason === 'BadDeviceToken' && tries.length === 1)) {
        await this.unregister(d.token);
        return 'gone';
      }
      if (res.reason === 'BadDeviceToken') continue;
      console.warn('push refused', res.status, res.reason);
      return 'refused';
    }
    await this.unregister(d.token);
    return 'gone';
  }
}
