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
  | 'todo.updated'
  /** The scheduled-task list changed. Broadcast only, never stored in an event log. */
  | 'schedules.changed';

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

/* The pieces below mirror the web timeline's reading of a tool event field by field, so that one
 * merged event leaves the timeline in exactly the state the whole run would. If the web's reading
 * changes (src/timeline.ts, applyToolData), this must change with it. */

function hasDiffParts(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => (part as { type?: unknown } | null)?.type === 'diff');
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const p = part as { type?: unknown; text?: unknown; content?: { type?: unknown; text?: unknown } } | null;
      if (!p || p.type === 'diff') return '';
      if (p.type === 'content' && p.content?.type === 'text') return String(p.content.text ?? '');
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function toolText(output: unknown, content: unknown): string {
  if (output !== undefined && output !== null && output !== '') {
    return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  }
  return textOfContent(content);
}

/** One run of updates and the end of a single tool call, as one event the timeline reads the same. */
function mergedToolEvent(run: StoredEvent[]): StoredEvent {
  const last = run[run.length - 1];
  let status: unknown;
  let title: unknown;
  let content: unknown;
  let text: string | undefined;
  for (const ev of run) {
    if (ev.data.status) status = ev.data.status;
    if (ev.data.title) title = ev.data.title;
    // The timeline replaces a step's diffs only when an event carries some, and its output text
    // from the last event that carries either; each field is taken from where it was last set.
    if (hasDiffParts(ev.data.content)) content = ev.data.content;
    const said = toolText(ev.data.output, ev.data.content);
    if (said) text = said;
  }
  const data: Record<string, unknown> = { id: last.data.id };
  if (status !== undefined) data.status = status;
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (text !== undefined) data.output = text;
  return { ...last, data };
}

/**
 * A tool call streaming to completion is stored as a burst of updates, each a snapshot that
 * supersedes the last, and an end; a long call under a chatty agent is hundreds of events whose
 * intermediates no reader needs. Consecutive update/end events of one call are collapsed into one
 * that carries the state the whole run leaves behind — every field from the event that last set
 * it, and the call's last seq, time and type, so durations and "still running" read the same. The
 * store keeps every intermediate; this is only how pages are served.
 */
export function coalesceToolEvents(events: StoredEvent[]): StoredEvent[] {
  const out: StoredEvent[] = [];
  let run: StoredEvent[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) out.push(mergedToolEvent(run));
    run = [];
  };
  for (const ev of events) {
    const isTool = ev.type === 'tool.update' || ev.type === 'tool.end';
    const continues = isTool && run.length > 0 && run[run.length - 1].turnId === ev.turnId && run[run.length - 1].data.id === ev.data.id;
    if (isTool && (continues || run.length === 0)) run.push(ev);
    else {
      flush();
      if (isTool) run.push(ev);
      else out.push(ev);
    }
  }
  flush();
  return out;
}
