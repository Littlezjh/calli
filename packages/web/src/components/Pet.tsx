import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, type Api, type PetStatus, type Thread } from '../api';
import { IconArrowUp, IconClose, IconList, IconEdit } from './icons';
import { useIsNarrow, useIsTouch } from '../hooks';
import { ProfileDialog } from './ProfileDialog';
import { t } from '../i18n';
import {
  applyPetStarter, clearPetHaze, nextPetFrame, petBustBox, parsePetPending, petCacheKey, petCacheName, petClampPosition, petDay, petErrorDetail, petGreetingLine, petLicenseUrl, petNotableThreads, petReplyParts, petRing, petStarters, petThreadState, readPetRouter, yawnDelay,
  PET_BUBBLE_FADE_MS, PET_BUBBLE_GONE_MS, PET_BUST_HEIGHT, PET_CACHE_PREFIX, PET_FRAME, PET_GIVE_UP_MS, PET_RING_SIZE, PET_WEBP_QUALITY, PET_LATE_MS, PET_LOST_POLLS,
  type PetBust, type PetClip, type PetGreeting, type PetPending, type PetPresence, type PetThreadState,
} from '../pet';

const GREETED_KEY = 'calli.pet.greeted';
const PENDING_KEY = 'calli.pet.pending';
const DRAFT_KEY = 'calli.pet.draft';
const POS_KEY = 'calli.pet.pos';
const PRESENCE_KEY = 'calli.pet.presence';
const PRESENCE_EVENT = 'calli:pet-presence';
const GREETING_DELAY_MS = 900;
const INSTALL_POLL_MS = 2_000;
const ROUTER_POLL_MS = 2_500;
/** Ticks a cut between clips takes to fade, so she does not jump from one pose to the next. */
const FADE_TICKS = 3;
/** Moving further than this counts as a drag rather than a tap. */
const DRAG_SLOP_PX = 5;
/** A new thread state shows the bar for this long before it hides again. */
const REVEAL_STATUS_MS = 4_500;
/** A phone has no hover: her first tap shows the bar for this long. */
const REVEAL_TAP_MS = 6_000;
/** In "when needed" presence she goes back to the dot this long after the last thing to show. */
const TUCK_AFTER_SPEAK_MS = 10_000;

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

  constructor(private readonly id: string, private readonly commit: string, private readonly frameUrl: (clip: string, index: number) => string) {
    this.scratch.width = PET_FRAME.width;
    this.scratch.height = PET_FRAME.height;
    this.scratchContext = this.scratch.getContext('2d', { willReadFrequently: true });
    this.cache = this.openCache();
  }

  private async openCache(): Promise<Cache | null> {
    if (typeof caches === 'undefined') return null;
    try {
      const name = petCacheName(this.id, this.commit);
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
    this.store = new PetFrameStore(status.id, status.commit, frameUrl);
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

/** Her head and upper body from the first idle frame, cut to her outline. */
export type { PetBust } from '../pet';

const busts = new Map<string, Promise<PetBust | null>>();

async function cutBust(url: string): Promise<PetBust | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  const source = await createImageBitmap(await response.blob());
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0);
  source.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  clearPetHaze(pixels.data);
  const box = petBustBox(pixels.data, canvas.width, canvas.height);
  if (!box) return null;
  // Cut at the size it is kept at, so what the device remembers is no larger than what it shows.
  const scale = Math.min(1, PET_BUST_HEIGHT / box.height);
  const cut = document.createElement('canvas');
  cut.width = Math.max(1, Math.round(box.width * scale));
  cut.height = Math.max(1, Math.round(box.height * scale));
  cut.getContext('2d')?.drawImage(canvas, box.x, box.y, box.width, box.height, 0, 0, cut.width, cut.height);
  return { src: cut.toDataURL('image/png'), aspect: box.width / box.height };
}

