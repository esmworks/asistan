import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import { translator, type T } from '../i18n';
import {
  DEFAULT_LOCALE,
  EFFORTS,
  isLocale,
  isValidTimeZone,
  LOCALES,
  patchOf,
  PROFILE_FOCUS,
  PROFILE_HELP,
  ROUTINE_GATE_MODES,
  type Locale,
} from '@yumakbot/shared';

/** The most turns the person may let run at the same time. */
export const MAX_TURNS_LIMIT = 10;

export const Settings = z.object({
  userName: z.string().max(80).default(''),
  /** How bots should address the person, e.g. a first name. */
  addressAs: z.string().max(60).default(''),
  occupation: z.string().max(200).default(''),
  focus: z.enum(PROFILE_FOCUS).optional(),
  helpWith: z.array(z.enum(PROFILE_HELP)).max(PROFILE_HELP.length).default([]),
  /** Free text from the person that every bot reads. */
  aboutMe: z.string().max(2000).default(''),
  /** The first-run questions were answered or skipped. */
  onboarded: z.boolean().default(false),
  /** Model for Claude bots that do not name one; empty leaves it to the server's default. */
  defaultModel: z.string().trim().max(100).default(''),
  /** Effort for Claude bots; empty leaves it to the model. */
  effort: z.union([z.enum(EFFORTS), z.literal('')]).default(''),
  /** The engine new bots start with: Claude, or another provider through Pi. */
  defaultEngine: z.enum(['claude', 'pi']).default('claude'),
  /** `provider/model` new Pi bots start with; empty until one is picked. */
  piModel: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(100)
        .regex(/^[a-z0-9._-]+\/\S+$/i),
    ])
    .default(''),
  /**
   * `provider/model` that carries a turn when the usage limit of the bot's own model is spent;
   * empty waits for the limit to lift.
   */
  backupModel: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(100)
        .regex(/^[a-z0-9._-]+\/\S+$/i),
    ])
    .default(''),
  timezone: z.string().refine(isValidTimeZone).default('Europe/Istanbul'),
  /**
   * The most the bots may spend in a calendar month, in US dollars, as the engines report it; 0 for
   * no limit. Turns wait for the next month once it is reached.
   */
  monthlyLimitUsd: z.number().min(0).max(1_000_000).default(0),
  /**
   * The small-model check before a routine run that a watched page or a webhook started: off,
   * watching only (it records what it would do), or on (it skips runs with nothing new).
   */
  routineGate: z.enum(ROUTINE_GATE_MODES).default('off'),
  /**
   * How many turns may run at the same time across every bot; 0 leaves it to the server's
   * `YUMAKBOT_MAX_TURNS`. Fewer at once spends more slowly; more gets more done together.
   */
  maxTurns: z.number().int().min(0).max(MAX_TURNS_LIMIT).default(0),
  /**
   * The bots' browsers reach the web through the person's own computer while its desktop app is
   * connected, so sites see that connection instead of the server's; otherwise from the server.
   */
  browserViaComputer: z.boolean().default(false),
  /**
   * The domain bots receive mail at (`bots.example.com`), when a relay hands its mail to this
   * server; empty when mail is off.
   */
  emailDomain: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .toLowerCase()
        .max(200)
        .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'validation.domain'),
    ])
    .default(''),
  /** Unset until someone picks one; the app then stores the language it opened in. */
  language: z.enum(LOCALES).optional(),
});
export type Settings = z.infer<typeof Settings>;

/** The language the server writes in: thread lines, bot prompts and tool texts. */
export async function serverLocale(ctx: Ctx): Promise<Locale> {
  const [row] = await ctx.db.select().from(schema.kv).where(eq(schema.kv.key, 'setting.language')).limit(1);
  return isLocale(row?.value) ? row.value : DEFAULT_LOCALE;
}

export async function serverTranslator(ctx: Ctx): Promise<T> {
  return translator(await serverLocale(ctx));
}

export class SettingsService {
  constructor(private ctx: Ctx) {}

  async all(): Promise<Settings> {
    const rows = await this.ctx.db.select().from(schema.kv);
    const obj: Record<string, unknown> = {};
    for (const r of rows) if (r.key.startsWith('setting.')) obj[r.key.slice(8)] = r.value;
    if (Array.isArray(obj.helpWith)) {
      obj.helpWith = obj.helpWith.filter((h) => (PROFILE_HELP as readonly unknown[]).includes(h));
    }
    // A stored value this version does not accept (an option that is no longer offered, a
    // longer text from another version) reads as unset instead of failing every request.
    for (const [key, field] of Object.entries(Settings.shape)) {
      if (key in obj && !(field as z.ZodType).safeParse(obj[key]).success) delete obj[key];
    }
    return Settings.parse(obj);
  }

  async get<K extends keyof Settings>(key: K): Promise<Settings[K] | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.kv)
      .where(eq(schema.kv.key, `setting.${key}`))
      .limit(1);
    return row ? (row.value as Settings[K]) : null;
  }

  locale(): Promise<Locale> {
    return serverLocale(this.ctx);
  }

  translator(): Promise<T> {
    return serverTranslator(this.ctx);
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const valid = patchOf(Settings).parse(patch);
    for (const [k, v] of Object.entries(valid)) {
      if (v === undefined) continue;
      await this.ctx.db
        .insert(schema.kv)
        .values({ key: `setting.${k}`, value: v })
        .onConflictDoUpdate({ target: schema.kv.key, set: { value: v } });
    }
    this.ctx.bus.refresh({ scope: 'info' });
    return this.all();
  }
}
