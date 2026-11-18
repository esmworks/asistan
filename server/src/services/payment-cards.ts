import type { PaymentCard, PaymentCardCreate, PaymentCardUpdate } from '@yumakbot/shared';
import {
  cardBrand,
  PaymentCardCreate as CreateSchema,
  PaymentCardUpdate as UpdateSchema,
} from '@yumakbot/shared';
import { asc, eq, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { newId, notFound } from '../util';
import type { VaultService } from './vault';

type Row = typeof schema.paymentCards.$inferSelect;

/** What a card's sealed values are bound to: its row. Moved to another row, they do not open. */
const secretBinding = (id: string) => ['payment_cards.secret', id];
const sitesBinding = (id: string) => ['payment_cards.sites', id];

/** A card's sealed values; the server alone opens them, to fill a checkout page. */
export interface CardSecret {
  number: string;
  cvc: string | null;
  holder: string | null;
}

/** A card as a bot's checkout step needs it: what it may say about it, and its values. */
export interface OpenCard extends CardSecret {
  id: string;
  label: string;
  brand: PaymentCard['brand'];
  last4: string;
  expMonth: number;
  expYear: number;
  sites: string[];
  /** The team's card rather than the person's own. */
  team: boolean;
}

const usableBy = (userId: string) =>
  or(isNull(schema.paymentCards.userId), eq(schema.paymentCards.userId, userId))!;

/**
 * Payment cards, sealed like the vault's passwords. Bots never see a number: they ask the server to
 * fill one into the page, which happens only for the person the card belongs to (or the team's,
 * for anyone in it), in a turn that person started, and on a site they agreed to.
 */
export class PaymentCardService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  private sites(r: Row): string[] {
    if (!r.sites) return [];
    try {
      const list = JSON.parse(this.vault.open(r.sites, sitesBinding(r.id))) as unknown;
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      // Not sealed for this row: no site is taken as agreed to.
      return [];
    }
  }

  /** A card as the app shows it; the sealed values are not opened for that. */
  private toCard(r: Row): PaymentCard {
    return {
      id: r.id,
      label: r.label,
      brand: r.brand as PaymentCard['brand'],
      last4: r.last4,
      expMonth: r.expMonth,
      expYear: r.expYear,
      hasCvc: r.hasCvc,
      sites: this.sites(r),
      botIds: r.botIds ?? null,
      userId: r.userId,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private secret(r: Row): CardSecret {
    return JSON.parse(this.vault.open(r.secret, secretBinding(r.id))) as CardSecret;
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.paymentCards)
      .where(eq(schema.paymentCards.id, id))
      .limit(1);
    if (!row) throw notFound('vault');
    return row;
  }

  /** The team's cards and, with `userId`, that person's own. */
  async list(userId?: string): Promise<PaymentCard[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.paymentCards)
      .where(userId ? usableBy(userId) : undefined)
      .orderBy(asc(schema.paymentCards.createdAt));
    return rows.map((r) => this.toCard(r));
  }

  async get(id: string): Promise<PaymentCard> {
    return this.toCard(await this.row(id));
  }

  async create(raw: PaymentCardCreate, owner: string | null): Promise<PaymentCard> {
    const v = CreateSchema.parse(raw);
    const id = newId();
    const secret: CardSecret = { number: v.number, cvc: v.cvc ?? null, holder: v.holder || null };
    const [row] = await this.ctx.db
      .insert(schema.paymentCards)
      .values({
        id,
        userId: owner,
        label: v.label,
        brand: cardBrand(v.number),
        last4: v.number.slice(-4),
        expMonth: v.expMonth,
        expYear: v.expYear,
        secret: this.vault.seal(JSON.stringify(secret), secretBinding(id)),
        hasCvc: !!secret.cvc,
        botIds: v.botIds ?? null,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'vault' });
    return this.toCard(row!);
  }

  async update(id: string, raw: PaymentCardUpdate, owner?: string | null): Promise<PaymentCard> {
    const v = UpdateSchema.parse(raw);
    const old = await this.row(id);
    const changesSecret = v.cvc !== undefined || v.holder !== undefined;
    const secret = changesSecret
      ? (() => {
          const s = this.secret(old);
          return this.vault.seal(
            JSON.stringify({
              ...s,
              ...(v.cvc !== undefined && { cvc: v.cvc || null }),
              ...(v.holder !== undefined && { holder: v.holder || null }),
            }),
            secretBinding(id),
          );
        })()
      : undefined;
    const sites = v.forgetSites
      ? this.vault.seal(
          JSON.stringify(this.sites(old).filter((x) => !v.forgetSites!.includes(x))),
          sitesBinding(id),
        )
      : undefined;
    const [row] = await this.ctx.db
      .update(schema.paymentCards)
      .set({
        ...(v.label !== undefined && { label: v.label }),
        ...(v.expMonth !== undefined && { expMonth: v.expMonth }),
        ...(v.expYear !== undefined && { expYear: v.expYear }),
        ...(secret !== undefined && { secret }),
        ...(v.cvc !== undefined && { hasCvc: !!v.cvc }),
        ...(sites !== undefined && { sites }),
        ...(v.botIds !== undefined && { botIds: v.botIds }),
        ...(owner !== undefined && { userId: owner }),
        updatedAt: new Date(),
      })
      .where(eq(schema.paymentCards.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'vault' });
    return this.toCard(row!);
  }

  async remove(id: string) {
    await this.ctx.db.delete(schema.paymentCards).where(eq(schema.paymentCards.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }

  /**
   * The cards a bot may fill while it works for `userId`, with their values. Server-side only. A
   * card that does not open for its row is left out.
   */
  async forBot(botId: string, userId: string): Promise<OpenCard[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.paymentCards)
      .where(usableBy(userId))
      .orderBy(asc(schema.paymentCards.createdAt));
    return rows
      .filter((r) => !r.botIds || r.botIds.includes(botId))
      .flatMap((r): OpenCard[] => {
        try {
          return [
            {
              id: r.id,
              label: r.label,
              brand: r.brand as PaymentCard['brand'],
              last4: r.last4,
              expMonth: r.expMonth,
              expYear: r.expYear,
              sites: this.sites(r),
              team: !r.userId,
              ...this.secret(r),
            },
          ];
        } catch {
          return [];
        }
      });
  }

  /** Lets a card be filled on `site` from now on without asking. */
  async allowSite(id: string, site: string) {
    const r = await this.row(id);
    const sites = [...new Set([...this.sites(r), site])].sort();
    await this.ctx.db
      .update(schema.paymentCards)
      .set({ sites: this.vault.seal(JSON.stringify(sites), sitesBinding(id)) })
      .where(eq(schema.paymentCards.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }

  async used(id: string) {
    await this.ctx.db
      .update(schema.paymentCards)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.paymentCards.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }
}
