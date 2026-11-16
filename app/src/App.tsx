import { isLocale } from '@yumakbot/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { ShapeArt } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { CreateAccount } from '@/features/AccountSetup';
import { BotDialog } from '@/features/BotDialog';
import { AppsDialog } from '@/features/Connections';
import { ComputerDialog } from '@/features/Computer';
import { FilePreview } from '@/features/FilePreview';
import { Chat } from '@/features/Chat';
import { RoomDialog, RoomView } from '@/features/Rooms';
import { Login } from '@/features/Login';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { RightPanel } from '@/features/RightPanel';
import { SearchDialog } from '@/features/SearchDialog';
import { SettingsDialog } from '@/features/SettingsDialog';
import { ShortcutsDialog } from '@/features/ShortcutsDialog';
import { TodayDialog } from '@/features/TodayDialog';
import { OpenedRoutineDialog } from '@/features/RoutineDialog';
import { Sidebar } from '@/features/Sidebar';
import { useLocale, useT } from '@/i18n';
import { api, setUnauthorizedHandler } from '@/lib/api';
import { takeLinkedThread } from '@/lib/threadLink';
import { desktop } from '@/lib/desktop';
import { useLayout } from '@/lib/layout';
import { useBots, useRooms, useSettings } from '@/lib/queries';
import { connectRealtime } from '@/lib/realtime';
import { PANEL_WIDTH, useUi } from '@/lib/store';
import { useUnreadTracking } from '@/lib/unread';
import { useChatWidth, useFont } from '@/lib/density';
import { cn } from '@/lib/utils';

// The chosen chat width applies from the first paint.
useChatWidth.getState();
useFont.getState();

export function App() {
  const authed = useUi((s) => s.authed);
  const setAuthed = useUi((s) => s.setAuthed);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    const check = async () => {
      if ((await api.session()).authenticated) return true;
      // In the desktop app the shell holds the key; log in without asking.
      const key = await desktop?.accessKey();
      if (!key) return false;
      await api.access(key);
      return true;
    };
    check()
      .then(setAuthed)
      .catch(() => setAuthed(false));
  }, [setAuthed]);

  return (
    <>
      {authed === null ? <Loading /> : authed ? <Authed /> : <Login />}
      <Toaster position="bottom-center" />
    </>
  );
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * The first-run questions on a server that has no bots and says they were never answered;
 * otherwise the workspace. Decided once, so bots made during the questions do not cut them off.
 * A server older than the questions sends no `onboarded` and goes straight to the workspace.
 */
function Authed() {
  const qc = useQueryClient();
  const settings = useSettings();
  const bots = useBots();
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  // In a browser, a server without an account asks for one right after the key: from then on the
  // username and password sign in. The desktop app signs in by itself and does not ask.
  const account = useQuery({ queryKey: ['account'], queryFn: api.account, enabled: !desktop, retry: false });
  const [accountDone, setAccountDone] = useState(false);
  useLocaleSync();
  if (!desktop && !accountDone) {
    if (account.isPending) return <Loading />;
    if (account.data?.username === null) return <CreateAccount onDone={() => setAccountDone(true)} />;
  }
  if (onboarding === null) {
    const first =
      settings.isError || bots.isError
        ? false
        : settings.data && bots.data
          ? settings.data.onboarded === false && bots.data.length === 0
          : null;
    // Adjusting state while rendering: the choice is kept from the first answer on.
    if (first !== null) setOnboarding(first);
  }
  if (onboarding === null) return <Loading />;
  if (onboarding)
    return (
      <Onboarding
        onDone={() => {
          void Promise.all([
            qc.invalidateQueries({ queryKey: ['settings'] }),
            qc.invalidateQueries({ queryKey: ['bots'] }),
          ]).then(() => setOnboarding(false));
        }}
      />
    );
  return <Workspace />;
}

/**
 * Keeps the app's language and the server's `language` setting the same. The server's choice
 * wins, so every browser shows the same language; a server without one takes the app's, as
 * does a choice made on the login page before the setting could be saved.
 */
function useLocaleSync() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const server = settings ? (settings.language ?? null) : undefined;
  useEffect(() => {
    if (server === undefined) return;
    const { locale, unsaved, setLocale } = useLocale.getState();
    if (isLocale(server) && !unsaved) {
      if (server !== locale) setLocale(server);
      return;
    }
    if (server === locale) {
      if (unsaved) useLocale.setState({ unsaved: false });
      return;
    }
    void api.updateSettings({ language: locale }).then(() => {
      useLocale.setState({ unsaved: false });
      return qc.invalidateQueries({ queryKey: ['settings'] });
    });
  }, [server, qc]);
}

