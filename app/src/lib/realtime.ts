import type { ClientToServerEvents, RefreshScope, ServerToClientEvents } from '@yumakbot/shared';
import type { QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { browserSocketClosed, onBrowserReconnect, useBrowsers } from './browser';
import { computerSocketClosed, onComputerReconnect, useComputers } from './computer';
import { notice, watchAnswered } from './notify';
import { useUi } from './store';
import { serverBuild } from './update';

/**
 * Realtime channel. Pushes only say what changed; lasting state is always refetched over HTTP.
 * The session cookie authenticates the connection (same origin).
 */
export function connectRealtime(qc: QueryClient): () => void {
  const s: Socket<ServerToClientEvents, ClientToServerEvents> = io({
    path: '/socket.io',
    transports: ['websocket'],
    withCredentials: true,
  });
  let bootId: string | null = null;
  const ui = useUi.getState;
  const stopWatching = watchAnswered(qc);

  s.on('connect', () => {
    ui().setConnected(true);
    onBrowserReconnect(s);
    onComputerReconnect(s);
  });
  s.on('disconnect', (reason) => {
    ui().setConnected(false);
    // A server shutting down (a restart, a redeploy) drops every socket itself, and Socket.IO does
    // not retry that on its own; reconnecting here falls into the usual backoff until it is back.
    if (reason === 'io server disconnect') s.connect();
  });
  s.on('hello', (e) => {
    // Reconnects can miss events; a new boot means every cached view is stale.
    if (bootId !== null) ui().resetLive();
    bootId = e.bootId;
    serverBuild(e.buildId);
    void qc.invalidateQueries();
  });
  s.on('refresh', (e) => refresh(qc, e));
  s.on('delta', (e) => {
    ui().appendStream(e.threadId, e.turnId, e.text);
    ui().markWriting(e.threadId);
  });
  s.on('tool', (e) => ui().setTool(e.threadId, e.tool));
  s.on('turn', (e) => {
    ui().setState(e.threadId, e.state);
    if (e.state !== 'running') ui().setTool(e.threadId, null);
    void qc.invalidateQueries({ queryKey: ['summaries'] });
    void qc.invalidateQueries({ queryKey: ['threads', e.botId] });
    // Who speaks in a room changes with every turn there.
    void qc.invalidateQueries({ queryKey: ['rooms'] });
    if (e.state === 'idle') {
      void qc.invalidateQueries({ queryKey: ['library', e.botId] });
      // A file open in the preview may have been rewritten by the turn that just ended.
      void qc.invalidateQueries({ queryKey: ['file-text', e.botId] });
      // Clear the stream once the saved message is in the cache.
      const stream = ui().streams[e.threadId];
      void qc.refetchQueries({ queryKey: ['messages', e.threadId] }).then(() => {
        if (stream) ui().dropStream(e.threadId, stream.turnId);
      });
    }
  });
  s.on('notice', (e) => notice(qc, e));
  s.on('browser:state', (e) => useBrowsers.getState().setState(e));
  s.on('browser:frame', (e) => useBrowsers.getState().setFrame(e));
  s.on('computer:state', (e) => useComputers.getState().setState(e));
  s.on('connect_error', (err) => {
    // The refusal is worded in either language; both name the access key.
    if (/anahtar|access key/i.test(err.message)) ui().setAuthed(false);
  });
  return () => {
    stopWatching();
    s.removeAllListeners();
    s.close();
    browserSocketClosed(s);
    computerSocketClosed(s);
  };
}

function refresh(qc: QueryClient, e: RefreshScope) {
  const inv = (...queryKey: unknown[]) => void qc.invalidateQueries({ queryKey });
  switch (e.scope) {
    case 'bots':
      inv('bots');
      inv('summaries');
      break;
    case 'groups':
      inv('groups');
      break;
    case 'rooms':
      inv('rooms');
      break;
    case 'threads':
      inv('threads', e.botId);
      inv('summaries');
      break;
    case 'thread':
      // A room's list entry shows its latest line and who speaks.
      inv('rooms');
      inv('messages', e.threadId);
      inv('thread', e.threadId);
      inv('threads', e.botId);
      inv('summaries');
      inv('job');
      break;
    case 'approvals':
      inv('approvals');
      inv('summaries');
      // An answered card counts toward ways to ask less.
      inv('suggestions');
      break;
    case 'memory':
      inv('memory');
      break;
    case 'routines':
      inv('routines');
      // A routine's instruction may have changed, by a bot or on another device.
      inv('routine-revisions');
      inv('summaries');
      break;
    case 'rules':
      inv('rules');
      inv('suggestions');
      break;
    case 'vault':
      inv('vault');
      break;
    case 'skills':
      inv('skills');
      break;
    case 'connections':
      inv('connections');
      break;
    case 'channels':
      inv('telegram');
      inv('whatsapp');
      inv('slack');
      inv('slack-link');
      inv('discord');
      break;
    case 'tickets':
      inv('tickets');
      break;
    case 'tables':
      inv('tables', e.botId);
      inv('table-rows');
      break;
    case 'actions':
      inv('actions', e.botId);
      break;
    case 'info':
      inv('info');
      inv('providers');
      // The model catalog came in: lists fill in with names and new models.
      inv('provider-models');
      break;
    case 'people':
      inv('people');
      // A changed role changes what this device may do.
      inv('session');
      inv('bots');
      break;
  }
}
