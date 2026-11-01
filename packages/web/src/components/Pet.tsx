import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, type Api, type PetStatus } from '../api';
import { IconArrowUp, IconClose } from './icons';
import { useIsNarrow } from '../hooks';
import { t } from '../i18n';
import {
  applyPetStarter, clearPetHaze, nextPetFrame, parsePetPending, petCacheKey, petCacheName, petDay, petErrorDetail, petGreetingLine, petReplyParts, petRing, petStarters, readPetRouter, yawnDelay,
  PET_ART_COMMIT, PET_CACHE_PREFIX, PET_FRAME, PET_GIVE_UP_MS, PET_RING_SIZE, PET_WEBP_QUALITY, PET_LATE_MS, PET_LOST_POLLS,
  type PetClip, type PetGreeting, type PetPending,
} from '../pet';

const GREETED_KEY = 'calli.pet.greeted';
const PENDING_KEY = 'calli.pet.pending';
const DRAFT_KEY = 'calli.pet.draft';
const CREDIT_URL = `https://github.com/QCYTSN/dsh-dafeiyu/blob/${PET_ART_COMMIT}/assets/dsh-pet-LICENSE.txt`;
const GREETING_DELAY_MS = 900;
const GREETING_MS = 8_000;
const INSTALL_POLL_MS = 2_000;
const ROUTER_POLL_MS = 2_500;
/** Ticks a cut between clips takes to fade, so she does not jump from one pose to the next. */
const FADE_TICKS = 3;
const SEND_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↵' : 'Ctrl ↵';

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: it just lasts as long as the page.
  }
}

/**
 * Where cleaned frames live. The artwork carries a faint haze that has to be taken out pixel by pixel,
 * which is slow and only needs doing once per device: the result is encoded again and kept in Cache
 * Storage. Without it (an http address that is not localhost) the results are kept in memory for the
 * clip's lifetime. Only WebP is ever kept: a browser that cannot encode it cleans each frame as it comes
 * up, on every pass, rather than pile up megabytes of PNG on disk.
 */
class PetFrameStore {
  private readonly scratch = document.createElement('canvas');
  private readonly scratchContext: CanvasRenderingContext2D | null;
  private readonly cache: Promise<Cache | null>;
  private readonly held = new Map<string, Blob>();

  constructor(private readonly id: string, private readonly frameUrl: (clip: string, index: number) => string) {
    this.scratch.width = PET_FRAME.width;
    this.scratch.height = PET_FRAME.height;
    this.scratchContext = this.scratch.getContext('2d', { willReadFrequently: true });
    this.cache = this.openCache();
  }

  private async openCache(): Promise<Cache | null> {
    if (typeof caches === 'undefined') return null;
    try {
      const name = petCacheName(this.id);
      for (const old of await caches.keys()) {
        if (old !== name && old.startsWith(PET_CACHE_PREFIX)) void caches.delete(old);
      }
      return await caches.open(name);
    } catch {
      return null;
    }
  }

  /** The cleaned frame as a picture. The caller owns it and closes it. */
  async bitmap(clip: PetClip, index: number): Promise<ImageBitmap> {
    const key = petCacheKey(clip, index);
    const held = this.held.get(key);
    if (held) return createImageBitmap(held);
    const cache = await this.cache;
    const saved = await cache?.match(key).catch(() => undefined);
    if (saved) return createImageBitmap(await saved.blob());
    return this.clean(clip, index, key, cache ?? null);
  }

  private async clean(clip: PetClip, index: number, key: string, cache: Cache | null): Promise<ImageBitmap> {
    const response = await fetch(this.frameUrl(clip, index));
    if (!response.ok) throw new Error(`frame ${response.status}`);
    const source = await createImageBitmap(await response.blob());
    const scratch = this.scratchContext;
    if (!scratch) return source;
    scratch.clearRect(0, 0, PET_FRAME.width, PET_FRAME.height);
    scratch.drawImage(source, 0, 0);
    source.close();
    const pixels = scratch.getImageData(0, 0, PET_FRAME.width, PET_FRAME.height);
    clearPetHaze(pixels.data);
    scratch.putImageData(pixels, 0, 0);
    this.scratch.toBlob((blob) => {
      // A browser that cannot encode WebP (Safari) answers with a PNG instead, about ten times the size.
      if (blob?.type !== 'image/webp') return;
      if (cache) void cache.put(key, new Response(blob)).catch(() => undefined);
      else this.held.set(key, blob);
    }, 'image/webp', PET_WEBP_QUALITY);
    return createImageBitmap(pixels);
  }

