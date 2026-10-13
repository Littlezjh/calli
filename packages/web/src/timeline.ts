/**
 * Turns the daemon's event log into the items the thread view renders.
 * Pure: no React, no I/O, so it can be unit-tested directly.
 */
import { diffStats } from './diff';
import { IMAGE_FILE } from './paths';

export interface StoredEvent {
  threadId: string;
  seq: number;
  turnId: string | null;
  type: string;
  ts: string;
  data: Record<string, any>;
}

/** One edited region of a file, as the agent reported it, with its line counts. */
export interface FileDiff {
  path: string;
  oldText: string | null;
  newText: string;
  added: number;
  removed: number;
}

export interface Step {
  id: string;
  title: string;
  kind: string;
  status: string;
  input?: unknown;
  output?: string;
  diffs: FileDiff[];
  /** When the agent started and finished this call, from the event log's timestamps. */
  startedAt?: string;
  endedAt?: string;
}

export interface ImageRef {
  id: string;
  mimeType: string;
}

/** Everything a turn did to one file. */
export interface FileChange {
  path: string;
  added: number;
  removed: number;
  diffs: FileDiff[];
}

/** One task in the agent's own to-do list for a turn. */
export interface PlanEntry {
  content: string;
  /** pending | in_progress | completed */
  status: string;
}

/** How full the agent's context window is, as it last reported. */
export interface Usage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: string;
}

/** One stretch of the agent's thinking, between two things it did or said. */
export interface Thought {
  key: string;
  text: string;
  startedAt: string;
  endedAt: string;
}

/** What a turn's work is made of, in the order it happened. */
export type WorkEntry =
  | { kind: 'thought'; thought: Thought }
  | { kind: 'step'; step: Step }
  /** Something the agent said on the way, before going on to do more. */
  | { kind: 'note'; key: string; text: string };

/** A turn another agent of the team started: who sent it and what it is, apart from its text. */
export interface CoordinationNote {
  /** The sender's name in the team; empty when the turn does not say. */
  from: string;
  kind: 'result' | 'task';
  failed: boolean;
}

/**
 * Splits what the daemon shows for a delivered message ("来自 NAME 的结果", a blank line, then the
 * text) into who and what. Text in any other shape is kept whole.
 */
export function coordinationNote(shown: string): { note: CoordinationNote; text: string } {
  const m = /^来自 (.+?) 的(结果|任务)(?:\n\n([\s\S]*))?$/.exec(shown);
  if (!m) return { note: { from: '', kind: 'result', failed: false }, text: shown };
  const kind = m[2] === '结果' ? 'result' : 'task';
  // Only a result opens with how the turn went; a task's first line is the sender's own words.
  const state = kind === 'result' ? /^状态：(失败|本轮已返回，仍需验收)(?:\n|$)/.exec(m[3] ?? '') : null;
  return { note: { from: m[1], kind, failed: state?.[1] === '失败' }, text: (m[3] ?? '').slice(state?.[0].length ?? 0).trim() };
}

