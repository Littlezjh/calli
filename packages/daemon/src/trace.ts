import { mcpCallOf } from './activity.js';
import { coalesceToolEvents, compactDeltas, replaceMessageTail, type StoredEvent } from './events.js';

/**
 * One turn read back as a trace: what the user sent, what the model thought and said, each tool
 * it called with what came back, and each model request with its tokens, in the order they
 * happened. Built from the hub's own event log, the same one the thread view replays; the whole
 * system prompt is the conversation's, not the turn's, and is read separately.
 */

export type TraceStepKind = 'user' | 'thinking' | 'assistant' | 'tool' | 'request' | 'context' | 'error';

export interface TraceStep {
  kind: TraceStepKind;
  ts: string;
  /** When the step finished: the last fragment of a text, a tool's end. Absent while it runs. */
  endTs?: string;
  /** user, thinking, assistant, error, context: the text itself, cut at TEXT_CHARS. */
  text?: string;
  /** tool: the raw name (`Bash`, `mcp__github__create_issue`) and the agent's one-line title. */
  tool?: string;
  title?: string;
  server?: string;
  status?: string;
  /** tool: what it was given and what it gave back, cut at TEXT_CHARS. */
  input?: string;
  output?: string;
  /** request: the model and its token counts, as the agent reported them. */
  model?: string;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  /** True when a text above was cut; the thread still holds all of it. */
  cut?: boolean;
}

export interface TraceTotals {
  tools: number;
  mcp: number;
  requests: number;
  input: number;
  output: number;
}

export interface TurnTrace {
  threadId: string;
  turnId: string;
  title: string;
  agent: string;
  cwd: string;
  /** Models the requests named, in order of first use; the thread's chosen model when none did. */
  models: string[];
  status: 'running' | 'done' | 'cancelled' | 'error';
  startedAt: string;
  endedAt: string | null;
  steps: TraceStep[];
  totals: TraceTotals;
  /** The thread's other turns, oldest first, so the trace can step to the one before or after. */
  turns: Array<{ turnId: string; ts: string }>;
}

/** A trace is read, not archived: a long tool output is cut, the thread keeps the whole of it. */
const TEXT_CHARS = 20_000;

function cut(text: string): { text: string; cut: boolean } {
  return text.length > TEXT_CHARS ? { text: `${text.slice(0, TEXT_CHARS)}…`, cut: true } : { text, cut: false };
}

function stringOf(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * The steps of one turn's events. Streamed fragments become one text, a tool's start, updates and
 * end become one step, and every `usage.sample` is one request. Events of other turns are ignored.
 */
export function buildTrace(events: StoredEvent[]): { steps: TraceStep[]; totals: TraceTotals; models: string[]; status: TurnTrace['status']; endedAt: string | null } {
  const steps: TraceStep[] = [];
  const tools = new Map<string, TraceStep>();
  const compactions = new Map<string, TraceStep>();
  const totals: TraceTotals = { tools: 0, mcp: 0, requests: 0, input: 0, output: 0 };
  const models: string[] = [];
  let status: TurnTrace['status'] = 'running';
  let endedAt: string | null = null;

  const setText = (step: TraceStep, text: string) => {
    const c = cut(text);
    step.text = c.text;
    if (c.cut) step.cut = true;
    else delete step.cut;
  };

  for (const ev of compactDeltas(coalesceToolEvents(events))) {
    const data = ev.data;
    switch (ev.type) {
      case 'turn.started':
        setText(steps[steps.push({ kind: 'user', ts: ev.ts }) - 1], stringOf(data.text));
        break;
      case 'message.delta':
      case 'reasoning.delta': {
        const kind = ev.type === 'message.delta' ? 'assistant' : 'thinking';
        const last = steps[steps.length - 1];
        // compactDeltas gives a run as its first fragment and then the rest; join them back.
        if (last?.kind === kind && last.endTs !== undefined && !last.cut) {
          setText(last, (last.text ?? '') + stringOf(data.text));
          last.endTs = ev.ts;
        } else {
          const step: TraceStep = { kind, ts: ev.ts, endTs: ev.ts };
          setText(step, stringOf(data.text));
          steps.push(step);
        }
        break;
      }
      case 'message.replace': {
        const last = [...steps].reverse().find(step => step.kind === 'assistant');
        if (last && !last.cut) setText(last, replaceMessageTail(last.text ?? '', data));
        break;
      }
      case 'tool.start':
      case 'tool.update':
      case 'tool.end': {
        const id = String(data.id ?? '');
        let step = tools.get(id);
        if (!step) {
          step = { kind: 'tool', ts: ev.ts };
          tools.set(id, step);
          steps.push(step);
          totals.tools += 1;
        }
        if (typeof data.tool === 'string' && data.tool) step.tool = data.tool;
        if (typeof data.title === 'string' && data.title) step.title = data.title;
        if (typeof data.status === 'string' && data.status) step.status = data.status;
        const mcp = mcpCallOf(data);
        if (mcp && !step.server) {
          step.server = mcp.server;
          totals.mcp += 1;
        }
        const input = stringOf(data.input);
        if (input && input !== '{}') {
          const c = cut(input);
          step.input = c.text;
          if (c.cut) step.cut = true;
        }
        const output = stringOf(data.output);
        if (output) {
          const c = cut(output);
          step.output = c.text;
          if (c.cut) step.cut = true;
        }
        if (ev.type === 'tool.end') step.endTs = ev.ts;
        break;
      }
      case 'usage.sample': {
        const model = typeof data.model === 'string' ? data.model : undefined;
        if (model && !models.includes(model)) models.push(model);
        const tokens = { input: num(data.input), output: num(data.output), cacheRead: num(data.cacheRead), cacheWrite: num(data.cacheWrite) };
        totals.requests += 1;
        totals.input += tokens.input ?? 0;
        totals.output += tokens.output ?? 0;
        const started = typeof data.startedAt === 'string' ? data.startedAt : ev.ts;
        const ended = typeof data.endedAt === 'string' ? data.endedAt : ev.ts;
        steps.push({ kind: 'request', ts: started, endTs: ended, model, tokens });
        break;
      }
      case 'context.compaction': {
        // Codex reports one as started and again as finished; it is one step.
        const id = String(data.id ?? ev.seq);
        if (compactions.has(id)) {
          compactions.get(id)!.endTs = ev.ts;
          break;
        }
        const step: TraceStep = { kind: 'context', ts: ev.ts, text: data.automatic ? '上下文自动压缩' : '上下文压缩' };
        compactions.set(id, step);
        steps.push(step);
        break;
      }
      case 'turn.error':
        status = 'error';
        endedAt = ev.ts;
        steps.push({ kind: 'error', ts: ev.ts, text: stringOf(data.message ?? data.error) || '这一轮出错了' });
        break;
      case 'turn.done':
        status = data.stopReason === 'cancelled' ? 'cancelled' : 'done';
        endedAt = ev.ts;
        break;
      default:
        break;
    }
  }
  // A tool step that never ended reads as running until the turn did; then it ended with it.
  if (endedAt) for (const step of [...tools.values(), ...compactions.values()]) step.endTs ??= endedAt;
  return { steps, totals, models, status, endedAt };
}
