import { useEffect, useState, type RefObject } from 'react';

export interface NoteMark {
  id: string;
  /** The note's number in the box, as the message will call it ("[注释 2]", which the daemon reads). */
  n: number;
  range: Range;
}

/** The highlight registered with the browser for noted passages; styled with ::highlight(calli-note). */
const HIGHLIGHT = 'calli-note';

interface Spot {
  id: string;
  n: number;
  top: number;
  left: number;
}

/**
 * Noted passages, marked where they stand in the conversation while their notes wait in the box:
 * the text tinted (the CSS Custom Highlight API, so the messages' own markup is left alone) and the
 * note's number at the end of it, like Codex. A passage whose message has re-rendered or scrolled
 * out of the thread's view simply shows no mark.
 */
export function NoteMarks({ marks, scrollerRef }: { marks: NoteMark[]; scrollerRef: RefObject<HTMLElement | null> }) {
  const [spots, setSpots] = useState<Spot[]>([]);

  useEffect(() => {
    const registry = typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined;
    const live = marks.filter((m) => m.range.startContainer.isConnected && m.range.endContainer.isConnected);
    if (registry && typeof Highlight !== 'undefined') {
      if (live.length) registry.set(HIGHLIGHT, new Highlight(...live.map((m) => m.range)));
      else registry.delete(HIGHLIGHT);
    }

    let raf = 0;
    const place = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const view = scrollerRef.current?.getBoundingClientRect();
        setSpots(
          live.flatMap((m) => {
            const rects = m.range.getClientRects();
            const last = rects[rects.length - 1];
            if (!last || !view || last.bottom < view.top || last.top > view.bottom) return [];
            return [{ id: m.id, n: m.n, top: last.top + last.height / 2, left: last.right }];
          }),
        );
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      registry?.delete(HIGHLIGHT);
    };
  }, [marks, scrollerRef]);

  return (
    <>
      {spots.map((s) => (
        <span key={s.id} className="note-mark" style={{ top: s.top, left: s.left }} aria-hidden="true">
          {s.n}
        </span>
      ))}
    </>
  );
}
