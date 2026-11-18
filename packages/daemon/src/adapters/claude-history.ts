import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ForkPoint } from './types.js';

/** What Claude writes into its session as a user message when the user stops it. */
const INTERRUPT_NOTE = /^\[Request interrupted by user( for tool use)?\]$/;

interface Entry {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  /** On a compaction boundary: the message the conversation stood at before it. */
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string; subkind?: string };
  message?: { id?: string; content?: unknown };
}

const blocks = (entry: Entry): Array<Record<string, unknown>> => {
  const content = entry.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object') : [];
};

/**
 * The turns of a whole Claude conversation, read from its session file. The agent's own replay
 * starts at the last compaction, because the SDK follows `parentUuid` and a compaction starts a new
 * chain; the file still has everything, and the boundary says where the old chain ends
 * (`logicalParentUuid`). Following both gives every turn, so a copy can stop at any of them.
 *
 * A turn is a user message and what followed it, the way the replay groups them: tool results,
 * notes the agent wrote itself, compaction summaries, task notifications and sidechains are not the user's, and
 * branches that were rewound away are not on the chain.
 */
export function claudeForkPoints(jsonl: string): ForkPoint[] {
  const entries = new Map<string, Entry>();
  // The messages in the order they were written, and how many came before each entry.
  const messages: Entry[] = [];
  const before = new Map<string, number>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.uuid !== 'string') continue;
    entries.set(entry.uuid, entry);
    before.set(entry.uuid, messages.length);
    if ((entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain) messages.push(entry);
  }

  // From the newest message back to the first. A compaction boundary names the message it
  // followed, but not always one the file has; then the message written just before it is meant.
  const chain: Entry[] = [];
  const seen = new Set<string>();
  const parentOf = (entry: Entry): Entry | undefined => {
    const parent = entries.get(entry.parentUuid ?? entry.logicalParentUuid ?? '');
    if (parent || entry.parentUuid || entry.type !== 'system') return parent;
    return messages[(before.get(entry.uuid!) ?? 0) - 1];
  };
  for (let at = messages.at(-1); at?.uuid && !seen.has(at.uuid); at = parentOf(at)) {
    seen.add(at.uuid);
    chain.push(at);
  }
  chain.reverse();

  const turns: ForkPoint[] = [];
  let current: ForkPoint | null = null;
  let answered = false;
  let ended = false;
  for (const entry of chain) {
    if (entry.isSidechain) continue;
    const parts = blocks(entry);
    if (entry.type === 'assistant') {
      answered = true;
      // The last thing said in a turn is where a copy that ends with it stops.
      if (current && parts.some((b) => b.type === 'text' || b.type === 'thinking')) current.forkRef = entry.message?.id || entry.uuid;
      continue;
    }
    if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || parts.some((b) => b.type === 'tool_result')) continue;
    // The CLI tells the model that a background task stopped; the replay shows that as status, not as a turn.
    if (entry.origin?.kind === 'task-notification' && !entry.origin.subkind) continue;
    const text = parts.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
    if (INTERRUPT_NOTE.test(text.trim())) {
      ended = true;
      continue;
    }
    if (current && !answered && !ended) {
      current.text += `\n\n${text}`;
      continue;
    }
    current = { text };
    turns.push(current);
    answered = false;
    ended = false;
  }
  return turns;
}

/**
 * Names a Claude session the way the CLI's `/rename` does: a `custom-title` record appended to the
 * transcript, and the `<sessionId>/custom-title.json` beside it that the resume list reads when
 * the record has scrolled out of the file's tail. A CLI that has the session open adopts the
 * record when it next writes its metadata. Nothing is appended when the tail already ends on
 * this title.
 */
export async function writeClaudeTitle(sessionPath: string, sessionId: string, title: string): Promise<void> {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  const record = JSON.stringify({ type: 'custom-title', customTitle: clean, sessionId });
  const handle = await open(sessionPath, 'r');
  let tail = '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    tail = buffer.toString('utf8');
  } finally {
    await handle.close();
  }
  let current: string | undefined;
  for (const line of tail.split('\n')) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; customTitle?: unknown };
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') current = entry.customTitle;
    } catch { /* a torn or partial line */ }
  }
  if (current !== clean) await appendFile(sessionPath, `${tail === '' || tail.endsWith('\n') ? '' : '\n'}${record}\n`);
  const sidecar = join(dirname(sessionPath), basename(sessionPath, '.jsonl'), 'custom-title.json');
  await mkdir(dirname(sidecar), { recursive: true, mode: 0o700 });
  const temporary = `${sidecar}.tmp.${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temporary, JSON.stringify({ customTitle: clean }), { flag: 'wx', mode: 0o600 });
    await rename(temporary, sidecar);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
