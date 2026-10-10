/**
 * Unified event model. Every adapter maps its native events onto these types,
 * so the web UI only has to understand one stream.
 */
export type EventType =
  | 'thread.created'
  | 'thread.updated'
  | 'turn.started'
  | 'turn.done'
  | 'turn.error'
  | 'message.delta'
  | 'reasoning.delta'
  | 'tool.start'
  | 'tool.update'
  | 'tool.end'
  | 'plan.updated'
  | 'usage.updated'
  | 'approval.request'
  | 'approval.resolved'
  /** Something on the plan page changed. Broadcast only, never stored in an event log. */
  | 'todo.updated';

export interface StoredEvent {
  threadId: string;
  seq: number;
  turnId: string | null;
  type: EventType;
  ts: string;
  data: Record<string, unknown>;
}

/** An event as emitted by an adapter, before the store assigns seq and ts. */
export interface EmittedEvent {
  type: EventType;
  data: Record<string, unknown>;
}
