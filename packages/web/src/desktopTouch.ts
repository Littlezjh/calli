// The arithmetic of the desktop on a touch screen: how big the picture is at a zoom, where the
// view scrolls to so a pinch stays under the fingers, and how a finger on the touchpad becomes
// pointer motion. Kept apart from the panel so it can be tested without a browser.

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

export interface Size {
  w: number;
  h: number;
}

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The desktop scaled to fit the box whole, keeping its shape. */
export function fitSize(desktop: Size, box: Size): Size {
  if (!desktop.w || !desktop.h || !box.w || !box.h) return { w: box.w, h: box.h };
  const s = Math.min(box.w / desktop.w, box.h / desktop.h);
  return { w: desktop.w * s, h: desktop.h * s };
}

/** The zoom at which the picture fills the box's height (a wide desktop on an upright phone). */
export function fillZoom(desktop: Size, box: Size): number {
  const fit = fitSize(desktop, box);
  return clampZoom(Math.max(box.w / fit.w, box.h / fit.h));
}

/**
 * Where to scroll so the point under `focal` (relative to the box) stays there while the zoom
 * goes from z0 to z1. `offset` is how far the picture sits from the box's start when it is
 * smaller than the box and centred.
 */
export function scrollForZoom(scroll: number, focal: number, z0: number, z1: number, offset0 = 0, offset1 = 0): number {
  const content = (scroll + focal - offset0) / z0;
  return Math.max(0, content * z1 + offset1 - focal);
}

/** How far the pointer moves on the desktop for a finger's move: slow is precise, fast covers ground. */
export function pointerDelta(fingerPx: number, ms: number, desktopPerScreenPx: number): number {
  const speed = ms > 0 ? Math.abs(fingerPx) / ms : 0;
  // From half a desktop pixel per screen pixel at a crawl to the picture's own scale and a bit when flicked.
  const gain = Math.min(1.4, 0.5 + speed * 0.9);
  return fingerPx * desktopPerScreenPx * gain;
}

/** A touch that ended without travelling far, quickly enough to be a tap. */
export const TAP_MS = 250;
export const TAP_SLOP_PX = 10;
export const LONG_PRESS_MS = 450;

export function isTap(ms: number, travelled: number): boolean {
  return ms < TAP_MS && travelled < TAP_SLOP_PX;
}

/** Two fingers: spreading or pinching zooms; moving together scrolls. Undecided until one is clear. */
export function twoFingerKind(startDistance: number, distance: number, midMoved: number): 'zoom' | 'scroll' | null {
  if (Math.abs(distance - startDistance) > 30) return 'zoom';
  if (midMoved > 12) return 'scroll';
  return null;
}
