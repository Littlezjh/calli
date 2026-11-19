/** Reading a chain one segment per page: how far past an edge the person has to go before the page turns. */

export type GateDir = 1 | -1;
/** What the pull is made by: a finger (damped, released by lifting it) or a wheel or key (released when it stops). */
export type GateInput = 'touch' | 'wheel' | 'key';

export const TOUCH_NEED = 110;
export const WHEEL_NEED = 260;
export const TOUCH_DAMP = 0.6;
/** A wheel has no release: it counts as let go once it has been still this long. */
export const WHEEL_IDLE_MS = 250;
/** Two wheel events closer than this belong to one flick (or its momentum). */
export const WHEEL_STREAM_GAP_MS = 120;
/** Past the edge a key press counts for half the way; the second one fills it. */
export const KEY_STEP = 0.5;

export interface Pull { dir: GateDir | 0; amount: number }
export const noPull: Pull = { dir: 0, amount: 0 };

export const gateNeed = (input: GateInput): number => input === 'touch' ? TOUCH_NEED : WHEEL_NEED;

/** Adds to the pull in one direction; going the other way starts over. */
export function addPull(pull: Pull, dir: GateDir, amount: number): Pull {
  return pull.dir === dir ? { dir, amount: pull.amount + Math.abs(amount) } : { dir, amount: Math.abs(amount) };
}

/** 0 to 1: how much of the way the pull has gone. */
export const pullProgress = (pull: Pull, input: GateInput): number => pull.dir ? Math.min(1, pull.amount / gateNeed(input)) : 0;
export const pullReady = (pull: Pull, input: GateInput): boolean => pullProgress(pull, input) >= 1;

/** A finger that went from `from` to `to` past an edge, as pull: dragging up is toward the next segment. */
export function touchPull(from: number, to: number, dir: GateDir): number {
  const moved = dir > 0 ? from - to : to - from;
  return Math.max(0, moved) * TOUCH_DAMP;
}

export interface Edges { atTop: boolean; atBottom: boolean; hasPrev: boolean; hasNext: boolean }

/** Which way a move of `delta` (positive scrolls down) would turn the page, if it is at that edge with a segment beyond. */
export function gateDirection(delta: number, edges: Edges): GateDir | 0 {
  if (delta > 0 && edges.atBottom && edges.hasNext) return 1;
  if (delta < 0 && edges.atTop && edges.hasPrev) return -1;
  return 0;
}

/**
 * Whether a wheel event may count toward a pull. A flick that scrolls to the edge keeps sending
 * events as it fades; only a stream that began at the edge, after the reading had been still, is a
 * deliberate push on it.
 */
export function wheelCounts(streamStartedAtEdge: boolean): boolean { return streamStartedAtEdge; }

/** The segment before the first one, after it, or none: the position shown in the bar, one-based. */
export function segmentPosition(keys: string[], key: string): { index: number; total: number } | null {
  const at = keys.indexOf(key);
  return at < 0 ? null : { index: at + 1, total: keys.length };
}
