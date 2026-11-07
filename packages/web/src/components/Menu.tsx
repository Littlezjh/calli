import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsNarrow } from '../hooks';
import { IconCheck, IconChevron } from './icons';

export interface MenuItem {
  id: string;
  label: string;
  icon?: (p: { size?: number }) => JSX.Element;
  /** Red text, for actions that destroy something. */
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  /** Runs when picked. Ignored when the item opens a submenu. */
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItem | 'separator';

interface Props {
  /** Accessible name. */
  label: string;
  /** Where the menu opens, in viewport coordinates. */
  x: number;
  y: number;
  /** Which corner of the panel sits at that point. A menu opened from the bottom of the screen grows upwards. */
  corner?: 'top-left' | 'bottom-right';
  items: MenuEntry[];
  /** Optional account summary, mounted only while the root menu is visible. */
  header?: ReactNode;
  onClose: () => void;
}

const EDGE = 8;

/** How long after the finger that opened a menu lifts before the menu takes taps. */
const ARM_DELAY_MS = 400;

/** Fingers on the screen right now. A menu opened by a long press appears under one of them. */
let fingers = 0;
if (typeof document !== 'undefined') {
  const count = (e: TouchEvent) => { fingers = e.touches.length; };
  for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) document.addEventListener(type, count, { capture: true, passive: true });
}

/**
 * A menu with icons, separators and one level of submenus.
 * Wide screens: a floating panel at the pointer, with submenus opening beside their row.
 * Phones: the same anchored surface, with a submenu replacing its parent list.
 */
export function Menu({ label, x, y, corner = 'top-left', items, header, onClose }: Props) {
  const narrow = useIsNarrow();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [pos, setPos] = useState({ left: x, top: y, flip: false, ready: false });
  // A menu opened under a finger (a long press) ignores that finger: lifting it must not pick
  // the row that slid in beneath it, nor close the menu. Safari sends the lifted finger's mouse
  // press and click a moment later, wherever it now is, so those are swallowed too, and the menu
  // listens only a little after every finger is up.
  const [armed, setArmed] = useState(() => fingers === 0);
  useEffect(() => {
    if (armed) return;
    let timer: number | undefined;
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const up = (e: TouchEvent) => {
      if (e.touches.length) return;
      if (e.cancelable) e.preventDefault();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setArmed(true), ARM_DELAY_MS);
    };
    const touch = ['touchend', 'touchcancel'] as const;
    const mouse = ['mousedown', 'mouseup', 'click'] as const;
    for (const type of touch) document.addEventListener(type, up, true);
    for (const type of mouse) document.addEventListener(type, swallow, true);
    return () => {
      window.clearTimeout(timer);
      for (const type of touch) document.removeEventListener(type, up, true);
      for (const type of mouse) document.removeEventListener(type, swallow, true);
    };
  }, [armed]);

  // The portal uses viewport coordinates, including the part left above a phone keyboard.
  useLayoutEffect(() => {
    const place = () => {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const viewport = window.visualViewport;
      const minY = (viewport?.offsetTop ?? 0) + EDGE;
      const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight);
      const [wantLeft, wantTop] = corner === 'bottom-right' ? [x - rect.width, y - rect.height] : [x, y];
      const left = Math.max(EDGE, Math.min(wantLeft, innerWidth - rect.width - EDGE));
      const top = Math.max(minY, Math.min(wantTop, bottom - rect.height - EDGE));
      const flip = left + rect.width + 240 > innerWidth;
      setPos(previous => previous.left === left && previous.top === top && previous.flip === flip && previous.ready ? previous : { left, top, flip, ready: true });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); };
  }, [x, y, corner, narrow, items, openSub]);

  useEffect(() => {
    // composedPath is captured at dispatch, so it still works if the clicked row is removed by its handler.
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !e.composedPath().includes(rootRef.current)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openSub) setOpenSub(null);
      else onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, openSub]);

  useEffect(() => {
    if (!armed) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key)) return;
      const current = document.activeElement as HTMLElement;
      const menu = current?.closest('[role="menu"]');
      if (!menu || !rootRef.current?.contains(menu)) return;
      const rows = [...menu.querySelectorAll<HTMLElement>('button:not(:disabled)')].filter(row => row.closest('[role="menu"]') === menu);
      if (!rows.length) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'ArrowRight') { if (current.getAttribute('aria-haspopup') === 'menu') { current.click(); requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.menu-sub button, .menu-back')?.focus()); } return; }
      if (event.key === 'ArrowLeft') { setOpenSub(null); return; }
      const index = rows.indexOf(current);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [armed]);

  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.submenu) {
      // Hovering has usually opened it already; a click on top of that means "this one", not "close it".
      setOpenSub(item.id);
      return;
    }
    onClose();
    item.onSelect?.();
  };

  const row = (item: MenuItem, inSubmenu: boolean) => {
    const Icon = item.icon;
    return (
      <button
        type="button"
        role={item.checked !== undefined ? 'menuitemradio' : 'menuitem'}
        aria-checked={item.checked}
        aria-haspopup={item.submenu ? 'menu' : undefined}
        aria-expanded={item.submenu ? openSub === item.id : undefined}
        className={`menu-row${item.danger ? ' danger' : ''}${openSub === item.id ? ' open' : ''}`}
        disabled={item.disabled}
        onClick={() => pick(item)}
        // Hover opens a submenu on wide screens, and moving to a plain row closes any open one.
        onMouseEnter={() => !narrow && !inSubmenu && setOpenSub(item.submenu && !item.disabled ? item.id : null)}
      >
        <span className="menu-icon">{Icon ? <Icon size={17} /> : null}</span>
        <span className="menu-label">{item.label}</span>
        {item.checked && (
          <span className="menu-trail">
            <IconCheck size={15} />
          </span>
        )}
        {item.submenu && (
          <span className="menu-trail">
            <IconChevron size={14} />
          </span>
        )}
      </button>
    );
  };

  const list = (entries: MenuEntry[], inSubmenu: boolean) =>
    entries.map((entry, i) =>
      entry === 'separator' ? (
        <div key={`sep-${i}`} className="menu-sep" role="separator" />
      ) : (
        <div key={entry.id} className="menu-cell">
          {row(entry, inSubmenu)}
          {!narrow && !inSubmenu && entry.submenu && openSub === entry.id && (
            <div className={`menu-panel menu-sub${pos.flip ? ' flip' : ''}`} role="menu" aria-label={entry.label}>
              {list(entry.submenu, true)}
            </div>
          )}
        </div>
      ),
    );

  const sub = items.find((e): e is MenuItem => e !== 'separator' && e.id === openSub && Boolean(e.submenu));
  return createPortal(
    <div ref={rootRef} className={armed ? undefined : 'sheet-unarmed'}>
      <div ref={panelRef} className={`menu-panel menu-float${narrow ? ' menu-touch' : ''}`} role="menu" aria-label={narrow && sub ? sub.label : label}
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}>
        {narrow && sub ? <><button className="menu-back" onClick={() => setOpenSub(null)}><span className="menu-back-icon"><IconChevron size={14} /></span>{sub.label}</button>{list(sub.submenu ?? [], true)}</> : <>{header}{list(items, false)}</>}
      </div>
    </div>, document.body,
  );
}
