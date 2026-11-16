import type { UsageRange } from '@yumakbot/shared';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api';

export const useBots = () => useQuery({ queryKey: ['bots'], queryFn: api.bots });
export const useGroups = () => useQuery({ queryKey: ['groups'], queryFn: api.groups });
export const useRooms = () => useQuery({ queryKey: ['rooms'], queryFn: api.rooms });
export const useSummaries = () => useQuery({ queryKey: ['summaries'], queryFn: api.summaries });
export const useInfo = () => useQuery({ queryKey: ['info'], queryFn: api.info });
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: api.settings });
/** Null on a server older than the in-app Claude sign-in. */
export const useClaudeAuth = () =>
  useQuery({
    queryKey: ['claude-auth'],
    queryFn: () =>
      api.claudeAuth().catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
  });
export const useClaudeModels = (enabled = true) =>
  useQuery({
    queryKey: ['claude-models'],
    queryFn: () =>
      api.claudeModels().catch((e) => (e instanceof ApiError && e.status === 404 ? [] : Promise.reject(e))),
    enabled,
    staleTime: 5 * 60_000,
  });
export const useProviders = () => useQuery({ queryKey: ['providers'], queryFn: api.providers });
export const useProviderModels = (id: string | null) =>
  useQuery({
    queryKey: ['provider-models', id],
    queryFn: () => api.providerModels(id!),
    enabled: !!id,
    staleTime: Infinity,
  });
export const useApprovals = () => useQuery({ queryKey: ['approvals'], queryFn: api.approvals });
export const useRules = () => useQuery({ queryKey: ['rules'], queryFn: api.rules });
export const useVault = () => useQuery({ queryKey: ['vault'], queryFn: api.vault });
export const useConnections = () => useQuery({ queryKey: ['connections'], queryFn: api.connections });
export const useMemory = () => useQuery({ queryKey: ['memory'], queryFn: api.memory });
// Under `memory`, so a change to any note brings the list up to date.
export const useStaleMemory = () => useQuery({ queryKey: ['memory', 'stale'], queryFn: api.staleMemory });
export const useRoutines = () => useQuery({ queryKey: ['routines'], queryFn: api.routines });
export const useSkills = () => useQuery({ queryKey: ['skills'], queryFn: api.skills });
export const useUsage = (days: UsageRange, botId?: string) =>
  useQuery({ queryKey: ['usage', days, botId], queryFn: () => api.usage(days, botId), staleTime: 30_000 });

export const useThreads = (botId: string | null) =>
  useQuery({ queryKey: ['threads', botId], queryFn: () => api.threads(botId!), enabled: !!botId });
export const useMainThread = (botId: string | null) =>
  useQuery({ queryKey: ['main-thread', botId], queryFn: () => api.mainThread(botId!), enabled: !!botId });
export const useMessages = (threadId: string | null) =>
  useQuery({ queryKey: ['messages', threadId], queryFn: () => api.messages(threadId!), enabled: !!threadId });
export const useJob = (jobId: string | null) =>
  useQuery({ queryKey: ['job', jobId], queryFn: () => api.job(jobId!), enabled: !!jobId });
export const useLibrary = (botId: string | null) =>
  useQuery({ queryKey: ['library', botId], queryFn: () => api.library(botId!), enabled: !!botId });
