/// <reference path="../novnc.d.ts" />
// The machine's Linux desktop, through the VNC server already running there. View only until the
// person takes control, so a stray touch on a phone cannot disturb an agent working on it. The
// picture is scaled to the window; the desktop's own resolution is never changed from here.
import { useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import type { Api } from '../api';
import { copyText } from '../clipboard';
import { useIsTouch } from '../hooks';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { Popover } from './Popover';
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconClipboard, IconClose, IconDesktop, IconFit, IconKeyboard, IconMinus, IconPointer, IconSend } from './icons';

interface Props {
  api: Api;
  /** Minimized: out of sight, still connected, so coming back needs no reconnect. */
  hidden?: boolean;
  onMinimize: () => void;
  /** Disconnects. */
  onClose: () => void;
}

type Phase = 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'failed';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// X keysyms for the keys a phone keyboard lacks, and Control for the shortcuts sent on a Mac's behalf.
const KEY = { esc: 0xff1b, tab: 0xff09, backspace: 0xff08, enter: 0xff0d, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, ctrl: 0xffe3 };

/** On a Mac, ⌘ is the shortcut key; the Linux desktop's is Control. */
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** How long after Ctrl/⌘+C the desktop's new clipboard is still copied here on its own. */
const COPY_WINDOW_MS = 3000;

/** The keysym that types a character: Latin-1 is its own code, the rest of Unicode is offset. */
const keysym = (ch: string): number => {
  if (ch === '\n') return KEY.enter;
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x100 ? cp : 0x1000000 + cp;
};

/** The VNC password is kept on this device, per machine, like the token. Storage may be blocked. */
const passwordKey = (host: string | null) => `rah.vnc.${host ?? 'local'}`;
function loadPassword(host: string | null): string | null {
  try {
    return localStorage.getItem(passwordKey(host));
  } catch {
    return null;
  }
}
function savePassword(host: string | null, password: string | null): void {
  try {
    if (password) localStorage.setItem(passwordKey(host), password);
    else localStorage.removeItem(passwordKey(host));
  } catch {
    // Storage unavailable: asked again next time.
  }
}

