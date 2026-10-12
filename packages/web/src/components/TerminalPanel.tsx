// A real terminal on the host, one per daemon for now: closing the panel hides it, typing `exit`
// or the daemon's idle sweep ends it. The panel reattaches to whatever terminal is alive, so
// closing and reopening keeps the screen; the daemon replays its backlog on every connect.
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { Api, TerminalFrame, TerminalInfo } from '../api';
import { copyText } from '../clipboard';
import { folderName } from '../paths';
import type { ToastState } from './Toast';
import { IconClose, IconTerminal } from './icons';

interface Props {
  api: Api;
  /** Where a terminal starts. Only used when none is alive; after that the shell goes where it pleases. */
  cwd: string;
  toast: (t: ToastState | null) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Terminal colours come from the page's own variables, so themes apply without a mapping of our own. */
function themeFromPage(): { theme: Record<string, string>; dark: boolean } {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const m = /^#([0-9a-f]{6})$/i.exec(v('--bg'));
  const n = m ? parseInt(m[1], 16) : 0;
  const dark = !m || (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 128;
  // The ANSI 16 are picked by hand for the two modes: xterm's defaults are made for black screens.
  const ansi = dark
    ? ['#161514', '#f97066', '#3f9a72', '#f0935a', '#7ba7d9', '#c39ac9', '#6fc3c9', '#9a978f', '#6f6c65', '#f97066', '#3f9a72', '#f0935a', '#7ba7d9', '#c39ac9', '#6fc3c9', '#ecebe7']
    : ['#1f1e1c', '#b42318', '#2f7d5b', '#8a6a1f', '#3b6ea5', '#8f4f7d', '#20707a', '#6f6c65', '#a9a69e', '#b42318', '#2f7d5b', '#8a6a1f', '#3b6ea5', '#8f4f7d', '#20707a', '#1f1e1c'];
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  const theme: Record<string, string> = {
    background: v('--bg'),
    foreground: v('--text'),
    cursor: v('--text'),
    cursorAccent: v('--bg'),
    selectionBackground: v('--active'),
  };
  names.forEach((name, i) => (theme[name] = ansi[i]));
  return { theme, dark };
}

export function TerminalPanel({ api, cwd, toast, onClose, onError }: Props) {
  // Bumped by 重新打开/重试: the whole terminal (xterm and stream) is rebuilt from scratch.
  const [nonce, setNonce] = useState(0);
  const [phase, setPhase] = useState<'connecting' | 'running' | 'ended' | 'failed'>('connecting');
  const [failure, setFailure] = useState('');
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const host = hostRef.current;
    if (!host) return;

    const { theme } = themeFromPage();
    const term = new Terminal({
      theme,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host);

    // Themes can change while the panel is open (light/dark switch, another palette).
    const observer = new MutationObserver(() => {
      term.options.theme = themeFromPage().theme;
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });

    const phaseNow = (p: 'connecting' | 'running' | 'ended' | 'failed') => {
      if (!disposed) setPhase(p);
    };

    // Keystrokes wait briefly in a batch: a POST per key would hammer the connection.
    let pending = '';
    let flushTimer: number | null = null;
    const flush = (id: string) => {
      flushTimer = null;
      const data = pending;
      pending = '';
      if (data) {
        api.terminalInput(id, data).catch((e) => {
          if (/exited/.test(message(e))) phaseNow('ended');
        });
      }
    };

    void (async () => {
      try {
        // Attach to the newest live terminal; only when there is none does the directory matter.
        const alive = await api.listTerminals();
        const t = alive.at(-1) ?? (await api.createTerminal(cwd));
        if (disposed) return;
        setInfo(t);
        if (host.clientWidth === 0) await new Promise((r) => requestAnimationFrame(r));

        const applyFit = () => {
          try {
            fit.fit();
          } catch {
            return; // the container is hidden or has no size yet
          }
          api.terminalSize(t.id, term.cols, term.rows).catch(() => undefined);
        };
        const ro = new ResizeObserver(() => requestAnimationFrame(applyFit));
        ro.observe(host);
        applyFit();

        term.onData((data) => {
          pending += data;
          if (flushTimer === null) flushTimer = window.setTimeout(() => flush(t.id), 16);
        });
        term.focus();
        phaseNow('running');

        // Reconnect until the shell exits or the panel closes. Every connect replays the backlog,
        // so the screen is repainted whole (term.reset) instead of continuing where it broke off.
        let exited = false;
        const onFrame = (f: TerminalFrame) => {
          if (f.type === 'backlog') {
            term.reset();
            term.write(bytes(f.data));
          } else if (f.type === 'out') {
            term.write(bytes(f.data));
          } else {
            exited = true;
            phaseNow('ended');
          }
        };
        while (!disposed && !exited) {
          try {
            await api.stream<TerminalFrame>(`/api/terminals/${t.id}/stream`, onFrame, abort.signal);
            if (disposed || exited) break;
          } catch (e) {
            if (abort.signal.aborted || disposed) break;
            if (/unknown terminal/.test(message(e))) {
              // Gone for good on the daemon: swept after its grace, or the daemon restarted.
              exited = true;
              phaseNow('ended');
              break;
            }
            if (e instanceof Error && e.name === 'AuthError') {
              onError(e);
              break;
            }
          }
          await sleep(800, abort.signal);
        }
        ro.disconnect();
      } catch (e) {
        if (!disposed) {
          setFailure(message(e));
          phaseNow('failed');
        }
      } finally {
        if (flushTimer !== null) window.clearTimeout(flushTimer);
      }
    })();

    return () => {
      disposed = true;
      abort.abort();
      observer.disconnect();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      term.dispose();
    };
  }, [nonce]);

  const restart = () => {
    setFailure('');
    setInfo(null);
    setPhase('connecting');
    setNonce((n) => n + 1);
  };

  return (
    <div className="dialog-scrim term-scrim">
      <div className="panel term-panel" role="dialog" aria-modal="true" aria-label="终端">
        <header className="panel-head">
          <div className="term-head-main">
            <h2 className="panel-title">
              <IconTerminal size={20} /> 终端
            </h2>
            {info && (
              <button
                className="term-cwd"
                title={info.cwd}
                onClick={() => void copyText(info.cwd).then((ok) => toast({ message: ok ? '已复制目录' : '复制失败，请手动复制' }))}
              >
                {folderName(info.cwd)}
              </button>
            )}
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <div className="term-body" ref={hostRef} />
        {phase !== 'running' && (
          <div className="term-note" role="status">
            {phase === 'connecting' && <p>连接中…</p>}
            {phase === 'ended' && (
              <>
                <p>终端已结束</p>
                <button onClick={restart}>重新打开</button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <p>{failure || '打不开终端'}</p>
                <button onClick={restart}>重试</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
