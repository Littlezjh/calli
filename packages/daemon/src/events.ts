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
  | 'approval.resolved';

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

/**
 * Text and thinking are stored one event per streamed fragment, so a long turn is tens of
 * thousands of events that say very little each. For reading back, a run of fragments of one kind
 * in one turn is given as two events: the first as it was, and one carrying the rest of the text
 * under the last fragment's seq and time. Both ends stay, so when the run began and ended is
 * still known, and resuming after the last seq still works.
 */
export function compactDeltas(events: StoredEvent[]): StoredEvent[] {
  const out: StoredEvent[] = [];
  // Index in `out` of the first fragment of the run being read, or -1.
  let head = -1;
  for (const ev of events) {
    const isDelta = ev.type === 'message.delta' || ev.type === 'reasoning.delta';
    const first = head >= 0 ? out[head] : undefined;
    if (isDelta && first && first.type === ev.type && first.turnId === ev.turnId) {
      const rest = out.length - 1 > head ? String(out[out.length - 1].data.text ?? '') : '';
      const merged = { ...ev, data: { ...ev.data, text: rest + String(ev.data.text ?? '') } };
      if (out.length - 1 > head) out[out.length - 1] = merged;
      else out.push(merged);
      continue;
    }
    out.push(ev);
    head = isDelta ? out.length - 1 : -1;
  }
  return out;
}
