import {
  botNoteGroups,
  describeSchedule,
  INTL_LOCALE,
  LOCALE_NAMES,
  LOCALES,
  STALE_MEMORY_DAYS,
  type BotNoteGroup,
  type Locale,
  type Memory,
  type ServerInfo,
} from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  Brain,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  FileInput,
  Folder,
  FolderOpen,
  Info,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  MessageCircle,
  Plus,
  RefreshCw,
  Shield,
  Smartphone,
  Sparkles,
  SlidersHorizontal,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { deviceName } from '@/lib/device';
import { useFormat } from '@/lib/format';
import { PHONE, useMedia } from '@/lib/media';
import {
  useBots,
  useClaudeAuth,
  useConnections,
  useGroups,
  useInfo,
  useMemory,
  useStaleMemory,
  useRoutines,
  useRules,
  useSettings,
} from '@/lib/queries';
import { desktop, useDesktopServer } from '@/lib/desktop';
import { useUi, type SettingsTab } from '@/lib/store';
import {
  allowNotifications,
  chime,
  NOTIFY_LEVELS,
  notificationsSupported,
  testNotification,
  useNotify,
  type NotifyLevel,
} from '@/lib/notify';
import {
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  SPEECH_RATE_STEP,
  speechSupported,
  useServerVoice,
  useSpeech,
} from '@/lib/speech';
import { Slider } from '@/components/ui/slider';
import { useSendKey, type SendKey } from '@/lib/sendKey';
import { useTheme, type ThemeChoice } from '@/lib/theme';
import {
  useChatWidth,
  useDensity,
  useFont,
  type ChatWidth,
  type Density,
  type FontChoice,
} from '@/lib/density';
import { ruleLabel } from '@/lib/ruleLabel';
import { settingsMatch } from '@/lib/settingsMatch';
import { useZoom, ZOOMS } from '@/lib/zoom';
import { cn } from '@/lib/utils';
import { ChannelsTab } from './ChannelsTab';
import { AiServicesTab } from './AiServicesTab';
import { PendingMemory } from './PendingMemory';
import { ImportTab } from './ImportTab';
import { ProfileTab } from './ProfileTab';
import { SkillsTab } from './SkillsTab';
import { UsageTab } from './UsageTab';
import { VaultTab } from './VaultTab';
import { AccountForm } from './AccountSetup';
import { ClaudeConnect } from './ClaudeConnect';
import { ModelDefaults } from './ModelDefaults';
import { ApnsCard } from './PhoneSettings';
import { Chip } from './onboarding/Chip';
import {
  AddProviderForm,
  isPiModel,
  PiModelPicker,
  ProviderRows,
  useHasProvider,
  useSavePiModel,
} from './ProviderConnect';

const TABS: { id: SettingsTab; icon: React.ReactNode }[] = [
  { id: 'profile', icon: <UserRound /> },
  { id: 'general', icon: <SlidersHorizontal /> },
  { id: 'connection', icon: <Link2 /> },
  { id: 'channels', icon: <MessageCircle /> },
  { id: 'permissions', icon: <Shield /> },
  { id: 'vault', icon: <KeyRound /> },
  { id: 'memory', icon: <Brain /> },
  { id: 'services', icon: <AudioLines /> },
  { id: 'routines', icon: <Clock /> },
  { id: 'skills', icon: <Sparkles /> },
  { id: 'groups', icon: <Folder /> },
  { id: 'import', icon: <FileInput /> },
  { id: 'usage', icon: <ChartColumn /> },
  { id: 'about', icon: <Info /> },
];

/** Every time zone the browser knows, for the searchable list. */
const ZONES: string[] = (() => {
  try {
    return [...Intl.supportedValuesOf('timeZone'), 'UTC'];
  } catch {
    return ['Europe/Istanbul', 'Europe/London', 'America/New_York', 'Asia/Tokyo', 'UTC'];
  }
})();

const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
})();

