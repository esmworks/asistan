import { Smile } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT } from '@/i18n';
import {
  EMOJI_GROUPS,
  loadEmojis,
  noteRecentEmoji,
  recentEmojis,
  searchEmojis,
  type Emoji,
  type EmojiGroup,
} from '@/lib/emoji';

/** One emoji standing for each section in the row of section buttons. */
const GROUP_ICON: Record<EmojiGroup, string> = {
  smileys: '😀',
  people: '👋',
  animals: '🐻',
  food: '🍔',
  travel: '✈️',
  activities: '⚽',
  objects: '💡',
  symbols: '❤️',
  flags: '🏁',
};

/**
 * The composer's emoji button: a searchable grid of every emoji, the latest picked first. The pick
 * goes where the caret was when the picker opened.
 */
export function EmojiButton({ onPick }: { onPick(emoji: string): void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-9 shrink-0 rounded-full text-muted-foreground max-sm:hidden"
              aria-label={t('emoji.open')}
            >
              <Smile className="size-[18px]" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('emoji.open')}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 rounded-2xl p-0"
        // The text box gets the focus back with the emoji in it, not the button.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {open && (
          <EmojiGrid
            onPick={(e, keepOpen) => {
              noteRecentEmoji(e);
              onPick(e);
              if (!keepOpen) setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function EmojiGrid({ onPick }: { onPick(emoji: string, keepOpen: boolean): void }) {
  const t = useT();
  const [all, setAll] = useState<Emoji[] | null>(null);
  const [query, setQuery] = useState('');
  const [recent] = useState(recentEmojis);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void loadEmojis().then((list) => live && setAll(list));
    return () => {
      live = false;
    };
  }, []);
  const found = useMemo(() => (all && query.trim() ? searchEmojis(all, query) : null), [all, query]);
  const groups = useMemo(
    () => EMOJI_GROUPS.map((g) => ({ g, items: (all ?? []).filter((e) => e.group === g) })),
    [all],
  );
  const jump = (id: string) =>
    scroller.current?.querySelector(`[data-emoji-group="${id}"]`)?.scrollIntoView({ block: 'start' });
  // Shift-click picks more than one without closing.
  const cell = (e: string, key: string) => (
    <button
      key={key}
      type="button"
      onClick={(ev) => onPick(e, ev.shiftKey)}
      className="flex size-8 items-center justify-center rounded-lg text-xl hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      {e}
    </button>
  );
  return (
    <div className="flex flex-col">
      <div className="p-2 pb-1">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found?.[0]) {
              e.preventDefault();
              onPick(found[0].emoji, false);
            }
          }}
          placeholder={t('emoji.search')}
          aria-label={t('emoji.search')}
          className="h-8 rounded-lg"
        />
      </div>
      {!found && (
        <div className="flex justify-between px-2" role="toolbar" aria-label={t('emoji.sections')}>
          {recent.length > 0 && (
            <SectionButton icon="🕘" label={t('emoji.recent')} onClick={() => jump('recent')} />
          )}
          {EMOJI_GROUPS.map((g) => (
            <SectionButton
              key={g}
              icon={GROUP_ICON[g]}
              label={t(`emoji.group.${g}`)}
              onClick={() => jump(g)}
            />
          ))}
        </div>
      )}
      <div ref={scroller} className="h-72 overflow-y-auto px-2 pb-2">
        {!all ? null : found ? (
          found.length ? (
            <div className="grid grid-cols-8 pt-1">{found.map((e) => cell(e.emoji, e.emoji))}</div>
          ) : (
            <p className="p-4 text-center text-sm text-muted-foreground">{t('emoji.none')}</p>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <Section id="recent" title={t('emoji.recent')}>
                {recent.map((e) => cell(e, `recent-${e}`))}
              </Section>
            )}
            {groups.map(({ g, items }) => (
              <Section key={g} id={g} title={t(`emoji.group.${g}`)}>
                {items.map((e) => cell(e.emoji, e.emoji))}
              </Section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function SectionButton({ icon, label, onClick }: { icon: string; label: string; onClick(): void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-base opacity-70 hover:bg-accent hover:opacity-100"
    >
      {icon}
    </button>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-emoji-group={id}>
      <h3 className="sticky top-0 bg-popover py-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-8">{children}</div>
    </section>
  );
}