  /** Lets go of what is held in memory for a clip. */
  forget(clip: PetClip): void {
    const prefix = petCacheKey(clip, 0).replace(/\d+\.webp$/, '');
    for (const key of this.held.keys()) {
      if (key.startsWith(prefix)) this.held.delete(key);
    }
  }
}

/**
 * Plays clips onto a canvas, keeping only the frames just ahead decoded. A frame not here yet holds
 * the last one: she pauses, never blanks.
 */
class PetPlayer {
  private readonly context: CanvasRenderingContext2D | null;
  private readonly before = document.createElement('canvas');
  private readonly store: PetFrameStore;
  private readonly ring = new Map<number, ImageBitmap>();
  private readonly loading = new Set<number>();
  private readonly failed = new Set<number>();
  /** Bumped when the clip changes, so a frame that arrives late for the old one is dropped. */
  private generation = 0;
  private clip: PetClip = 'idle';
  private frame = 0;
  private loop = true;
  private shown = false;
  private fade = 0;
  private timer: number | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly status: PetStatus,
    frameUrl: (clip: string, index: number) => string,
    private readonly still: boolean,
    private readonly onEnd: () => void,
  ) {
    this.context = canvas.getContext('2d');
    this.before.width = PET_FRAME.width;
    this.before.height = PET_FRAME.height;
    this.store = new PetFrameStore(status.id, frameUrl);
    this.fill();
  }

  get current(): PetClip { return this.clip; }

  private get count(): number {
    return this.still ? 1 : this.status.clips[this.clip] ?? 1;
  }

  /** Decodes what is coming up and closes what has passed. */
  private fill(): void {
    const wanted = petRing(this.frame, this.count, this.loop, PET_RING_SIZE);
    for (const [index, bitmap] of this.ring) {
      if (!wanted.includes(index)) { bitmap.close(); this.ring.delete(index); }
    }
    for (const index of wanted) {
      if (this.ring.has(index) || this.loading.has(index) || this.failed.has(index)) continue;
      this.loading.add(index);
      const generation = this.generation;
      this.store.bitmap(this.clip, index).then((bitmap) => {
        if (generation !== this.generation) { bitmap.close(); return; }
        this.loading.delete(index);
        this.ring.set(index, bitmap);
        if (index === this.frame && !this.shown) this.draw(bitmap);
      }, () => {
        if (generation !== this.generation) return;
        this.loading.delete(index);
        this.failed.add(index);
      });
    }
  }

  play(clip: PetClip, loop: boolean): void {
    if (this.still || (clip === this.clip && loop === this.loop)) return;
    const before = this.before.getContext('2d');
    if (before && this.context) {
      before.clearRect(0, 0, PET_FRAME.width, PET_FRAME.height);
      before.drawImage(this.context.canvas, 0, 0);
    }
    if (this.shown) this.fade = FADE_TICKS;
    if (this.clip !== 'idle' && this.clip !== clip) this.store.forget(this.clip);
    this.clearRing();
    this.clip = clip;
    this.loop = loop;
    this.frame = 0;
    this.shown = false;
    this.fill();
  }

  private clearRing(): void {
    this.generation += 1;
    for (const bitmap of this.ring.values()) bitmap.close();
    this.ring.clear();
    this.loading.clear();
    this.failed.clear();
  }

  private draw(bitmap: ImageBitmap): void {
    const context = this.context;
    if (!context) return;
    this.shown = true;
    context.clearRect(0, 0, PET_FRAME.width, PET_FRAME.height);
    context.drawImage(bitmap, 0, 0);
    if (this.fade > 0) {
      context.globalAlpha = this.fade / (FADE_TICKS + 1);
      context.drawImage(this.before, 0, 0);
      context.globalAlpha = 1;
    }
  }

  private tick(): void {
    const next = nextPetFrame(this.frame, this.count, this.loop);
    if (next === null) { this.onEnd(); return; }
    const bitmap = this.ring.get(next);
    // A frame that failed to load is skipped, not waited for.
    if (!bitmap && !this.failed.has(next)) return;
    if (this.fade > 0) this.fade -= 1;
    this.frame = next;
    if (bitmap) this.draw(bitmap);
    this.fill();
  }

  start(): void {
    if (this.still || this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), this.status.frameMs);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.clearRing();
  }
}