/** The bots' time zone: typed with suggestions from the full list; the device's zone is offered. */
function TimeZoneField({ value, onChange }: { value: string; onChange(zone: string): void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft === null) return;
    const zone = ZONES.find((z) => z.toLowerCase() === draft.trim().toLowerCase());
    if (zone && zone !== value) onChange(zone);
    setDraft(null);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        list="time-zones"
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        aria-label={t('general.timezone')}
        className="w-56 rounded-full"
      />
      <datalist id="time-zones">
        {ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      {deviceZone && deviceZone !== value && ZONES.includes(deviceZone) && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => onChange(deviceZone)}
        >
          {t('general.useDeviceZone', { zone: deviceZone })}
        </button>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const t = useT();
  const tab = useUi((s) => s.settingsTab);
  const open = useUi((s) => s.openSettings);
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  // A phone shows one of two screens: the list of sections, or the section picked from it.
  const phone = useMedia(PHONE);
  const listing = useUi((s) => s.settingsList) && phone;
  const toList = () => useUi.setState({ settingsList: true });
  // The list narrows to the sections whose name or contents match what is typed.
  const [find, setFind] = useState('');
  const shownTabs = TABS.filter((tb) =>
    settingsMatch(find, `${t(`settings.tab.${tb.id}`)} ${t(`settings.keywords.${tb.id}`)}`),
  );
  // ⌘, / Ctrl+, opens the settings, as in most desktop apps; again closes them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        open(useUi.getState().settingsTab ? null : 'general');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <Dialog open={!!tab} onOpenChange={(o) => !o && open(null)}>
      <DialogContent
        // A phone would put its keyboard over the list for the search box; there it waits for a tap.
        onOpenAutoFocus={(e) => phone && e.preventDefault()}
        // Escape in an open list (the model search) closes the list, not the whole settings.
        onEscapeKeyDown={(e) => {
          const el = e.target as HTMLElement | null;
          if (el?.getAttribute('role') === 'combobox' && el.getAttribute('aria-expanded') === 'true')
            e.preventDefault();
        }}
        className="screen-edges sidebar-top flex h-[min(720px,90vh)] gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-4xl phone:flex-col phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none phone:border-0"
      >
        {(!phone || listing) && (
          <nav className="scroll-thin flex shrink-0 flex-col gap-1 bg-sidebar p-3 phone:min-h-0 phone:flex-1 phone:overflow-y-auto roomy:w-56 roomy:border-r">
            <DialogTitle className="px-3 pt-2 pb-3 text-base phone:pt-1 phone:text-lg">
              {t('settings.title')}
            </DialogTitle>
            <Input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && shownTabs[0]) open(shownTabs[0].id);
              }}
              placeholder={t('settings.search')}
              aria-label={t('settings.search')}
              className="mb-2 h-8 shrink-0 rounded-full text-sm phone:h-10 phone:text-base"
            />
            {shownTabs.map((tb) => (
              <button
                key={tb.id}
                onClick={() => open(tb.id)}
                className={cn(
                  'flex shrink-0 items-center gap-3 rounded-xl px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-accent [&>svg]:size-4 phone:py-3 phone:text-base',
                  !phone && current.id === tb.id && 'bg-accent font-medium',
                )}
              >
                {tb.icon}
                <span className="flex-1 text-left">{t(`settings.tab.${tb.id}`)}</span>
                {phone && <ChevronRight className="text-muted-foreground" />}
              </button>
            ))}
          </nav>
        )}
        {!listing && (
          <>
            {phone && (
              // The section's own title bar, with the way back to the list.
              <div className="flex h-14 shrink-0 items-center gap-1 border-b bg-sidebar pr-12 pl-1">
                <Button variant="ghost" size="icon" onClick={toList} aria-label={t('settings.back')}>
                  <ChevronLeft className="size-5" />
                </Button>
                <DialogTitle className="truncate text-lg">{t(`settings.tab.${current.id}`)}</DialogTitle>
              </div>
            )}
            <div className="scroll-thin min-h-0 min-w-0 flex-1 overflow-y-auto p-4 roomy:p-8">
              <h2 className="mb-6 text-2xl font-semibold phone:hidden">{t(`settings.tab.${current.id}`)}</h2>
              {current.id === 'profile' && <ProfileTab />}
              {current.id === 'general' && <General />}
              {current.id === 'connection' && <Connection />}
              {current.id === 'channels' && <ChannelsTab />}
              {current.id === 'permissions' && <Permissions />}
              {current.id === 'vault' && <VaultTab />}
              {current.id === 'memory' && <MemoryTab />}
              {current.id === 'services' && <AiServicesTab />}
              {current.id === 'routines' && <RoutinesTab />}
              {current.id === 'skills' && <SkillsTab />}
              {current.id === 'groups' && <GroupsTab />}
              {current.id === 'import' && <ImportTab />}
              {current.id === 'usage' && <UsageTab />}
              {current.id === 'about' && <About />}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** What this device shows as notifications while the person looks elsewhere. */
function Notifications() {
  const t = useT();
  const level = useNotify((s) => s.level);
  const setLevel = useNotify((s) => s.setLevel);
  const sound = useNotify((s) => s.sound);
  const setSound = useNotify((s) => s.setSound);
  const [permission, setPermission] = useState(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  );
  const choose = async (next: NotifyLevel) => {
    setLevel(next);
    if (next !== 'off') {
      await allowNotifications();
      setPermission(Notification.permission);
    }
  };
  const hint = !notificationsSupported()
    ? t('notify.unsupported')
    : permission === 'denied'
      ? t('notify.blocked')
      : t('notify.hint');
  return (
    <Card title={t('notify.title')}>
      <Row label={t('notify.level')} hint={hint}>
        <Select value={level} onValueChange={(v) => void choose(v as NotifyLevel)}>
          <SelectTrigger className="w-56 rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NOTIFY_LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {t(`notify.level.${l}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('notify.sound')} hint={t('notify.soundHint')}>
        <Switch
          checked={sound}
          onCheckedChange={(on) => {
            setSound(on);
            if (on) chime();
          }}
          aria-label={t('notify.sound')}
        />
      </Row>
      {notificationsSupported() && (
        <Row label={t('notify.test')}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            onClick={async () => {
              if (await allowNotifications()) testNotification();
              setPermission(Notification.permission);
            }}
          >
            {t('notify.testButton')}
          </Button>
        </Row>
      )}
    </Card>
  );
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{title}</h3>}
      <div className="divide-y rounded-2xl border bg-card/50">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-40 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
    onError: (e) => toast.error((e as Error).message),
  });
}

/** In the desktop app: whether it opens, and the server with it, when the person logs in. */
function OpenAtLogin() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void desktop
      ?.openAtLogin?.()
      .then(setOn)
      .catch(() => setOn(null));
  }, []);
  if (!desktop?.openAtLogin || on === null) return null;
  return (
    <Card title={t('general.desktop')}>
      <Row label={t('general.openAtLogin')} hint={t('general.openAtLoginHint')}>
        <Switch
          checked={on}
          onCheckedChange={(v) =>
            void desktop
              ?.openAtLogin?.(v)
              .then(setOn)
              .catch((e: Error) => toast.error(e.message))
          }
        />
      </Row>
    </Card>
  );
}

