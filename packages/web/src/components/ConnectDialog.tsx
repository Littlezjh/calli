import { useEffect, useRef, useState } from 'react';
import { Api, ApiError, AuthError } from '../api';
import { DialogSurface } from './Dialog';

interface Props {
  /** Why it opened, under the title: what was being done, or why the old token stopped working. */
  reason?: string;
  /** Called with a token the hub has just accepted. */
  onConnected: (token: string) => void;
  onCancel: () => void;
}

/** Asks for the hub's token and tries it before keeping it, so a wrong one is said here and not later. */
export function ConnectDialog({ reason, onConnected, onCancel }: Props) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const connect = async () => {
    const token = value.trim();
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      await new Api(token).agents();
      onConnected(token);
    } catch (e) {
      setError(e instanceof AuthError ? 'token 不对，请检查后重试。' : e instanceof ApiError ? e.message : '连不上 hub，请检查地址和网络。');
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <DialogSurface labelledBy="connect-title" onClose={onCancel} busy={busy} className="connect-dialog">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <h2 id="connect-title" className="dialog-title">
          连接到 hub
        </h2>
        {reason && <p className="connect-reason">{reason}</p>}
        <p className="dialog-message">输入 hub 的访问 token，只保存在这台设备上。</p>
        <label className="dialog-field connect-field">
          <span className="sr-only">访问 token</span>
          <input
            ref={input}
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="RAH_TOKEN"
            aria-label="访问 token"
            aria-invalid={error ? true : undefined}
            disabled={busy}
          />
        </label>
        {error ? (
          <p className="field-hint bad" role="alert">
            {error}
          </p>
        ) : (
          <p className="field-hint">token 是 hub 所在机器上 .env 里的 RAH_TOKEN。</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy || !value.trim()}>
            {busy ? <span className="connect-spinner" aria-label="正在连接" /> : '连接'}
          </button>
        </div>
      </form>
    </DialogSurface>
  );
}

/** The line that says the page shows made-up data, with the way to connect. */
export function DemoBar({ compact, onConnect }: { compact?: boolean; onConnect: () => void }) {
  return (
    <div className="demo-bar" role="note">
      <span className="demo-bar-text">
        <strong>示例数据</strong>
        {!compact && <span className="demo-bar-more">，不会发给任何 agent。</span>}
      </span>
      <button type="button" className="primary demo-bar-btn" onClick={onConnect}>
        连接 hub
      </button>
    </div>
  );
}
