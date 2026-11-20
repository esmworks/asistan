import { getDomain, getDomainWithoutSuffix } from 'tldts';
import { hkdfSync, randomBytes } from 'node:crypto';
import { openWith, sealWith } from '../crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  VaultImport,
  VaultImportResult,
  VaultImportSkip,
  VaultLogin,
  VaultLoginCreate,
  VaultLoginUpdate,
} from '@yumakbot/shared';
import {
  VaultImport as ImportSchema,
  VaultLoginCreate as CreateSchema,
  VaultLoginUpdate as UpdateSchema,
} from '@yumakbot/shared';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { totpSecret } from '../totp';
import { importedTotp, loginsFromCsv } from './vault-import';
import { HttpError, isUniqueViolation, newId, notFound } from '../util';

type Row = typeof schema.vaultLogins.$inferSelect;

/**
 * What a sign-in's sealed values are bound to: the row and the site. A password moved to another
 * row, or left in a row whose site was changed in the database, no longer opens, so it is never
 * typed into a site it was not saved for.
 */
const passwordBinding = (id: string, site: string) => ['vault_logins.secret', id, site];
const totpBinding = (id: string, site: string) => ['vault_logins.totp', id, site];

/** The bytes a secret is bound to: unambiguous, whatever the parts hold. */
const bindingData = (bind: readonly string[]) => Buffer.from(JSON.stringify(bind), 'utf8');

/**
 * Lists, in the data folder, the tables whose secrets were all sealed bound to their rows. Once a
 * table is listed, an unbound (`v1:`) value found in it is not opened: it can only have been put
 * there from elsewhere, as an unbound secret copied from another place. It lives beside the vault
 * key, out of reach of whoever can only write to the database. A restore removes it, since the
 * restored rows may be older than the binding.
 */
export const BOUND_FILE = 'vault.bound';

/** A sign-in with its password, for the server to type into a site. Never handed to a bot. */
export interface Credential {
  id: string;
  site: string;
  username: string;
  password: string;
  /** The authenticator secret, when the sign-in keeps one. */
  totp: string | null;
}

/** The ids of the sign-ins a password manager gives start with this, so they are never taken for the vault's. */
export const MANAGER_ID_PREFIX = 'pm:';

