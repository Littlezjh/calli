import { useState } from 'react';

interface Props {
  onSubmit: (token: string) => void;
  message?: string;
}

export function TokenGate({ onSubmit, message }: Props) {
  const [value, setValue] = useState('');
  return (
    <div className="gate">
      <form
        className="gate-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h1>Remote Agent Hub</h1>
        <p className="muted">输入访问 token。它只保存在这台设备的浏览器里。</p>
        <input
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="RAH_TOKEN"
          aria-label="access token"
          autoFocus
        />
        <button type="submit" className="primary" disabled={!value.trim()}>
          进入
        </button>
        {message && <p className="error-text">{message}</p>}
      </form>
    </div>
  );
}