function General() {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const theme = useTheme();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const font = useFont((s) => s.font);
  const setFont = useFont((s) => s.set);
  const chatWidth = useChatWidth((s) => s.width);
  const setChatWidth = useChatWidth((s) => s.set);
  const density = useDensity((s) => s.density);
  const setDensity = useDensity((s) => s.set);
  const zoom = useZoom((s) => s.zoom);
  const setZoom = useZoom((s) => s.setZoom);
  const sendKey = useSendKey((s) => s.key);
  const setSendKey = useSendKey((s) => s.set);
  const speechRate = useSpeech((s) => s.rate);
  const setSpeechRate = useSpeech((s) => s.setRate);
  const serverVoice = useServerVoice();
  const changeLanguage = (language: Locale) => {
    setLocale(language, { unsaved: true });
    save.mutate({ language }, { onSuccess: () => useLocale.setState({ unsaved: false }) });
  };
  return (
    <>
      <OpenAtLogin />
      <Card title={t('general.appearance')}>
        <Row label={t('general.theme')}>
          <Select value={theme.choice} onValueChange={(v) => theme.setChoice(v as ThemeChoice)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('general.theme.system')}</SelectItem>
              <SelectItem value="light">{t('general.theme.light')}</SelectItem>
              <SelectItem value="dark">{t('general.theme.dark')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.font')}>
          <Select value={font} onValueChange={(v) => setFont(v as FontChoice)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t('general.font.default')}</SelectItem>
              <SelectItem value="system">{t('general.font.system')}</SelectItem>
              <SelectItem value="serif">{t('general.font.serif')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.chatWidth')} hint={t('general.chatWidthHint')}>
          <Select value={chatWidth} onValueChange={(v) => setChatWidth(v as ChatWidth)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">{t('general.chatWidth.normal')}</SelectItem>
              <SelectItem value="wide">{t('general.chatWidth.wide')}</SelectItem>
              <SelectItem value="full">{t('general.chatWidth.full')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.density')} hint={t('general.densityHint')}>
          <Select value={density} onValueChange={(v) => setDensity(v as Density)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comfortable">{t('general.density.comfortable')}</SelectItem>
              <SelectItem value="compact">{t('general.density.compact')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.zoom')} hint={t('general.zoomHint')}>
          <Select value={String(zoom)} onValueChange={(v) => setZoom(Number(v))}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ZOOMS.map((z) => (
                <SelectItem key={z} value={String(z)}>
                  {Math.round(z * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('common.language')} hint={t('general.languageHint')}>
          <Select value={locale} onValueChange={(v) => changeLanguage(v as Locale)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((l) => (
                <SelectItem key={l} value={l} lang={l}>
                  {LOCALE_NAMES[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Card>
      <Card title={t('general.behavior')}>
        <Row label={t('general.sendKey')} hint={t('general.sendKeyHint')}>
          <Select value={sendKey} onValueChange={(v) => setSendKey(v as SendKey)}>
            <SelectTrigger className="w-56 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="enter">{t('general.sendKey.enter')}</SelectItem>
              <SelectItem value="mod">{t('general.sendKey.mod')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        {(serverVoice || speechSupported()) && (
          <Row label={t('general.speechRate')} hint={t('general.speechRateHint')}>
            <div className="flex w-56 items-center gap-3">
              <Slider
                min={SPEECH_RATE_MIN}
                max={SPEECH_RATE_MAX}
                step={SPEECH_RATE_STEP}
                value={[speechRate]}
                onValueChange={([v]) => setSpeechRate(v ?? 1)}
                aria-label={t('general.speechRate')}
              />
              <button
                type="button"
                onClick={() => setSpeechRate(1)}
                title={t('general.speechRateReset')}
                className="w-12 shrink-0 text-right text-sm tabular-nums text-muted-foreground hover:text-foreground"
              >
                {`${speechRate.toLocaleString(INTL_LOCALE[locale], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`}
              </button>
            </div>
          </Row>
        )}
      </Card>
      <Notifications />
      <Card title={t('general.bots')}>
        <Row label={t('general.timezone')} hint={t('general.timezoneHint')}>
          <TimeZoneField
            value={settings?.timezone ?? 'Europe/Istanbul'}
            onChange={(timezone) => save.mutate({ timezone })}
          />
        </Row>
      </Card>
    </>
  );
}

function Connection() {
  const t = useT();
  const { data: info } = useInfo();
  const setAuthed = useUi((s) => s.setAuthed);
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: api.checkClaude,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['info'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => setAuthed(false) });
  const { data: claudeAuth } = useClaudeAuth();
  // Opened from the model card too, when another provider is picked before any is connected.
  const [adding, setAdding] = useState(false);
  const addAnchor = useRef<HTMLDivElement>(null);
  const addProvider = () => {
    setAdding(true);
    requestAnimationFrame(() => addAnchor.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const status = info?.claude.status ?? 'unknown';
  const claude = info?.claude;
  const hint =
    status === 'logged-out'
      ? t('connection.loggedOutHint')
      : claude?.reason === 'api-key'
        ? t('connection.apiKeyInUse', { source: claude.detail ?? '' })
        : claude?.reason === 'timeout'
          ? t('connection.timeout')
          : (claude?.detail ?? t('connection.defaultHint'));
  return (
    <>
      <Card title={t('connection.ai')}>
        {claudeAuth === null ? (
          <Row label={t('connection.claude')} hint={hint}>
            <span
              className={cn(
                'flex items-center gap-1.5 text-sm',
                status === 'ok'
                  ? 'text-emerald-500'
                  : status === 'unknown'
                    ? 'text-muted-foreground'
                    : 'text-amber-500',
              )}
            >
              {status === 'ok' ? (
                <Check className="size-4" />
              ) : status === 'unknown' ? null : (
                <X className="size-4" />
              )}
              {t(`connection.status.${status}`)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={() => check.mutate()}
              disabled={check.isPending}
            >
              <RefreshCw className={cn(check.isPending && 'animate-spin')} /> {t('connection.check')}
            </Button>
          </Row>
        ) : (
          <div className="space-y-3 px-4 py-4">
            <ClaudeConnect checking={check.isPending} />
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-muted-foreground"
              onClick={() => check.mutate()}
              disabled={check.isPending}
            >
              <RefreshCw className={cn(check.isPending && 'animate-spin')} /> {t('connection.check')}
            </Button>
          </div>
        )}
        <ProviderRows plain />
        <AddProvider open={adding} onOpenChange={setAdding} anchor={addAnchor} />
      </Card>
      <ModelCard onAddProvider={addProvider} />
      <Card title={t('connection.environment')}>
        <ShellSandboxRow sandbox={info?.shellSandbox} />
        <BrowserRow browser={info?.browser} />
        <EgressRow egress={info?.egress} />
      </Card>
      <Card title={t('connection.server')}>
        <Row label={t('connection.address')} hint={window.location.origin} />
        <DesktopServerRow />
        <Row label={t('connection.version')} hint={info?.version ?? '…'} />
        <AccountRow />
        <Row label={t('connection.logoutHere')}>
          <Button variant="secondary" size="sm" className="rounded-full" onClick={() => logout.mutate()}>
            <LogOut /> {t('connection.logout')}
          </Button>
        </Row>
      </Card>
      <PairDevice />
      <Devices />
      <ApnsCard />
    </>
  );
}

/**
 * A one-time code for signing in a phone or another computer, typed there instead of the password.
 * It works once, within five minutes; the address is the one the other device reaches this
 * server at.
 */
function PairDevice() {
  const t = useT();
  const qc = useQueryClient();
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; url: string | null } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  const make = useMutation({
    mutationFn: api.pairingCode,
    onSuccess: (p) => {
      setPairing(p);
      setNow(Date.now());
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const left = pairing ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  useEffect(() => {
    if (!pairing || left <= 0) return;
    const timer = setTimeout(() => {
      setNow(Date.now());
      // A device that used the code shows up in the list below.
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    }, 1000);
    return () => clearTimeout(timer);
  }, [pairing, left, qc]);
  const address = pairing?.url ?? window.location.origin;
  return (
    <Card title={t('pair.title')}>
      <Row label={t('pair.label')} hint={t('pair.hint')}>
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          onClick={() => make.mutate()}
          disabled={make.isPending}
        >
          {make.isPending ? <Loader2 className="animate-spin" /> : <Smartphone />}
          {pairing && left > 0 ? t('pair.again') : t('pair.make')}
        </Button>
      </Row>
      {pairing && left > 0 && (
        <div className="space-y-2 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-xl bg-secondary px-4 py-2 font-mono text-2xl tracking-widest">
              {pairing.code}
            </code>
            <span className="text-xs text-muted-foreground">
              {t('pair.left', {
                minutes: String(Math.floor(left / 60)),
                seconds: String(left % 60).padStart(2, '0'),
              })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t('pair.where', { address })}</p>
        </div>
      )}
    </Card>
  );
}

/** The username and password browsers sign in with; hidden on servers older than accounts. */
function AccountRow() {
  const t = useT();
  const { data, isError } = useQuery({ queryKey: ['account'], queryFn: api.account, retry: false });
  const [open, setOpen] = useState(false);
  if (isError || !data) return null;
  return (
    <div>
      <Row label={t('account.title')} hint={data.username ?? t('account.none')}>
        <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setOpen((v) => !v)}>
          {data.username ? t('account.change') : t('account.create')}
        </Button>
      </Row>
      {open && (
        <div className="max-w-sm px-4 pb-4">
          <AccountForm
            username={data.username ?? ''}
            change={data.username !== null}
            onDone={() => {
              setOpen(false);
              toast.success(t('account.saved'));
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The browsers and apps signed in to this server, each of which can be signed out from here. */
function Devices() {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
  const end = useMutation({
    mutationFn: api.endSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!sessions?.length) return null;
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Card title={t('devices.title')}>
      {sessions.map((s) => {
        const { app, os } = deviceName(s.userAgent);
        const name = app && os ? t('devices.appOnOs', { app, os }) : (app ?? os ?? t('devices.unknown'));
        return (
          <Row key={s.id} label={name} hint={t('devices.lastSeen', { when: dayLabel(s.lastSeenAt) })}>
            {s.current ? (
              <span className="text-xs text-muted-foreground">{t('devices.this')}</span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full"
                disabled={end.isPending}
                onClick={() => end.mutate(s.id)}
              >
                {t('devices.signOut')}
              </Button>
            )}
          </Row>
        );
      })}
      <Row label={t('devices.othersHint')}>
        {others > 1 && (
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={end.isPending}
            onClick={() => end.mutate('others')}
          >
            {t('devices.signOutOthers')}
          </Button>
        )}
      </Row>
    </Card>
  );
}

/** Default model and effort for Claude bots; hidden on servers that cannot store them. */
function ModelCard({ onAddProvider }: { onAddProvider(): void }) {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [picked, setPicked] = useState<'claude' | 'pi' | null>(null);
  const [claudeOpen, setClaudeOpen] = useState(false);
  if (settings?.defaultModel === undefined) return null;
  const kind = picked ?? settings.defaultEngine ?? 'claude';
  // Bots already on Claude keep using this setting, so it stays reachable, folded out of the way.
  const folded = kind === 'pi' && !claudeOpen;
  return (
    <Card title={t('model.title')}>
      {settings.defaultEngine !== undefined && (
        <NewBotEngine kind={kind} onPick={setPicked} onAddProvider={onAddProvider} />
      )}
      <div className="space-y-3 px-4 py-4">
        {settings.defaultEngine !== undefined && (
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">{t('model.claudeBots')}</div>
              <div className="text-xs text-muted-foreground">
                {kind === 'pi' ? t('model.claudeBotsFoldedHint') : t('model.claudeBotsHint')}
              </div>
            </div>
            {kind === 'pi' && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 rounded-full text-muted-foreground"
                aria-expanded={!folded}
                onClick={() => setClaudeOpen(!claudeOpen)}
              >
                {folded ? t('model.show') : t('model.hide')}
                <ChevronDown className={cn('transition-transform', !folded && 'rotate-180')} />
              </Button>
            )}
          </div>
        )}
        {!folded && (
          <ModelDefaults
            value={{ model: settings.defaultModel, effort: settings.effort ?? '' }}
            onChange={(v) => save.mutate({ defaultModel: v.model, effort: v.effort })}
          />
        )}
      </div>
      {settings.backupModel !== undefined && <BackupModel onAddProvider={onAddProvider} />}
    </Card>
  );
}

/** The model that carries the work once the usage limit is spent, instead of waiting for it. */
function BackupModel({ onAddProvider }: { onAddProvider(): void }) {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [on, setOn] = useState<boolean | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const pi = useSavePiModel(() => setRef(null), true);
  const hasProvider = useHasProvider();
  const stored = settings?.backupModel ?? '';
  const open = on ?? !!stored;
  const value = ref ?? stored;
  return (
    <div className="space-y-3 border-t px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{t('model.backup')}</div>
          <div className="text-xs text-muted-foreground">{t('model.backupHint')}</div>
        </div>
        <Switch
          checked={open}
          onCheckedChange={(v) => {
            setOn(v);
            if (!v && stored) save.mutate({ backupModel: '' });
          }}
          aria-label={t('model.backup')}
        />
      </div>
      {open && (
        <div className="space-y-2">
          <PiModelPicker value={value} onChange={setRef} empty={<NoProvider onAdd={onAddProvider} />} />
          {hasProvider && (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                className="rounded-full"
                onClick={() => pi.save.mutate(value)}
                disabled={!isPiModel(value) || value === stored || pi.save.isPending}
              >
                {pi.save.isPending && <Loader2 className="animate-spin" />}
                {pi.save.isPending ? t('claude.testing') : t('provider.tryAndSave')}
              </Button>
              {stored && value === stored && (
                <span className="text-xs text-muted-foreground">{t('provider.inUse')}</span>
              )}
            </div>
          )}
          {pi.error && (
            <p className="text-sm text-destructive">{t('provider.failed', { detail: pi.error })}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Which AI new bots start with: Claude, or a model of a provider with a stored key. The choice
 * is held by the card, which folds the Claude settings away while another provider is picked.
 */
function NewBotEngine({
  kind,
  onPick,
  onAddProvider,
}: {
  kind: 'claude' | 'pi';
  onPick(kind: 'claude' | 'pi'): void;
  onAddProvider(): void;
}) {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [ref, setRef] = useState<string | null>(null);
  const pi = useSavePiModel(() => setRef(null));
  const hasProvider = useHasProvider();
  const value = ref ?? settings?.piModel ?? '';
  const saved = settings?.defaultEngine === 'pi' && settings.piModel === value;
  return (
    <div className="space-y-3 border-b px-4 py-4">
      <div>
        <div className="text-sm font-medium">{t('model.newBots')}</div>
        <div className="text-xs text-muted-foreground">{t('model.newBotsHint')}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Chip
          on={kind === 'claude'}
          onClick={() => {
            onPick('claude');
            if (settings?.defaultEngine !== 'claude') save.mutate({ defaultEngine: 'claude' });
          }}
        >
          {t('ai.claude')}
        </Chip>
        <Chip on={kind === 'pi'} onClick={() => onPick('pi')}>
          {t('ai.other')}
        </Chip>
      </div>
      {kind === 'pi' && (
        <div className="space-y-2">
          <PiModelPicker value={value} onChange={setRef} empty={<NoProvider onAdd={onAddProvider} />} />
          {hasProvider && (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                className="rounded-full"
                onClick={() => pi.save.mutate(value)}
                disabled={!isPiModel(value) || saved || pi.save.isPending}
              >
                {pi.save.isPending && <Loader2 className="animate-spin" />}
                {pi.save.isPending ? t('claude.testing') : t('provider.tryAndSave')}
              </Button>
              {saved && <span className="text-xs text-muted-foreground">{t('provider.inUse')}</span>}
            </div>
          )}
          {pi.error && (
            <p className="text-sm text-destructive">{t('provider.failed', { detail: pi.error })}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** In the desktop app: switch this window to another server, or back to the one on this computer. */
function DesktopServerRow() {
  const t = useT();
  const server = useDesktopServer();
  if (!desktop?.openConnect || !server) return null;
  return (
    <Row
      label={t('connection.connectedTo')}
      hint={server.mode === 'local' ? t('connection.thisComputer') : (server.url ?? '')}
    >
      <Button
        variant="secondary"
        size="sm"
        className="rounded-full"
        onClick={() => void desktop!.openConnect?.()}
      >
        {t('connection.connectOther')}
      </Button>
      {server.mode === 'remote' && (
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          onClick={() => void desktop!.useLocal()}
        >
          {t('connection.useLocal')}
        </Button>
      )}
    </Row>
  );
}

/**
 * Adds a provider other than Claude: folded to one button once some provider is connected, open
 * while none is, since then it is the way on.
 */
function AddProvider({
  open,
  onOpenChange,
  anchor,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  anchor: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const hasProvider = useHasProvider();
  const shown = open || !hasProvider;
  return (
    <div ref={anchor} className="px-4 py-4">
      {shown ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{t('keys.hint')}</p>
          <AddProviderForm onAdded={() => onOpenChange(false)} />
          {hasProvider && (
            <Button
              variant="ghost"
              size="sm"
              className="rounded-full text-muted-foreground"
              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel')}
            </Button>
          )}
        </div>
      ) : (
        <Button variant="secondary" size="sm" className="rounded-full" onClick={() => onOpenChange(true)}>
          <Plus /> {t('provider.add')}
        </Button>
      )}
    </div>
  );
}

/** In the model card while no provider is connected: says so and opens the form above. */
function NoProvider({ onAdd }: { onAdd(): void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-muted-foreground">{t('provider.noneYet')}</p>
      <Button variant="secondary" size="sm" className="rounded-full" onClick={onAdd}>
        <Plus /> {t('provider.add')}
      </Button>
    </div>
  );
}

function Permissions() {
  const t = useT();
  const { data: rules = [] } = useRules();
  const { data: connections = [] } = useConnections();
  const apps = new Map(connections.map((c) => [c.slug, c.name]));
  const qc = useQueryClient();
  const [pattern, setPattern] = useState('');
  const [list, setList] = useState<'ask' | 'allow' | 'block'>('ask');
  const add = useMutation({
    mutationFn: () => api.addRule({ list, pattern }),
    onSuccess: () => {
      setPattern('');
      void qc.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: api.removeRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const section = (l: 'ask' | 'allow' | 'block', title: MessageKey, hint: MessageKey) => (
    <Card title={t(title)}>
      <div className="px-4 py-3 text-xs text-muted-foreground">{t(hint)}</div>
      {rules
        .filter((r) => r.list === l)
        .map((r) => {
          // The readable name on top, the rule as it is matched under it.
          const label = ruleLabel(r.pattern, t, apps);
          return (
            <Row key={r.id} label={label ?? r.pattern} hint={label ? r.pattern : undefined}>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={() => remove.mutate(r.id)}
                aria-label={t('common.remove')}
              >
                <Trash2 className="size-4" />
              </Button>
            </Row>
          );
        })}
    </Card>
  );
  return (
    <>
      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pattern.trim()) add.mutate();
        }}
      >
        <Select value={list} onValueChange={(v) => setList(v as 'ask' | 'allow' | 'block')}>
          <SelectTrigger className="w-48 rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ask">{t('rules.ask')}</SelectItem>
            <SelectItem value="allow">{t('rules.allow')}</SelectItem>
            <SelectItem value="block">{t('rules.block')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder={t('rules.placeholder')}
          className="flex-1 rounded-full"
        />
        <Button className="rounded-full" disabled={!pattern.trim()}>
          {t('common.add')}
        </Button>
      </form>
      {section('ask', 'rules.ask', 'rules.askHint')}
      {section('allow', 'rules.allow', 'rules.allowHint')}
      {section('block', 'rules.block', 'rules.blockHint')}
    </>
  );
}

function MemoryTab() {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: memory = [] } = useMemory();
  const { data: bots = [] } = useBots();
  // Notes of an archived bot stay until deleted; its name tells them apart.
  const { data: archived = [] } = useQuery({ queryKey: ['bots', 'archived'], queryFn: api.archivedBots });
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['memory'] });
  const clearBot = useMutation({
    mutationFn: api.removeBotMemory,
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const add = useMutation({
    mutationFn: () => api.addMemory({ scope: 'user', content: text }),
    onSuccess: () => {
      setText('');
      void refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // A deleted memory can be brought back for a moment, in case the wrong one went.
  const forget = useMutation({
    mutationFn: async (m: Memory) => {
      await api.removeMemory(m.id);
      return m;
    },
    onSuccess: (m) => {
      void refresh();
      toast(t('memory.deleted'), {
        action: {
          label: t('memory.undo'),
          onClick: () =>
            void api
              .addMemory({ scope: m.scope, botId: m.botId, content: m.content, site: m.site })
              .then(refresh)
              .catch((e: Error) => toast.error(e.message)),
        },
      });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const { data: stale = [] } = useStaleMemory();
  const clearStale = useMutation({
    mutationFn: () => api.removeStaleMemory(stale.map((m) => m.id)),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const user = memory.filter((m) => m.scope === 'user');
  const groups = botNoteGroups(memory, bots, archived);
  const botName = (id: string | null) =>
    [...bots, ...archived].find((b) => b.id === id)?.name ?? t('common.bot');
  const name = (g: BotNoteGroup) => g.name ?? t('common.bot');
  // Each bot's notes stay folded until opened, so a long list reads as one line per bot.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <>
      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('memory.placeholder')}
          className="flex-1 rounded-full"
        />
        <Button className="rounded-full" disabled={!text.trim()}>
          {t('common.add')}
        </Button>
      </form>
      <PendingMemory bots={[...bots, ...archived]} />
      {stale.length > 0 && (
        <Card title={t('memory.stale')}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <p className="min-w-40 flex-1 text-xs text-muted-foreground">
              {t('memory.staleHint', { days: STALE_MEMORY_DAYS })}
            </p>
            {stale.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full"
                disabled={clearStale.isPending}
                onClick={() =>
                  confirm(t('memory.staleDeleteAllConfirm', { count: stale.length })) && clearStale.mutate()
                }
              >
                {t('memory.deleteAll')}
              </Button>
            )}
          </div>
          {stale.map((m) => (
            <Row
              key={m.id}
              label={m.site ? `${m.site} · ${m.content}` : m.content}
              hint={`${m.scope === 'user' ? t('memory.staleShared') : botName(m.botId)} · ${
                m.lastUsedAt
                  ? t('memory.lastUsed', { when: dayLabel(m.lastUsedAt) })
                  : t('memory.neverUsed', { when: dayLabel(m.updatedAt) })
              }`}
            >
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={() => forget.mutate(m)}
                aria-label={t('common.delete')}
              >
                <Trash2 className="size-4" />
              </Button>
            </Row>
          ))}
        </Card>
      )}
      <Card title={t('memory.user')}>
        {user.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">{t('memory.empty')}</div>
        )}
        {user.map((m) => (
          <Row key={m.id} label={m.site ? `${m.site} · ${m.content}` : m.content}>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              onClick={() => forget.mutate(m)}
              aria-label={t('common.delete')}
            >
              <Trash2 className="size-4" />
            </Button>
          </Row>
        ))}
      </Card>
      <Card title={t('memory.bots')}>
        {groups.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">{t('memory.empty')}</div>
        )}
        {groups.map((g) => {
          const isOpen = open.has(g.botId);
          return (
            <div key={g.botId}>
              <div className="flex min-h-14 items-center gap-2 px-4 py-2">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(g.botId)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <ChevronRight
                    className={cn(
                      'size-4 shrink-0 text-muted-foreground transition-transform',
                      isOpen && 'rotate-90',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {g.archived ? t('memory.archivedBot', { name: name(g) }) : name(g)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t('memory.noteCount', { count: g.notes.length })}
                    </span>
                  </span>
                </button>
                {isOpen && g.notes.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="rounded-full"
                    disabled={clearBot.isPending}
                    onClick={() =>
                      confirm(t('memory.deleteAllConfirm', { name: name(g), count: g.notes.length })) &&
                      clearBot.mutate(g.botId)
                    }
                  >
                    {t('memory.deleteAll')}
                  </Button>
                )}
              </div>
              {isOpen && (
                <div className="divide-y border-t">
                  {g.notes.map((m) => (
                    <Row key={m.id} label={m.site ? `${m.site} · ${m.content}` : m.content}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 rounded-full"
                        onClick={() => forget.mutate(m)}
                        aria-label={t('common.delete')}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </Row>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </>
  );
}

function RoutinesTab() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { dayLabel } = useFormat();
  const { data: routines = [] } = useRoutines();
  const { data: bots = [] } = useBots();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (r: { id: string; enabled: boolean }) => api.updateRoutine(r.id, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines'] }),
  });
  if (!routines.length) {
    return <p className="text-sm text-muted-foreground">{t('routines.empty')}</p>;
  }
  return (
    <Card>
      {routines.map((r) => {
        const bot = bots.find((b) => b.id === r.botId);
        return (
          <div key={r.id} className="flex items-center gap-3 px-4 py-3">
            {bot && <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={28} />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{r.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {bot?.name} · {describeSchedule(r.schedule, locale)}
                {r.lastRunAt ? ` · ${t('routines.lastRun', { when: dayLabel(r.lastRunAt) })}` : ''}
              </div>
            </div>
            <Switch checked={r.enabled} onCheckedChange={() => toggle.mutate(r)} />
          </div>
        );
      })}
    </Card>
  );
}

function GroupsTab() {
  const t = useT();
  const { data: groups = [] } = useGroups();
  const { data: bots = [] } = useBots();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['groups'] });
  const add = useMutation({
    mutationFn: () => api.createGroup(name),
    onSuccess: () => {
      setName('');
      void refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: api.deleteGroup,
    onSuccess: () => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">{t('groups.hint')}</p>
      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('groups.placeholder')}
          className="flex-1 rounded-full"
        />
        <Button className="rounded-full" disabled={!name.trim()}>
          {t('common.add')}
        </Button>
      </form>
      <Card>
        {groups.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">{t('groups.empty')}</div>
        )}
        {groups.map((g) => {
          const count = bots.filter((b) => b.groupId === g.id).length;
          return (
            <Row key={g.id} label={g.name} hint={t('groups.count', { count })}>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={() =>
                  (count === 0 || confirm(t('sidebarMenu.deleteGroupConfirm', { name: g.name }))) &&
                  remove.mutate(g.id)
                }
                aria-label={t('common.delete')}
              >
                <Trash2 className="size-4" />
              </Button>
            </Row>
          );
        })}
      </Card>
      <ArchivedBots />
    </>
  );
}

/** Bots put away from the sidebar: each can come back, or go for good with all it holds. */
function ArchivedBots() {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const { data: archived = [] } = useQuery({ queryKey: ['bots', 'archived'], queryFn: api.archivedBots });
  const refresh = () => qc.invalidateQueries({ queryKey: ['bots'] });
  const restore = useMutation({
    mutationFn: api.restoreBot,
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: api.deleteBot,
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card title={t('archive.title')}>
      {archived.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">{t('archive.empty')}</div>
      )}
      {archived.map((b) => (
        <Row key={b.id} label={b.name} hint={t('archive.since', { when: dayLabel(b.archivedAt!) })}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={restore.isPending}
            onClick={() => restore.mutate(b.id)}
          >
            {t('archive.restore')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-destructive"
            disabled={remove.isPending}
            onClick={() => confirm(t('archive.deleteConfirm', { name: b.name })) && remove.mutate(b.id)}
            aria-label={t('archive.delete')}
            title={t('archive.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </Row>
      ))}
    </Card>
  );
}

const REPO_URL = 'https://github.com/esmworks/yumakbot';

/** A new issue with the version and the device filled in, so a report starts with what it needs. */
function issueUrl(version: string | undefined): string {
  const body = [`Version: ${version ?? '?'}`, `Browser: ${navigator.userAgent}`, '', ''].join('\n');
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

/**
 * Copyright, license and source links. The license requires that everyone who gets a copy also
 * gets its terms and the NOTICE file's "Required Notice:" lines, so both stay reachable from here.
 */
function About() {
  const t = useT();
  const { data: info } = useInfo();
  const link = (href: string, label: string, hint = href.replace('https://', '')) => (
    <Row label={label} hint={hint}>
      <Button asChild variant="secondary" size="sm" className="rounded-full">
        <a href={href} target="_blank" rel="noopener noreferrer">
          <ExternalLink /> {t('about.open')}
        </a>
      </Button>
    </Row>
  );
  return (
    <>
      <div className="mb-6 flex items-center gap-4 px-1">
        <img src="/logo.png" alt="" className="size-14 rounded-2xl" />
        <div>
          <div className="text-lg font-semibold">Yumak Bot</div>
          <div className="text-sm text-muted-foreground">
            {t('about.version', { version: info?.version ?? '…' })}
          </div>
        </div>
      </div>
      <Card title={t('about.license')}>
        <div className="space-y-2 px-4 py-3 text-sm">
          <p>Copyright © 2026 esmworks (Erhan Erbaş)</p>
          <p className="text-muted-foreground">{t('about.licenseText')}</p>
          <p className="text-muted-foreground">{t('about.warranty')}</p>
        </div>
      </Card>
      <Card title={t('about.links')}>
        {link(REPO_URL, t('about.source'))}
        {link(`${REPO_URL}/blob/main/LICENSE`, t('about.licenseLink'))}
        {link(`${REPO_URL}/blob/main/NOTICE`, t('about.notice'))}
        {link(issueUrl(info?.version), t('about.report'), t('about.reportHint'))}
      </Card>
      {desktop?.showLogs && (
        <Card title={t('about.logs')}>
          <Row label={t('about.logsHint')}>
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={() => void desktop?.showLogs?.()}
            >
              <FolderOpen /> {t('about.showLogs')}
            </Button>
          </Row>
        </Card>
      )}
    </>
  );
}

function ShellSandboxRow({ sandbox }: { sandbox: ServerInfo['shellSandbox'] | undefined }) {
  const t = useT();
  const status = sandbox?.status ?? 'unknown';
  // The bwrap error itself is useful; the other reasons say all there is.
  const reason = sandbox?.reason ? t(`sandbox.reason.${sandbox.reason}`) : null;
  const detail =
    sandbox?.reason === 'bwrap-failed' && sandbox.detail
      ? `${reason} (${sandbox.detail})`
      : (reason ?? sandbox?.detail ?? '');
  return (
    <Row
      label={t('sandbox.label')}
      hint={status === 'unavailable' ? t('sandbox.unavailableHint', { detail }) : t('sandbox.okHint')}
    >
      <span
        className={cn(
          'flex items-center gap-1.5 text-sm',
          status === 'ok'
            ? 'text-emerald-500'
            : status === 'unknown'
              ? 'text-muted-foreground'
              : 'text-amber-500',
        )}
      >
        {status === 'ok' ? (
          <Check className="size-4" />
        ) : status === 'unknown' ? null : (
          <X className="size-4" />
        )}
        {t(`sandbox.status.${status}`)}
      </span>
    </Row>
  );
}

/**
 * The bots' browsers reach the web through the person's own computer, so sites see its connection
 * instead of the server's. Offered only when the server runs elsewhere.
 */
function EgressRow({ egress }: { egress: ServerInfo['egress'] | undefined }) {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  if (!egress || settings?.browserViaComputer === undefined) return null;
  const on = settings.browserViaComputer;
  const now = egress.connected
    ? egress.device
      ? t('egress.connected', { device: egress.device })
      : t('egress.connectedUnnamed')
    : t('egress.waiting');
  return (
    <Row label={t('egress.label')} hint={on ? `${t('egress.hint')} ${now}` : t('egress.hint')}>
      <Switch checked={on} onCheckedChange={(v) => save.mutate({ browserViaComputer: v })} />
    </Row>
  );
}

function BrowserRow({ browser }: { browser: ServerInfo['browser'] | undefined }) {
  const t = useT();
  if (!browser) return null;
  const ok = browser.status === 'ok';
  return (
    <Row
      label={t('browserInfo.label')}
      hint={ok ? t('browserInfo.okHint', { path: browser.detail ?? '' }) : t('browserInfo.missingHint')}
    >
      <span className={cn('flex items-center gap-1.5 text-sm', ok ? 'text-emerald-500' : 'text-amber-500')}>
        {ok ? <Check className="size-4" /> : <X className="size-4" />}
        {ok ? t('browserInfo.ok') : t('browserInfo.missing')}
      </span>
    </Row>
  );
}