/** The opening of a delivered message as plain words, for the folded card: Markdown marks taken off. */
export function deliveredPreview(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(#{1,6}|[-*+>]|\d+\.)\s+/, '').replace(/[*_`]/g, '').trim())
    .filter((line) => line && !line.startsWith('|') && !/^[-=]+$/.test(line))
    .slice(0, 3)
    .join(' ')
    .slice(0, 200);
}

export type Item =
  | { kind: 'user'; key: string; turnId: string; text: string; images: ImageRef[]; fromTerminal?: boolean; coordination?: CoordinationNote }
  /** The turn's answer: the text after everything the agent did. */
  | { kind: 'assistant'; key: string; turnId: string; text: string; done: boolean }
  /**
   * Everything a turn did on the way to its answer, as one block: thinking, tool calls and the
   * remarks in between, in order. Open while the turn runs, folded to one line once it is done.
   */
  | {
      kind: 'work';
      key: string;
      turnId: string;
      entries: WorkEntry[];
      /** The tool calls among the entries, for counting and for the files they changed. */
      steps: Step[];
      /** From the turn's start to its end; until it ends, to the last thing that happened. */
      startedAt: string;
      endedAt: string | null;
      done: boolean;
      /** False for turns imported from the agent's history: their events were all written at once. */
      timed: boolean;
      /** The user stopped the turn: it reads "你在 N 秒后停止了", like Codex. */
      stopped?: boolean;
    }
  /** A turn the user stopped before it did anything worth a work block. */
  | { kind: 'stopped'; key: string; turnId: string; startedAt: string; endedAt: string; timed: boolean }
  | {
      kind: 'approval';
      key: string;
      turnId: string;
      approvalId: string;
      title: string;
      options: ApprovalOption[];
      decision: { optionId: string } | { cancelled: true } | null;
      /** What is about to be written, when the agent says. */
      diffs: FileDiff[];
      /** The shell command about to run, when the request is for one. */
      command: string | null;
    }
  /** The agent's task list for a turn. Later updates replace the entries in place. */
  | { kind: 'plan'; key: string; turnId: string; entries: PlanEntry[]; done: boolean }
  /** Files a turn changed, shown once after everything else in the turn. */
  | { kind: 'changes'; key: string; turnId: string; files: FileChange[]; added: number; removed: number }
  /** The row under a finished answer. `text` is what "copy" copies; `at` is when the turn ended, where the hub saw it end. */
  | { kind: 'actions'; key: string; turnId: string; text: string; at?: string }
  | { kind: 'error'; key: string; turnId: string | null; message: string }
  /** Where a fork begins: above it is the conversation it was copied from, below it its own. `branch` when it got a worktree. */
  | { kind: 'fork'; key: string; turnId: null; branch?: string };

/**
 * What to show for a failed turn. Failures the daemon marks with a code get an explanation and a
 * way out; anything else is shown as the agent reported it.
 */
export function errorText(data: Record<string, any>): string {
  if (data.code === 'interrupted') return 'hub 重启时这一轮还在运行，被中断了。再发一条消息可以接着做。';
  if (data.code === 'permission_refused') {
    const what = Array.isArray(data.refused) && data.refused.length ? `（${data.refused.join('、')}）` : '';
    return `这一步需要批准${what}，但这个 agent 在后台运行时没法询问，所以拒绝后停下了。把输入框下方的权限切到"完全访问"，再发一次。`;
  }
  return String(data.message ?? 'error');
}

export interface Timeline {
  items: Item[];
  lastSeq: number;
  /** A turn has started and not yet finished (turn.done or turn.error). */
  running: boolean;
  /** An approval is waiting for the user. */
  awaitingApproval: boolean;
  /** The latest context usage the agent reported, if it reports any. */
  usage: Usage | null;
}

/**
 * Text a user picked out of a message, quoted into the text they send. The quote rides along as
 * ordinary Markdown block-quote lines, so the agent, the terminal and every copy of the thread
 * see the same thing with no storage of our own.
 */
export function withQuote(quote: string, body: string): string {
  const quoted = quote
    .trim()
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
  const rest = body.trim();
  return rest ? `${quoted}\n\n${rest}` : quoted;
}

/** A passage picked out of the conversation to talk about, with what the user says about it. */
export interface Note {
  quote: string;
  /** Optional: a passage can go along on its own. */
  comment: string;
}

const NOTE_HEAD = /^\[注释 (\d+)\]$/;
const NOTE_COMMENT = '评论：';

/**
 * A message with numbered notes in front, in plain text any agent reads and can refer back to
 * ("注释 2"):
 *
 *   [注释 1]
 *   > the passage
 *   评论：what the user says about it
 *
 *   the message itself
 */
export function withNotes(notes: Note[], body: string): string {
  const blocks = notes.map((note, i) => {
    const quoted = note.quote
      .trim()
      .split('\n')
      .map((line) => `> ${line}`.trimEnd())
      .join('\n');
    const comment = note.comment.trim().replace(/\s*\n\s*/g, ' ');
    return [`[注释 ${i + 1}]`, quoted, ...(comment ? [NOTE_COMMENT + comment] : [])].join('\n');
  });
  const rest = body.trim();
  return [...blocks, ...(rest ? [rest] : [])].join('\n\n');
}

/** The notes at the start of a sent message, split back out to draw as a chip above the bubble. */
export function splitNotes(text: string): { notes: Note[]; body: string } {
  const lines = text.split('\n');
  const notes: Note[] = [];
  let i = 0;
  let end = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i += 1;
    if (i >= lines.length || !NOTE_HEAD.test(lines[i].trim())) break;
    i += 1;
    const quoted: string[] = [];
    while (i < lines.length && lines[i].startsWith('>')) quoted.push(lines[i++].replace(/^>\s?/, ''));
    let comment = '';
    if (i < lines.length && lines[i].startsWith(NOTE_COMMENT)) comment = lines[i++].slice(NOTE_COMMENT.length).trim();
    notes.push({ quote: quoted.join('\n').trim(), comment });
    end = i;
  }
  if (notes.length === 0) return { notes, body: text };
  return { notes, body: lines.slice(end).join('\n').replace(/^\n+/, '') };
}