/** Her small portrait for the sidebar and the title, once per page; null until it is cut, or if she is not installed. */
export function usePetBust(api: Api, status: PetStatus | null, kept?: { url: string; bust: PetBust } | null): PetBust | null {
  const url = status?.installed ? api.petFrame(status.id, 'idle', 0) : null;
  // What this device kept stands in for the first frame, when it is this portrait it was cut from.
  const [bust, setBust] = useState<PetBust | null>(() => (kept && kept.url === url ? kept.bust : null));
  useEffect(() => {
    if (!url) { setBust(null); return; }
    let live = true;
    let cutting = busts.get(url);
    if (!cutting) { cutting = cutBust(url).catch(() => null); busts.set(url, cutting); }
    void cutting.then((value) => { if (live) setBust(value); });
    return () => { live = false; };
  }, [url]);
  return bust;
}

/** That portrait at a given height, centred on an icon's width so the label beside it keeps its place. */
export function PetBustImage({ bust, height, slot }: { bust: PetBust; height: number; slot: number }) {
  const width = Math.round(height * bust.aspect);
  return <img className="pet-bust" src={bust.src} alt="" width={width} height={height}
    style={{ marginInline: (slot - width) / 2, marginBlock: Math.min(0, (slot - height) / 2) }} />;
}


/**
 * Her face at the head of her own conversation: the same artwork as on the desk, cropped to head and
 * shoulders. It scrolls away with the conversation, and says when it has, so the title bar can carry
 * her instead; a tap pokes her.
 */
export function PetPortrait({ api, status, onAway }: { api: Api; status: PetStatus; onAway?: (away: boolean) => void }) {
  const visible = usePageVisible();
  const still = useReducedMotion();
  const faceRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<PetPlayer | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const player = new PetPlayer(canvas, status, (clip, index) => api.petFrame(status.id, clip, index), still, () => playerRef.current?.play('idle', true));
    playerRef.current = player;
    return () => { player.dispose(); playerRef.current = null; };
  }, [api, status, still]);
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !visible) return;
    player.start();
    return () => player.stop();
  }, [visible, api, status, still]);
  useEffect(() => {
    const face = faceRef.current;
    const scroller = face?.closest('.scroller');
    if (!face || !scroller || !onAway) return;
    let away: boolean | null = null;
    const read = () => {
      const rect = face.getBoundingClientRect();
      const now = rect.top + rect.height / 2 < scroller.getBoundingClientRect().top;
      if (now !== away) onAway((away = now));
    };
    read();
    scroller.addEventListener('scroll', read, { passive: true });
    return () => { scroller.removeEventListener('scroll', read); onAway(false); };
  }, [onAway]);
  return (
    <div className="pet-portrait">
      <button ref={faceRef} type="button" className="pet-portrait-face" aria-label={t('pet.name')} onClick={() => playerRef.current?.play('poke', false)}>
        <canvas ref={canvasRef} width={PET_FRAME.width} height={PET_FRAME.height} aria-hidden="true" />
      </button>
      <span className="pet-portrait-name">{t('pet.name')}</span>
    </div>
  );
}

type Say =
  | { kind: 'setup' | 'notice'; text: string }
  | { kind: 'greeting'; text: string }
  | { kind: 'reply'; text: string; threadId: string }
  | { kind: 'error'; text: string; retry?: () => void; threadId?: string; detail?: string | null; lost?: boolean; configure?: boolean };

/** Reads the presence choice, which lives on the device rather than with the hub. */
export function readPetPresence(): PetPresence {
  try {
    const saved = localStorage.getItem(PRESENCE_KEY);
    return saved === 'event' || saved === 'off' ? saved : 'always';
  } catch { return 'always'; }
}

/** Writes the presence choice and tells every reader on the page, so a change in one dialog moves her at once. */
export function savePetPresence(value: PetPresence): void {
  try { localStorage.setItem(PRESENCE_KEY, value); } catch { /* It lasts as long as the page. */ }
  window.dispatchEvent(new CustomEvent(PRESENCE_EVENT, { detail: value }));
}

/** The presence choice, kept live across the dialogs that can change it. */
export function usePetPresence(): PetPresence {
  const [presence, setPresence] = useState(readPetPresence);
  useEffect(() => {
    const read = (e: Event) => setPresence((e instanceof CustomEvent ? e.detail : null) ?? readPetPresence());
    window.addEventListener(PRESENCE_EVENT, read);
    window.addEventListener('storage', read);
    return () => { window.removeEventListener(PRESENCE_EVENT, read); window.removeEventListener('storage', read); };
  }, []);
  return presence;
}