/** Whether a modal sits above her. A spread pile is modal too, but below. */
function petCoveredByModal(pet: HTMLElement | null): boolean {
  if (!pet) return false;
  const own = Number(getComputedStyle(pet).zIndex) || 0;
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
    .some((dialog) => (Number(getComputedStyle(dialog.closest('.dialog-scrim') ?? dialog).zIndex) || 0) > own);
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const read = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);
  return visible;
}

function useReducedMotion(): boolean {
  const [reduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  return reduced;
}

type Say =
  | { kind: 'greeting'; text: string }
  | { kind: 'reply'; text: string; threadId: string }
  | { kind: 'error'; text: string; retry?: () => void; threadId?: string; detail?: string | null; lost?: boolean; configure?: boolean };

interface Props {
  api: Api;
  greeting: PetGreeting;
  /** A pile is spread out on the desk: she steps back so she does not cover it. */
  spreadOpen: boolean;
  onOpenThread: (id: string) => void;
  /** Her install state, as it changes, for whatever else shows her. */
  onStatusChange?: (status: PetStatus) => void;
  /** Opens the private settings, for when no agent has been chosen to answer. */
  onConfigure?: () => void;
  /** Matters a reply may name; with `onOpenTodo` their names become links that spread that pile. */
  todos?: readonly { id: string; text: string }[];
  onOpenTodo?: (id: string) => void;
}

/** A failure's technical side: one tap away, for whoever needs it. Lives in a wrapping row, and opens below it. */
function PetDetail({ text }: { text?: string | null }) {
  const [shown, setShown] = useState(false);
  if (!text) return null;
  return (
    <>
      <button type="button" className="pet-say-action" aria-expanded={shown} title={text} onClick={() => setShown((was) => !was)}>{t('pet.details')}</button>
      {shown && <p className="pet-detail">{text}</p>}
    </>
  );
}

/** The desk's companion and the way to talk to the Router. Nothing here until she has been asked for. */
export function Pet({ api, greeting, spreadOpen, onOpenThread, onStatusChange, onConfigure, todos, onOpenTodo }: Props) {
  const [status, setStatus] = useState<PetStatus | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (api.demo) return;
    let gone = false;
    // Without a reading she stays away: the desk does not need her to work.
    void api.pet().then((next) => { if (!gone) setStatus(next); }).catch(() => undefined);
    return () => { gone = true; };
  }, [api]);

  const statusListener = useRef(onStatusChange);
  statusListener.current = onStatusChange;
  useEffect(() => {
    if (status) statusListener.current?.(status);
  }, [status]);

  const installing = Boolean(status?.installing);
  useEffect(() => {
    if (!installing) return;
    let gone = false;
    const timer = window.setInterval(() => {
      void api.pet().then((next) => { if (!gone) setStatus(next); }).catch(() => undefined);
    }, INSTALL_POLL_MS);
    return () => { gone = true; window.clearInterval(timer); };
  }, [api, installing]);

  const install = () => {
    setInstallError(null);
    if (status) setStatus({ ...status, installing: true, error: null });
    api.installPet().then(setStatus).catch((e: unknown) => {
      setInstallError(e instanceof Error ? e.message : String(e));
      setStatus((current) => current && { ...current, installing: false });
    });
  };

  if (api.demo || !status) return null;
  if (status.installed) return <PetCompanion api={api} status={status} greeting={greeting} spreadOpen={spreadOpen} onOpenThread={onOpenThread} onConfigure={onConfigure} todos={todos} onOpenTodo={onOpenTodo} />;

  const error = status.installing ? null : installError ?? status.error;
  return createPortal(
    <div className="pet pet-away">
      {error ? (
        <div className="pet-summon-failed" role="alert">
          <div className="pet-summon-why"><strong>{t('pet.installFailed')}</strong><div className="pet-say-actions"><PetDetail text={petErrorDetail(error)} /></div></div>
          <button type="button" className="pet-summon" onClick={install}>{t('pet.retry')}</button>
        </div>
      ) : status.installing ? (
        <div className="pet-summon pet-summoning" role="status"><span className="spinner" />{t('pet.installing')}</div>
      ) : (
        <button type="button" className="pet-summon" onClick={install}>{t('pet.summon')}</button>
      )}
    </div>,
    document.body,
  );
}

