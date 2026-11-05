import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * What a thread has produced, gathered over all its turns for the overview beside the conversation:
 * the files its agents changed, as they reported them, and the pictures and files its answers point
 * at. Only names and counts; diffs, pictures and file text are read when one is opened.
 */
export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  /** The thread's first change to it wrote it from nothing. */
  created: boolean;
  /** How many turns changed it, and the last of them. */
  turns: number;
  turnId: string;
  at: string;
}

export interface MentionedFile {
  path: string;
  /** The last answer that named it. */
  turnId: string;
  at: string;
}

export interface ThreadOutputs {
  changes: { files: ChangedFile[]; added: number; removed: number; total: number };
  images: MentionedFile[];
  files: MentionedFile[];
  /** The log position this was read at, so a caller can tell a fresh list from a stale one. */
  seq: number;
}

/** Enough for any overview; a thread that wrote more is summarised by `total`. */
export const MAX_OUTPUT_ITEMS = 200;

export const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|svg)$/i;
/** Pictures the user sent, which the agent opens by their stored path: inputs, not outputs. */
const ATTACHMENT = /\/attachments\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z]+$/i;

export interface DiffEvent {
  turnId: string | null; seq: number; ts: string;
  data: { id: string; files?: Array<{ path: string; added: number; removed: number; created: boolean }> };
}
export interface Answer { turnId: string; seq: number; ts: string; text: string }
interface OrderedChange extends ChangedFile { seq: number }

/** A path as the thread names it, made absolute against where the thread runs. */
function absolute(path: string, cwd: string, cwdReal: string): string {
  if (!isAbsolute(path)) return resolve(cwdReal, path);
  const inside = relative(cwd, path);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside) ? resolve(cwdReal, inside) : resolve(path);
}

export function changedFiles(events: DiffEvent[], cwd: string, cwdReal = cwd): Omit<ThreadOutputs['changes'], 'files'> & { files: OrderedChange[] } {
  // A tool call reports its diffs again with each update; the last report is what it did.
  const calls = new Map<string, { turnId: string; seq: number; ts: string; diffs: NonNullable<DiffEvent['data']['files']> }>();
  for (const ev of events) {
    if (!ev.turnId) continue;
    const diffs = ev.data.files?.filter(f => f.path) ?? [];
    if (diffs.length) calls.set(`${ev.turnId}\0${ev.data.id}`, { turnId: ev.turnId, seq: ev.seq, ts: ev.ts, diffs });
  }
  const files = new Map<string, OrderedChange & { turnSet: Set<string> }>();
  for (const call of calls.values()) {
    for (const d of call.diffs) {
      const path = absolute(d.path, cwd, cwdReal);
      const { added, removed } = d;
      const file = files.get(path);
      if (!file) {
        files.set(path, { path, added, removed, created: d.created, turns: 1, turnId: call.turnId, at: call.ts, seq: call.seq, turnSet: new Set([call.turnId]) });
        continue;
      }
      file.added += added;
      file.removed += removed;
      file.turnSet.add(call.turnId);
      file.turns = file.turnSet.size;
      if (call.seq >= file.seq) { file.at = call.ts; file.turnId = call.turnId; file.seq = call.seq; }
    }
  }
  const all = [...files.values()].map(({ turnSet: _turns, ...file }) => file).sort((a, b) => b.seq - a.seq || a.path.localeCompare(b.path));
  return {
    files: all,
    added: all.reduce((n, f) => n + f.added, 0),
    removed: all.reduce((n, f) => n + f.removed, 0),
    total: all.length,
  };
}

