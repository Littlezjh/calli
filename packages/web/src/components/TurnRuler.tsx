import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TurnPreview } from '../timeline';
import { t } from '../i18n';

interface Props {
  /** The scroll container holding the thread. A ref, because it mounts with the app. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Preview text per turn id, from the timeline. */
  previews: Map<string, TurnPreview>;
}

/** Fewer turns than this and the ruler is not worth its space. */
const MIN_TURNS = 3;
/** Ticks sit at an even pitch, like Codex: roomy for short threads, packed for long ones. */
const MAX_PITCH = 12;
const MIN_PITCH = 5;
/** Dash length by distance from the hovered tick (fisheye); beyond the list, the base length. */
const FISHEYE = [26, 20, 15, 11];
const BASE_W = 8;
const ACTIVE_W = 14;

interface Tick {
  turnId: string;
  /** Index among the rendered turn rows; differs from the tick's own index once ticks are sampled. */
  row: number;
  /** The scroll offset clicking this tick jumps to. */
  top: number;
}

/**
 * The ruler along the thread's left edge: one tick per turn, the current turn longer. Hovering
 * enlarges the neighbours and shows what that turn was about; clicking jumps there. The ticks read
 * the rendered rows, so turns folded away by the "N earlier messages" collapse have no tick until expanded.
 * Desktop only; CSS hides it on narrow screens.
 */
export function TurnRuler({ scrollerRef, previews }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  // The scroll handler reads the latest ticks without re-subscribing on every measure.
  const ticksRef = useRef<Tick[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [height, setHeight] = useState(0);

  const measure = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const out: Tick[] = [];
    for (const row of scroller.querySelectorAll<HTMLElement>('[data-turn]')) {
      const top = row.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
      out.push({ turnId: row.dataset.turn ?? '', row: out.length, top });
    }
    const h = rootRef.current?.clientHeight ?? 0;
    if (h > 0) setHeight(h);
    // Sample down to what fits at the minimum pitch, always keeping the last (current) turn.
    const fit = Math.max(MIN_TURNS, Math.floor((h || 600) / MIN_PITCH));
    const step = Math.ceil(out.length / fit);
    const shown = step > 1 ? out.filter((_, i) => i % step === 0 || i === out.length - 1) : out;
    ticksRef.current = shown;
    setTicks(shown);
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
        let current = -1;
        let i = 0;
        for (const row of scroller.querySelectorAll<HTMLElement>('[data-turn]')) {
          const top = row.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
          if (top <= scroller.scrollTop + 80) current = i;
          i++;
        }
        // At the bottom the last turn is the one being read, however short it is.
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) current = i - 1;
        // With sampled ticks, the current turn is marked by the last tick at or before it.
        let idx = -1;
        ticksRef.current.forEach((t, k) => {
          if (current >= 0 && t.row <= current) idx = k;
        });
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

  // Ticks are centred as a block in the rail; the popover follows the hovered tick.
  const pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, height > 0 ? height / ticks.length : MAX_PITCH));
  const start = Math.max(0, (height - pitch * ticks.length) / 2);
  const centerOf = (i: number) => start + pitch * i + pitch / 2;
  const widthOf = (i: number) => {
    const d = hoverIdx >= 0 ? Math.abs(i - hoverIdx) : Infinity;
    if (d < FISHEYE.length) return FISHEYE[d];
    return i === activeIdx ? ACTIVE_W : BASE_W;
  };

  // The rail itself must render (empty) so it can be measured before ticks appear.
  if (ticks.length < MIN_TURNS) return <div className="turn-ruler" ref={rootRef} style={{ pointerEvents: 'none' }} aria-hidden />;

  return (
    <div className="turn-ruler" ref={rootRef} onMouseLeave={() => setHoverIdx(-1)}>
      {ticks.map((tick, i) => (
        <button
          key={tick.turnId || i}
          className={`tick${i === activeIdx ? ' active' : ''}${i === hoverIdx ? ' hover' : ''}`}
          style={{ top: centerOf(i) - pitch / 2, height: pitch, ['--w' as string]: `${widthOf(i)}px` }}
          aria-label={t('ruler.jump', i + 1)}
          onClick={() => jump(tick)}
          onMouseEnter={() => setHoverIdx(i)}
        />
      ))}
      {hoverIdx >= 0 && previewOf(hoverIdx) && (
        <div className="ruler-pop" style={{ top: centerOf(hoverIdx) }}>
          <div className="ruler-pop-q">{previewOf(hoverIdx)!.question.slice(0, 90) || t('ruler.image')}</div>
          {previewOf(hoverIdx)!.answer && <div className="ruler-pop-a">{previewOf(hoverIdx)!.answer.slice(0, 110)}</div>}
        </div>
      )}
    </div>
  );
}
