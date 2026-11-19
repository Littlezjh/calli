import { useEffect, useState, type PointerEvent, type ReactNode } from 'react';
import { t } from '../i18n';
import { clampWidth, savedWidth, WIDTH_KEY } from './FilesPanel';

/**
 * The column right of the conversation that everything opened from the overview goes into on a
 * computer: a page the agent wrote, one file's changes, the whole list of a group. One panel at a
 * time, the width of the files panel (shared, dragged from its left edge, kept on this device), so
 * the conversation stays readable beside it. On a phone each of these is a page of its own.
 */
export function DockPanel({ label, children }: { label: string; children: ReactNode }) {
  const [width, setWidth] = useState(() => clampWidth(savedWidth()));
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const move = (ev: globalThis.PointerEvent) => setWidth(clampWidth(startW + startX - ev.clientX));
    const up = (ev: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      localStorage.setItem(WIDTH_KEY, String(clampWidth(startW + startX - ev.clientX)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return <aside className="files-panel dock-panel" style={{ width }} aria-label={label}>
    <div className="files-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label={t('common.resize')} />
    {children}
  </aside>;
}
