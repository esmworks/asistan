import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiFor, type Api } from './api';

const KEY = 'yumakbot.server';

interface ServerState {
  /** False until the saved address has been read. */
  ready: boolean;
  /** The chosen server's origin, such as `http://192.168.1.20:4319`; null before one is chosen. */
  origin: string | null;
  setOrigin: (origin: string) => Promise<void>;
}

const ServerContext = createContext<ServerState | null>(null);

/** Keeps the chosen server address on the phone so the app opens straight to it next time. */
export function ServerProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [origin, setOriginState] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((saved) => setOriginState(saved))
      // Unreadable storage only means the address is asked for again.
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  const setOrigin = useCallback(async (next: string) => {
    setOriginState(next);
    try {
      await AsyncStorage.setItem(KEY, next);
    } catch {
      // Not kept: the address is asked for again next launch.
    }
  }, []);

  const value = useMemo(() => ({ ready, origin, setOrigin }), [ready, origin, setOrigin]);
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerState {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer outside ServerProvider');
  return ctx;
}

/** The endpoints of the chosen server. Screens that call it are only reached once one is chosen. */
export function useApi(): Api {
  const { origin } = useServer();
  if (!origin) throw new Error('useApi before a server is chosen');
  return useMemo(() => apiFor(origin), [origin]);
}
