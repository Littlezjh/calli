import { t } from './i18n';
import type { TeamStatus } from './api';

export type PetClip = 'idle' | 'thinking' | 'success' | 'poke' | 'head_pat' | 'idle_yawn';

/** How she shows up away from the desk: always there, only when something needs the person, or off. */
export type PetPresence = 'always' | 'event' | 'off';

/** A thread as her status bar reads it. Only the fields the bar needs; `Thread` satisfies this. */
export interface PetThreadLike {
  status: 'idle' | 'running' | 'error';
  waiting: boolean;
  unread: boolean;
  updatedAt: string;
  coordination?: { team?: { status: TeamStatus } } | null;
}

/** What a thread is doing, as the bar names it: waiting for the person, stuck, finished and unread, running, or nothing. */
export type PetThreadState = 'waiting' | 'failed' | 'review' | 'running' | 'idle';

/** The order the bar and the tray put them in: what needs the person first. */
export const PET_THREAD_ORDER: Record<PetThreadState, number> = { waiting: 0, failed: 1, review: 2, running: 3, idle: 4 };

/** Reads a thread's state from what the page already holds; a team member's word outranks the thread's own. */
export function petThreadState(thread: PetThreadLike): PetThreadState {
  const team = thread.coordination?.team?.status;
  if (team === 'awaiting_confirm' || thread.waiting) return 'waiting';
  if (team === 'needs_attention' || thread.status === 'error') return 'failed';
  if (thread.unread) return 'review';
  if (team === 'running' || thread.status === 'running') return 'running';
  return 'idle';
}

/** The threads worth a place under her, most needing first; what changed most recently breaks ties. */
export function petNotableThreads<T extends PetThreadLike>(threads: readonly T[]): T[] {
  return threads
    .map(thread => ({ thread, state: petThreadState(thread) }))
    .filter(entry => entry.state !== 'idle')
    .sort((a, b) => PET_THREAD_ORDER[a.state] - PET_THREAD_ORDER[b.state] || b.thread.updatedAt.localeCompare(a.thread.updatedAt))
    .map(entry => entry.thread);
}

/** A reply starts fading after this long and is gone a moment after that. */
export const PET_BUBBLE_FADE_MS = 8_000;
export const PET_BUBBLE_GONE_MS = 11_000;

/** Keeps her whole self inside the viewport, however it is resized. */
export function petClampPosition(x: number, y: number, w: number, h: number, viewW: number, viewH: number): { x: number; y: number } {
  const maxX = Math.max(8, viewW - w - 8);
  const maxY = Math.max(8, viewH - h - 8);
  return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}

/** What the desk knows when she speaks. Null until the matters have loaded: no data is not "nothing urgent". */
export type PetGreeting = { you: number; first: string | null } | null;

/** The size of every frame in the artwork. */
export const PET_FRAME = { width: 412, height: 344 };
/** Frames kept decoded: the one on screen and those just ahead, about half a megabyte each. */
export const PET_RING_SIZE = 8;
export const PET_WEBP_QUALITY = 0.9;
export const PET_CACHE_PREFIX = 'calli-pet-';

/** Named after the artwork and how it is cleaned, so changing either starts over. */
export function petCacheName(id: string, commit: string): string {
  return `${PET_CACHE_PREFIX}${id}-${commit}-1`;
}

/** The license that came with the artwork, at the commit the hub pinned. */
export function petLicenseUrl(commit: string): string {
  return `https://github.com/QCYTSN/dsh-dafeiyu/blob/${commit}/assets/dsh-pet-LICENSE.txt`;
}

/** Never fetched: Cache Storage only wants an address of this origin to file the frame under. */
export function petCacheKey(clip: PetClip, index: number): string {
  return `/calli-pet-frames/${clip}/${index}.webp`;
}

/** The frames to keep decoded: this one and the next ones, wrapping if it loops, stopping at the end if not. */
export function petRing(frame: number, frames: number, loop: boolean, size: number): number[] {
  const ring: number[] = [];
  for (let step = 0; step < Math.min(size, frames); step += 1) {
    if (!loop && frame + step >= frames) break;
    ring.push((frame + step) % frames);
  }
  return ring;
}

/** The frame after this one, or null when a one-shot clip has played out. */
export function nextPetFrame(frame: number, frames: number, loop: boolean): number | null {
  if (frame + 1 < frames) return frame + 1;
  return loop ? 0 : null;
}

/** How long she stays awake between yawns: 40 to 80 seconds. */
export function yawnDelay(random: () => number = Math.random): number {
  return 40_000 + random() * 40_000;
}

/** Local date, so "once a day" turns over at the person's own midnight. */
export function petDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What she says on the first visit of the day: what needs the person, or something light when nothing does. */
export function petGreetingLine(greeting: NonNullable<PetGreeting>, now: Date): string {
  if (greeting.you > 0) return t('pet.greeting', greeting.you, greeting.first);
  const calm = [t('pet.calm1'), t('pet.calm2'), t('pet.calm3')];
  return calm[now.getDate() % calm.length];
}

/** The openings offered above the keyboard. Each is a label and the words it puts in the field. */
export function petStarters(): { label: string; start: string }[] {
  return [
    { label: t('pet.urgent'), start: t('pet.urgentStart') },
    { label: t('pet.note'), start: t('pet.noteStart') },
    { label: t('pet.done'), start: t('pet.doneStart') },
  ];
}

