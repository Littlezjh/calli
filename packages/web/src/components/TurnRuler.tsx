import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TurnPreview } from '../timeline';

interface Props {
  /** The scroll container holding the thread. A ref, because it mounts with the app. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Preview text per turn id, from the timeline. */
  previews: Map<string, TurnPreview>;
}

/** Fewer turns than this and the ruler is not worth its space. */
const MIN_TURNS = 3;
/** With very long threads the ticks are sampled, so the ruler stays readable. */
const MAX_TICKS = 120;

interface Tick {
  turnId: string;
  /** Position within the scroll content, 0..1. */
  ratio: number;
  /** The scroll offset clicking this tick jumps to. */
  top: number;
}

/**
 * The ruler along the thread's left edge: one tick per turn, the current turn longer. Hovering
 * enlarges the neighbours and shows what that turn was about; clicking jumps there. The ticks read
 * the rendered rows, so turns folded away by the "上 N 条消息" collapse have no tick until expanded.
 * Desktop only; CSS hides it on narrow screens.
 */
export function TurnRuler({ scrollerRef, previews }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [hoverIdx, setHoverIdx] = useState(-1);

  const measure = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const content = scroller.scrollHeight;
    const out: Tick[] = [];
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-turn]')) {
      const rect = row.getBoundingClientRect();
      const top = rect.top - scrollerTop + scroller.scrollTop;
      out.push({ turnId: row.dataset.turn ?? '', ratio: content > 0 ? top / content : 0, top });
    }
    // Sample down to MAX_TICKS, always keeping the last (current) turn.
    const step = Math.ceil(out.length / MAX_TICKS);
    const shown = step > 1 ? out.filter((_, i) => i % step === 0 || i === out.length - 1) : out;
    setTicks(shown);
    setActiveIdx((prev) => Math.min(prev, shown.length - 1));
  };

  // Positions change as content streams in, images load and groups expand; polling is cheap and
  // catches them all without wiring callbacks through the thread view.
  useEffect(() => {
    measure();
    const timer = setInterval(measure, 800);
    return () => clearInterval(timer);
    // previews changes whenever the timeline is rebuilt, which covers new turns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previews, scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const scrollerTop = scroller.getBoundingClientRect().top;
        const content = scroller.scrollHeight;
        let idx = -1;
        let i = 0;
        for (const row of scroller.querySelectorAll<HTMLElement>('[data-turn]')) {
          const top = row.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
          if (top <= scroller.scrollTop + 80) idx = i;
          i++;
        }
        setActiveIdx(idx);
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [scrollerRef, ticks.length]);

  const jump = (tick: Tick) => {
    const scroller = scrollerRef.current;
    scroller?.scrollTo({ top: Math.max(0, tick.top - 90), behavior: 'smooth' });
  };

  const previewOf = useMemo(() => (idx: number): TurnPreview | null => previews.get(ticks[idx]?.turnId ?? '') ?? null, [previews, ticks]);

  if (ticks.length < MIN_TURNS) return null;

  return (
    <div className="turn-ruler" ref={rootRef} onMouseLeave={() => setHoverIdx(-1)}>
      {ticks.map((tick, i) => (
        <button
          key={tick.turnId || i}
          className={`tick${i === activeIdx ? ' active' : ''}${Math.abs(i - hoverIdx) <= 1 && hoverIdx >= 0 ? ' near' : ''}`}
          style={{ top: `${tick.ratio * 100}%` }}
          aria-label={`跳到第 ${i + 1} 轮`}
          onClick={() => jump(tick)}
          onMouseEnter={() => setHoverIdx(i)}
        />
      ))}
      {hoverIdx >= 0 && previewOf(hoverIdx) && (
        <div className="ruler-pop" style={{ top: `${ticks[hoverIdx].ratio * 100}%` }}>
          <div className="ruler-pop-q">{previewOf(hoverIdx)!.question.slice(0, 90) || '（图片）'}</div>
          {previewOf(hoverIdx)!.answer && <div className="ruler-pop-a">{previewOf(hoverIdx)!.answer.slice(0, 110)}</div>}
        </div>
      )}
    </div>
  );
}
