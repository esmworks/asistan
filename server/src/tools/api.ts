import { ApiAuth, ApiCredentialName, ApiOrigin, type ApiSource, type Bot } from '@yumakbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { ApiCallError } from '../services/api-credentials';
import type { TurnRow } from '../runtime/turns';
import { askPerson, type Define } from './index';

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Tools for calling a service with an API key the person saved. The bot asks for a key on a
 * protected card that shows where the key will go; afterwards it names the key in a request and
 * the server adds the key itself. The value never reaches the bot, its prompt or a message.
 */
export function apiTools(opts: {
  def: Define;
  services: Services;
  bot: Bot;
  /** OpenAPI documents the bot may call; with any, it gets the tools for their operations. */
  sources?: ApiSource[];
  thread: { id: string };
  turn: TurnRow;
  signal: AbortSignal;
  /** How long a card waits when nobody may be watching (a routine's turn); undefined waits on. */
  unattended?: number;
  t: T;
}): AppTool[] {
  const { def, services: s, bot, thread, turn, signal, unattended, t } = opts;
  const sources = opts.sources ?? [];
  const describe = (auth: ApiAuth) =>
    auth.type === 'header'
      ? t('tool.apiAuth.header', { header: auth.header })
      : auth.type === 'query'
        ? t('tool.apiAuth.query', { param: auth.param })
        : t(`tool.apiAuth.${auth.type}`);
  return [
    def(
      'api_keys_list',
      {},
      async () => {
        const keys = await s.apiCredentials.forBot(bot.id);
        if (!keys.length) return t('tool.apiKeysNone');
        return keys
          .map((k) => `- ${k.name}: ${k.origin} (${describe(k.auth)})${k.label ? ` — ${k.label}` : ''}`)
          .join('\n');
      },
      'read',
    ),
    def(
      'credential_request',
      {
        key: z.string().max(64),
        origin: z.string().max(500),
        auth: ApiAuth.optional(),
        label: z.string().trim().min(1).max(200),
        why: z.string().max(500).optional(),
      },
      async ({ key, origin, auth, label, why }) => {
        const name = ApiCredentialName.safeParse(key);
        if (!name.success) return t('tool.credentialBadName');
        const where = ApiOrigin.safeParse(origin);
        if (!where.success) return t('tool.credentialBadOrigin');
        const mine = await s.apiCredentials.forBot(bot.id);
        const existing = (await s.apiCredentials.list()).find((k) => k.name === name.data);
        // A key under that name another bot keeps to itself: this bot cannot replace it.
        if (existing && !mine.some((k) => k.id === existing.id))
          return t('tool.credentialTaken', { key: name.data });
        const how = auth ?? { type: 'bearer' as const };
        const r = await askPerson(s, {
          bot,
          thread,
          turn,
          signal,
          timeoutMs: unattended,
          title: t('tool.credentialTitle', { bot: bot.name, label }),
          items: [
            {
              question: t('tool.credentialQuestion', { label }),
              context: [t('tool.credentialWhere', { origin: where.data, how: describe(how) }), why]
                .filter(Boolean)
                .join(' '),
              options: [],
              secret: true,
            },
          ],
        });
        if (r.timedOut) return t('tool.questionTimedOut');
        if (r.status === 'expired') return t('tool.questionExpired');
        const value = r.answers[0]?.trim();
        if (r.status !== 'allowed' || !value) return t('tool.credentialSkipped');
        await s.apiCredentials.put({
          name: name.data,
          origin: where.data,
          auth: how,
          label,
          value,
          // A new key is this bot's alone until the person opens it to others in the vault.
          ...(existing ? {} : { botIds: [bot.id] }),
        });
        return t('tool.credentialSaved', { key: name.data, origin: where.data });
      },
      'internal',
    ),
    def(
      'api_request',
      {
        key: z.string().max(64),
        method: z
          .string()
          .transform((m) => m.toUpperCase())
          .pipe(z.enum(METHODS))
          .default('GET'),
        url: z.string().min(1).max(4000),
        headers: z.record(z.string(), z.string().max(4000)).optional(),
        body: z.unknown().optional(),
      },
      async ({ key, method, url, headers, body }) => {
        try {
          const res = await s.apiCredentials.call(bot.id, key, { method, url, headers, body }, signal);
          const head = [
            `HTTP ${res.status}${res.type ? ` · ${res.type}` : ''}`,
            res.location && t('tool.apiRedirect', { location: res.location }),
          ]
            .filter(Boolean)
            .join('\n');
          return [head, res.body, res.cut && t('tool.apiCut')].filter(Boolean).join('\n\n');
        } catch (err) {
          if (!(err instanceof ApiCallError)) throw err;
          return t(`tool.apiRefused.${err.reason}`, { detail: err.detail });
        }
      },
      'read',
      // Reading is free like any other read of a service the person gave a key for; anything that
      // changes something there goes by the bot's approval level.
      async ({ method }) => method !== 'GET' && method !== 'HEAD',
    ),
    ...(sources.length
      ? [
          def(
            'api_operations',
            { api: z.string().max(64).optional(), query: z.string().max(200).optional() },
            async ({ api, query }) => {
              if (!api) {
                return sources
                  .map(
                    (x) =>
                      `- ${x.name}: ${x.title || x.baseUrl} (${t('tool.apiOperationCount', { count: x.operations })})`,
                  )
                  .join('\n');
              }
              const ops = await s.apiSources.operations(bot.id, api, query);
              if (!ops)
                return t('tool.apiSourceMissing', { api, names: sources.map((x) => x.name).join(', ') });
              if (!ops.length) return t('tool.apiOperationsNone');
              const shown = ops.slice(0, 60).map((o) => {
                const params = o.params
                  .map((p) => `${p.name}${p.required ? '*' : ''} (${p.in}, ${p.type})`)
                  .join(', ');
                return [
                  `- ${o.id}: ${o.method} ${o.path}${o.summary ? ` — ${o.summary}` : ''}`,
                  params && `  ${t('tool.apiParams')}: ${params}`,
                  o.body && `  body: ${o.body}`,
                ]
                  .filter(Boolean)
                  .join('\n');
              });
              return [...shown, ops.length > 60 && t('tool.apiOperationsMore', { count: ops.length - 60 })]
                .filter(Boolean)
                .join('\n');
            },
            'read',
          ),
          def(
            'api_call',
            {
              api: z.string().max(64),
              operation: z.string().max(120),
              params: z.record(z.string(), z.unknown()).optional(),
              body: z.unknown().optional(),
            },
            async ({ api, operation, params, body }) => {
              try {
                const res = await s.apiSources.call(bot.id, api, operation, { params, body }, signal);
                const head = [
                  `HTTP ${res.status}${res.type ? ` · ${res.type}` : ''}`,
                  res.location && t('tool.apiRedirect', { location: res.location }),
                ]
                  .filter(Boolean)
                  .join('\n');
                return [head, res.body, res.cut && t('tool.apiCut')].filter(Boolean).join('\n\n');
              } catch (err) {
                if (!(err instanceof ApiCallError)) throw err;
                return t(`tool.apiRefused.${err.reason}`, { detail: err.detail });
              }
            },
            'read',
            // Reading is free; an operation that changes something goes by the bot's approval level.
            async ({ api, operation }) => {
              const ops = await s.apiSources.operations(bot.id, api);
              const op = ops?.find((o) => o.id === operation);
              return !op || (op.method !== 'GET' && op.method !== 'HEAD');
            },
          ),
        ]
      : []),
  ];
}
