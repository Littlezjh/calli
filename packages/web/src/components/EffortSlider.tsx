import { useState, type CSSProperties, type PointerEvent } from 'react';
import { EFFORT_LABELS } from '../permissions';

interface Props {
  levels: string[];
  value: string | null;
  onChange: (value: string | null) => void;
  onPreview: (value: string | null | undefined) => void;
}

/** A discrete, pointer- and keyboard-operated slider. Dragging previews; releasing commits once. */
export function EffortSlider({ levels, value, onChange, onPreview }: Props) {
  const options = [null, ...levels];
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const index = dragIndex ?? Math.max(0, options.indexOf(value));
  const label = (i: number) => options[i] === null ? '默认' : (EFFORT_LABELS[options[i]!] ?? options[i]!);
  const position = (i: number) => `${i / levels.length * 100}%`;
  const indexAt = (event: PointerEvent<HTMLDivElement>) => {
    const rail = event.currentTarget.querySelector('.effort-rail')!.getBoundingClientRect();
    return Math.max(0, Math.min(levels.length, Math.round((event.clientX - rail.left) / rail.width * levels.length)));
  };
  const preview = (i: number) => { setDragIndex(i); onPreview(options[i]); };
  const clear = () => { setDragIndex(null); onPreview(undefined); };
  return (
    <div
      className={`effort-slider${index === 0 ? ' is-default' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label="思考强度"
      aria-valuemin={0}
      aria-valuemax={levels.length}
      aria-valuenow={index}
      aria-valuetext={label(index)}
      aria-orientation="horizontal"
      style={{ '--effort-position': position(index), '--effort-fraction': index / levels.length } as CSSProperties}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        preview(indexAt(event));
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) preview(indexAt(event));
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onChange(options[indexAt(event)]);
        clear();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={clear}
      onLostPointerCapture={clear}
      onKeyDown={(event) => {
        let next = index;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next++;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next--;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = levels.length;
        else return;
        event.preventDefault();
        onChange(options[Math.max(0, Math.min(levels.length, next))]);
      }}
    >
      <div className="effort-fill" />
      <div className="effort-rail">
        {options.map((option, i) => (
          <span key={option ?? 'default'} className={`effort-dot${i <= index ? ' filled' : ''}`} style={{ left: position(i) }} title={label(i)} />
        ))}
        <span className="effort-thumb" />
      </div>
    </div>
  );
}
