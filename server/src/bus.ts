import { EventEmitter } from 'node:events';
import type { DeltaEvent, NoticeEvent, RefreshScope, ToolEvent, TurnEvent } from '@leafbot/shared';

/** In-process event bus; the realtime layer forwards these to connected clients. */
export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
  }
  refresh(e: RefreshScope) {
    this.ee.emit('refresh', e);
  }
  delta(e: DeltaEvent) {
    this.ee.emit('delta', e);
  }
  turn(e: TurnEvent) {
    this.ee.emit('turn', e);
  }
  notice(e: NoticeEvent) {
    this.ee.emit('notice', e);
  }
  tool(e: ToolEvent) {
    this.ee.emit('tool', e);
  }
  on(event: 'refresh', fn: (e: RefreshScope) => void): () => void;
  on(event: 'delta', fn: (e: DeltaEvent) => void): () => void;
  on(event: 'turn', fn: (e: TurnEvent) => void): () => void;
  on(event: 'notice', fn: (e: NoticeEvent) => void): () => void;
  on(event: 'tool', fn: (e: ToolEvent) => void): () => void;
  on(event: string, fn: (e: never) => void): () => void {
    const listener = fn as (...args: unknown[]) => void;
    this.ee.on(event, listener);
    return () => this.ee.off(event, listener);
  }
}