/** The leading block-quote lines of a sent message, split back out to draw above the bubble. */
export function splitUserQuote(text: string): { quote: string | null; body: string } {
  const lines = text.split('\n');
  let end = 0;
  while (end < lines.length && lines[end].startsWith('>')) end += 1;
  if (end === 0) return { quote: null, body: text };
  const quote = lines
    .slice(0, end)
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
  const body = lines.slice(end).join('\n').replace(/^\n+/, '');
  return { quote: quote || null, body };
}

// The timeline is rebuilt on every new event. Line counts are the costly part, and the raw
// diff objects in the event log never change, so each one is measured only once.
const diffCache = new WeakMap<object, FileDiff>();

function diffsOf(content: unknown): FileDiff[] {
  if (!Array.isArray(content)) return [];
  const out: FileDiff[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || (part as any).type !== 'diff') continue;
    let diff = diffCache.get(part);
    if (!diff) {
      const raw = part as { path?: unknown; oldText?: unknown; newText?: unknown };
      const oldText = typeof raw.oldText === 'string' ? raw.oldText : null;
      const newText = typeof raw.newText === 'string' ? raw.newText : '';
      diff = { path: String(raw.path ?? ''), oldText, newText, ...diffStats(oldText, newText) };
      diffCache.set(part, diff);
    }
    out.push(diff);
  }
  return out;
}

