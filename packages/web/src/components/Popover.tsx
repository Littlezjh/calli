import { useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  /** Accessible name of the panel. */
  label: string;
  triggerClassName?: string;
  triggerTitle?: string;
  triggerLabel?: string;
  panelClassName?: string;
  trigger: ReactNode;
  /** Which edge of the trigger the panel lines up with on wide screens. */
  align?: 'start' | 'end';
  disabled?: boolean;
  /** Opens the panel each time this number changes, so something else can trigger it. */
  openSignal?: number;
  children: (close: () => void) => ReactNode;
}

/**
 * A button that opens a panel above it. On phones the panel becomes a bottom sheet.
 * Used instead of native <select> so menus look and behave the same everywhere.
 */
export function Popover({
  label,
  triggerClassName,
  triggerTitle,
  triggerLabel,
  panelClassName,
  trigger,
  align = 'start',
  disabled,
  openSignal,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    // composedPath is captured at dispatch, so it still works if the clicked node is removed by the handler.
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !e.composedPath().includes(rootRef.current)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="pop" ref={rootRef}>
      <button
        type="button"
        className={triggerClassName}
        title={triggerTitle}
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <>
          <div className="pop-scrim" onClick={close} aria-hidden="true" />
          <div className={`pop-panel align-${align}${panelClassName ? ` ${panelClassName}` : ''}`} role="menu" aria-label={label}>
            {children(close)}
          </div>
        </>
      )}
    </div>
  );
}