/** Sign-ins kept somewhere other than the vault (a password manager), offered after its own. */
export interface OtherLogins {
  forHost(host: string, botId: string | undefined, userId: string | null): Promise<Credential[]>;
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

/** The sign-ins a person may use: the team's and their own; with null (a team conversation), the team's. */
const usableBy = (userId: string | null) =>
  userId
    ? or(isNull(schema.vaultLogins.userId), eq(schema.vaultLogins.userId, userId))!
    : isNull(schema.vaultLogins.userId);

const toLogin = (r: Row): VaultLogin => ({
  id: r.id,
  site: r.site,
  username: r.username,
  hasTotp: !!r.totp,
  botIds: r.botIds ?? null,
  userId: r.userId,
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
  private upgrades = new Map<string, Promise<void>>();
  private others: OtherLogins | null = null;

  constructor(private ctx: Ctx) {}

  /** Where sign-ins the vault does not keep itself are found: the password managers. */
  useOthers(others: OtherLogins) {
    this.others = others;
  }

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

  /**
   * Encrypts a secret with the vault key; also used for the Claude token and API key. With `bind`,
   * the secret is bound to it (`v2:`) and opens only with the same `bind`: a secret kept beside
   * fields that say where it may go (a site, an address) is bound to them and to its row.
   */
  seal(plain: string, bind?: readonly string[]): string {
    if (bind) return `v2:${sealWith(this.cipherKey(), plain, bindingData(bind))}`;
    return `v1:${sealWith(this.cipherKey(), plain)}`;
  }

  /** A sealed secret's text; a bound one needs the `bind` it was sealed with, an unbound one none. */
  open(sealed: string, bind?: readonly string[]): string {
    if (bind) {
      if (!sealed.startsWith('v2:')) throw new Error('Unknown vault format');
      return openWith(this.cipherKey(), sealed.slice(3), bindingData(bind));
    }
    if (!sealed.startsWith('v1:')) throw new Error('Unknown vault format');
    return openWith(this.cipherKey(), sealed.slice(3));
  }

  /**
   * Runs `upgrade` once for `table`: the step that binds the secrets saved before they were bound.
   * It runs before the table's secrets are first used in this process, and never again once the
   * data folder lists the table as done (see BOUND_FILE). A failed run is tried again next time.
   */
  bindOnce(table: string, upgrade: () => Promise<void>): Promise<void> {
    let run = this.upgrades.get(table);
    if (!run) {
      run = (async () => {
        if (this.boundTables().includes(table)) return;
        await upgrade();
        this.markBound(table);
      })();
      this.upgrades.set(table, run);
      run.catch(() => this.upgrades.delete(table));
    }
    return run;
  }

  private boundTables(): string[] {
    try {
      const list = JSON.parse(readFileSync(join(this.ctx.config.dataDir, BOUND_FILE), 'utf8')) as unknown;
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private markBound(table: string) {
    const file = join(this.ctx.config.dataDir, BOUND_FILE);
    const list = [...new Set([...this.boundTables(), table])];
    mkdirSync(this.ctx.config.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(list), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /**
   * An unbound secret saved before secrets were bound, sealed again bound to `bind`; null when it
   * is not one or cannot be opened (sealed with a vault key that is gone), so it is left as it is.
   */
  rebind(sealed: string, bind: readonly string[]): string | null {
    if (!sealed.startsWith('v1:')) return null;
    try {
      return this.seal(this.open(sealed), bind);
    } catch {
      return null;
    }
  }

  /** A bound secret sealed again for a new binding; left as it is when it does not open. */
  reseal(sealed: string, from: readonly string[], to: readonly string[]): string {
    try {
      return this.seal(this.open(sealed, from), to);
    } catch {
      return sealed;
    }
  }

  /** Sign-ins saved before their secrets were bound to row and site, bound now. */
  private ready(): Promise<void> {
    return this.bindOnce('vault_logins', async () => {
      const rows = await this.ctx.db.select().from(schema.vaultLogins);
      for (const r of rows) {
        const secret = this.rebind(r.secret, passwordBinding(r.id, r.site));
        const totp = r.totp ? this.rebind(r.totp, totpBinding(r.id, r.site)) : null;
        if (!secret && !totp) continue;
        await this.ctx.db
          .update(schema.vaultLogins)
          .set({ ...(secret && { secret }), ...(totp && { totp }) })
          .where(eq(schema.vaultLogins.id, r.id));
      }
    });
  }

  /** Every sign-in; with `userId`, the team's and that person's own. */
  async list(userId?: string): Promise<VaultLogin[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.vaultLogins)
      .where(userId ? usableBy(userId) : undefined)
      .orderBy(asc(schema.vaultLogins.site), asc(schema.vaultLogins.username));
    return rows.map(toLogin);
  }

  async get(id: string): Promise<VaultLogin> {
    return toLogin(await this.row(id));
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

  /** A typed authenticator setup, sealed; empty clears it; a 400 when it is not one. */
  private sealTotp(raw: string | undefined, id: string, site: string): string | null | undefined {
    if (raw === undefined) return undefined;
    if (!raw) return null;
    const secret = totpSecret(raw);
    if (!secret) throw new HttpError(400, 'error.totpInvalid');
    return this.seal(secret, totpBinding(id, site));
  }

  /**
   * Saves a sign-in, `userId`'s own or the team's when null; the same site and username of the
   * same owner replaces the old password.
   */
  async save(input: VaultLoginCreate, userId: string | null): Promise<VaultLogin> {
    const v = CreateSchema.parse(input);
    await this.ready();
    const [existing] = await this.ctx.db
      .select()
      .from(schema.vaultLogins)
      .where(
        and(
          eq(schema.vaultLogins.site, v.site),
          eq(schema.vaultLogins.username, v.username),
          userId ? eq(schema.vaultLogins.userId, userId) : isNull(schema.vaultLogins.userId),
        ),
      )
      .limit(1);
    const id = existing?.id ?? newId();
    const secret = this.seal(v.password, passwordBinding(id, v.site));
    const totp = this.sealTotp(v.totp, id, v.site);
    const access = v.botIds === undefined ? {} : { botIds: v.botIds };
    const [row] = existing
      ? await this.ctx.db
          .update(schema.vaultLogins)
          .set({ secret, ...(totp !== undefined && { totp }), ...access, updatedAt: new Date() })
          .where(eq(schema.vaultLogins.id, existing.id))
          .returning()
      : await this.ctx.db
          .insert(schema.vaultLogins)
          .values({ id, userId, site: v.site, username: v.username, secret, totp: totp ?? null, ...access })
          .returning();
    this.ctx.bus.refresh({ scope: 'vault' });
    return toLogin(row!);
  }

  /** Changes a sign-in; `owner` moves it to that person, or to the team when null. */
  async update(id: string, input: VaultLoginUpdate, owner?: string | null): Promise<VaultLogin> {
    const v = UpdateSchema.parse(input);
    await this.ready();
    const old = await this.row(id);
    const site = v.site ?? old.site;
    // A new site needs the secrets bound to it: the ones not typed anew are sealed again for it.
    const moved = site !== old.site;
    const secret =
      v.password !== undefined
        ? this.seal(v.password, passwordBinding(id, site))
        : moved
          ? this.reseal(old.secret, passwordBinding(id, old.site), passwordBinding(id, site))
          : undefined;
    const totp =
      v.totp !== undefined
        ? this.sealTotp(v.totp, id, site)
        : moved && old.totp
          ? this.reseal(old.totp, totpBinding(id, old.site), totpBinding(id, site))
          : undefined;
    try {
      const [row] = await this.ctx.db
        .update(schema.vaultLogins)
        .set({
          ...(v.site !== undefined && { site: v.site }),
          ...(v.username !== undefined && { username: v.username }),
          ...(secret !== undefined && { secret }),
          ...(totp !== undefined && { totp }),
          ...(v.botIds !== undefined && { botIds: v.botIds }),
          ...(owner !== undefined && { userId: owner }),
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

  /**
   * Sign-ins from a file a browser or a password manager exported, for `userId` or the team when
   * null. Each is saved under its site's registrable domain, as a sign-in typed on a card is. Only
   * https sign-ins with a password are taken; one the vault already has for the same owner, site
   * and username stays as it is. Without `apply` nothing is saved.
   */
  async importCsv(raw: VaultImport, userId: string | null): Promise<VaultImportResult> {
    const input = ImportSchema.parse(raw);
    const read = loginsFromCsv(input.csv);
    if (read.unknown) throw new HttpError(400, 'error.vaultImportUnknown');
    if (read.tooMany) throw new HttpError(400, 'error.vaultImportTooMany');
    const skipped: VaultImportSkip[] = [...read.skipped];
    const have = new Set(
      (
        await this.ctx.db
          .select({ site: schema.vaultLogins.site, username: schema.vaultLogins.username })
          .from(schema.vaultLogins)
          .where(userId ? eq(schema.vaultLogins.userId, userId) : isNull(schema.vaultLogins.userId))
      ).map((r) => `${r.site}\n${r.username}`),
    );
    const seen = new Set<string>();
    const add: (VaultImportResult['add'][number] & { password: string; totp: string | null })[] = [];
    let totpDropped = 0;
    for (const l of read.logins) {
      let url: URL | null = null;
      try {
        url = new URL(l.url.includes('://') ? l.url : `https://${l.url}`);
      } catch {
        url = null;
      }
      const host = url && /^https?:$/.test(url.protocol) ? url.hostname : '';
      const site = host ? registrableSite(host) : '';
      const skip = (reason: VaultImportSkip['reason']) =>
        skipped.push({ line: l.line, site: site || l.url, username: l.username, reason });
      if (!site || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) skip('noSite');
      else if (url!.protocol !== 'https:') skip('notHttps');
      else if (l.username.length > 500 || l.password.length > 500) skip('tooLong');
      else if (seen.has(`${site}\n${l.username}`)) skip('duplicate');
      else if (have.has(`${site}\n${l.username}`)) skip('exists');
      else {
        seen.add(`${site}\n${l.username}`);
        const totp = importedTotp(l.totp);
        if (l.totp && !totp) totpDropped++;
        add.push({ line: l.line, site, username: l.username, hasTotp: !!totp, password: l.password, totp });
      }
    }
    skipped.sort((a, b) => a.line - b.line);
    let saved = 0;
    if (input.apply) {
      await this.ready();
      for (const a of add) {
        const id = newId();
        await this.ctx.db
          .insert(schema.vaultLogins)
          .values({
            id,
            userId,
            site: a.site,
            username: a.username,
            secret: this.seal(a.password, passwordBinding(id, a.site)),
            totp: a.totp ? this.seal(a.totp, totpBinding(id, a.site)) : null,
            botIds: input.botIds ?? null,
          })
          .onConflictDoNothing();
        saved++;
      }
      if (saved) this.ctx.bus.refresh({ scope: 'vault' });
    }
    return {
      add: add.map(({ line, site, username, hasTotp }) => ({ line, site, username, hasTotp })),
      skipped,
      totpDropped,
      saved,
    };
  }

  async remove(id: string) {
    await this.ctx.db.delete(schema.vaultLogins).where(eq(schema.vaultLogins.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }

  /**
   * Sign-ins for a page's host that the bot may use while it works for `userId`, with their
   * passwords. Server-side only. A sign-in kept for some bots stays out of reach of the others,
   * and a person's own is typed only for them.
   */
  async forHost(host: string, botId: string | undefined, userId: string | null): Promise<Credential[]> {
    await this.ready();
    const rows = await this.ctx.db.select().from(schema.vaultLogins).where(usableBy(userId));
    const own = rows
      .filter((r) => siteMatches(host, r.site))
      .filter((r) => !r.botIds || (botId !== undefined && r.botIds.includes(botId)))
      .sort((a, b) => b.site.length - a.site.length || a.username.localeCompare(b.username))
      .flatMap((r): Credential[] => {
        // A secret that does not open for its row and site was moved there, or its site was
        // changed: it is left out, never typed in.
        try {
          return [
            {
              id: r.id,
              site: r.site,
              username: r.username,
              password: this.open(r.secret, passwordBinding(r.id, r.site)),
              totp: r.totp ? this.open(r.totp, totpBinding(r.id, r.site)) : null,
            },
          ];
        } catch {
          return [];
        }
      });
    if (!this.others) return own;
    // The vault's own sign-in for a username wins over a manager's for the same one.
    const taken = new Set(own.map((c) => c.username));
    const others = (await this.others.forHost(host, botId, userId).catch(() => [])).filter((c) => {
      if (taken.has(c.username)) return false;
      taken.add(c.username);
      return true;
    });
    return [...own, ...others];
  }

  /**
   * Why `forHost` found nothing, as far as the bot may be told without handing it anything of the
   * vault: how many of the person's own logins for this site are kept for other bots only (a count,
   * never a name), and the sites this bot may use that carry the same name under another ending
   * (a page at example.org when the login is for example.com). Sites with nothing to do with the
   * page are never named, so a page cannot make the bot list the vault. Another person's logins
   * and the team's are not counted.
   */
  async whyNone(
    host: string,
    botId: string | undefined,
    userId: string | null,
  ): Promise<{ notShared: number; otherSites: string[] }> {
    await this.ready();
    const rows = await this.ctx.db.select().from(schema.vaultLogins).where(usableBy(userId));
    const mayUse = (r: Row) => !r.botIds || (botId !== undefined && r.botIds.includes(botId));
    const notShared = rows.filter(
      (r) => userId !== null && r.userId === userId && siteMatches(host, r.site) && !mayUse(r),
    ).length;
    const name = getDomainWithoutSuffix(siteOf(host), { allowPrivateDomains: true });
    const otherSites = name
      ? [
          ...new Set(
            rows
              .filter(
                (r) =>
                  mayUse(r) &&
                  !siteMatches(host, r.site) &&
                  getDomainWithoutSuffix(r.site, { allowPrivateDomains: true }) === name,
              )
              .map((r) => r.site),
          ),
        ].slice(0, 3)
      : [];
    return { notShared, otherSites };
  }

  async used(id: string) {
    // A password manager's sign-in has no row here to mark.
    if (id.startsWith(MANAGER_ID_PREFIX)) return;
    await this.ctx.db
      .update(schema.vaultLogins)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.vaultLogins.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }
}
