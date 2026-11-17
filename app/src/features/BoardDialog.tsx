import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

const NOBODY = '__nobody__';
const PRIORITY_TINT: Record<TicketPriority, string> = {
  low: 'text-muted-foreground',
  normal: '',
  high: 'text-amber-600 dark:text-amber-400',
  urgent: 'text-red-600 dark:text-red-400',
};

/**
 * The board: tickets the person and the bots both work from, in columns by status. Assigning one
 * to a bot starts it on the work; what it reports comes back as a comment, and the ticket moves to
 * review for the person to close or send back with a comment.
 */
export function BoardDialog() {
  const t = useT();
  const open = useUi((s) => s.boardOpen);
  const setOpen = useUi((s) => s.setBoardOpen);
  const { data: tickets = [] } = useQuery({ queryKey: ['tickets'], queryFn: api.tickets, enabled: open });
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const current = tickets.find((k) => k.id === openId) ?? null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setOpenId(null);
      }}
    >
      <DialogContent className="screen-edges flex h-[min(780px,92vh)] flex-col gap-3 overflow-hidden rounded-3xl sm:max-w-6xl phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none">
        <div className="flex items-center gap-2 pr-8">
          {current && (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onClick={() => setOpenId(null)}
              aria-label={t('settings.back')}
            >
              <ArrowLeft />
            </Button>
          )}
          <DialogTitle className="flex-1">{current ? `#${current.number}` : t('board.title')}</DialogTitle>
          {!current && (
            <Button size="sm" className="rounded-full" onClick={() => setAdding(true)}>
              <Plus /> {t('board.new')}
            </Button>
          )}
        </div>
        {current ? (
          <TicketDetail ticket={current} onDeleted={() => setOpenId(null)} />
        ) : (
          <>
            {adding && <NewTicket onDone={() => setAdding(false)} />}
            {!tickets.length && !adding && (
              <p className="px-1 text-sm text-muted-foreground">{t('board.empty')}</p>
            )}
            <div className="scroll-thin grid min-h-0 flex-1 auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2 phone:grid-flow-row phone:auto-cols-auto phone:overflow-y-auto">
              {TICKET_STATUSES.map((status) => (
                <Column
                  key={status}
                  status={status}
                  tickets={tickets.filter((k) => k.status === status)}
                  onOpen={setOpenId}
                />
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Column({
  status,
  tickets,
  onOpen,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  onOpen(id: string): void;
}) {
  const t = useT();
  const { data: bots = [] } = useBots();
  return (
    <section className="flex min-h-0 flex-col rounded-2xl bg-secondary/50 p-2">
      <h3 className="flex items-center gap-2 px-2 pb-2 text-xs font-medium text-muted-foreground">
        {t(`board.status.${status}`)}
        <span className="rounded-full bg-background px-1.5">{tickets.length}</span>
      </h3>
      <div className="scroll-thin flex min-h-0 flex-col gap-2 overflow-y-auto">
        {tickets.map((k) => {
          const bot = bots.find((b) => b.id === k.assigneeBotId);
          return (
            <button
              key={k.id}
              type="button"
              onClick={() => onOpen(k.id)}
              className="flex flex-col gap-1 rounded-xl border bg-card px-3 py-2 text-left text-sm shadow-xs transition-colors hover:bg-accent"
            >
              <span className="font-medium [overflow-wrap:anywhere]">{k.title}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>#{k.number}</span>
                {k.priority !== 'normal' && (
                  <span className={PRIORITY_TINT[k.priority]}>{t(`board.priority.${k.priority}`)}</span>
                )}
                {k.comments.length > 0 && (
                  <span className="flex items-center gap-0.5">
                    <MessageSquare className="size-3" /> {k.comments.length}
                  </span>
                )}
                <span className="flex-1" />
                {bot && <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={18} />}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AssigneeSelect({ value, onChange }: { value: string | null; onChange(id: string | null): void }) {
  const t = useT();
  const { data: bots = [] } = useBots();
  return (
    <Select value={value ?? NOBODY} onValueChange={(v) => onChange(v === NOBODY ? null : v)}>
      <SelectTrigger className="w-48 rounded-full" aria-label={t('board.assignee')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NOBODY}>{t('board.nobody')}</SelectItem>
        {bots
          .filter((b) => !b.archivedAt)
          .map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

function PrioritySelect({ value, onChange }: { value: TicketPriority; onChange(p: TicketPriority): void }) {
  const t = useT();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TicketPriority)}>
      <SelectTrigger className="w-36 rounded-full" aria-label={t('board.priority')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TICKET_PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            {t(`board.priority.${p}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NewTicket({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [assignee, setAssignee] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.createTicket({ title, description, priority, assigneeBotId: assignee }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim()) save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border bg-background p-3">
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t('board.titlePlaceholder')}
        required
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('board.descriptionPlaceholder')}
        rows={3}
      />
      <div className="flex flex-wrap items-center gap-2">
        <AssigneeSelect value={assignee} onChange={setAssignee} />
        <PrioritySelect value={priority} onChange={setPriority} />
        <span className="flex-1" />
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending || !title.trim()}>
          {t('common.add')}
        </Button>
      </div>
      {assignee && <p className="text-xs text-muted-foreground">{t('board.startsHint')}</p>}
    </form>
  );
}

function TicketDetail({ ticket, onDeleted }: { ticket: Ticket; onDeleted(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const { dayLabel } = useFormat();
  const { data: bots = [] } = useBots();
  const [comment, setComment] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['tickets'] });
  const fail = (e: Error) => toast.error(e.message);
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateTicket>[1]) => api.updateTicket(ticket.id, patch),
    onSuccess: () => void refresh(),
    onError: fail,
  });
  const send = useMutation({
    mutationFn: () => api.commentTicket(ticket.id, comment),
    onSuccess: () => {
      setComment('');
      void refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.removeTicket(ticket.id),
    onSuccess: () => {
      void refresh();
      onDeleted();
    },
    onError: fail,
  });
  const author = (a: string) =>
    a === 'user' ? t('board.you') : (bots.find((b) => `bot:${b.id}` === a)?.name ?? a);
  const assignee = bots.find((b) => b.id === ticket.assigneeBotId);
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{ticket.title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={ticket.status} onValueChange={(v) => update.mutate({ status: v as TicketStatus })}>
          <SelectTrigger className="w-44 rounded-full" aria-label={t('board.statusLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TICKET_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`board.status.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AssigneeSelect
          value={ticket.assigneeBotId}
          onChange={(id) => update.mutate({ assigneeBotId: id })}
        />
        <PrioritySelect value={ticket.priority} onChange={(p) => update.mutate({ priority: p })} />
        <span className="flex-1" />
        {assignee && ticket.threadId && (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => {
              const ui = useUi.getState();
              ui.openChat(assignee.id);
              ui.selectThread(ticket.threadId);
              ui.setBoardOpen(false);
            }}
          >
            {t('board.openWork')}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          onClick={() => {
            if (confirm(t('board.deleteConfirm', { number: ticket.number }))) remove.mutate();
          }}
          aria-label={t('common.delete')}
        >
          <Trash2 />
        </Button>
      </div>
      {ticket.description && (
        <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{ticket.description}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {t('board.openedBy', { who: author(ticket.createdBy), when: dayLabel(ticket.createdAt) })}
      </p>
      <section className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('board.comments')}</h3>
        {ticket.comments.map((c) => (
          <div
            key={c.id}
            className={cn('rounded-2xl px-3 py-2 text-sm', c.author === 'user' ? 'bg-secondary' : 'border')}
          >
            <div className="mb-1 text-xs text-muted-foreground">
              {author(c.author)} · {dayLabel(c.createdAt)}
            </div>
            <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{c.text}</div>
          </div>
        ))}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (comment.trim()) send.mutate();
          }}
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t(ticket.assigneeBotId ? 'board.commentToBot' : 'board.commentPlaceholder')}
            rows={2}
            className="flex-1"
          />
          <Button type="submit" className="rounded-full" disabled={send.isPending || !comment.trim()}>
            {t('board.send')}
          </Button>
        </form>
      </section>
    </div>
  );
}