export function DesktopPanel({ api, hidden = false, onMinimize, onClose }: Props) {
  // Bumped by Reconnect: a new ticket and a new connection.
  const [nonce, setNonce] = useState(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [failure, setFailure] = useState('');
  const [name, setName] = useState('');
  const [asking, setAsking] = useState<null | 'first' | 'wrong'>(null);
  const [control, setControl] = useState(false);
  const [fit, setFit] = useState(true);
  const touch = useIsTouch();
  // The typing bar: open from the start on a touch screen, where there is no other keyboard.
  const [typing, setTyping] = useState(touch);
  const [line, setLine] = useState('');
  // The desktop's clipboard as last heard, and whether it changed since the person looked.
  const [remoteClip, setRemoteClip] = useState('');
  const [clipFresh, setClipFresh] = useState(false);
  const remoteClipRef = useRef('');
  const copyWantedRef = useRef(0);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const viewRef = useRef({ control, fit });
  viewRef.current = { control, fit };
  // A password the server turned down: the next connection asks again, saying so.
  const wrongRef = useRef(false);
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let rfb: RFB | null = null;
    const screen = screenRef.current;
    if (!screen) return;
    const phaseNow = (p: Phase) => {
      if (!disposed) setPhase(p);
    };
    void (async () => {
      try {
        const { available } = await api.desktop();
        if (disposed) return;
        if (!available) return phaseNow('unavailable');
        // noVNC is loaded only when a desktop is opened.
        const [{ default: Client }, url] = await Promise.all([import('@novnc/novnc'), api.desktopSocketUrl()]);
        if (disposed) return;
        const saved = loadPassword(api.host);
        pendingRef.current = saved;
        rfb = new Client(screen, url, { shared: true, ...(saved ? { credentials: { password: saved } } : {}) });
        rfbRef.current = rfb;
        rfb.background = 'transparent';
        rfb.resizeSession = false;
        rfb.viewOnly = !viewRef.current.control;
        rfb.scaleViewport = viewRef.current.fit;
        rfb.clipViewport = !viewRef.current.fit;
        rfb.dragViewport = !viewRef.current.fit && !viewRef.current.control;
        rfb.addEventListener('connect', () => {
          wrongRef.current = false;
          savePassword(api.host, pendingRef.current);
          phaseNow('connected');
        });
        rfb.addEventListener('clipboard', (e) => {
          const text = (e as CustomEvent<{ text: string }>).detail.text;
          if (disposed || text === remoteClipRef.current) return;
          remoteClipRef.current = text;
          setRemoteClip(text);
          // Just after Ctrl/⌘+C the keystroke still counts as the person's: the copy lands here too.
          if (Date.now() - copyWantedRef.current < COPY_WINDOW_MS) {
            copyWantedRef.current = 0;
            void copyText(text).then((ok) => {
              setClipFresh(!ok);
              rfbRef.current?.focus();
            });
          } else {
            setClipFresh(true);
          }
        });
        rfb.addEventListener('desktopname', (e) => {
          if (!disposed) setName((e as CustomEvent<{ name: string }>).detail.name);
        });
        rfb.addEventListener('credentialsrequired', () => {
          if (!disposed) setAsking(wrongRef.current ? 'wrong' : 'first');
        });
        // Why the server turned the connection away, when it is not a wrong password.
        let refused = '';
        rfb.addEventListener('securityfailure', (e) => {
          const reason = (e as CustomEvent<{ reason?: string }>).detail.reason ?? '';
          // TigerVNC's word for a wrong password; anything else (too many failures) is a refusal.
          if (reason && !/authentication/i.test(reason)) {
            refused = /too many/i.test(reason) ? t('desktop.blocked') : t('desktop.refused', reason);
            return;
          }
          savePassword(api.host, null);
          wrongRef.current = true;
        });
        rfb.addEventListener('disconnect', () => {
          if (disposed) return;
          rfbRef.current = null;
          setAsking(null);
          if (refused) {
            setFailure(refused);
            phaseNow('failed');
          } else if (wrongRef.current) {
            // A wrong password closes the connection; a new one asks for the password again.
            setNonce((n) => n + 1);
          } else {
            phaseNow('disconnected');
          }
        });
      } catch (e) {
        if (disposed) return;
        setFailure(message(e));
        phaseNow('failed');
      }
    })();
    return () => {
      disposed = true;
      rfbRef.current = null;
      rfb?.disconnect();
    };
  }, [api, nonce]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = !control;
    rfb.scaleViewport = fit;
    rfb.clipViewport = !fit;
    // At full size the picture is panned by dragging, while dragging is not the desktop's own.
    rfb.dragViewport = !fit && !control;
    if (control && !touch && !hidden) rfb.focus();
  }, [control, fit, phase, touch, hidden]);

  // With a real keyboard the shortcuts carry the clipboard: Ctrl/⌘+V pastes this device's text on
  // the desktop, Ctrl/⌘+C copies the desktop's back. On a Mac, ⌘ stands in for Control.
  useEffect(() => {
    const screen = screenRef.current;
    const rfb = rfbRef.current;
    if (!screen || !rfb || !control || touch || phase !== 'connected') return;
    const swallowed = new Set<string>();
    let pasteTimer = 0;
    // Control is already down on the desktop unless ⌘ stood in for it.
    const chord = (key: string) => {
      if (MAC) rfb.sendKey(KEY.ctrl, 'ControlLeft', true);
      rfb.sendKey(keysym(key), null);
      if (MAC) rfb.sendKey(KEY.ctrl, 'ControlLeft', false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // ⌘ alone is not passed on as the desktop's Super key: it only ever means Control here.
      if (MAC && e.key === 'Meta') {
        e.stopPropagation();
        return;
      }
      const shortcut = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!shortcut || e.altKey || e.key.length !== 1) return;
      const key = e.key.toLowerCase();
      e.stopPropagation();
      swallowed.add(e.code);
      if (key === 'v') {
        // Not prevented: the browser pastes, and the paste event below brings the text. Without
        // one (nothing to paste here) the desktop pastes what it already has.
        pasteTimer = window.setTimeout(() => chord('v'), 150);
        return;
      }
      e.preventDefault();
      if (key === 'c' || key === 'x') copyWantedRef.current = Date.now();
      chord(key);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if ((MAC && e.key === 'Meta') || swallowed.delete(e.code)) e.stopPropagation();
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      window.clearTimeout(pasteTimer);
      e.preventDefault();
      if (text) {
        rfb.clipboardPasteFrom(text);
        remoteClipRef.current = text;
        setRemoteClip(text);
      }
      // A moment for the desktop to own the new text before the app there asks for it.
      pasteTimer = window.setTimeout(() => chord('v'), 50);
    };
    screen.addEventListener('keydown', onKeyDown, true);
    screen.addEventListener('keyup', onKeyUp, true);
    screen.addEventListener('paste', onPaste, true);
    return () => {
      window.clearTimeout(pasteTimer);
      screen.removeEventListener('keydown', onKeyDown, true);
      screen.removeEventListener('keyup', onKeyUp, true);
      screen.removeEventListener('paste', onPaste, true);
    };
  }, [control, touch, phase]);

  const sendClip = (text: string) => {
    rfbRef.current?.clipboardPasteFrom(text);
    remoteClipRef.current = text;
    setRemoteClip(text);
  };

  const reconnect = () => {
    setFailure('');
    setName('');
    setPhase('connecting');
    setNonce((n) => n + 1);
  };

  const type = (text: string) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    for (const ch of text) rfb.sendKey(keysym(ch), null);
  };
  const press = (sym: number) => rfbRef.current?.sendKey(sym, null);

  const keys: Array<[string, number, JSX.Element?]> = [
    ['Esc', KEY.esc],
    ['Tab', KEY.tab],
    [t('desktop.backspace'), KEY.backspace],
    ['Enter', KEY.enter],
    [t('term.up'), KEY.up, <IconArrowUp size={16} />],
    [t('term.down'), KEY.down, <IconArrowDown size={16} />],
    [t('term.left'), KEY.left, <IconArrowLeft size={16} />],
    [t('term.right'), KEY.right, <IconArrowRight size={16} />],
  ];
  const live = phase === 'connected';

  return (
    <div className="dialog-scrim term-scrim" hidden={hidden}>
      <div className="panel term-panel desktop-panel" role="dialog" aria-modal="true" aria-label={t('desktop.title')}>
        <header className="panel-head">
          <div className="term-head-main">
            <h2 className="panel-title">
              <IconDesktop size={20} /> {t('desktop.title')}
            </h2>
            {name && (
              <span className="desktop-name" title={name}>
                {name}
              </span>
            )}
          </div>
          <div className="desktop-actions">
            <button
              className={`desktop-control${control ? ' on' : ''}`}
              aria-pressed={control}
              title={t('desktop.controlHint')}
              disabled={!live}
              onClick={() => setControl((c) => !c)}
            >
              <IconPointer size={16} />
              <span>{t('desktop.control')}</span>
            </button>
            <button
              className={`icon-btn${fit ? '' : ' on'}`}
              aria-pressed={!fit}
              aria-label={fit ? t('desktop.actual') : t('desktop.fit')}
              title={fit ? t('desktop.actual') : t('desktop.fit')}
              disabled={!live}
              onClick={() => setFit((f) => !f)}
            >
              <IconFit size={18} />
            </button>
            {/* noVNC passes no clipboard either way while view only: it is part of taking control. */}
            {control && <Popover
              label={t('desktop.clipboard')}
              triggerClassName={`icon-btn desktop-clip-btn${clipFresh ? ' fresh' : ''}`}
              triggerLabel={clipFresh ? t('desktop.clipNew') : t('desktop.clipboard')}
              triggerTitle={clipFresh ? t('desktop.clipNew') : t('desktop.clipboard')}
              panelClassName="desktop-clip"
              align="end"
              disabled={!live}
              trigger={<IconClipboard size={18} />}
            >
              {() => <ClipboardSheet remote={remoteClip} hint={!touch} onSeen={() => setClipFresh(false)} onSend={sendClip} />}
            </Popover>}
            {control && touch && (
              <button
                className={`icon-btn${typing ? ' on' : ''}`}
                aria-pressed={typing}
                aria-label={t('desktop.keyboard')}
                title={t('desktop.keyboard')}
                onClick={() => setTyping((v) => !v)}
              >
                <IconKeyboard size={18} />
              </button>
            )}
            <button className="icon-btn desktop-minimize" aria-label={t('desktop.minimize')} title={t('desktop.minimizeHint')} onClick={onMinimize}>
              <IconMinus size={18} />
            </button>
            <button className="icon-btn" aria-label={t('desktop.close')} title={t('desktop.close')} onClick={onClose}>
              <IconClose size={18} />
            </button>
          </div>
        </header>
        <div className={`desktop-screen${control ? ' control' : ''}`} ref={screenRef} />
        {control && touch && typing && live && (
          <div className="term-input desktop-input">
            <div className="term-keys" role="toolbar" aria-label={t('desktop.keys')}>
              {keys.map(([label, sym, icon]) => (
                <button key={label} type="button" aria-label={label} onPointerDown={(e) => e.preventDefault()} onClick={() => press(sym)}>
                  {icon ?? label}
                </button>
              ))}
            </div>
            <form
              className="term-line"
              onSubmit={(e) => {
                e.preventDefault();
                type(line);
                press(KEY.enter);
                setLine('');
              }}
            >
              <input
                value={line}
                onChange={(e) => setLine(e.target.value)}
                onKeyDown={(e) => {
                  // An empty field passes Backspace on, to rub out what is already on the desktop.
                  if (e.key === 'Backspace' && line === '' && !e.nativeEvent.isComposing) press(KEY.backspace);
                }}
                placeholder={t('desktop.placeholder')}
                aria-label={t('desktop.input')}
                enterKeyHint="send"
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="term-send" aria-label={t('common.send')}>
                <IconSend size={16} />
              </button>
            </form>
          </div>
        )}
        {phase !== 'connected' && !asking && (
          <div className="term-note" role="status">
            {phase === 'connecting' && <p>{t('desktop.connecting')}</p>}
            {phase === 'unavailable' && (
              <>
                <p>{t('desktop.unavailable')}</p>
                <p className="desktop-hint">{t('desktop.unavailableHint')}</p>
                <button onClick={reconnect}>{t('common.retry')}</button>
              </>
            )}
            {phase === 'disconnected' && (
              <>
                <p>{t('desktop.disconnected')}</p>
                <button onClick={reconnect}>{t('desktop.reconnect')}</button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <p>{failure || t('desktop.failed')}</p>
                <button onClick={reconnect}>{t('common.retry')}</button>
              </>
            )}
          </div>
        )}
        {asking && (
          <Dialog
            title={t('desktop.pwTitle')}
            message={asking === 'wrong' ? t('desktop.pwWrong') : t('desktop.pwMsg')}
            input={{ initial: '', label: t('desktop.pw'), secret: true }}
            confirmLabel={t('desktop.connect')}
            onConfirm={(password) => {
              setAsking(null);
              pendingRef.current = password ?? null;
              rfbRef.current?.sendCredentials({ password: password ?? '' });
            }}
            onCancel={() => {
              setAsking(null);
              wrongRef.current = false;
              rfbRef.current?.disconnect();
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Both directions of the clipboard: the desktop's text to copy here, and a field to send text there. */
function ClipboardSheet({ remote, hint, onSeen, onSend }: { remote: string; hint: boolean; onSeen: () => void; onSend: (text: string) => void }) {
  const [copied, setCopied] = useState<null | boolean>(null);
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(onSeen, [remote]);
  return (
    <div className="desktop-clip-body">
      <section>
        <h3>{t('desktop.clipRemote')}</h3>
        {remote ? <pre className="desktop-clip-text">{remote}</pre> : <p className="desktop-clip-empty">{t('desktop.clipEmpty')}</p>}
        {remote && (
          <button type="button" className="ghost" onClick={() => void copyText(remote).then(setCopied)}>
            {t('desktop.clipCopy')}
          </button>
        )}
        {copied !== null && <p className={`desktop-clip-note${copied ? '' : ' bad'}`}>{copied ? t('desktop.clipCopied') : t('desktop.clipCopyFailed')}</p>}
      </section>
      <section>
        <h3>{t('desktop.clipLocal')}</h3>
        <textarea
          value={text}
          rows={3}
          placeholder={t('desktop.clipPaste')}
          aria-label={t('desktop.clipPaste')}
          onChange={(e) => {
            setText(e.target.value);
            setSent(false);
          }}
        />
        <button
          type="button"
          className="ghost"
          disabled={!text}
          onClick={() => {
            onSend(text);
            setSent(true);
          }}
        >
          {t('desktop.clipSend')}
        </button>
        {sent && <p className="desktop-clip-note">{t('desktop.clipSent')}</p>}
      </section>
      {hint && <p className="desktop-clip-hint">{t('desktop.clipHint')}</p>}
    </div>
  );
}
