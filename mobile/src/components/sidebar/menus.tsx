import { applyMove, moveTo, PINNED, UNGROUPED } from '@leafbot/app/src/lib/botLayout';
import type { Bot, BotSummary, Group } from '@leafbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactElement } from 'react';
import { confirm, askText, toast, toastError } from '@/components/overlay';
import { Sheet, type SheetItem } from '@/components/page';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { isUnread, markSeen, useSeen } from '@/lib/seen';
import { useApi, useServer } from '@/lib/server';
import { useStored } from '@/lib/stored';
import { isMuted, muteUntil, MUTED_KEY, withMute, withoutMute, type Mutes } from './mutes';

type Menu =
  | { kind: 'bot'; bot: Bot; stage: 'main' | 'move' | 'mute' }
  | { kind: 'group'; group: Group; prevId: string | null; nextId: string | null }
  | { kind: 'sidebar' };

export interface SidebarMenus {
  openBot(bot: Bot): void;
  openGroup(group: Group, prevId: string | null, nextId: string | null): void;
  openSidebar(): void;
  /** The sheet that shows the open menu; render it once. */
  sheet: ReactElement;
}

/**
 * The menus a long press opens: on a bot, on a group's heading and on the list's empty space.
 * They hold what the web app's right-click menus hold, as one bottom sheet.
 */