function PetCompanion({ api, status, greeting, spreadOpen, onOpenThread, onConfigure, todos, onOpenTodo }: Props & { status: PetStatus }) {
  const visible = usePageVisible();
  const still = useReducedMotion();
  const narrow = useIsNarrow();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const playerRef = useRef<PetPlayer | null>(null);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => readStored(DRAFT_KEY) ?? '');
  const [say, setSay] = useState<Say | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPendingState] = useState<PetPending | null>(() => parsePetPending(readStored(PENDING_KEY), Date.now()));
  const [late, setLate] = useState(false);

  const busy = sending || pending !== null;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const pendingRef = useRef(pending);
  const setPending = useCallback((next: PetPending | null) => {
    pendingRef.current = next;
    writeStored(PENDING_KEY, next && JSON.stringify(next));
    setPendingState(next);
  }, []);

  useEffect(() => {
    writeStored(DRAFT_KEY, draft || null);
  }, [draft]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const player = new PetPlayer(canvas, status, (clip, index) => api.petFrame(status.id, clip, index), still, () => {
      playerRef.current?.play(busyRef.current ? 'thinking' : 'idle', true);
    });
    playerRef.current = player;
    if (busyRef.current) player.play('thinking', true);
    return () => { player.dispose(); playerRef.current = null; };
  }, [api, status, still]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !visible) return;
    player.start();
    return () => player.stop();
  }, [visible, api, status, still]);

  // Now and then, only while she has nothing else to do.
  useEffect(() => {
    if (still || !visible || busy) return;
    let timer: number;
    const arm = () => {
      timer = window.setTimeout(() => {
        if (playerRef.current?.current === 'idle') playerRef.current.play('idle_yawn', false);
        arm();
      }, yawnDelay());
    };
    arm();
    return () => window.clearTimeout(timer);
  }, [still, visible, busy]);

  // Once a day, once the matters are in, and only when it can be seen: never over the card or a spread pile.
  useEffect(() => {
    if (!greeting || !visible || busy || open || spreadOpen) return;
    const now = new Date();
    if (readStored(GREETED_KEY) === petDay(now)) return;
    const timer = window.setTimeout(() => {
      writeStored(GREETED_KEY, petDay(now));
      // A phone has no room for a bubble that does not cover the desk: she only waves, and the words wait in the card.
      if (narrow) playerRef.current?.play('poke', false);
      else setSay((current) => current ?? { kind: 'greeting', text: petGreetingLine(greeting, now) });
    }, GREETING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [greeting, visible, busy, open, spreadOpen, narrow]);

  const greetingShown = say?.kind === 'greeting';
  useEffect(() => {
    if (!greetingShown) return;
    const timer = window.setTimeout(() => {
      setSay((current) => (current?.kind === 'greeting' ? null : current));
    }, GREETING_MS);
    // She only volunteered it: as soon as the person starts on the desk it gets out of the way.
    const dismiss = () => setSay((current) => (current?.kind === 'greeting' ? null : current));
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) dismiss(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('scroll', dismiss, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('scroll', dismiss, { capture: true });
    };
  }, [greetingShown]);

  // Wait for the Router's answer. The page being away pauses this; coming back reads at once.
  useEffect(() => {
    if (!pending || !visible) return;
    let gone = false;
    let timer: number;
    let resting = 0;
    let lost = 0;
    const settle = (next: Say, clip: PetClip, loop: boolean) => {
      setPending(null);
      setLate(false);
      setSay(next);
      playerRef.current?.play(clip, loop);
    };
    const unanswered = (): Say => ({
      kind: 'error',
      text: t('pet.replyFailed'),
      threadId: pending.threadId,
      retry: () => void send(pending.text),
    });
    const poll = async () => {
      const age = Date.now() - pending.sentAt;
      if (age > PET_GIVE_UP_MS) { settle(unanswered(), 'idle', true); return; }
      setLate(age > PET_LATE_MS);
      try {
        const router = await api.petRouter();
        if (gone) return;
        lost = 0;
        setSay((current) => (current?.kind === 'error' && current.lost ? null : current));
        resting = router.status === 'running' ? 0 : resting + 1;
        const reading = readPetRouter(router, pending.since, resting);
        if (reading === 'failed' || reading === 'quiet') { settle(unanswered(), 'idle', true); return; }
        if (reading !== 'waiting') {
          settle({ kind: 'reply', text: reading.reply, threadId: pending.threadId }, 'success', false);
          return;
        }
      } catch (e) {
        if (gone) return;
        lost += 1;
        // It keeps trying: the answer is still on its way, and the bubble clears when the hub is back.
        if (lost >= PET_LOST_POLLS) setSay({ kind: 'error', text: t('pet.lost'), detail: petErrorDetail(e), threadId: pending.threadId, lost: true });
      }
      timer = window.setTimeout(() => void poll(), ROUTER_POLL_MS);
    };
    void poll();
    return () => { gone = true; window.clearTimeout(timer); };
    // `send` only reads refs and setters, so an older copy of it is as good as a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pending, visible, setPending]);

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    setOpen(false);
    setDraft('');
    setSay(null);
    setLate(false);
    setSending(true);
    playerRef.current?.play('thinking', true);
    try {
      // Already waiting: this one joins that wait, and the next reply covers both.
      const waiting = pendingRef.current;
      const since = waiting ? waiting.since : await api.petRouter().then((router) => router.lastReplyAt).catch(() => null);
      const { threadId } = await api.petSay(text);
      setPending({ since, threadId, sentAt: Date.now(), text });
    } catch (e) {
      setDraft(text);
      const configure = e instanceof ApiError && e.status === 409 && e.message === 'personal agent is not configured';
      setSay({
        kind: 'error',
        text: configure ? t('pet.needsSetup') : e instanceof TypeError ? t('pet.sendOffline') : t('pet.sendFailed'),
        detail: configure ? null : petErrorDetail(e),
        retry: () => void send(text),
        configure,
      });
      if (!pendingRef.current) playerRef.current?.play('idle', true);
    } finally {
      setSending(false);
    }
  };

  const openCard = () => {
    if (!busy && !open) playerRef.current?.play('poke', false);
    setOpen((was) => !was);
    setSay((current) => (current?.kind === 'greeting' ? null : current));
  };

  // Grows with the words, up to the height the stylesheet allows.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [draft, open]);

  useEffect(() => {
    if (!open) return;
    const field = fieldRef.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      // After the press has put focus where it belongs: only if it landed nowhere does it come back to her.
      window.setTimeout(() => { if (document.activeElement === document.body) bodyRef.current?.focus({ preventScroll: true }); });
    };
    // Captured, because a spread pile below her also listens for Esc, and she answers first. A modal
    // above her or an open menu has the keyboard, and the same goes for a composing input method.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      if (document.querySelector('.pop-panel') || petCoveredByModal(rootRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      bodyRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const openThread = (id: string) => {
    setSay(null);
    onOpenThread(id);
  };

  const starters = petStarters();
  const startWith = (start: string) => {
    setDraft((current) => applyPetStarter(current, start, starters.map((s) => s.start)));
    fieldRef.current?.focus();
  };

  // A pile spread out has the floor: what she volunteers waits, what the person asked for stays.
  const bubble = open || (spreadOpen && say?.kind === 'greeting') ? null : say;

  // On the body, because a spread pile is too, and she has to stay above it and within reach.
  return createPortal(
    <div ref={rootRef} className={`pet${open ? ' pet-open' : ''}${spreadOpen ? ' pet-back' : ''}`}>
      {open && (
        <div className="pet-card" role="dialog" aria-label={t('pet.open')}>
          {narrow && greeting && greeting.you > 0 && <p className="pet-card-note">{petGreetingLine(greeting, new Date())}</p>}
          <textarea
            ref={fieldRef}
            className="pet-field"
            rows={2}
            value={draft}
            placeholder={t('pet.placeholder')}
            aria-label={t('pet.open')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); }
            }}
          />
          <div className="pet-card-foot">
            {draft.trim() ? (
              <span className="pet-shortcut">{t('pet.shortcut', SEND_KEY)}</span>
            ) : (
              <div className="pet-starters">
                {starters.map((starter) => (
                  <button key={starter.start} type="button" className="pet-starter" onClick={() => startWith(starter.start)}>{starter.label}</button>
                ))}
              </div>
            )}
            <button type="button" className="pet-send" aria-label={t('pet.send')} title={t('pet.send')} disabled={!draft.trim()} onClick={() => void send(draft)}>
              <IconArrowUp size={16} />
            </button>
          </div>
          <a className="pet-credit" href={CREDIT_URL} target="_blank" rel="noreferrer">{t('pet.credit')}</a>
        </div>
      )}

      {bubble?.kind === 'greeting' && (
        <button type="button" className="pet-say pet-say-tap" onClick={openCard}>{bubble.text}</button>
      )}
      {bubble && bubble.kind !== 'greeting' && (
        <div className={`pet-say${bubble.kind === 'error' ? ' pet-say-error' : ''}`} role={bubble.kind === 'error' ? 'alert' : 'status'}>
          <p>
            {bubble.kind === 'reply' && onOpenTodo
              ? petReplyParts(bubble.text, todos ?? []).map((part, index) => (part.todoId
                ? <button key={index} type="button" className="pet-say-todo" onClick={() => { setSay(null); onOpenTodo(part.todoId!); }}>{part.text}</button>
                : <span key={index}>{part.text}</span>))
              : bubble.text}
          </p>
          <div className="pet-say-actions">
            {bubble.kind === 'error' && bubble.configure && onConfigure && <button type="button" className="pet-say-action" onClick={onConfigure}>{t('pet.configure')}</button>}
            {bubble.kind === 'error' && bubble.retry && <button type="button" className="pet-say-action" onClick={bubble.retry}>{t('pet.retry')}</button>}
            {bubble.kind === 'error' && <PetDetail key={bubble.text} text={bubble.detail} />}
            {bubble.threadId && <button type="button" className="pet-say-action" onClick={() => openThread(bubble.threadId!)}>{t('pet.openThread')}</button>}
            <button type="button" className="pet-say-close" aria-label={t('pet.dismiss')} title={t('pet.dismiss')} onClick={() => setSay(null)}><IconClose size={14} /></button>
          </div>
        </div>
      )}
      {!bubble && !open && busy && (
        <div className="pet-say pet-say-thinking" role="status">
          <p>{late ? t('pet.thinkingLate') : t('pet.thinking')}</p>
          {late && pending && <div className="pet-say-actions"><button type="button" className="pet-say-action" onClick={() => openThread(pending.threadId)}>{t('pet.openThread')}</button></div>}
        </div>
      )}

      <button ref={bodyRef} type="button" className="pet-body" aria-label={t('pet.open')} aria-expanded={open} onClick={openCard}>
        <canvas ref={canvasRef} width={PET_FRAME.width} height={PET_FRAME.height} aria-hidden="true" />
      </button>
    </div>,
    document.body,
  );
}
