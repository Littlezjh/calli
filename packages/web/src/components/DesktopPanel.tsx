/// <reference path="../novnc.d.ts" />
// The machine's Linux desktop, through the VNC server already running there. View only until the
// person takes control, so a stray touch on a phone cannot disturb an agent working on it. The
// picture is scaled to the window; the desktop's own resolution is never changed from here.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import type { Api } from '../api';
import { copyText } from '../clipboard';
import { clampZoom, fillZoom, fitSize, isTap, LONG_PRESS_MS, pointerDelta, scrollForZoom, TAP_SLOP_PX, twoFingerKind, type Size } from '../desktopTouch';
import { useIsTouch } from '../hooks';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { Popover } from './Popover';
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconClipboard, IconClose, IconDesktop, IconFit, IconKeyboard, IconMinus, IconPointer, IconSend, IconTouchpad } from './icons';

interface Props {
  api: Api;
  /** Minimized: out of sight, still connected, so coming back needs no reconnect. */
  hidden?: boolean;
  onMinimize: () => void;
  /** Disconnects. */
  onClose: () => void;
}

type Phase = 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'failed';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// X keysyms for the keys a phone keyboard lacks, and Control for the shortcuts sent on a Mac's behalf.
const KEY = { esc: 0xff1b, tab: 0xff09, backspace: 0xff08, enter: 0xff0d, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, ctrl: 0xffe3 };

/** On a Mac, ⌘ is the shortcut key; the Linux desktop's is Control. */
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** How long after Ctrl/⌘+C the desktop's new clipboard is still copied here on its own. */
const COPY_WINDOW_MS = 3000;
/** Two taps this close in time are a double tap. */
const DOUBLE_TAP_MS = 300;
/** On the touchpad, the view follows the pointer to keep it this far inside the edge. */
const FOLLOW_MARGIN = 48;
const ROTATE_HINT_KEY = 'rah.desktop.rotateHint';

const rotateHintSeen = () => {
  try {
    return localStorage.getItem(ROTATE_HINT_KEY) === '1';
  } catch {
    return false;
  }
};

/** The keysym that types a character: Latin-1 is its own code, the rest of Unicode is offset. */
const keysym = (ch: string): number => {
  if (ch === '\n') return KEY.enter;
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x100 ? cp : 0x1000000 + cp;
};

/** The VNC password is kept on this device, per machine, like the token. Storage may be blocked. */
const passwordKey = (host: string | null) => `rah.vnc.${host ?? 'local'}`;
function loadPassword(host: string | null): string | null {
  try {
    return localStorage.getItem(passwordKey(host));
  } catch {
    return null;
  }
}
function savePassword(host: string | null, password: string | null): void {
  try {
    if (password) localStorage.setItem(passwordKey(host), password);
    else localStorage.removeItem(passwordKey(host));
  } catch {
    // Storage unavailable: asked again next time.
  }
}

