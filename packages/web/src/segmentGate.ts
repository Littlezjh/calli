/** Reading a chain one segment to a page: how far an edge has to be dragged before the page turns. */

export type GateDir = 1 | -1;
/** What drags: a finger anywhere, or a mouse pressed on empty space. A wheel or trackpad only scrolls and never turns the page. */
export type GateInput = 'touch' | 'mouse';

/** Needed pull (the finger or mouse moves 1 / DRAG_DAMP times this far). */
export const TOUCH_NEED = 150;
export const MOUSE_NEED = 170;
export const DRAG_DAMP = 0.5;
/** The page follows the pull by this much, up to the threshold. */
export const PAGE_FOLLOW = 0.35;

export interface Pull { dir: GateDir | 0; amount: number }
export const noPull: Pull = { dir: 0, amount: 0 };

export const gateNeed = (input: GateInput): number => input === 'touch' ? TOUCH_NEED : MOUSE_NEED;

/** 0 to 1: how much of the way the pull has gone. */
export const pullProgress = (pull: Pull, input: GateInput): number => pull.dir ? Math.min(1, pull.amount / gateNeed(input)) : 0;
export const pullReady = (pull: Pull, input: GateInput): boolean => pullProgress(pull, input) >= 1;

/** A drag from `from` to `to` past an edge, as damped pull: dragging up is toward the next segment. */
export function dragPull(from: number, to: number, dir: GateDir): number {
  const moved = dir > 0 ? from - to : to - from;
  return Math.max(0, moved) * DRAG_DAMP;
}

/** How far the page is shifted by the pull: it follows, with a cap. */
export const pageShift = (pull: Pull, input: GateInput): number => pull.dir ? -pull.dir * Math.min(pull.amount, gateNeed(input)) * PAGE_FOLLOW : 0;

export interface Edges { atTop: boolean; atBottom: boolean; hasPrev: boolean; hasNext: boolean }

/** Which way a drag that scrolls by `delta` (positive scrolls down) would turn the page, if it is at that edge with a segment beyond. */
export function gateDirection(delta: number, edges: Edges): GateDir | 0 {
  if (delta > 0 && edges.atBottom && edges.hasNext) return 1;
  if (delta < 0 && edges.atTop && edges.hasPrev) return -1;
  return 0;
}

interface PressTarget { closest(selector: string): unknown; childNodes: ArrayLike<{ nodeType: number; textContent: string | null }> }
const TEXTUAL = 'a, button, input, textarea, select, label, summary, pre, code, img, video, canvas, svg, table, p, li, h1, h2, h3, h4, h5, h6, blockquote, [contenteditable], [role="button"], [role="dialog"], [class*="markdown"]';

/**
 * Whether a mouse press may start a drag between segments: only on empty space (beside the text, in
 * the room under a short segment), never on words, code, buttons, links or fields, and not while
 * something is selected: there a drag belongs to the text.
 */
export function blankPress(target: PressTarget | null, selectionCollapsed: boolean): boolean {
  if (!target || !selectionCollapsed || target.closest(TEXTUAL)) return false;
  return !Array.from(target.childNodes).some(node => node.nodeType === 3 && Boolean(node.textContent?.trim()));
}
