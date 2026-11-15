import { Download } from 'lucide-react';
import { LiveFrame } from '@/components/LiveFrame';
import { api } from '@/lib/api';

/**
 * A page a bot made (show_page), running in the conversation. It is read fresh from the bot's
 * folder, so the card shows the file as it is now. Its scripts run isolated: it may load the usual
 * libraries and show web images (map tiles), and fetch nothing.
 */
export function BotPage({
  botId,
  path,
  name,
  title,
  height,
}: {
  botId: string;
  path: string;
  name: string;
  title: string;
  /** The height the bot asked for, for a page laid out to the window (a map, a canvas). */
  height?: number;
}) {
  const url = api.fileUrl(botId, path);
  return (
    <div className="w-full max-w-(--bubble-width) space-y-2">
      <div className="flex items-center gap-2 px-1 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{title || name}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <Download className="size-3.5" /> {name}
        </a>
      </div>
      <LiveFrame title={title || name} src={api.pageUrl(botId, path, height)} initialHeight={height ?? 360} />
    </div>
  );
}