/** Where she was last left, if this device remembers: left edge, and how high above the viewport bottom. */
function readPetPos(): { left: number; lift: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { left?: unknown; lift?: unknown };
    if (typeof value.left !== 'number' || typeof value.lift !== 'number') return null;
    return { left: value.left, lift: value.lift };
  } catch { return null; }
}

interface Props {
  api: Api;
  greeting: PetGreeting;
  setupNeeded?: boolean | null;
  setupNotice?: { text: string; at: number } | null;
  onExplore?: () => void;
  /** A pile is spread out on the desk: she steps back so she does not cover it. */
  spreadOpen: boolean;
  /** The desk is the one page she shows on even when her presence is "off". */
  desk: boolean;
  /** Where the default spot is: clear of the composer on a thread, the corner anywhere else. */
  place: 'corner' | 'thread';
  /** The threads the page already holds; her status bar reads these and fetches nothing. */
  threads: readonly Thread[];
  onOpenThread: (id: string) => void;
  /** Her install state, as it changes, for whatever else shows her. */
  onStatusChange?: (status: PetStatus) => void;
  /** Opens the private settings, for when no agent has been chosen to answer. */
  onConfigure?: () => void;
  /** Matters a reply may name; with `onOpenTodo` their names become links that spread that pile. */
  todos?: readonly { id: string; text: string }[];
  onOpenTodo?: (id: string) => void;
}

/** A failure's technical side: one tap away, for whoever needs it. Opens below the words it belongs to. */
function PetDetail({ text }: { text?: string | null }) {
  const [shown, setShown] = useState(false);
  if (!text) return null;
  return (
    <>
      <button type="button" className="pet-bub-act" aria-expanded={shown} title={text} onClick={() => setShown((was) => !was)}>{t('pet.details')}</button>
      {shown && <span className="pet-detail">{text}</span>}
    </>
  );
}

function threadStateLabel(state: PetThreadState): string {
  return t(state === 'waiting' ? 'pet.state.waiting' : state === 'review' ? 'pet.state.review' : state === 'failed' ? 'pet.state.failed' : 'pet.state.running');
}