/** Puts an opening in front of what is written, in place of another opening if one is already there. */
export function applyPetStarter(draft: string, start: string, starts: readonly string[]): string {
  const opening = starts.find((s) => draft.startsWith(s));
  return start + (opening ? draft.slice(opening.length) : draft);
}

/** A message on its way to the Router. Kept across pages, because leaving the desk must not lose the answer. */
export interface PetPending {
  /** The Router's last reply when this was sent: only something newer answers it. */
  since: string | null;
  threadId: string;
  sentAt: number;
  /** What was said, to send again if no answer comes. */
  text: string;
}

/** After this long she says she is still at it; the wait goes on. */
export const PET_LATE_MS = 2 * 60_000;
/** After this long the answer is left in the conversation. */
export const PET_GIVE_UP_MS = 30 * 60_000;
/** Polls in a row with the Router at rest and nothing new before it counts as having ended without a reply. */
export const PET_QUIET_POLLS = 6;
/** Failed polls in a row before she says she cannot reach the hub. */
export const PET_LOST_POLLS = 5;

export function parsePetPending(raw: string | null, now: number): PetPending | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PetPending>;
    if (typeof value.threadId !== 'string' || typeof value.sentAt !== 'number') return null;
    if (now - value.sentAt > PET_GIVE_UP_MS) return null;
    return { since: typeof value.since === 'string' ? value.since : null, threadId: value.threadId, sentAt: value.sentAt, text: typeof value.text === 'string' ? value.text : '' };
  } catch {
    return null;
  }
}

export interface PetRouterReading {
  threadId: string | null;
  status: string | null;
  lastReply: string | null;
  lastReplyAt: string | null;
}

export type PetWait = 'waiting' | 'quiet' | 'failed' | { reply: string };

/** Reads one poll of the Router: answered, gone wrong, or still to wait for. `restingPolls` counts this one. */
export function readPetRouter(router: PetRouterReading, since: string | null, restingPolls: number): PetWait {
  const fresh = Boolean(router.lastReplyAt && router.lastReply) && (!since || Date.parse(router.lastReplyAt!) > Date.parse(since));
  if (fresh) return { reply: petReplyPreview(router.lastReply!) };
  if (router.status === 'error') return 'failed';
  if (router.status !== 'running' && restingPolls >= PET_QUIET_POLLS) return 'quiet';
  return 'waiting';
}

/**
 * The artwork carries a sheet of nearly invisible black (alpha 1 to 3) across every frame, which shows
 * as a faint box on a pale page. Clears it in place; real edges and sparkles are well above this.
 */
export function clearPetHaze(pixels: Uint8ClampedArray): void {
  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
    if (pixels[alpha] <= 3) pixels[alpha] = 0;
  }
}

/** How much of her height, from the top of her hair, a small portrait keeps: head and upper body. */
export const PET_BUST = 0.68;

/**
 * The box around her head and upper body in one frame, trimmed to her outline: nothing but the
 * artwork, no margin of empty canvas. Null for a frame with nothing in it.
 */
export function petBustBox(pixels: Uint8ClampedArray, width: number, height: number, keep = PET_BUST): { x: number; y: number; width: number; height: number } | null {
  const solid = (x: number, y: number) => pixels[(y * width + x) * 4 + 3] > 24;
  let top = -1, bottom = -1;
  for (let y = 0; y < height && top < 0; y++) for (let x = 0; x < width; x++) if (solid(x, y)) { top = y; break; }
  if (top < 0) return null;
  for (let y = height - 1; y >= top && bottom < 0; y--) for (let x = 0; x < width; x++) if (solid(x, y)) { bottom = y; break; }
  const end = top + Math.max(1, Math.round((bottom - top + 1) * keep));
  let left = width, right = -1;
  for (let y = top; y < end; y++) for (let x = 0; x < width; x++) if (solid(x, y)) { if (x < left) left = x; if (x > right) right = x; }
  return { x: left, y: top, width: right - left + 1, height: end - top };
}

/** The technical part of a failure, for the details line: never the addresses in it. Null when nothing is left. */
export function petErrorDetail(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const detail = message.replace(/\b[a-z]+:\/\/\S+/gi, '').replace(/[\s:：,，-]+$/, '').trim();
  return detail || null;
}

export type PetReplyPart = { text: string; todoId?: string };

/** Splits a reply around the matters it names, longest name first, so each can be opened from the bubble. */
export function petReplyParts(reply: string, todos: readonly { id: string; text: string }[]): PetReplyPart[] {
  const names = todos.filter((todo) => Array.from(todo.text).length >= 2).sort((a, b) => b.text.length - a.text.length);
  const parts: PetReplyPart[] = [];
  let rest = reply;
  while (rest) {
    let first: { at: number; todo: { id: string; text: string } } | null = null;
    for (const todo of names) {
      const at = rest.indexOf(todo.text);
      if (at >= 0 && (!first || at < first.at)) first = { at, todo };
    }
    if (!first) { parts.push({ text: rest }); break; }
    if (first.at > 0) parts.push({ text: rest.slice(0, first.at) });
    parts.push({ text: first.todo.text, todoId: first.todo.id });
    rest = rest.slice(first.at + first.todo.text.length);
  }
  return parts;
}

/** Keep the bubble short without cutting a surrogate pair. The Router is asked for 100 characters, not forced to. */
export function petReplyPreview(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length > 100 ? chars.slice(0, 99).join('') + '…' : chars.join('');
}