export function DesktopPanel({ api, hidden = false, onMinimize, onClose }: Props) {
  // Bumped by Reconnect: a new ticket and a new connection.
  const [nonce, setNonce] = useState(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [failure, setFailure] = useState('');
  const [name, setName] = useState('');
  const [asking, setAsking] = useState<null | 'first' | 'wrong'>(null);
  const [control, setControl] = useState(false);
  const [fit, setFit] = useState(true);
  const touch = useIsTouch();
  // The typing bar, on a touch screen only: closed until asked for, so the picture gets the room.
  const [typing, setTyping] = useState(false);
  // On a touch screen: the picture's zoom (1 fits it whole), the desktop's own size, the room it
  // is shown in, and in control whether the screen is a touchpad (the default) or tapped directly.
  const [zoom, setZoom] = useState(1);
  const [fb, setFb] = useState<Size>({ w: 0, h: 0 });
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const [touchpad, setTouchpad] = useState(true);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [rotateHint, setRotateHint] = useState(() => !rotateHintSeen());
  const viewportRef = useRef<HTMLDivElement>(null);
  const padRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  /** Where the view scrolls once the new zoom is laid out, so a pinch stays under the fingers. */
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const [line, setLine] = useState('');
  // The desktop's clipboard as last heard, and whether it changed since the person looked.
  const [remoteClip, setRemoteClip] = useState('');
  const [clipFresh, setClipFresh] = useState(false);
  const remoteClipRef = useRef('');
  const copyWantedRef = useRef(0);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const viewRef = useRef({ control, fit });
  viewRef.current = { control, fit };
  // A password the server turned down: the next connection asks again, saying so.
  const wrongRef = useRef(false);
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let rfb: RFB | null = null;
    const screen = screenRef.current;
    if (!screen) return;
    const phaseNow = (p: Phase) => {
      if (!disposed) setPhase(p);
    };
    void (async () => {
      try {
        const { available } = await api.desktop();
        if (disposed) return;
        if (!available) return phaseNow('unavailable');
        // noVNC is loaded only when a desktop is opened.
        const [{ default: Client }, url] = await Promise.all([import('@novnc/novnc'), api.desktopSocketUrl()]);
        if (disposed) return;
        const saved = loadPassword(api.host);
        pendingRef.current = saved;
        rfb = new Client(screen, url, { shared: true, ...(saved ? { credentials: { password: saved } } : {}) });
        rfbRef.current = rfb;
        rfb.background = 'transparent';
        rfb.resizeSession = false;
        rfb.viewOnly = !viewRef.current.control;
        rfb.scaleViewport = viewRef.current.fit;
        rfb.clipViewport = !viewRef.current.fit;
        rfb.dragViewport = !viewRef.current.fit && !viewRef.current.control;
        rfb.addEventListener('connect', () => {
          wrongRef.current = false;
          savePassword(api.host, pendingRef.current);
          phaseNow('connected');
        });
        rfb.addEventListener('clipboard', (e) => {
          const text = (e as CustomEvent<{ text: string }>).detail.text;
          if (disposed || text === remoteClipRef.current) return;
          remoteClipRef.current = text;
          setRemoteClip(text);
          // Just after Ctrl/⌘+C the keystroke still counts as the person's: the copy lands here too.
          if (Date.now() - copyWantedRef.current < COPY_WINDOW_MS) {
            copyWantedRef.current = 0;
            void copyText(text).then((ok) => {
              setClipFresh(!ok);
              rfbRef.current?.focus();
            });
          } else {
            setClipFresh(true);
          }
        });
        rfb.addEventListener('desktopname', (e) => {
          if (!disposed) setName((e as CustomEvent<{ name: string }>).detail.name);
        });
        rfb.addEventListener('credentialsrequired', () => {
          if (!disposed) setAsking(wrongRef.current ? 'wrong' : 'first');
        });
        // Why the server turned the connection away, when it is not a wrong password.
        let refused = '';
        rfb.addEventListener('securityfailure', (e) => {
          const reason = (e as CustomEvent<{ reason?: string }>).detail.reason ?? '';
          // TigerVNC's word for a wrong password; anything else (too many failures) is a refusal.
          if (reason && !/authentication/i.test(reason)) {
            refused = /too many/i.test(reason) ? t('desktop.blocked') : t('desktop.refused', reason);
            return;
          }
          savePassword(api.host, null);
          wrongRef.current = true;
        });
        rfb.addEventListener('disconnect', () => {
          if (disposed) return;
          rfbRef.current = null;
          setAsking(null);
          if (refused) {
            setFailure(refused);
            phaseNow('failed');
          } else if (wrongRef.current) {
            // A wrong password closes the connection; a new one asks for the password again.
            setNonce((n) => n + 1);
          } else {
            phaseNow('disconnected');
          }
        });
      } catch (e) {
        if (disposed) return;
        setFailure(message(e));
        phaseNow('failed');
      }
    })();
    return () => {
      disposed = true;
      rfbRef.current = null;
      rfb?.disconnect();
    };
  }, [api, nonce]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = !control;
    // On a touch screen the picture always fits its box; zooming makes the box bigger.
    rfb.scaleViewport = touch || fit;
    rfb.clipViewport = !touch && !fit;
    // At full size the picture is panned by dragging, while dragging is not the desktop's own.
    rfb.dragViewport = !touch && !fit && !control;
    if (control && !touch && !hidden) rfb.focus();
  }, [control, fit, phase, touch, hidden]);

  // The desktop's size, from noVNC's canvas, and the room the picture has: both decide the zoom.
  useEffect(() => {
    const canvas = screenRef.current?.querySelector('canvas');
    const viewport = viewportRef.current;
    if (!touch || !canvas || !viewport || phase !== 'connected') return;
    const readFb = () => {
      setFb({ w: canvas.width, h: canvas.height });
      setCursor((c) => (c.x || c.y ? c : { x: canvas.width / 2, y: canvas.height / 2 }));
    };
    const readBox = () => setBox({ w: viewport.clientWidth, h: viewport.clientHeight });
    readFb();
    readBox();
    const mo = new MutationObserver(readFb);
    mo.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    const ro = new ResizeObserver(readBox);
    ro.observe(viewport);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [touch, phase, hidden]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const pending = pendingScrollRef.current;
    if (!viewport || !pending) return;
    viewport.scrollLeft = pending.left;
    viewport.scrollTop = pending.top;
    pendingScrollRef.current = null;
  }, [zoom]);

  const fitted = fitSize(fb, box);
  /** Zooms to `z`, keeping the point at (clientX, clientY) where it is on the screen. */
  const zoomTo = (z1: number, clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport || !fitted.w) return;
    const z0 = zoomRef.current;
    z1 = clampZoom(z1);
    if (Math.abs(z1 - z0) < 0.001) return;
    const rect = viewport.getBoundingClientRect();
    const offset = (z: number, room: number, size: number) => Math.max(0, (room - size * z) / 2);
    pendingScrollRef.current = {
      left: scrollForZoom(viewport.scrollLeft, clientX - rect.left, z0, z1, offset(z0, box.w, fitted.w), offset(z1, box.w, fitted.w)),
      top: scrollForZoom(viewport.scrollTop, clientY - rect.top, z0, z1, offset(z0, box.h, fitted.h), offset(z1, box.h, fitted.h)),
    };
    zoomRef.current = z1;
    setZoom(z1);
  };
  /** Double tap, or the fit button: between the whole picture and one that fills the height. */
  const toggleZoom = (clientX: number, clientY: number) => {
    const fill = fillZoom(fb, box);
    zoomTo(zoomRef.current > 1.05 ? 1 : fill > 1.05 ? fill : 2.5, clientX, clientY);
  };
  // The gesture handlers below live as long as the mode does; through these they see the latest sizes.
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  const toggleZoomRef = useRef(toggleZoom);
  toggleZoomRef.current = toggleZoom;

  // View only on a touch screen: one finger scrolls the view (the browser's own), two pinch to
  // zoom it, a double tap zooms in on a spot or back out. Nothing reaches the desktop.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!touch || control || !viewport || phase !== 'connected') return;
    let pinch: { dist: number; zoom: number } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    let start = { t: 0, x: 0, y: 0 };
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const mid = (e: TouchEvent) => ({ x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 });
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { dist: dist(e), zoom: zoomRef.current };
      else if (e.touches.length === 1) start = { t: Date.now(), x: e.touches[0].clientX, y: e.touches[0].clientY };
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e);
      zoomToRef.current(pinch.zoom * (dist(e) / pinch.dist), m.x, m.y);
    };
    const onEnd = (e: TouchEvent) => {
      if (pinch) {
        if (e.touches.length < 2) pinch = null;
        return;
      }
      const t = e.changedTouches[0];
      if (!t || !isTap(Date.now() - start.t, Math.hypot(t.clientX - start.x, t.clientY - start.y))) return;
      const now = Date.now();
      if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40) {
        toggleZoomRef.current(t.clientX, t.clientY);
        lastTap = { t: 0, x: 0, y: 0 };
      } else {
        lastTap = { t: now, x: t.clientX, y: t.clientY };
      }
    };
    viewport.addEventListener('touchstart', onStart, { passive: true });
    viewport.addEventListener('touchmove', onMove, { passive: false });
    viewport.addEventListener('touchend', onEnd);
    return () => {
      viewport.removeEventListener('touchstart', onStart);
      viewport.removeEventListener('touchmove', onMove);
      viewport.removeEventListener('touchend', onEnd);
    };
  }, [touch, control, phase, hidden]);

  // In control on a touch screen, the screen is a touchpad: a finger moves the pointer (drawn
  // here, the desktop's own cursor is not shown on touch), a tap clicks, two fingers tapped
  // right-click, two moving scroll, two spreading zoom, and a long press starts a drag. The
  // gestures become mouse and wheel events on noVNC's canvas, which sends them on.
  useEffect(() => {
    const pad = padRef.current;
    const canvas = screenRef.current?.querySelector('canvas');
    const viewport = viewportRef.current;
    if (!touch || !control || !touchpad || !pad || !canvas || !viewport || phase !== 'connected') return;
    const fire = (type: 'mousedown' | 'mouseup' | 'mousemove', buttons: number, button = 0) => {
      const rect = canvas.getBoundingClientRect();
      const s = rect.width / (canvas.width || 1);
      const { x, y } = cursorRef.current;
      const ev = new MouseEvent(type, { clientX: rect.left + (x + 0.5) * s, clientY: rect.top + (y + 0.5) * s, buttons, button, bubbles: true, cancelable: true });
      // A press makes noVNC cover the page with a capture layer, gone only when a release reaches
      // the window; one sent to the canvas stops there. Sent to the window, noVNC passes it to the
      // canvas itself and lifts the layer, which would otherwise sit over this touchpad.
      (type === 'mouseup' ? window : canvas).dispatchEvent(ev);
    };
    const click = (button: 0 | 2) => {
      const mask = button === 2 ? 2 : 1;
      fire('mousedown', mask, button);
      fire('mouseup', 0, button);
    };
    const wheel = (deltaY: number) => {
      const rect = canvas.getBoundingClientRect();
      const s = rect.width / (canvas.width || 1);
      const { x, y } = cursorRef.current;
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode: 0, clientX: rect.left + x * s, clientY: rect.top + y * s, bubbles: true, cancelable: true }));
    };
    // Keeps the pointer in sight when zoomed in: the view scrolls after it near the edge.
    const follow = () => {
      const rect = canvas.getBoundingClientRect();
      const vp = viewport.getBoundingClientRect();
      const s = rect.width / (canvas.width || 1);
      const px = rect.left + cursorRef.current.x * s - vp.left;
      const py = rect.top + cursorRef.current.y * s - vp.top;
      if (px < FOLLOW_MARGIN) viewport.scrollLeft += px - FOLLOW_MARGIN;
      else if (px > vp.width - FOLLOW_MARGIN) viewport.scrollLeft += px - vp.width + FOLLOW_MARGIN;
      if (py < FOLLOW_MARGIN) viewport.scrollTop += py - FOLLOW_MARGIN;
      else if (py > vp.height - FOLLOW_MARGIN) viewport.scrollTop += py - vp.height + FOLLOW_MARGIN;
    };
    const moveBy = (dx: number, dy: number, ms: number) => {
      const rect = canvas.getBoundingClientRect();
      const perPx = (canvas.width || 1) / (rect.width || 1);
      const c = cursorRef.current;
      const next = {
        x: Math.min(canvas.width - 1, Math.max(0, c.x + pointerDelta(dx, ms, perPx))),
        y: Math.min(canvas.height - 1, Math.max(0, c.y + pointerDelta(dy, ms, perPx))),
      };
      cursorRef.current = next;
      setCursor(next);
    };

    type Mode = 'idle' | 'one' | 'drag' | 'two' | 'zoom' | 'scroll';
    let mode: Mode = 'idle';
    let started = 0;
    let last = { x: 0, y: 0, t: 0 };
    let travelled = 0;
    let longTimer = 0;
    let two = { dist: 0, mid: { x: 0, y: 0 }, lastMid: { x: 0, y: 0 }, zoom: 1 };
    const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    const mid = (e: TouchEvent) => ({ x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 });

    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1 && mode === 'idle') {
        mode = 'one';
        started = Date.now();
        travelled = 0;
        last = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: started };
        longTimer = window.setTimeout(() => {
          if (mode !== 'one' || travelled >= TAP_SLOP_PX) return;
          mode = 'drag';
          fire('mousedown', 1);
          navigator.vibrate?.(10);
        }, LONG_PRESS_MS);
      } else if (e.touches.length === 2 && (mode === 'one' || mode === 'idle')) {
        window.clearTimeout(longTimer);
        mode = 'two';
        started = Date.now();
        const m = mid(e);
        two = { dist: dist(e), mid: m, lastMid: m, zoom: zoomRef.current };
      }
    };
    const onMove = (e: TouchEvent) => {
      e.preventDefault();
      if ((mode === 'one' || mode === 'drag') && e.touches.length === 1) {
        const t = e.touches[0];
        const now = Date.now();
        const dx = t.clientX - last.x;
        const dy = t.clientY - last.y;
        travelled += Math.hypot(dx, dy);
        if (travelled >= TAP_SLOP_PX) window.clearTimeout(longTimer);
        moveBy(dx, dy, now - last.t);
        last = { x: t.clientX, y: t.clientY, t: now };
        fire('mousemove', mode === 'drag' ? 1 : 0);
        follow();
      } else if (e.touches.length === 2 && (mode === 'two' || mode === 'zoom' || mode === 'scroll')) {
        const m = mid(e);
        if (mode === 'two') {
          const kind = twoFingerKind(two.dist, dist(e), Math.hypot(m.x - two.mid.x, m.y - two.mid.y));
          if (kind) mode = kind;
        }
        if (mode === 'zoom') zoomToRef.current(two.zoom * (dist(e) / two.dist), m.x, m.y);
        // Fingers up scroll the page down, as on a phone's own lists.
        if (mode === 'scroll') wheel((two.lastMid.y - m.y) * 2);
        two.lastMid = m;
      }
    };
    const onEnd = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length > 0) return;
      window.clearTimeout(longTimer);
      const ms = Date.now() - started;
      if (mode === 'one' && isTap(ms, travelled)) click(0);
      else if (mode === 'two' && ms < 300) click(2);
      else if (mode === 'drag') fire('mouseup', 0);
      mode = 'idle';
    };
    pad.addEventListener('touchstart', onStart, { passive: false });
    pad.addEventListener('touchmove', onMove, { passive: false });
    pad.addEventListener('touchend', onEnd, { passive: false });
    pad.addEventListener('touchcancel', onEnd, { passive: false });
    return () => {
      window.clearTimeout(longTimer);
      pad.removeEventListener('touchstart', onStart);
      pad.removeEventListener('touchmove', onMove);
      pad.removeEventListener('touchend', onEnd);
      pad.removeEventListener('touchcancel', onEnd);
    };
  }, [touch, control, touchpad, phase, hidden]);

  // With a real keyboard the shortcuts carry the clipboard: Ctrl/⌘+V pastes this device's text on
  // the desktop, Ctrl/⌘+C copies the desktop's back. On a Mac, ⌘ stands in for Control.
  useEffect(() => {
    const screen = screenRef.current;
    const rfb = rfbRef.current;
    if (!screen || !rfb || !control || touch || phase !== 'connected') return;
    const swallowed = new Set<string>();
    let pasteTimer = 0;
    // Control is already down on the desktop unless ⌘ stood in for it.
    const chord = (key: string) => {
      if (MAC) rfb.sendKey(KEY.ctrl, 'ControlLeft', true);
      rfb.sendKey(keysym(key), null);
      if (MAC) rfb.sendKey(KEY.ctrl, 'ControlLeft', false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // ⌘ alone is not passed on as the desktop's Super key: it only ever means Control here.
      if (MAC && e.key === 'Meta') {
        e.stopPropagation();
        return;
      }
      const shortcut = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!shortcut || e.altKey || e.key.length !== 1) return;
      const key = e.key.toLowerCase();
      e.stopPropagation();
      swallowed.add(e.code);
      if (key === 'v') {
        // Not prevented: the browser pastes, and the paste event below brings the text. Without
        // one (nothing to paste here) the desktop pastes what it already has.
        pasteTimer = window.setTimeout(() => chord('v'), 150);
        return;
      }
      e.preventDefault();
      if (key === 'c' || key === 'x') copyWantedRef.current = Date.now();
      chord(key);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if ((MAC && e.key === 'Meta') || swallowed.delete(e.code)) e.stopPropagation();
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      window.clearTimeout(pasteTimer);
      e.preventDefault();
      if (text) {
        rfb.clipboardPasteFrom(text);
        remoteClipRef.current = text;
        setRemoteClip(text);
      }
      // A moment for the desktop to own the new text before the app there asks for it.
      pasteTimer = window.setTimeout(() => chord('v'), 50);
    };
    screen.addEventListener('keydown', onKeyDown, true);
    screen.addEventListener('keyup', onKeyUp, true);
    screen.addEventListener('paste', onPaste, true);
    return () => {
      window.clearTimeout(pasteTimer);
      screen.removeEventListener('keydown', onKeyDown, true);
      screen.removeEventListener('keyup', onKeyUp, true);
      screen.removeEventListener('paste', onPaste, true);
    };
  }, [control, touch, phase]);

  const sendClip = (text: string) => {
    rfbRef.current?.clipboardPasteFrom(text);
    remoteClipRef.current = text;
    setRemoteClip(text);
  };

  const reconnect = () => {
    setFailure('');
    setName('');
    setPhase('connecting');
    setNonce((n) => n + 1);
  };

  const type = (text: string) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    for (const ch of text) rfb.sendKey(keysym(ch), null);
  };
  const press = (sym: number) => rfbRef.current?.sendKey(sym, null);

  const keys: Array<[string, number, JSX.Element?]> = [
    ['Esc', KEY.esc],
    ['Tab', KEY.tab],
    [t('desktop.backspace'), KEY.backspace],
    ['Enter', KEY.enter],
    [t('term.up'), KEY.up, <IconArrowUp size={16} />],
    [t('term.down'), KEY.down, <IconArrowDown size={16} />],
    [t('term.left'), KEY.left, <IconArrowLeft size={16} />],
    [t('term.right'), KEY.right, <IconArrowRight size={16} />],
  ];
  const live = phase === 'connected';
  const padOn = touch && control && touchpad;

  return (
    <div className="dialog-scrim term-scrim" hidden={hidden}>
      <div className="panel term-panel desktop-panel" role="dialog" aria-modal="true" aria-label={t('desktop.title')}>
        <header className="panel-head">
          <div className="term-head-main">
            <h2 className="panel-title">
              <IconDesktop size={20} /> {t('desktop.title')}
            </h2>
            {name && (
              <span className="desktop-name" title={name}>
                {name}
              </span>
            )}
          </div>
          <div className="desktop-actions">
            <button
              className={`desktop-control${control ? ' on' : ''}`}
              aria-pressed={control}
              title={t('desktop.controlHint')}
              disabled={!live}
              onClick={() => setControl((c) => !c)}
            >
              <IconPointer size={16} />
              <span>{t('desktop.control')}</span>
            </button>
            {touch ? (
              <button
                className={`icon-btn${zoom > 1.05 ? ' on' : ''}`}
                aria-pressed={zoom > 1.05}
                aria-label={zoom > 1.05 ? t('desktop.fit') : t('desktop.zoomIn')}
                title={zoom > 1.05 ? t('desktop.fit') : t('desktop.zoomIn')}
                disabled={!live}
                onClick={() => {
                  const r = viewportRef.current?.getBoundingClientRect();
                  if (r) toggleZoom(r.left + r.width / 2, r.top + r.height / 2);
                }}
              >
                <IconFit size={18} />
              </button>
            ) : (
              <button
                className={`icon-btn${fit ? '' : ' on'}`}
                aria-pressed={!fit}
                aria-label={fit ? t('desktop.actual') : t('desktop.fit')}
                title={fit ? t('desktop.actual') : t('desktop.fit')}
                disabled={!live}
                onClick={() => setFit((f) => !f)}
              >
                <IconFit size={18} />
              </button>
            )}
            {control && touch && (
              <button
                className={`icon-btn desktop-touchpad-btn${touchpad ? ' on' : ''}`}
                aria-pressed={touchpad}
                aria-label={t('desktop.touchpad')}
                title={t('desktop.touchpadHint')}
                onClick={() => setTouchpad((v) => !v)}
              >
                <IconTouchpad size={18} />
              </button>
            )}
            {/* noVNC passes no clipboard either way while view only: it is part of taking control. */}
            {control && <Popover
              label={t('desktop.clipboard')}
              triggerClassName={`icon-btn desktop-clip-btn${clipFresh ? ' fresh' : ''}`}
              triggerLabel={clipFresh ? t('desktop.clipNew') : t('desktop.clipboard')}
              triggerTitle={clipFresh ? t('desktop.clipNew') : t('desktop.clipboard')}
              panelClassName="desktop-clip"
              align="end"
              disabled={!live}
              trigger={<IconClipboard size={18} />}
            >
              {() => <ClipboardSheet remote={remoteClip} hint={!touch} onSeen={() => setClipFresh(false)} onSend={sendClip} />}
            </Popover>}
            {control && touch && (
              <button
                className={`icon-btn${typing ? ' on' : ''}`}
                aria-pressed={typing}
                aria-label={t('desktop.keyboard')}
                title={t('desktop.keyboard')}
                onClick={() => setTyping((v) => !v)}
              >
                <IconKeyboard size={18} />
              </button>
            )}
            <button className="icon-btn desktop-minimize" aria-label={t('desktop.minimize')} title={t('desktop.minimizeHint')} onClick={onMinimize}>
              <IconMinus size={18} />
            </button>
            <button className="icon-btn" aria-label={t('desktop.close')} title={t('desktop.close')} onClick={onClose}>
              <IconClose size={18} />
            </button>
          </div>
        </header>
        <div className={`desktop-stage${touch ? ' touch' : ''}`}>
          <div className="desktop-viewport" ref={viewportRef}>
            <div className="desktop-content" style={touch && fitted.w ? { width: fitted.w * zoom, height: fitted.h * zoom } : undefined}>
              <div className={`desktop-screen${control ? ' control' : ''}${padOn ? ' under-pad' : ''}`} ref={screenRef} />
              {padOn && live && fb.w > 0 && (
                <svg className="desktop-cursor" style={{ left: `${(cursor.x / fb.w) * 100}%`, top: `${(cursor.y / fb.h) * 100}%` }} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <path d="M2 1.5l12.5 7-5.6 1.4L6.6 15.5z" />
                </svg>
              )}
            </div>
          </div>
          {padOn && live && <div className="desktop-pad" ref={padRef} aria-label={t('desktop.touchpadHint')} />}
          {touch && live && rotateHint && box.h > box.w && fb.w > fb.h && (
            <button
              type="button"
              className="desktop-rotate"
              onClick={() => {
                setRotateHint(false);
                try {
                  localStorage.setItem(ROTATE_HINT_KEY, '1');
                } catch {
                  // Shown again next time.
                }
              }}
            >
              {t('desktop.rotate')}
              <IconClose size={14} />
            </button>
          )}
        </div>
        {control && touch && typing && live && (
          <div className="term-input desktop-input">
            <div className="term-keys" role="toolbar" aria-label={t('desktop.keys')}>
              {keys.map(([label, sym, icon]) => (
                <button key={label} type="button" aria-label={label} onPointerDown={(e) => e.preventDefault()} onClick={() => press(sym)}>
                  {icon ?? label}
                </button>
              ))}
            </div>
            <form
              className="term-line"
              onSubmit={(e) => {
                e.preventDefault();
                type(line);
                press(KEY.enter);
                setLine('');
              }}
            >
              <input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                onKeyDown={(e) => {
                  // An empty field passes Backspace on, to rub out what is already on the desktop.
                  if (e.key === 'Backspace' && line === '' && !e.nativeEvent.isComposing) press(KEY.backspace);
                }}
                placeholder={t('desktop.placeholder')}
                aria-label={t('desktop.input')}
                enterKeyHint="send"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="term-send" aria-label={t('common.send')}>
                <IconSend size={16} />
              </button>
            </form>
          </div>
        )}
        {phase !== 'connected' && !asking && (
          <div className="term-note" role="status">
            {phase === 'connecting' && <p>{t('desktop.connecting')}</p>}
            {phase === 'unavailable' && (
              <>
                <p>{t('desktop.unavailable')}</p>
                <p className="desktop-hint">{t('desktop.unavailableHint')}</p>
                <button onClick={reconnect}>{t('common.retry')}</button>
              </>
            )}
            {phase === 'disconnected' && (
              <>
                <p>{t('desktop.disconnected')}</p>
                <button onClick={reconnect}>{t('desktop.reconnect')}</button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <p>{failure || t('desktop.failed')}</p>
                <button onClick={reconnect}>{t('common.retry')}</button>
              </>
            )}
          </div>
        )}
        {asking && (
          <Dialog
            title={t('desktop.pwTitle')}
            message={asking === 'wrong' ? t('desktop.pwWrong') : t('desktop.pwMsg')}
            input={{ initial: '', label: t('desktop.pw'), secret: true }}
            confirmLabel={t('desktop.connect')}
            onConfirm={(password) => {
              setAsking(null);
              pendingRef.current = password ?? null;
              rfbRef.current?.sendCredentials({ password: password ?? '' });
            }}
            onCancel={() => {
              setAsking(null);
              wrongRef.current = false;
              rfbRef.current?.disconnect();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Both directions of the clipboard: the desktop's text to copy here, and a field to send text there. */
function ClipboardSheet({ remote, hint, onSeen, onSend }: { remote: string; hint: boolean; onSeen: () => void; onSend: (text: string) => void }) {
  const [copied, setCopied] = useState<null | boolean>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(onSeen, [remote]);
  return (
    <div className="desktop-clip-body">
      <section>
        <h3>{t('desktop.clipRemote')}</h3>
        {remote ? <pre className="desktop-clip-text">{remote}</pre> : <p className="desktop-clip-empty">{t('desktop.clipEmpty')}</p>}
        {remote && (
          <button type="button" className="ghost" onClick={() => void copyText(remote).then(setCopied)}>
            {t('desktop.clipCopy')}
          </button>
        )}
        {copied !== null && <p className={`desktop-clip-note${copied ? '' : ' bad'}`}>{copied ? t('desktop.clipCopied') : t('desktop.clipCopyFailed')}</p>}
      </section>
      <section>
        <h3>{t('desktop.clipLocal')}</h3>
        <textarea
          value={text}
          rows={3}
          placeholder={t('desktop.clipPaste')}
          aria-label={t('desktop.clipPaste')}
          onChange={(e) => {
            setText(e.target.value);
            setSent(false);
          }}
        />
        <button
          type="button"
          className="ghost"
          disabled={!text}
          onClick={() => {
            onSend(text);
            setSent(true);
          }}
        >
          {t('desktop.clipSend')}
        </button>
        {sent && <p className="desktop-clip-note">{t('desktop.clipSent')}</p>}
      </section>
      {hint && <p className="desktop-clip-hint">{t('desktop.clipHint')}</p>}
    </div>
  );
}