/** The companion and the way to talk to the Router, on every page. Nothing here until she has been asked for. */
export function Pet(props: Props) {
  const { api, onStatusChange } = props;
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

  const awayRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = awayRef.current;
    if (!el) return;
    const composer = document.querySelector('.composer-slot');
    const place = () => {
      const box = composer?.getBoundingClientRect();
      const pet = el.getBoundingClientRect();
      if (box?.height && pet.right > box.left && pet.left < box.right) el.style.top = `${Math.max(el.offsetHeight + 12, box.top - 12)}px`;
      else el.style.removeProperty('top');
    };
    place();
    const observer = new ResizeObserver(place);
    if (composer) observer.observe(composer);
    observer.observe(el);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [status?.installed, props.place]);

  if (api.demo || !status) return null;
  if (status.installed) return <PetCompanion {...props} status={status} />;

  const error = status.installing ? null : installError ?? status.error;
  return createPortal(
    <div className="pet pet-away" ref={awayRef}>
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

function PetCompanion({ api, status, greeting, spreadOpen, desk, place, threads, onOpenThread, onConfigure, todos, onOpenTodo, setupNeeded, onExplore, setupNotice }: Props & { status: PetStatus }) {
  const visible = usePageVisible();
  const still = useReducedMotion();
  const narrow = useIsNarrow();
  const touch = useIsTouch();
  const presence = usePetPresence();
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bust = usePetBust(api, status);
  const fieldRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<PetPlayer | null>(null);


  // ——— Where she stands ———
  // The position is hers alone: a default per page until she is dragged, then this device's own.
  const storedPos = useRef<{ left: number; lift: number } | null>(readPetPos());
  const posRef = useRef<{ left: number; lift: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; left: number; lift: number; moved: boolean } | null>(null);

  const viewport = () => {
    const vv = window.visualViewport;
    return { W: vv?.width ?? window.innerWidth, H: vv?.height ?? window.innerHeight };
  };

  const apply = useCallback((pos: { left: number; lift: number }) => {
    const el = rootRef.current;
    if (!el) return;
    const { W, H } = viewport();
    const { width: w, height: h } = el.getBoundingClientRect();
    if (!w || !h || !W || !H) return;
    const fixed = petClampPosition(pos.left, H - pos.lift - h, w, h, W, H);
    const composer = document.querySelector<HTMLElement>('.composer-slot');
    const obstacle = composer?.getBoundingClientRect();
    const placed = { left: Math.max(16, Math.min(fixed.x, W - w - 16)), lift: H - fixed.y - h };
    const move = () => {
      el.style.setProperty('--pet-left', `${placed.left}px`);
      el.style.setProperty('--pet-lift', `${placed.lift}px`);
    };
    el.dataset.side = placed.left + w / 2 < W / 2 ? 'left' : 'right';
    // Above a composer, speech stays above her as well.
    el.dataset.vert = !obstacle?.height && fixed.y < 140 ? 'top' : 'bottom';
    move();
    el.style.setProperty('--pet-under-x', '0px');
    const bar = el.querySelector<HTMLElement>('.pet-under');
    if (bar) {
      const rect = bar.getBoundingClientRect();
      const offset = rect.right > W - 16 ? W - 16 - rect.right : Math.max(0, 16 - rect.left);
      el.style.setProperty('--pet-under-x', `${offset}px`);
    }
    // Reserve the bar even while it is transparent: revealing it must not shift her under the pointer.
    const parts = [el, ...el.querySelectorAll<HTMLElement>('.pet-body canvas, .pet-under, .pet-above')]
      .map(part => part.getBoundingClientRect()).filter(rect => rect.width && rect.height);
    const left = Math.min(...parts.map(rect => rect.left));
    const right = Math.max(...parts.map(rect => rect.right));
    const under = el.querySelector<HTMLElement>('.pet-under');
    let bottom = Math.max(...parts.map(rect => rect.bottom), el.getBoundingClientRect().top + (under?.offsetTop ?? 0) + (under?.offsetHeight ?? 0));
    let top = Math.min(...parts.map(rect => rect.top));
    const viewportBottom = H + (window.visualViewport?.offsetTop ?? 0);
    const shift = (amount: number) => { placed.lift += amount; top -= amount; bottom -= amount; };
    shift(Math.max(0, bottom + 12 - viewportBottom));
    // The phone's floating thread switcher is a separate control, not a circle behind her head.
    for (const box of [obstacle, document.querySelector('.quick-switch-button')?.getBoundingClientRect()]) {
      if (box?.height && left < box.right + 12 && right > box.left - 12 && top < box.bottom + 12 && bottom > box.top - 12) {
        shift(bottom + 12 - box.top);
      }
    }
    move();
    posRef.current = placed;
  }, []);

  const placePet = useCallback(() => {
    if (storedPos.current) { apply(storedPos.current); return; }
    const el = rootRef.current;
    if (!el) return;
    const { W } = viewport();
    const w = el.offsetWidth;
    if (!w || !W) return;
    apply({ left: W - w - (narrow ? 16 : 20), lift: 12 });
  }, [apply, narrow]);

  useLayoutEffect(placePet);

  useEffect(() => {
    placePet();
    const el = rootRef.current;
    const vv = window.visualViewport;
    // Observe the real composer, including tools and attachments, and her out-of-flow speech.
    const ro = new ResizeObserver(placePet);
    for (const part of [el, el?.querySelector('.pet-above'), el?.querySelector('.pet-under'), document.querySelector('.composer-slot')]) {
      if (part) ro.observe(part);
    }
    window.addEventListener('resize', placePet);
    vv?.addEventListener('resize', placePet);
    vv?.addEventListener('scroll', placePet);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', placePet);
      vv?.removeEventListener('resize', placePet);
      vv?.removeEventListener('scroll', placePet);
    };
  }, [placePet, place, presence, desk]);

  // ——— What she says ———
  const [say, setSay] = useState<Say | null>(null);
  useEffect(() => { if (setupNotice) setSay({ kind: 'notice', text: setupNotice.text }); }, [setupNotice]);
  const [expanded, setExpanded] = useState(false);
  const [fading, setFading] = useState(false);
  const [compose, setCompose] = useState(false);
  const [panel, setPanel] = useState<null | 'tray' | 'detail'>(null);
  const [revealed, setRevealed] = useState(false);
  const [tucked, setTucked] = useState(presence === 'event');

  const [draft, setDraft] = useState(() => readStored(DRAFT_KEY) ?? '');
  const [sending, setSending] = useState(false);
  const [pending, setPendingState] = useState<PetPending | null>(() => parsePetPending(readStored(PENDING_KEY), Date.now()));
  const [late, setLate] = useState(false);
  // Whether the person has yet to say what they care about; null until known, and she waits to greet until then.
  const [profileBlank, setProfileBlank] = useState<boolean | null>(null);
  const [writingProfile, setWritingProfile] = useState(false);

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

  const sayRef = useRef(say);
  sayRef.current = say;

  // ——— The status bar under her ———
  const notable = useMemo(() => petNotableThreads(threads), [threads]);
  const top = notable[0] ?? null;
  const topState = top ? petThreadState(top) : null;
  const attn = notable.some(thread => { const state = petThreadState(thread); return state === 'waiting' || state === 'failed'; });

  const revealTimer = useRef(0);
  const fadeTimer = useRef(0);
  const goneTimer = useRef(0);
  const tuckTimer = useRef(0);
  const reveal = useCallback((ms = 0) => {
    window.clearTimeout(revealTimer.current);
    setRevealed(true);
    if (ms > 0) revealTimer.current = window.setTimeout(() => setRevealed(false), ms);
  }, []);
  const conceal = useCallback(() => {
    window.clearTimeout(revealTimer.current);
    setRevealed(false);
  }, []);

  // While she is at it the line stays; once the answer is in, it goes back to hiding.
  useEffect(() => {
    if (busy) reveal();
    else setRevealed(false);
  }, [busy, reveal]);

  // A new state arriving shows the line briefly, and in "when needed" presence brings her out.
  const topSig = top ? `${top.id}:${topState}` : '';
  const sigRef = useRef(topSig);
  useEffect(() => {
    if (sigRef.current === topSig) return;
    sigRef.current = topSig;
    if (!topSig) return;
    reveal(REVEAL_STATUS_MS);
    if (presence === 'event') setTucked(false);
  }, [topSig, presence, reveal]);

  // ——— Playing her ———
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

  useEffect(() => {
    let live = true;
    void api.personalProfile().then(profile => { if (live) setProfileBlank(profile.isTemplate); }).catch(() => { if (live) setProfileBlank(false); });
    return () => { live = false; };
  }, [api, setupNotice?.at]);

  // Once a day, once the matters are in, and only when it can be seen: never over a bubble of the person's own asking or a spread pile.
  useEffect(() => {
    if ((!greeting && !setupNeeded) || (profileBlank === null && !setupNeeded) || !visible || busy || compose || panel || spreadOpen) return;
    const now = new Date();
    if (readStored(GREETED_KEY) === petDay(now)) return;
    const timer = window.setTimeout(() => {
      writeStored(GREETED_KEY, petDay(now));
      setSay((current) => current ?? (setupNeeded && onExplore ? { kind: 'setup', text: t('explore.offer') } : { kind: 'greeting', text: profileBlank ? t('pet.askProfile') : petGreetingLine(greeting!, now) }));
    }, GREETING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [greeting, profileBlank, visible, busy, compose, panel, spreadOpen, setupNeeded, onExplore]);

  // The greeting is volunteered: as soon as the person scrolls on with something, it gets out of the way.
  const greetingShown = say?.kind === 'greeting';
  useEffect(() => {
    if (!greetingShown) return;
    const dismiss = () => setSay((current) => (current?.kind === 'greeting' ? null : current));
    document.addEventListener('scroll', dismiss, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', dismiss, { capture: true });
  }, [greetingShown]);

  // A bubble that is not an error fades and then goes; expanded reading earns a little longer.
  useEffect(() => {
    window.clearTimeout(fadeTimer.current);
    window.clearTimeout(goneTimer.current);
    setFading(false);
    if (!say || say.kind === 'error') return;
    const fadeMs = expanded ? PET_BUBBLE_FADE_MS + 4_000 : PET_BUBBLE_FADE_MS;
    fadeTimer.current = window.setTimeout(() => setFading(true), fadeMs);
    goneTimer.current = window.setTimeout(() => setSay(current => current === say ? null : current), fadeMs + PET_BUBBLE_GONE_MS - PET_BUBBLE_FADE_MS);
    return () => { window.clearTimeout(fadeTimer.current); window.clearTimeout(goneTimer.current); };
  }, [say, expanded]);

  // Something to say brings her out of the dot.
  useEffect(() => {
    if (say) setTucked(false);
  }, [say]);

  // In "when needed" presence she goes back to the dot once nothing is left to show, about ten seconds after the last of it.
  useEffect(() => {
    if (presence !== 'event') { setTucked(false); return; }
    window.clearTimeout(tuckTimer.current);
    if (tucked || busy || say || compose || panel) return;
    tuckTimer.current = window.setTimeout(() => setTucked(true), TUCK_AFTER_SPEAK_MS);
    return () => window.clearTimeout(tuckTimer.current);
  }, [presence, tucked, busy, say, compose, panel]);

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
      setExpanded(false);
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
    setCompose(false);
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

  // ——— Talking to her ———
  const openCompose = () => {
    setPanel(null);
    setCompose(true);
    setSay((current) => (current?.kind === 'greeting' ? null : current));
  };

  useEffect(() => {
    if (!compose) return;
    const field = fieldRef.current;
    field?.focus();
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [compose]);

  // A press elsewhere: a phone hides the line, a panel goes, and an empty field goes with it. What is typed stays.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      if (touch) conceal();
      if (panel) setPanel(null);
      if (compose && !draft.trim()) setCompose(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [touch, conceal, panel, compose, draft]);

  // Captured, because a spread pile below her also listens for Esc, and she answers first. A modal
  // above her or an open menu has the keyboard, and the same goes for a composing input method.
  useEffect(() => {
    if (!compose && !panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      if (document.querySelector('.pop-panel') || petCoveredByModal(rootRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      if (panel) { setPanel(null); return; }
      setCompose(false);
      bodyRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [compose, panel]);

  // ——— Dragging her ———
  const onBodyPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!rootRef.current || !posRef.current) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, left: posRef.current.left, lift: posRef.current.lift, moved: false };
    bodyRef.current?.setPointerCapture(e.pointerId);
  };
  const onBodyPointerMove = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    if (!drag.moved) { drag.moved = true; rootRef.current?.setAttribute('data-drag', 'true'); }
    const el = rootRef.current;
    if (!el) return;
    const { W, H } = viewport();
    const { width: w, height: h } = el.getBoundingClientRect();
    const fixed = petClampPosition(drag.left + dx, H - drag.lift - h + dy, w, h, W, H);
    apply({ left: fixed.x, lift: H - fixed.y - h });
  };
  const onBodyPointerUp = (e: ReactPointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    rootRef.current?.removeAttribute('data-drag');
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.moved && posRef.current) {
      // This is where she was left: it is this device's answer until she is moved again.
      storedPos.current = posRef.current;
      writeStored(POS_KEY, JSON.stringify(posRef.current));
      return;
    }
    petClick();
  };
  const onBodyPointerCancel = () => {
    dragRef.current = null;
    rootRef.current?.removeAttribute('data-drag');
  };

  const petClick = () => {
    if (compose) { setCompose(false); return; }
    if (!busy) playerRef.current?.play('poke', false);
    // A phone has no hover: the first tap shows what a pointer would have, the next one talks to her.
    if (touch && !revealed) { reveal(REVEAL_TAP_MS); return; }
    if (say?.kind === 'error' && !expanded) { setExpanded(true); return; }
    openCompose();
  };

  const onAvatarClick = () => {
    setTucked(false);
    if (!busy) playerRef.current?.play('poke', false);
    if (!sayRef.current) openCompose();
  };

  const openThread = (id: string) => {
    setSay(null);
    setPanel(null);
    onOpenThread(id);
  };

  const starters = petStarters();
  const startWith = (start: string) => {
    setDraft((current) => applyPetStarter(current, start, starters.map((s) => s.start)));
    fieldRef.current?.focus();
  };

  // "Off" leaves the desk to her: nowhere else does she show.
  if (presence === 'off' && !desk) return null;

  // A pile spread out has the floor: what she volunteers waits, what the person asked for stays.
  const bubble = compose || panel || (spreadOpen && say?.kind === 'greeting') ? null : say;
  const bubbleMore = bubble ? Array.from(bubble.text).length > 30 : false;
  const bubbleText = bubble && !expanded && bubbleMore ? Array.from(bubble.text).slice(0, 26).join('') + '…' : bubble?.text ?? '';

  // On the body, because a spread pile is too, and she has to stay above it and within reach.
  return createPortal(
    <div ref={rootRef} className={`pet pet-live${spreadOpen ? ' pet-back' : ''}`}
      data-reveal={revealed || undefined} data-tucked={tucked || undefined} data-attn={attn || undefined} data-badge={attn || undefined}>
      <div className="pet-above">
        {panel === 'tray' && (
          <div className="pet-panel" role="dialog" aria-label={t('pet.threads')}>
            <div className="pet-panel-head">
              <span>{t('pet.threads')}</span>
              <button type="button" aria-label={t('pet.dismiss')} title={t('pet.dismiss')} onClick={() => setPanel(null)}><IconClose size={12} /></button>
            </div>
            {notable.length ? (
              <div className="pet-tray">
                {notable.map(thread => {
                  const state = petThreadState(thread);
                  return (
                    <button key={thread.id} type="button" className="pet-tray-item" onClick={() => openThread(thread.id)}>
                      <span className="pet-dot" data-s={state} />
                      <span>{thread.title}</span>
                      <small className={state === 'waiting' || state === 'failed' ? 'warn' : undefined}>{threadStateLabel(state)}</small>
                    </button>
                  );
                })}
              </div>
            ) : <p className="pet-panel-empty">{t('pet.trayEmpty')}</p>}
            <a className="pet-credit" href={petLicenseUrl(status.commit)} target="_blank" rel="noreferrer">{t('pet.credit')}</a>
          </div>
        )}
        {panel === 'detail' && top && topState && (
          <div className="pet-panel" role="dialog" aria-label={threadStateLabel(topState)}>
            <div className="pet-panel-head">
              <span>{threadStateLabel(topState)}</span>
              <button type="button" aria-label={t('pet.dismiss')} title={t('pet.dismiss')} onClick={() => setPanel(null)}><IconClose size={12} /></button>
            </div>
            <p className="pet-panel-title">{top.title}</p>
            {top.preview && <p className="pet-panel-note">{top.preview}</p>}
            <div className="pet-panel-acts">
              <button type="button" className="pet-bar-chip" onClick={() => openThread(top.id)}>{t('pet.goSee')}</button>
            </div>
          </div>
        )}
        {bubble && (
          <div
            className={`pet-bub${bubble.kind === 'error' ? ' pet-bub-error' : ''}${expanded ? ' pet-bub-open' : ''}`}
            data-fading={fading || undefined}
            data-more={!expanded && bubbleMore || undefined}
            role={bubble.kind === 'error' ? 'alert' : 'status'}
            title={!expanded && bubbleMore ? t('pet.more') : undefined}
            onClick={e => {
              if ((e.target as HTMLElement).closest('button, a')) return;
              if (bubble.kind === 'greeting') { openCompose(); return; }
              if (bubbleMore) setExpanded(was => !was);
            }}
          >
            <p>
              {bubble.kind === 'reply' && onOpenTodo
                ? petReplyParts(bubbleText, todos ?? []).map((part, index) => (part.todoId
                  ? <button key={index} type="button" className="pet-bub-act" onClick={() => { setSay(null); onOpenTodo(part.todoId!); }}>{part.text}</button>
                  : <span key={index}>{part.text}</span>))
                : bubbleText}
              {' '}
              <span className="pet-bub-acts">
                {bubble.kind === 'setup' && onExplore && <button type="button" className="pet-bub-act" onClick={() => { setSay(null); onExplore(); }}>{t('explore.entry')}</button>}
                {bubble.kind === 'greeting' && profileBlank && <button type="button" className="pet-bub-act" onClick={() => { setSay(null); setWritingProfile(true); }}>{t('pet.writeShort')}</button>}
                {bubble.kind === 'reply' && <button type="button" className="pet-bub-act" onClick={() => openThread(bubble.threadId)}>{t('pet.openShort')}</button>}
                {bubble.kind === 'error' && bubble.configure && onConfigure && <button type="button" className="pet-bub-act" onClick={onConfigure}>{t('pet.configure')}</button>}
                {bubble.kind === 'error' && bubble.retry && <button type="button" className="pet-bub-act" onClick={bubble.retry}>{t('pet.retry')}</button>}
                {bubble.kind === 'error' && <PetDetail key={bubble.text} text={bubble.detail} />}
              </span>
            </p>
            {bubble.kind === 'error' && (
              <button type="button" className="pet-bub-close" aria-label={t('pet.dismiss')} title={t('pet.dismiss')} onClick={() => setSay(null)}><IconClose size={11} /></button>
            )}
          </div>
        )}
      </div>

      <span className="pet-attn" aria-hidden="true" />
      <button ref={bodyRef} type="button" className="pet-body" aria-label={t('pet.open')}
        onPointerDown={onBodyPointerDown} onPointerMove={onBodyPointerMove} onPointerUp={onBodyPointerUp} onPointerCancel={onBodyPointerCancel}>
        <canvas ref={canvasRef} width={PET_FRAME.width} height={PET_FRAME.height} aria-hidden="true" />
      </button>
      {tucked && <button type="button" className="pet-avatar" aria-label={t('pet.summonFromDot')} onClick={onAvatarClick}>
        {bust && <PetBustImage bust={bust} height={38} slot={40} />}
      </button>}
      <span className="pet-avatar-badge" aria-hidden="true" />

      <div className="pet-under">
        {compose ? (
          <div className="pet-qc-col">
            <div className="pet-qc">
              <input
                ref={fieldRef}
                value={draft}
                placeholder={t('pet.composePlaceholder')}
                aria-label={t('pet.open')}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); }
                }}
              />
              <button type="button" aria-label={t('pet.send')} title={t('pet.send')} disabled={!draft.trim()} onClick={() => void send(draft)}>
                <IconArrowUp size={14} />
              </button>
            </div>
            {!draft.trim() && (
              <div className="pet-qc-starters">
                {starters.map(starter => (
                  <button key={starter.start} type="button" className="chip pet-starter" onClick={() => startWith(starter.start)}>{starter.label}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="pet-bar">
            {busy ? (
              <>
                <button type="button" className="pet-bar-status" onClick={() => pending && openThread(pending.threadId)}>
                  <span className="pet-dot" data-s="running" />
                  <span>{late ? t('pet.thinkingLate') : t('pet.thinking')}</span>
                </button>
                {late && pending && <button type="button" className="pet-bar-chip" onClick={() => openThread(pending.threadId)}>{t('pet.openShort')}</button>}
              </>
            ) : top && topState ? (
              <>
                <button type="button" className="pet-bar-status" onClick={() => setPanel(panel === 'detail' ? null : 'detail')}>
                  <span className="pet-dot" data-s={topState} />
                  <span>{top.title} · {threadStateLabel(topState)}</span>
                </button>
                <button type="button" className="pet-bar-chip" onClick={() => openThread(top.id)}>{t('pet.goSee')}</button>
              </>
            ) : null}
            <button type="button" className="pet-bar-icon" aria-label={t('pet.write')} title={t('pet.write')} onClick={openCompose}><IconEdit size={14} /></button>
            <button type="button" className="pet-bar-icon" aria-label={t('pet.threads')} title={t('pet.threads')} onClick={() => setPanel(panel === 'tray' ? null : 'tray')}>
              <IconList size={14} />
              {attn && <b aria-hidden="true" />}
            </button>
          </div>
        )}
      </div>

      {writingProfile && createPortal(<ProfileDialog api={api} onClose={() => setWritingProfile(false)} onSaved={setProfileBlank} />, document.body)}
    </div>,
    document.body,
  );
}
