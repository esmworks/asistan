import type { LinkPreview } from '@yumakbot/shared';
import { useQuery } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import { HoverCard } from 'radix-ui';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/** A pull request or issue on GitHub, whose state is shown next to its link. */
const GITHUB_ITEM = /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+(?:[/?#]|$)/i;
const KEEP_MS = 10 * 60_000;
/** A link still being written out in a streamed reply changes; its state is asked once it stays. */
const SETTLE_MS = 1_000;

/** Whether `value` has stayed the same for `ms`. */
function useSettled(value: string, ms: number): boolean {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled === value;
}

const usePreviewOf = (href: string, enabled: boolean) =>
  useQuery({
    queryKey: ['link-preview', href],
    queryFn: () => api.linkPreview(href),
    enabled,
    staleTime: KEEP_MS,
    gcTime: KEEP_MS,
    retry: false,
  });

/**
 * A web link in a message. Held under the pointer it shows what the page is (its title,
 * description and site, as the server read them; no picture from the page is loaded here), and
 * a GitHub pull request or issue carries its state beside it. A link carrying a key or a long
 * code gets no preview (the server refuses to read it).
 */
export function WebLink({ href, children }: { href: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const github = GITHUB_ITEM.test(href);
  const settled = useSettled(href, SETTLE_MS);
  const { data } = usePreviewOf(href, open || (github && settled));
  const preview = data?.preview ?? null;
  return (
    <HoverCard.Root open={open && !!preview} onOpenChange={setOpen} openDelay={500} closeDelay={100}>
      <HoverCard.Trigger asChild>
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
          {preview?.github && <GithubState g={preview.github} />}
        </a>
      </HoverCard.Trigger>
      {preview && (
        <HoverCard.Portal>
          <HoverCard.Content
            side="top"
            align="start"
            sideOffset={6}
            className="z-50 w-80 rounded-2xl border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <PreviewCard p={preview} />
          </HoverCard.Content>
        </HoverCard.Portal>
      )}
    </HoverCard.Root>
  );
}

function PreviewCard({ p }: { p: LinkPreview }) {
  const t = useT();
  const g = p.github;
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-xs text-muted-foreground">
        {g
          ? t(g.kind === 'pr' ? 'link.pr' : 'link.issue', { repo: g.repo, number: String(g.number) })
          : p.site}
      </span>
      {p.title && <span className="line-clamp-2 font-medium">{p.title}</span>}
      {p.description && <span className="line-clamp-3 text-muted-foreground">{p.description}</span>}
      {g && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <GithubState g={g} />
          {t(`link.state.${g.state}`)}
          {g.author && <span>· {t('link.by', { author: g.author })}</span>}
        </span>
      )}
    </div>
  );
}

/** The state of a pull request or issue as GitHub draws it: its icon in its colour. */
function GithubState({ g }: { g: NonNullable<LinkPreview['github']> }) {
  const t = useT();
  const Icon =
    g.kind === 'pr'
      ? { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed }[
          g.state === 'notPlanned' ? 'closed' : g.state
        ]
      : {
          open: CircleDot,
          closed: CircleCheck,
          notPlanned: CircleSlash,
          draft: CircleDot,
          merged: CircleCheck,
        }[g.state];
  const tone =
    g.state === 'open'
      ? 'text-green-600 dark:text-green-500'
      : g.state === 'merged' || (g.kind === 'issue' && g.state === 'closed')
        ? 'text-purple-600 dark:text-purple-400'
        : g.state === 'closed'
          ? 'text-red-600 dark:text-red-500'
          : 'text-muted-foreground';
  return (
    <Icon
      role="img"
      aria-label={t(`link.state.${g.state}`)}
      className={cn('ms-1 inline size-3.5 align-[-2px]', tone)}
    />
  );
}
