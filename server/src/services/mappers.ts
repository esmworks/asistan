import type {
  Approval,
  Bot,
  Group,
  Memory,
  Message,
  PermissionRule,
  Routine,
  RoutineRun,
  Schedule,
  Thread,
  TurnState,
} from '@yumakbot/shared';
import type { schema } from '../db';
import { iso } from '../util';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export const toGroup = (r: Row<typeof schema.groups>): Group => ({
  id: r.id,
  name: r.name,
  createdAt: r.createdAt.toISOString(),
});

export const toBot = (r: Row<typeof schema.bots>): Bot => ({
  id: r.id,
  name: r.name,
  description: r.description,
  instructions: r.instructions,
  engine: r.engine,
  model: r.model,
  isManager: r.isManager,
  pinned: r.pinned,
  position: r.position,
  groupId: r.groupId,
  color: r.color,
  avatar: r.avatar,
  permissionMode: r.permissionMode,
  internet: r.internet,
  projectDir: r.projectDir,
  memory: r.memory,
  effort: r.effort,
  archivedAt: iso(r.archivedAt),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toThread = (
  r: Row<typeof schema.threads>,
  state: TurnState,
  preview: string | null = null,
): Thread => ({
  id: r.id,
  botId: r.botId,
  title: r.title,
  kind: r.kind,
  peerBotId: r.peerBotId,
  goal: r.goal,
  archivedAt: iso(r.archivedAt),
  snoozedUntil: iso(r.snoozedUntil),
  pinnedAt: iso(r.pinnedAt),
  icon: r.icon,
  state,
  preview,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toMessage = (r: Row<typeof schema.messages>): Message => ({
  id: r.id,
  threadId: r.threadId,
  role: r.role,
  author: r.author,
  text: r.text,
  props: r.props,
  clientId: r.clientId,
  turnId: r.turnId,
  createdAt: r.createdAt.toISOString(),
});

export const toApproval = (r: Row<typeof schema.approvals>): Approval => ({
  id: r.id,
  threadId: r.threadId,
  botId: r.botId,
  kind: r.kind,
  toolName: r.toolName,
  summary: r.summary,
  input: r.input,
  options: r.options,
  status: r.status,
  answer: r.answer,
  remembered: r.remembered,
  createdAt: r.createdAt.toISOString(),
  decidedAt: iso(r.decidedAt),
});

export const toRule = (r: Row<typeof schema.permissionRules>): PermissionRule => ({
  id: r.id,
  list: r.list,
  pattern: r.pattern,
  note: r.note,
  createdAt: r.createdAt.toISOString(),
});

export const toMemory = (r: Row<typeof schema.memories>): Memory => ({
  id: r.id,
  scope: r.scope,
  botId: r.botId,
  content: r.content,
  site: r.site,
  status: 'active',
  source: r.source,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toRoutine = (r: Row<typeof schema.routines>): Routine => ({
  id: r.id,
  botId: r.botId,
  name: r.name,
  prompt: r.prompt,
  schedule: r.schedule as Schedule,
  timezone: r.timezone,
  enabled: r.enabled,
  nextRunAt: iso(r.nextRunAt),
  lastRunAt: iso(r.lastRunAt),
  createdAt: r.createdAt.toISOString(),
  webhookToken: r.webhookToken,
  missed: r.missed,
  carryReport: r.carryReport,
  inMain: r.inMain,
  onStartup: r.onStartup,
  watchUrl: r.watchUrl,
  webhookFilter: r.webhookFilter,
  webhookPost: r.webhookPost,
  model: r.model,
});

export const toRun = (r: Row<typeof schema.routineRuns>): RoutineRun => ({
  id: r.id,
  routineId: r.routineId,
  occurrence: r.occurrence,
  status: r.status,
  reason: r.reason,
  threadId: r.threadId,
  startedAt: r.startedAt.toISOString(),
  finishedAt: iso(r.finishedAt),
});
