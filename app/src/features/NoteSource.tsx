import type { Memory } from '@leafbot/shared';
import { ExternalLink, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useUi } from '@/lib/store';

/** The host of a source address, for its label; the address itself when it has none. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Where a memory note came from: the page the bot read the fact on, and the conversation it wrote
 * the note in. Either opens, so the person can check the note before trusting it.
 */
export function NoteSource({ m }: { m: Pick<Memory, 'threadId' | 'sourceUrl'> }) {
  const t = useT();
  const goTo = (threadId: string) =>
    api
      .thread(threadId)
      .then((th) => {
        const ui = useUi.getState();
        ui.openSettings(null);
        if (th.kind === 'room') return ui.openRoom(th.id);
        ui.openChat(th.botId);
        ui.selectThread(th.id);
      })
      .catch(() => toast.error(t('chat.linkGone')));
  if (!m.sourceUrl && !m.threadId) return null;
  return (
    <div className="flex items-center gap-1">
      {m.sourceUrl && (
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="h-8 max-w-40 rounded-full px-2 text-xs text-muted-foreground"
        >
          <a href={m.sourceUrl} target="_blank" rel="noreferrer noopener" title={m.sourceUrl}>
            <ExternalLink className="size-3.5 shrink-0" />
            <span className="truncate">{sourceHost(m.sourceUrl)}</span>
          </a>
        </Button>
      )}
      {m.threadId && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          onClick={() => void goTo(m.threadId!)}
          title={t('memory.openSource')}
          aria-label={t('memory.openSource')}
        >
          <MessageCircle className="size-4" />
        </Button>
      )}
    </div>
  );
}
