import { getDomain } from 'tldts';
import { hkdfSync, randomBytes } from 'node:crypto';
import { openWith, sealWith } from '../crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VaultLogin, VaultLoginCreate, VaultLoginUpdate } from '@yumakbot/shared';
import { VaultLoginCreate as CreateSchema, VaultLoginUpdate as UpdateSchema } from '@yumakbot/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { totpSecret } from '../totp';
import { HttpError, isUniqueViolation, newId, notFound } from '../util';

type Row = typeof schema.vaultLogins.$inferSelect;

/** A sign-in with its password, for the server to type into a site. Never handed to a bot. */
export interface Credential {
  id: string;
  site: string;
  username: string;
  password: string;
  /** The authenticator secret, when the sign-in keeps one. */
  totp: string | null;
}

/** `facebook.com` is used on facebook.com and its subdomains (www, m), never on other sites. */
export function siteMatches(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === site || h.endsWith(`.${site}`);
}

/**
 * The site a sign-in made on this host is saved under: its registrable domain, so a login entered
 * on accounts.example.com is found on mail.example.com too. The public suffix list keeps
 * example.co.uk apart from other.co.uk, and someone.github.io apart from other github.io pages.
 * A host without one (an address, localhost) stays as it is.
 */
export function registrableSite(host: string): string {
  const h = siteOf(host);
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

/** The site a page belongs to, as saved in the vault: its host without `www.`. */
export function siteOf(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

const toLogin = (r: Row): VaultLogin => ({
  id: r.id,
  site: r.site,
  username: r.username,
  hasTotp: !!r.totp,
  botIds: r.botIds ?? null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

/**
 * The password vault. Passwords are encrypted (AES-256-GCM) with a key kept in the data folder,
 * so a copy of the database alone does not reveal them. The API lists sign-ins without passwords;
 * only the browser's sign-in step decrypts one, and only for the site it belongs to.
 */
export class VaultService {
  private key: Buffer | null = null;

  constructor(private ctx: Ctx) {}

  private cipherKey(): Buffer {
    if (this.key) return this.key;
    const file = join(this.ctx.config.dataDir, 'vault.key');
    if (!existsSync(file)) {
      mkdirSync(this.ctx.config.dataDir, { recursive: true, mode: 0o700 });
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    }
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`Invalid vault key: ${file}`);
    this.key = key;
    return key;
  }

  /**
   * The key content is sealed with in the database (see db/sealed.ts): derived from the vault key,
   * so it lives in the data folder and never in the database.
   */
  contentKey(): Buffer {
    return Buffer.from(hkdfSync('sha256', this.cipherKey(), Buffer.alloc(0), 'yumakbot content at rest', 32));
  }

  /** Encrypts a secret with the vault key; also used for the Claude token and API key. */
  seal(plain: string): string {
    return `v1:${sealWith(this.cipherKey(), plain)}`;
  }

  open(sealed: string): string {
    if (!sealed.startsWith('v1:')) throw new Error('Unknown vault format');
    return openWith(this.cipherKey(), sealed.slice(3));
  }

  async list(): Promise<VaultLogin[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.vaultLogins)
      .orderBy(asc(schema.vaultLogins.site), asc(schema.vaultLogins.username));
    return rows.map(toLogin);
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.vaultLogins)
      .where(eq(schema.vaultLogins.id, id))
      .limit(1);
    if (!row) throw notFound('vault');
    return row;
  }

  /** Saves a sign-in; the same site and username replaces the old password. */
  /** A typed authenticator setup, sealed; empty clears it; a 400 when it is not one. */
  private sealTotp(raw: string | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    if (!raw) return null;
    const secret = totpSecret(raw);
    if (!secret) throw new HttpError(400, 'error.totpInvalid');
    return this.seal(secret);
  }

  async save(input: VaultLoginCreate): Promise<VaultLogin> {
    const v = CreateSchema.parse(input);
    const secret = this.seal(v.password);
    const totp = this.sealTotp(v.totp);
    const access = v.botIds === undefined ? {} : { botIds: v.botIds };
    const [existing] = await this.ctx.db
      .select()
      .from(schema.vaultLogins)
      .where(and(eq(schema.vaultLogins.site, v.site), eq(schema.vaultLogins.username, v.username)))
      .limit(1);
    const [row] = existing
      ? await this.ctx.db
          .update(schema.vaultLogins)
          .set({ secret, ...(totp !== undefined && { totp }), ...access, updatedAt: new Date() })
          .where(eq(schema.vaultLogins.id, existing.id))
          .returning()
      : await this.ctx.db
          .insert(schema.vaultLogins)
          .values({ id: newId(), site: v.site, username: v.username, secret, totp: totp ?? null, ...access })
          .returning();
    this.ctx.bus.refresh({ scope: 'vault' });
    return toLogin(row!);
  }

  async update(id: string, input: VaultLoginUpdate): Promise<VaultLogin> {
    const v = UpdateSchema.parse(input);
    await this.row(id);
    try {
      const [row] = await this.ctx.db
        .update(schema.vaultLogins)
        .set({
          ...(v.site !== undefined && { site: v.site }),
          ...(v.username !== undefined && { username: v.username }),
          ...(v.password !== undefined && { secret: this.seal(v.password) }),
          ...(v.totp !== undefined && { totp: this.sealTotp(v.totp) }),
          ...(v.botIds !== undefined && { botIds: v.botIds }),
          updatedAt: new Date(),
        })
        .where(eq(schema.vaultLogins.id, id))
        .returning();
      this.ctx.bus.refresh({ scope: 'vault' });
      return toLogin(row!);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.vaultDuplicate');
      throw err;
    }
  }

  async remove(id: string) {
    await this.ctx.db.delete(schema.vaultLogins).where(eq(schema.vaultLogins.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }

  /**
   * Sign-ins for a page's host that the bot may use, with their passwords. Server-side only. A
   * sign-in kept for some bots stays out of reach of the others.
   */
  async forHost(host: string, botId?: string): Promise<Credential[]> {
    const rows = await this.ctx.db.select().from(schema.vaultLogins);
    return rows
      .filter((r) => siteMatches(host, r.site))
      .filter((r) => !r.botIds || (botId !== undefined && r.botIds.includes(botId)))
      .sort((a, b) => b.site.length - a.site.length || a.username.localeCompare(b.username))
      .map((r) => ({
        id: r.id,
        site: r.site,
        username: r.username,
        password: this.open(r.secret),
        totp: r.totp ? this.open(r.totp) : null,
      }));
  }

  async used(id: string) {
    await this.ctx.db
      .update(schema.vaultLogins)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.vaultLogins.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }
}