export function useSidebarMenus({
  bots,
  summaries,
  groups,
  logout,
}: {
  bots: readonly Bot[];
  summaries: readonly BotSummary[];
  groups: readonly Group[];
  logout(): void;
}): SidebarMenus {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const seen = useSeen(origin!);
  const [mutes, setMutes] = useStored<Mutes>(MUTED_KEY, {});
  // The menu stays set while the sheet slides out, so it does not empty first.
  const [menu, setMenuState] = useState<Menu | null>(null);
  const [open, setOpen] = useState(false);
  const setMenu = (m: Menu) => {
    setMenuState(m);
    setOpen(true);
  };

  const botsKey = useMemo(() => ['bots', origin], [origin]);
  const refresh = (name: string) => qc.invalidateQueries({ queryKey: [name, origin] });
  const unreadOf = (list: readonly BotSummary[]) => list.filter((s) => isUnread(s, seen));

  const move = (bot: Bot, section: string) => {
    const to = moveTo(section, null);
    const before = qc.getQueryData<Bot[]>(botsKey);
    if (before) qc.setQueryData<Bot[]>(botsKey, applyMove(before, bot.id, to));
    api.moveBot(bot.id, to).then(
      () => void refresh('bots'),
      (e) => {
        toastError(e);
        void refresh('bots');
      },
    );
  };

  const botItems = (bot: Bot, stage: 'main' | 'move' | 'mute'): SheetItem[] => {
    const current = bot.pinned ? PINNED : (bot.groupId ?? UNGROUPED);
    if (stage === 'move') {
      return [
        ...[
          { key: UNGROUPED, name: t('sidebar.ungrouped') },
          ...groups.map((g) => ({ key: g.id, name: g.name })),
        ].map((s): SheetItem => ({
          icon: 'folder',
          label: s.name,
          selected: s.key === current,
          onPress: () => s.key !== current && move(bot, s.key),
        })),
        {
          icon: 'folder-plus',
          label: t('sidebarMenu.newGroupItem'),
          onPress: () => void toNewGroup(bot),
        },
      ];
    }
    if (stage === 'mute') {
      return (['hour', 'morning', 'always'] as const).map((choice) => ({
        icon: 'bell-off',
        label: t(`sidebarMenu.mute.${choice}`),
        onPress: () => setMutes(withMute(mutes, bot.id, muteUntil(choice))),
      }));
    }
    const repliedAt = summaries.find((s) => s.botId === bot.id)?.repliedAt ?? null;
    const unread = isUnread({ botId: bot.id, repliedAt }, seen);
    const items: (SheetItem | false)[] = [
      {
        icon: 'bookmark',
        label: bot.pinned ? t('sidebarMenu.unpin') : t('sidebarMenu.pin'),
        onPress: () => move(bot, bot.pinned ? (bot.groupId ?? UNGROUPED) : PINNED),
      },
      {
        icon: 'folder',
        label: t('sidebarMenu.moveTo'),
        onPress: () => setMenu({ kind: 'bot', bot, stage: 'move' }),
      },
      {
        icon: 'plus-square',
        label: t('chat.newThread'),
        onPress: () => void newThread(bot),
      },
      { icon: 'edit-2', label: t('sidebarMenu.renameBot'), onPress: () => void rename(bot) },
      { icon: 'trash', label: t('sidebarMenu.clearThreads'), onPress: () => void clearThreads(bot) },
      !!unread &&
        !!repliedAt && {
          icon: 'mail',
          label: t('sidebarMenu.markRead'),
          onPress: () => markSeen(origin!, bot.id, repliedAt),
        },
      isMuted(mutes, bot.id)
        ? {
            icon: 'bell',
            label: t('sidebarMenu.unmute'),
            onPress: () => setMutes(withoutMute(mutes, bot.id)),
          }
        : {
            icon: 'bell-off',
            label: t('sidebarMenu.mute'),
            onPress: () => setMenu({ kind: 'bot', bot, stage: 'mute' }),
          },
      { icon: 'settings', label: t('sidebarMenu.settings'), onPress: () => nav.botEdit(bot.id) },
      { icon: 'archive', label: t('bot.archive'), destructive: true, onPress: () => void archive(bot) },
    ];
    return items.filter((i): i is SheetItem => !!i);
  };

  const newThread = async (bot: Bot) => {
    try {
      const created = await api.newThread(bot.id);
      void refresh('threads');
      nav.chat(bot.id, { threadId: created.id });
    } catch (e) {
      toastError(e);
    }
  };

  const rename = async (bot: Bot) => {
    const name = (
      await askText({ title: t('sidebarMenu.renameBot'), initial: bot.name, maxLength: 60 })
    )?.trim();
    if (!name || name === bot.name) return;
    try {
      await api.updateBot(bot.id, { name });
      void refresh('bots');
    } catch (e) {
      toastError(e);
    }
  };

  const toNewGroup = async (bot: Bot) => {
    const name = (await askText({ title: t('sidebarMenu.newGroup'), maxLength: 60 }))?.trim();
    if (!name) return;
    try {
      const group = await api.createGroup(name);
      await refresh('groups');
      await api.moveBot(bot.id, moveTo(group.id, null));
      void refresh('bots');
    } catch (e) {
      toastError(e);
    }
  };

  const clearThreads = async (bot: Bot) => {
    const ok = await confirm({
      title: t('sidebarMenu.clearThreads'),
      message: t('sidebarMenu.clearThreadsConfirm', { name: bot.name }),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      const { deleted } = await api.clearThreads(bot.id);
      void refresh('threads');
      void refresh('summaries');
      toast(t('sidebarMenu.threadsCleared', { count: deleted }));
    } catch (e) {
      toastError(e);
    }
  };

  const archive = async (bot: Bot) => {
    try {
      await api.archiveBot(bot.id);
      void refresh('bots');
      toast(t('sidebarMenu.archived', { name: bot.name }), {
        action: {
          label: t('sidebarMenu.undo'),
          onPress: () => void api.restoreBot(bot.id).then(() => refresh('bots'), toastError),
        },
      });
    } catch (e) {
      toastError(e);
    }
  };

  const groupItems = (group: Group, prevId: string | null, nextId: string | null): SheetItem[] => {
    const members = new Set(bots.filter((b) => b.groupId === group.id).map((b) => b.id));
    const unread = unreadOf(summaries.filter((s) => members.has(s.botId)));
    const after = (id: string) => groups[groups.findIndex((g) => g.id === id) + 1]?.id ?? null;
    /** Puts the group before `beforeId` (or last), on screen first, then on the server. */
    const reorder = (beforeId: string | null) => {
      qc.setQueryData<Group[]>(['groups', origin], (old) => {
        if (!old) return old;
        const rest = old.filter((g) => g.id !== group.id);
        const i = beforeId ? rest.findIndex((g) => g.id === beforeId) : -1;
        rest.splice(i < 0 ? rest.length : i, 0, group);
        return rest;
      });
      api.moveGroup(group.id, { beforeId }).then(
        () => void refresh('groups'),
        (e) => {
          toastError(e);
          void refresh('groups');
        },
      );
    };
    const items: (SheetItem | false)[] = [
      {
        icon: 'edit-2',
        label: t('sidebarMenu.rename'),
        onPress: async () => {
          const name = (
            await askText({ title: t('sidebarMenu.renameGroup'), initial: group.name, maxLength: 60 })
          )?.trim();
          if (!name || name === group.name) return;
          api.renameGroup(group.id, name).then(() => refresh('groups'), toastError);
        },
      },
      unread.length > 0 && {
        icon: 'mail',
        label: t('sidebarMenu.markGroupRead'),
        onPress: () => {
          for (const s of unread) if (s.repliedAt) markSeen(origin!, s.botId, s.repliedAt);
        },
      },
      !!prevId && { icon: 'arrow-up', label: t('sidebarMenu.moveUp'), onPress: () => reorder(prevId) },
      !!nextId && {
        icon: 'arrow-down',
        label: t('sidebarMenu.moveDown'),
        onPress: () => reorder(after(nextId)),
      },
      {
        icon: 'trash-2',
        label: t('common.delete'),
        destructive: true,
        onPress: async () => {
          const ok = await confirm({
            title: t('common.delete'),
            message: t('sidebarMenu.deleteGroupConfirm', { name: group.name }),
            confirmLabel: t('common.delete'),
            destructive: true,
          });
          if (!ok) return;
          api.deleteGroup(group.id).then(() => {
            void refresh('groups');
            void refresh('bots');
          }, toastError);
        },
      },
    ];
    return items.filter((i): i is SheetItem => !!i);
  };

  const sidebarItems = (): SheetItem[] => {
    const unread = unreadOf(summaries);
    const items: (SheetItem | false)[] = [
      { icon: 'plus', label: t('sidebar.newBot'), onPress: () => nav.botEdit() },
      {
        icon: 'folder-plus',
        label: t('sidebarMenu.newGroup'),
        onPress: async () => {
          const name = (await askText({ title: t('sidebarMenu.newGroup'), maxLength: 60 }))?.trim();
          if (!name) return;
          api.createGroup(name).then(() => refresh('groups'), toastError);
        },
      },
      unread.length > 0 && {
        icon: 'mail',
        label: t('sidebarMenu.markAllRead'),
        onPress: () => {
          for (const s of unread) if (s.repliedAt) markSeen(origin!, s.botId, s.repliedAt);
        },
      },
      { icon: 'log-out', label: t('bots.logout'), onPress: logout },
    ];
    return items.filter((i): i is SheetItem => !!i);
  };

  const title = menu?.kind === 'bot' ? menu.bot.name : menu?.kind === 'group' ? menu.group.name : undefined;
  const items = !menu
    ? []
    : menu.kind === 'bot'
      ? botItems(menu.bot, menu.stage)
      : menu.kind === 'group'
        ? groupItems(menu.group, menu.prevId, menu.nextId)
        : sidebarItems();

  return {
    openBot: (bot) => setMenu({ kind: 'bot', bot, stage: 'main' }),
    openGroup: (group, prevId, nextId) => setMenu({ kind: 'group', group, prevId, nextId }),
    openSidebar: () => setMenu({ kind: 'sidebar' }),
    sheet: <Sheet open={open} onClose={() => setOpen(false)} title={title} items={items} />,
  };
}
