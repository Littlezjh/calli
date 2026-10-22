/// <reference path="../novnc.d.ts" />
// The machine's Linux desktop, through the VNC server already running there. View only until the
// person takes control, so a stray touch on a phone cannot disturb an agent working on it. The
// picture is scaled to the window; the desktop's own resolution is never changed from here.
import { useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import type { Api } from '../api';
import { useIsTouch } from '../hooks';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconClose, IconDesktop, IconFit, IconKeyboard, IconPointer, IconSend } from './icons';

interface Props {
  api: Api;
  onClose: () => void;
}

type Phase = 'connecting' | 'connected' | 'disconnected' | 'unavailable' | 'failed';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// X keysyms for the keys a phone keyboard lacks.
const KEY = { esc: 0xff1b, tab: 0xff09, backspace: 0xff08, enter: 0xff0d, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54 };

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

export function DesktopPanel({ api, onClose }: Props) {
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
        rfb.addEventListener('desktopname', (e) => {
          if (!disposed) setName((e as CustomEvent<{ name: string }>).detail.name);
        });
        rfb.addEventListener('credentialsrequired', () => {
          if (!disposed) setAsking(wrongRef.current ? 'wrong' : 'first');
        });
        rfb.addEventListener('securityfailure', () => {
          savePassword(api.host, null);
          wrongRef.current = true;
        });
        rfb.addEventListener('disconnect', () => {
          if (disposed) return;
          rfbRef.current = null;
          setAsking(null);
          // A wrong password closes the connection; a new one asks for the password again.
          if (wrongRef.current) setNonce((n) => n + 1);
          else phaseNow('disconnected');
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
    if (control && !touch) rfb.focus();
  }, [control, fit, phase, touch]);

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
    <div className="dialog-scrim term-scrim">
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
            {control && (
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
            <button className="icon-btn" aria-label={t('common.close')} onClick={onClose}>
              <IconClose size={18} />
            </button>
          </div>
        </header>
        <div className={`desktop-screen${control ? ' control' : ''}`} ref={screenRef} />
        {control && typing && live && (
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
