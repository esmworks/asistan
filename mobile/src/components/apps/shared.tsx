import { addressKey, catalogEntry, type Bot, type Connection } from '@yumakbot/shared';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { openBrowserAsync } from 'expo-web-browser';
import { StyleSheet, Text, View } from 'react-native';
import { t, type MessageKey } from '@/i18n';
import { toastError } from '@/components/overlay';
import { ordered } from '@/lib/bots';
import { useBots } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

export const STATUS_KEY: Record<Connection['status'], MessageKey> = {
  connected: 'apps.status.connected',
  'signed-out': 'apps.status.signedOut',
  error: 'apps.status.error',
};

/** One service as the list shows it: a catalog service with all its accounts, or one other server. */
export interface Service {
  key: string;
  logo: string | null;
  name: string;
  accounts: Connection[];
}

/** The accounts of a catalog service at the same address are one service; other servers stand alone. */
export function servicesOf(connections: Connection[]): Service[] {
  const out = new Map<string, Service>();
  for (const c of connections) {
    const entry = catalogEntry(c.catalogId);
    const key = entry ? `${entry.id} ${addressKey(c.url)}` : c.id;
    const s = out.get(key);
    if (s) s.accounts.push(c);
    else out.set(key, { key, logo: c.catalogId, name: entry?.name ?? c.name, accounts: [c] });
  }
  return [...out.values()];
}

/** How a service's row reads: its accounts when more than one, else the one account's status. */
export function serviceStatus(accounts: Connection[]) {
  const first = accounts[0];
  return {
    sub:
      accounts.length > 1
        ? t('apps.accountCount', { count: accounts.length })
        : first
          ? t(STATUS_KEY[first.status])
          : '',
    tone: accounts.every((a) => a.status === 'connected') ? ('ok' as const) : ('warn' as const),
  };
}

/** Whether a bot may use a connection's tools. */
export function openTo(c: Connection, botId: string) {
  return c.allBots || c.botIds.includes(botId);
}

/** The bot ids a connection has now, with every active bot counted when it is open to all. */
function currentBots(c: Connection, bots: Bot[]) {
  return c.allBots ? ordered(bots).map((b) => b.id) : c.botIds;
}

/** The bot ids after one bot is turned on or off; narrowing starts from every bot. */
export function withBot(c: Connection, bots: Bot[], botId: string, on: boolean) {
  const current = currentBots(c, bots);
  return on ? [...new Set([...current, botId])] : current.filter((b) => b !== botId);
}

/** Changes which bots may use a connection. */
export function useConnectionBots() {
  const qc = useQueryClient();
  const api = useApi();
  const { origin } = useServer();
  return useMutation({
    mutationFn: ({ c, allBots, botIds = [] }: { c: Connection; allBots: boolean; botIds?: string[] }) =>
      api.setConnectionBots(c.id, { allBots, botIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections', origin] }),
    onError: toastError,
  });
}

/** Turns a connection on for one bot, or off. */
export function useToggleBot() {
  const { data: bots = [] } = useBots();
  const set = useConnectionBots();
  return {
    isPending: set.isPending,
    mutate: ({ c, botId, on }: { c: Connection; botId: string; on: boolean }) =>
      set.mutate({ c, allBots: false, botIds: withBot(c, bots, botId, on) }),
  };
}

/**
 * Opens a service's sign-in page in the in-app browser; when the person closes it, the
 * connection list is read again so the new status shows.
 */
export async function openSignIn(url: string, qc: QueryClient, origin: string | null) {
  try {
    await openBrowserAsync(url);
  } finally {
    await qc.invalidateQueries({ queryKey: ['connections', origin] });
  }
}

/** The service's logo box is AppLogo; this is the status dot and word under a name. */
export function StatusLine({ text, tone }: { text: string; tone?: 'ok' | 'warn' }) {
  const c = useColors();
  const color = tone === 'ok' ? c.success : tone === 'warn' ? c.amber : c.mutedForeground;
  return (
    <View style={styles.line}>
      {tone ? <View style={[styles.dot, { backgroundColor: color }]} /> : null}
      <Text style={[styles.text, { color }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontSize: 13, flexShrink: 1 },
});