const LINK = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\\\s()]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\s*\)/g;
// Bare angle references need a file URL, another path segment or a filename extension.
const QUOTED = /([`'"])((?:file:\/\/)?\/[^\r\n]*?)\1|<((?:file:\/\/\/|\/[^/>\r\n]+[/.])[^>\r\n]+)>/gi;
const ABSOLUTE = /(?<=^|[\s`'"(（：，。])((?:file:\/\/)?\/[^\s`'"<>()[\]，。；！？]+)/gi;
/** A path written out in the prose: after a space, quote or bracket, never mid-word or inside a URL. */
const BARE = /(?<=^|[\s`'"(（：，。])((?:file:\/\/)?[\p{L}\p{N}_@%+.~\-/]+\.[\p{L}\p{N}]{1,8})(?=$|[\s`'")）：，。,;；!?]|[.:](?:\s|$)|:\d)/gmu;

/** The local paths an answer names: links of any kind, and paths standing on their own. */
export function pathsIn(text: string): Array<{ path: string; linked: boolean }> {
  const out: Array<{ path: string; linked: boolean }> = [];
  const add = (raw: string, linked: boolean) => {
    let path = raw.trim();
    const fileUrl = /^file:\/\//i.test(path);
    if (fileUrl) path = path.slice(7);
    if (fileUrl && !isAbsolute(path)) return;
    if (linked || fileUrl) {
      try { path = decodeURIComponent(path); } catch { /* A literal percent sign. */ }
    }
    path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '');
    if (!path || path.startsWith('#') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return;
    out.push({ path, linked });
  };
  const mask = (value: string) => '\u0000'.repeat(value.length);
  let rest = text.replace(LINK, (match: string, angle: string | undefined, plain: string) => {
    add((angle ?? plain).replace(/\\([\\()[\]<> ])/g, '$1'), true);
    return mask(match);
  });
  rest = rest.replace(QUOTED, (match: string, _quote: string, quoted: string | undefined, angle: string) => {
    add(quoted ?? angle, false);
    return mask(match);
  });
  rest = rest.replace(ABSOLUTE, (match: string, path: string) => {
    add(path.replace(/[.,;!?：]+$/, ''), false);
    return mask(match);
  });
  for (const m of rest.matchAll(BARE)) add(m[1], false);
  return out;
}

/**
 * Pictures are every image path an answer names. Files are what it hands over on purpose: a link,
 * or an absolute path written out; a relative name in passing ("see src/a.ts") is talk, not output.
 * Files the thread created count as well. Sorting is stable, so an answer stays after the edits of its turn.
 */
export function mentionedFiles(answers: Answer[], cwd: string, created: OrderedChange[] = [], cwdReal = cwd): { images: MentionedFile[]; files: MentionedFile[] } {
  const images = new Map<string, MentionedFile>();
  const files = new Map<string, MentionedFile>();
  // What the thread wrote from nothing is output too, named or not, as Codex lists generated files.
  const made = created.filter(f => f.created).map(f => ({ turnId: f.turnId, seq: f.seq, ts: f.at, path: f.path }));
  const events = [...answers.map(a => ({ ...a, made: null as string | null })), ...made.map(m => ({ turnId: m.turnId, seq: m.seq, ts: m.ts, text: '', made: m.path }))]
    .sort((a, b) => a.seq - b.seq);
  for (const answer of events) {
    if (answer.made) {
      if (ATTACHMENT.test(answer.made)) continue;
      const into = IMAGE_PATH.test(answer.made) ? images : files;
      into.delete(answer.made);
      into.set(answer.made, { path: answer.made, turnId: answer.turnId, at: answer.ts });
      continue;
    }
    for (const { path: raw, linked } of pathsIn(answer.text)) {
      const path = absolute(raw, cwd, cwdReal);
      if (ATTACHMENT.test(path)) continue;
      const into = IMAGE_PATH.test(path) ? images : linked || isAbsolute(raw) ? files : null;
      if (!into) continue;
      into.delete(path); // Named again: it moves to the newest.
      into.set(path, { path, turnId: answer.turnId, at: answer.ts });
    }
  }
  const newest = (m: Map<string, MentionedFile>) => [...m.values()].reverse().slice(0, MAX_OUTPUT_ITEMS);
  return { images: newest(images), files: newest(files) };
}