/** The readable text in a tool's content, leaving out diffs (those are shown as diffs). */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: any) => {
      if (part?.type === 'diff') return '';
      if (part?.type === 'content' && part.content?.type === 'text') return String(part.content.text);
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function outputText(output: unknown): string {
  if (output === undefined || output === null || output === '') return '';
  return typeof output === 'string' ? output : JSON.stringify(output, null, 2);
}

function applyToolData(step: Step, data: Record<string, any>): void {
  if (data.status) step.status = String(data.status);
  if (data.title) step.title = String(data.title);
  const diffs = diffsOf(data.content);
  if (diffs.length) step.diffs = diffs;
  const text = outputText(data.output) || textOfContent(data.content);
  if (text) step.output = text;
}

export function buildTimeline(events: StoredEvent[]): Timeline {
  const items: Item[] = [];
  // Finished turns, with the time each ended. Turns the hub only copied in (imported history,
  // turns synced from the terminal) ended at some earlier time it never saw: those have none.
  const finished = new Map<string, string | undefined>();
  // Turns the user stopped. What they said so far stays on screen, but there is no answer to copy
  // or fork from: the agent may not have kept the turn at all.
  const stopped = new Set<string>();
  const imported = new Set<string>();
  let lastSeq = 0;
  let running = false;
  let usage: Usage | null = null;

  type Work = Extract<Item, { kind: 'work' }>;
  type Answer = Extract<Item, { kind: 'assistant' }>;
  type Plan = Extract<Item, { kind: 'plan' }>;

  // The turn that has started and not ended yet, with the items of it that are still being written.
  const open: { turn: string | null; startedAt: string; work: Work | null; answer: Answer | null; plan: Plan | null } = {
    turn: null,
    startedAt: '',
    work: null,
    answer: null,
    plan: null,
  };

  /**
   * The work block of the open turn, made on first use. Text the agent has said so far turns out
   * to have been a remark on the way, not the answer, so it moves into the block as a note: the
   * block reads top-down in the order things happened, and the answer is what comes after it all.
   */
  const workBlock = (key: string, ts: string): Work => {
    const turnId = open.turn ?? '';
    const { answer } = open;
    if (!open.work) {
      open.work = { kind: 'work', key, turnId, entries: [], steps: [], startedAt: open.startedAt || ts, endedAt: null, done: false, timed: !imported.has(turnId) };
      // Before the remark if there is one, so the note keeps its place on screen.
      const at = answer ? items.indexOf(answer) : -1;
      if (at >= 0) items.splice(at, 0, open.work);
      else items.push(open.work);
    }
    if (answer) {
      if (answer.text.trim()) open.work.entries.push({ kind: 'note', key: answer.key, text: answer.text });
      items.splice(items.indexOf(answer), 1);
      open.answer = null;
    }
    open.work.endedAt = ts;
    return open.work;
  };

  /** Ends the open turn's items. A turn that ended gets its duration; one that was cut off keeps its last sign of life. */
  const closeTurn = (endedAt?: string) => {
    const { work, answer, plan } = open;
    if (work) {
      work.done = true;
      if (endedAt) work.endedAt = endedAt;
      // A turn whose last act was a tool call still said something: its last remark is the answer.
      const last = answer ? -1 : work.entries.map((e) => e.kind).lastIndexOf('note');
      if (last >= 0) {
        const [note] = work.entries.splice(last, 1);
        if (note.kind === 'note') items.splice(items.indexOf(work) + 1, 0, { kind: 'assistant', key: note.key, turnId: work.turnId, text: note.text, done: true });
      }
    }
    if (answer) answer.done = true;
    if (plan) plan.done = true;
    open.turn = null;
    open.work = null;
    open.answer = null;
    open.plan = null;
  };

  for (const ev of events) {
    lastSeq = Math.max(lastSeq, ev.seq);
    const key = `e${ev.seq}`;
    const turn = ev.turnId ?? '';

    switch (ev.type) {
      case 'turn.started': {
        // A turn that never got its ending (the daemon died under it) ends where the next begins,
        // or it would read as working for the rest of the thread.
        if (open.turn !== null) closeTurn();
        open.turn = turn;
        open.startedAt = ev.ts;
        running = true;
        if (ev.data.imported) imported.add(turn);
        const shown = String(ev.data.displayText ?? ev.data.text ?? '');
        const delivered = ev.data.coordination ? coordinationNote(shown) : null;
        items.push({
          kind: 'user',
          key,
          turnId: turn,
          text: delivered ? delivered.text : shown,
          images: Array.isArray(ev.data.images) ? ev.data.images : [],
          ...(ev.data.fromTerminal ? { fromTerminal: true } : {}),
          ...(delivered ? { coordination: delivered.note } : {}),
        });
        break;
      }

      case 'message.delta':
        if (!open.answer) {
          open.answer = { kind: 'assistant', key, turnId: turn, text: '', done: false };
          items.push(open.answer);
        }
        open.answer.text += String(ev.data.text ?? '');
        break;

      case 'plan.updated': {
        const entries: PlanEntry[] = (Array.isArray(ev.data.entries) ? ev.data.entries : [])
          .filter((e: any) => e && typeof e.content === 'string' && e.content.trim())
          .map((e: any) => ({ content: String(e.content), status: String(e.status ?? 'pending') }));
        if (!open.plan) {
          if (entries.length === 0) break;
          open.plan = { kind: 'plan', key, turnId: turn, entries, done: false };
          items.push(open.plan);
        } else {
          open.plan.entries = entries;
        }
        break;
      }

      case 'usage.updated':
        if (typeof ev.data.size === 'number' && Number.isFinite(ev.data.size) && ev.data.size > 0) {
          // An explicit unknown reading invalidates the previous measurement, e.g. after compaction.
          if (ev.data.used === null) usage = null;
          else if (typeof ev.data.used === 'number' && Number.isFinite(ev.data.used) && ev.data.used >= 0) {
            usage = { used: ev.data.used, size: ev.data.size, ...(ev.data.cost ? { cost: ev.data.cost } : {}) };
          }
        }
        break;

      case 'reasoning.delta': {
        const block = workBlock(key, ev.ts);
        const last = block.entries.at(-1);
        // Thinking carries on in the same stretch until the agent does or says something.
        if (last?.kind === 'thought') {
          last.thought.text += String(ev.data.text ?? '');
          last.thought.endedAt = ev.ts;
        } else {
          block.entries.push({ kind: 'thought', thought: { key, text: String(ev.data.text ?? ''), startedAt: ev.ts, endedAt: ev.ts } });
        }
        break;
      }

      case 'tool.start': {
        const block = workBlock(key, ev.ts);
        const step: Step = {
          id: String(ev.data.id),
          title: String(ev.data.title ?? ''),
          kind: String(ev.data.kind ?? 'other'),
          status: String(ev.data.status ?? 'in_progress'),
          input: ev.data.input,
          diffs: [],
          startedAt: ev.ts,
        };
        applyToolData(step, { content: ev.data.content });
        block.entries.push({ kind: 'step', step });
        block.steps.push(step);
        break;
      }

      case 'tool.update':
      case 'tool.end': {
        // A result goes to the row its call started in. Text may have begun meanwhile; that does
        // not make the result a new piece of work. A result whose call is not here updates nothing.
        const { work } = open;
        const step = work?.turnId === turn ? work.steps.find((s) => s.id === String(ev.data.id)) : undefined;
        if (!work || !step) break;
        applyToolData(step, ev.data);
        if (ev.type === 'tool.end') step.endedAt = ev.ts;
        work.endedAt = ev.ts;
        break;
      }

      case 'approval.request': {
        const toolCall = (ev.data.toolCall ?? {}) as { content?: unknown; rawInput?: { command?: unknown } };
        items.push({
          kind: 'approval',
          key,
          turnId: turn,
          approvalId: String(ev.data.approvalId),
          title: String(ev.data.title ?? 'Permission requested'),
          options: (ev.data.options ?? []) as ApprovalOption[],
          decision: null,
          diffs: diffsOf(toolCall.content),
          command: typeof toolCall.rawInput?.command === 'string' ? toolCall.rawInput.command : null,
        });
        break;
      }

      case 'approval.resolved': {
        const id = String(ev.data.approvalId);
        for (const it of items) {
          if (it.kind === 'approval' && it.approvalId === id) it.decision = ev.data.decision ?? null;
        }
        break;
      }

      case 'turn.done':
        if (ev.data.stopReason === 'cancelled') {
          stopped.add(turn);
          if (open.work) open.work.stopped = true;
          else {
            const line: Item = { kind: 'stopped', key, turnId: turn, startedAt: open.startedAt || ev.ts, endedAt: ev.ts, timed: !imported.has(turn) };
            // Above whatever the agent had said, where a work block would stand.
            const at = open.answer ? items.indexOf(open.answer) : -1;
            if (at >= 0) items.splice(at, 0, line);
            else items.push(line);
          }
        }
        closeTurn(ev.ts);
        finished.set(turn, ev.data.imported || ev.data.fromTerminal ? undefined : ev.ts);
        running = false;
        break;

      case 'turn.error':
        closeTurn(ev.ts);
        items.push({ kind: 'error', key, turnId: turn, message: errorText(ev.data) });
        running = false;
        break;

      case 'thread.updated': {
        // Most of these are settings changing, which the thread view does not show. The one a fork
        // ends its copied history with marks where the copy starts going its own way.
        if (typeof ev.data.forkedFrom !== 'string') break;
        const branch = (ev.data.worktree as { branch?: unknown } | undefined)?.branch;
        items.push({ kind: 'fork', key, turnId: null, ...(typeof branch === 'string' ? { branch } : {}) });
        break;
      }

      default:
        break; // thread.created: not rendered in the thread view
    }
  }

  const withSummaries = addTurnSummaries(items, finished, stopped);
  const awaitingApproval = running && items.some((it) => it.kind === 'approval' && it.decision === null);
  return { items: withSummaries, lastSeq, running, awaitingApproval, usage };
}

const compactTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** What the context meter shows: a whole percentage, whether it is getting full, and the detail behind it. */
export function usageSummary(usage: Usage): { percent: number; high: boolean; detail: string } {
  const percent = Math.min(100, Math.max(0, Math.round((usage.used / usage.size) * 100)));
  const cost = usage.cost && usage.cost.amount > 0 ? ` · ${usage.cost.currency === 'USD' ? '$' : `${usage.cost.currency} `}${usage.cost.amount.toFixed(2)}` : '';
  return { percent, high: percent >= 80, detail: `上下文已用 ${compactTokens(usage.used)} / ${compactTokens(usage.size)}${cost}` };
}

const MAX_IMAGE_PATHS = 6;

/**
 * Local image files an answer points at: Markdown images, and paths written out in the text.
 * Web addresses are left alone. Whether a file really exists and is an image is for the daemon to say.
 */
export function imagePathsIn(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    let path = raw.replace(/^file:\/\//, '');
    if (path !== raw) {
      try {
        path = decodeURIComponent(path); // an address, so a space in the name was written as %20
      } catch {
        // Not encoded after all.
      }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return; // http:, data:, …
    if (!IMAGE_FILE.test(path) || found.includes(path) || found.length >= MAX_IMAGE_PATHS) return;
    found.push(path);
  };
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) add(m[1]);
  // A path stands on its own: after a space, a quote, a bracket or CJK punctuation, never mid-word or inside a URL.
  for (const m of text.matchAll(/(?<=^|[\s`'"(（：，。])((?:file:\/\/)?[\p{L}\p{N}_@%+.~\-/]+\.(?:png|jpe?g|gif|webp|svg))(?=$|[\s`'")）：，。,;；!?]|[.:](?:\s|$))/gimu)) {
    add(m[1]);
  }
  return found;
}

/**
 * Appends, once a turn has finished, the files it changed and the action row for its answer.
 * A turn still running gets neither: its live steps are the story on screen. Turns never overlap
 * in a thread, so a turn ends where the next user item begins.
 */
function addTurnSummaries(items: Item[], finished: Map<string, string | undefined>, stopped: Set<string>): Item[] {
  const out: Item[] = [];
  let turnItems: Item[] = [];

  const flush = () => {
    if (turnItems.length === 0) return;
    const turnId = (turnItems[0] as { turnId: string }).turnId;
    out.push(...turnItems);

    // Only edits that went through count; a refused or failed edit changed nothing.
    const files = new Map<string, FileChange>();
    for (const it of turnItems) {
      if (it.kind !== 'work') continue;
      for (const step of it.steps) {
        if (step.status !== 'completed') continue;
        for (const diff of step.diffs) {
          const file = files.get(diff.path) ?? { path: diff.path, added: 0, removed: 0, diffs: [] };
          file.added += diff.added;
          file.removed += diff.removed;
          file.diffs.push(diff);
          files.set(diff.path, file);
        }
      }
    }
    // The summary belongs to the finished turn, not to the work in flight: while the turn runs,
    // the live steps are the story, and a card of totals would read as an ending it has not had.
    if (files.size > 0 && finished.has(turnId)) {
      const list = [...files.values()];
      out.push({
        kind: 'changes',
        key: `changes-${turnId}`,
        turnId,
        files: list,
        added: list.reduce((n, f) => n + f.added, 0),
        removed: list.reduce((n, f) => n + f.removed, 0),
      });
    }

    if (finished.has(turnId) && !stopped.has(turnId)) {
      const answers = turnItems.filter((it): it is Extract<Item, { kind: 'assistant' }> => it.kind === 'assistant' && it.text.trim() !== '');
      const last = answers[answers.length - 1];
      const at = finished.get(turnId);
      if (last) out.push({ kind: 'actions', key: `actions-${turnId}`, turnId, text: last.text, ...(at ? { at } : {}) });
    }
    turnItems = [];
  };

  for (const it of items) {
    // A fork's mark stands between turns: after everything of the turn before it, summaries included.
    if (it.kind === 'user' || it.kind === 'fork') flush();
    if (it.kind === 'fork') out.push(it);
    else turnItems.push(it);
  }
  flush();
  return out;
}

/**
 * When a turn ended, as short as it can be said: the time alone today, the date with it earlier
 * this year, and the year too before that.
 */
export function clockLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${d.getFullYear()}年${date} ${time}`;
}

/** Seconds between the first and last event of a work group, for the "用时 X" label. */
export function durationLabel(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return '';
  const secs = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  if (secs < 60) return `${secs} 秒`;
  return `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
}

/** A tool call's own duration. Short calls keep one decimal, so instant calls do not all read "0 秒". */
export function stepDurationLabel(startedAt?: string, endedAt?: string): string {
  if (!startedAt || !endedAt) return '';
  const secs = Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
  if (secs < 10) return `${secs.toFixed(1)} 秒`;
  if (secs < 60) return `${Math.round(secs)} 秒`;
  return `${Math.floor(secs / 60)} 分 ${Math.round(secs % 60)} 秒`;
}

/** Verbs for the tool kinds the adapters report. `other` gets none: the title already speaks. */
const STEP_VERBS: Record<string, string> = {
  execute: '运行了',
  read: '读取了',
  edit: '编辑了',
  write: '写入了',
  create: '创建了',
  delete: '删除了',
  fetch: '抓取了',
  search: '搜索了',
  move: '移动了',
  switch: '切换了',
};

/** `cd <dir> && …` at the start of a command: where it ran, which the row's detail still shows. */
const LEADING_CD = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*(?=\S)/;

/** The step's one line, verb first: "运行了 npm test". A command is named by what it runs, not by the directory it first steps into. */
export function stepTitle(step: Step): string {
  const verb = STEP_VERBS[step.kind] ?? '';
  const title = step.kind === 'execute' ? step.title.replace(LEADING_CD, '') : step.title;
  return verb ? `${verb} ${title}` : title;
}

/** What the right side of a step row says: the duration when done, the state otherwise. */
export function stepStatusLabel(step: Step): string {
  if (step.status === 'failed') return '失败';
  if (stepActive(step)) return '运行中';
  return stepDurationLabel(step.startedAt, step.endedAt) || '完成';
}

/** A call that has started and not come back yet. */
export const stepActive = (step: Step) => step.status === 'in_progress' || step.status === 'pending';

/**
 * A turn's work as it is laid out: what the agent said on the way, and between those remarks the
 * stretches of thinking and tool calls. A stretch of several calls is shown as one line that
 * counts them, so a long turn reads as what was said, not as every command that was run.
 */
export type WorkSection =
  | { kind: 'note'; key: string; text: string }
  | { kind: 'run'; key: string; entries: Exclude<WorkEntry, { kind: 'note' }>[]; steps: Step[] };

export function workSections(entries: WorkEntry[]): WorkSection[] {
  const out: WorkSection[] = [];
  for (const entry of entries) {
    if (entry.kind === 'note') {
      out.push(entry);
      continue;
    }
    let run = out[out.length - 1];
    if (run?.kind !== 'run') {
      run = { kind: 'run', key: `run-${entry.kind === 'step' ? entry.step.id : entry.thought.key}`, entries: [], steps: [] };
      out.push(run);
    }
    run.entries.push(entry);
    if (entry.kind === 'step') run.steps.push(entry.step);
  }
  return out;
}

/** The kinds of call a summary counts apart, in the order it names them. Anything else is "a tool". */
const RUN_GROUPS: Array<{ kinds: string[]; say: (n: number) => string }> = [
  { kinds: ['read'], say: (n) => `浏览 ${n} 个文件` },
  { kinds: ['search'], say: (n) => `搜索 ${n} 次` },
  { kinds: ['fetch'], say: (n) => `抓取 ${n} 个网页` },
  { kinds: ['edit', 'write'], say: (n) => `编辑 ${n} 个文件` },
  { kinds: ['create'], say: (n) => `创建 ${n} 个文件` },
  { kinds: ['delete'], say: (n) => `删除 ${n} 个文件` },
  { kinds: ['move'], say: (n) => `移动 ${n} 个文件` },
  { kinds: ['execute'], say: (n) => `运行 ${n} 条命令` },
];

/**
 * A stretch of tool calls in one line: "已浏览 2 个文件，搜索 1 次". Also which kind of call
 * there was most of (for the row's icon) and how many failed.
 */
export function runSummary(steps: Step[]): { text: string; kind: string; failed: number } {
  const parts: string[] = [];
  let lead = { kind: 'other', count: 0 };
  const count = (kind: string, n: number, say: (n: number) => string) => {
    if (n === 0) return;
    parts.push(say(n));
    if (n > lead.count) lead = { kind, count: n };
  };
  const known = new Set(RUN_GROUPS.flatMap((g) => g.kinds));
  for (const group of RUN_GROUPS) {
    const calls = steps.filter((s) => group.kinds.includes(s.kind));
    // Three edits to one file changed one file. A call that does not say what it wrote counts as one.
    const files = new Set(calls.flatMap((s) => (s.diffs.length ? s.diffs.map((d) => d.path) : [`call:${s.id}`])));
    count(group.kinds[0], group.kinds[0] === 'edit' ? files.size : calls.length, group.say);
  }
  count('other', steps.filter((s) => !known.has(s.kind)).length, (n) => `调用 ${n} 次工具`);
  return { text: parts.length ? `已${parts.join('，')}` : '', kind: lead.kind, failed: steps.filter((s) => s.status === 'failed').length };
}

/** Thinking text the model wrote as one stream is shown as short paragraphs. */
const ABBREV_END = /(?:e\.g|i\.e|etc|vs|Fig|Eq|No)\.$/i;

/**
 * Splits a thinking stream into readable paragraphs. Paragraph breaks the model did write are
 * kept; sentences that were concatenated without a space ("codebase.Let me") are split apart so
 * the stream does not read as one jammed line. Common abbreviations are left alone.
 */
export function splitThinking(text: string): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.replace(/\s+/g, ' ').trim();
    if (!trimmed) continue;
    const sentences: string[] = [];
    let start = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch !== '.' && ch !== '。' && ch !== '！' && ch !== '？' && ch !== '!' && ch !== '?') continue;
      const after = trimmed[i + 1];
      // A sentence ends where the next word starts a fresh one: a capital, a digit or CJK. Quotes
      // and brackets let ".)Next" style endings through.
      if (!after || !/[A-Z0-9\u4e00-\u9fff""'(（]/.test(after)) continue;
      const soFar = trimmed.slice(start, i + 1);
      if (ABBREV_END.test(soFar.trimEnd())) continue;
      sentences.push(soFar.trim());
      start = i + 1;
    }
    sentences.push(trimmed.slice(start).trim());
    out.push(...sentences.filter(Boolean));
  }
  return out;
}

/** How much of the thinking in progress is shown under "思考中". */
const THINKING_PREVIEW_CHARS = 140;

/**
 * The latest of a thinking stream in progress: the end of its last paragraph, cut to a few lines.
 * It is the end that is shown, because that is where the stream is being written.
 */
export function thinkingPreview(paragraphs: string[]): string {
  const last = paragraphs.at(-1) ?? '';
  if (last.length <= THINKING_PREVIEW_CHARS) return last;
  const tail = last.slice(-THINKING_PREVIEW_CHARS);
  // Start at a word where there is one to start at; CJK text has no spaces and is cut as it is.
  const space = tail.indexOf(' ');
  return `…${space >= 0 && space < 24 ? tail.slice(space + 1) : tail}`;
}

/** Items of one turn, in order. A turn starts at its user item; stray items share the '' group. */
export interface TurnGroup {
  turnId: string;
  items: Item[];
}

/** Groups a timeline into turns, for the "render only the recent turns" collapse. */
export function groupByTurn(items: Item[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (it.kind === 'user' || !last) groups.push({ turnId: it.turnId ?? '', items: [it] });
    else last.items.push(it);
  }
  return groups;
}

/** What the ruler's preview popup shows for one turn: the question and how the answer starts. */
export interface TurnPreview {
  question: string;
  answer: string;
}

/** Previews keyed by turn id, built from the same items the ruler marks. */
export function turnPreviews(items: Item[]): Map<string, TurnPreview> {
  const out = new Map<string, TurnPreview>();
  for (const group of groupByTurn(items)) {
    const question = group.items.find((it): it is Extract<Item, { kind: 'user' }> => it.kind === 'user');
    if (!question) continue;
    const answer = group.items
      .filter((it): it is Extract<Item, { kind: 'assistant' }> => it.kind === 'assistant')
      .map((it) => it.text.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 140);
    out.set(group.turnId, { question: question.text.trim(), answer });
  }
  return out;
}

/** The conversation as Markdown, for "copy conversation". Tool output is left out; file changes are listed. */
export function toMarkdown(title: string, items: Item[]): string {
  const parts: string[] = [`# ${title}`];
  for (const it of items) {
    switch (it.kind) {
      case 'user': {
        const images = it.images.length ? `\n\n（附 ${it.images.length} 张图片）` : '';
        parts.push(`## 你\n\n${it.text}${images}`.trimEnd());
        break;
      }
      case 'assistant':
        if (it.text.trim()) parts.push(it.text.trim());
        break;
      case 'changes':
        parts.push(
          [`**已更改 ${it.files.length} 个文件** (+${it.added} −${it.removed})`, ...it.files.map((f) => `- \`${f.path}\` +${f.added} −${f.removed}`)].join('\n'),
        );
        break;
      case 'error':
        parts.push(`> 出错：${it.message}`);
        break;
      default:
        break;
    }
  }
  return parts.join('\n\n') + '\n';
}
