import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  /** Where the menu opens on wide screens, in viewport coordinates. Ignored on phones. */
  x: number;
  y: number;
  /** Which corner of the panel sits at that point. A menu opened from the bottom of the screen grows upwards. */
  corner?: 'top-left' | 'bottom-right';
  items: MenuEntry[];
  onClose: () => void;
}

const EDGE = 8;

/**
 * A menu with icons, separators and one level of submenus.
 * Wide screens: a floating panel at the pointer, with submenus opening beside their row.
 * Phones: a bottom sheet, where a submenu replaces the list and has a back row.
 */
export function Menu({ label, x, y, corner = 'top-left', items, onClose }: Props) {
  const narrow = useIsNarrow();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [pos, setPos] = useState({ left: x, top: y, flip: false, ready: false });

  // Keep the panel on screen: measure it, then move it back inside the viewport if needed.
  useLayoutEffect(() => {
    if (narrow) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // x and y are where the pointer was on screen; the panel is placed within the app's box,
    // which a phone or tablet keyboard can have moved down the page.
    const box = el.closest('.app')?.getBoundingClientRect();
    const [wantLeft, wantTop] = corner === 'bottom-right' ? [x - rect.width, y - rect.height] : [x, y];
    const left = Math.max(EDGE, Math.min(wantLeft, window.innerWidth - rect.width - EDGE)) - (box?.left ?? 0);
    const top = Math.max(EDGE, Math.min(wantTop, window.innerHeight - rect.height - EDGE)) - (box?.top ?? 0);
    // Submenus open to the right unless there is no room for one there.
    const flip = left + rect.width + 220 > window.innerWidth;
    setPos({ left, top, flip, ready: true });
  }, [x, y, corner, narrow, items]);

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

  if (narrow) {
    const sub = items.find((e): e is MenuItem => e !== 'separator' && e.id === openSub && Boolean(e.submenu));
    return (
      <div ref={rootRef}>
        <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
        <div className="menu-panel menu-sheet" role="menu" aria-label={sub ? sub.label : label}>
          {sub ? (
            <>
              <button type="button" className="menu-back" onClick={() => setOpenSub(null)}>
                <span className="menu-back-icon">
                  <IconChevron size={14} />
                </span>
                {sub.label}
              </button>
              {list(sub.submenu ?? [], true)}
            </>
          ) : (
            list(items, false)
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <div
        ref={panelRef}
        className="menu-panel menu-float"
        role="menu"
        aria-label={label}
        style={{ left: pos.left, top: pos.top, visibility: pos.ready ? 'visible' : 'hidden' }}
      >
        {list(items, false)}
      </div>
    </div>
  );
}