function Workspace() {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots, isLoading } = useBots();
  const botId = useUi((s) => s.botId);
  const selectBot = useUi((s) => s.selectBot);
  const panelOpen = useUi((s) => s.panelOpen);
  const openBotDialog = useUi((s) => s.openBotDialog);
  const panelSheet = useUi((s) => s.panelSheet);
  const togglePanelSheet = useUi((s) => s.togglePanelSheet);
  const phonePane = useUi((s) => s.phonePane);
  const { phone, panelBeside } = useLayout();

  useEffect(() => connectRealtime(qc), [qc]);
  useUnreadTracking();
  // The desktop app's menu bar holds Settings (⌘,) too.
  useEffect(() => desktop?.onOpenSettings?.(() => useUi.getState().openSettings('general', true)), []);

  const bot = bots?.find((b) => b.id === botId);
  useEffect(() => {
    if (bots && !bot && bots[0]) selectBot(bots[0].id);
  }, [bots, bot, selectBot]);
  // A room open in place of the bot's chat, while it still exists.
  const roomId = useUi((s) => s.roomId);
  const { data: rooms, isFetching: roomsFetching } = useRooms();
  const room = roomId ? rooms?.find((r) => r.id === roomId) : undefined;
  useEffect(() => {
    if (roomId && rooms && !roomsFetching && !rooms.some((r) => r.id === roomId))
      useUi.getState().openRoom(null);
  }, [roomId, rooms, roomsFetching]);
  // A link to one conversation (…?thread=<id>) opens it, once the person is signed in.
  useEffect(() => {
    const linked = takeLinkedThread();
    if (!linked) return;
    api
      .thread(linked)
      .then((th) => {
        if (th.kind === 'room') return useUi.getState().openRoom(th.id);
        useUi.getState().openChat(th.botId);
        useUi.getState().selectThread(th.id);
      })
      .catch(() => toast.error(t('chat.linkGone')));
  }, [t]);
  useEffect(() => {
    document.documentElement.style.setProperty('--brand', bot?.color ?? '#4f6bed');
  }, [bot?.color]);

  // A phone shows the list or the chat, never both; the chat needs a bot to show.
  const pane = phone ? (bot || room ? phonePane : 'list') : null;

  return (
    <div className="workspace flex h-full overflow-hidden">
      {pane !== 'chat' && <Sidebar />}
      <main className={cn('safe-pane min-w-0 flex-1 bg-background', pane === 'list' ? 'hidden' : 'flex')}>
        {room ? (
          <RoomView key={room.id} room={room} />
        ) : bot ? (
          <>
            <Chat key={bot.id} bot={bot} />
            {panelBeside ? (
              <AnimatePresence initial={false}>
                {panelOpen && (
                  <motion.div
                    key="panel"
                    initial={{ width: 0, opacity: 0 }}
                    animate={{ width: PANEL_WIDTH, opacity: 1 }}
                    exit={{ width: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <RightPanel bot={bot} beside />
                  </motion.div>
                )}
              </AnimatePresence>
            ) : (
              <Sheet open={panelSheet} onOpenChange={togglePanelSheet}>
                <SheetContent aria-describedby={undefined}>
                  <SheetTitle className="sr-only">{bot.name}</SheetTitle>
                  <RightPanel bot={bot} />
                </SheetContent>
              </Sheet>
            )}
          </>
        ) : (
          !isLoading && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <div className="size-20">
                <ShapeArt shape="cloud" color="var(--brand)" />
              </div>
              <h1 className="text-2xl font-semibold">{t('welcome.title')}</h1>
              <p className="max-w-sm text-sm text-muted-foreground">{t('welcome.body')}</p>
              <Button className="rounded-full" onClick={() => openBotDialog({ mode: 'create' })}>
                <Plus /> {t('welcome.create')}
              </Button>
            </div>
          )
        )}
      </main>
      <BotDialog />
      <RoomDialog />
      <ComputerDialog />
      <FilePreview />
      <SettingsDialog />
      <SearchDialog />
      <ShortcutsDialog />
      <TodayDialog />
      <OpenedRoutineDialog />
      <AppsDialog />
    </div>
  );
}
