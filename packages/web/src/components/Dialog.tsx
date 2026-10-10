import { useEffect, useRef, useState } from 'react';

interface Props {
  title: string;
  message?: string;
  /** When set, the dialog asks for text. The value is passed to onConfirm. */
  input?: { initial: string; label: string };
  /** An optional checkbox, off by default. Its state is the second argument to onConfirm. */
  option?: { label: string; hint?: string };
  confirmLabel: string;
  danger?: boolean;
  onConfirm: (value: string | undefined, optionChecked: boolean) => void;
  onCancel: () => void;
}

/** In-app modal used instead of window.prompt / window.confirm, so it matches the rest of the UI. */
export function Dialog({ title, message, input, option, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(input?.initial ?? '');
  const [checked, setChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => {
    if (input && !value.trim()) return;
    onConfirm(input ? value.trim() : undefined, checked);
  };

  return (
    <div className="dialog-scrim" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dialog-title" className="dialog-title">
          {title}
        </h2>
        {message && <p className="dialog-message">{message}</p>}
        {input && (
          <label className="dialog-field">
            <span className="sr-only">{input.label}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              aria-label={input.label}
            />
          </label>
        )}
        {option && (
          <label className="dialog-option">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span className="dialog-option-text">
              <span>{option.label}</span>
              {option.hint && <span className="dialog-option-hint">{option.hint}</span>}
            </span>
          </label>
        )}
        <div className="dialog-actions">
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className={danger ? 'danger' : 'primary'} onClick={submit} disabled={!!input && !value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
