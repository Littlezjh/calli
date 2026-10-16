import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { ApiError, MAX_QUEUED, type AgentMention, type OutgoingImage, type QueuedMessage, type SlashCommand } from '../api';
import { commandDraft, searchCommands, slashQuery, type HubAction, type MenuRow } from '../commands';
import { useIsNarrow } from '../hooks';
import { readDrafts, writeDraft, type Sending } from '../drafts';
import { sizeLabel } from '../files';
import { MAX_IMAGES, prepareImage, restoreImage, type PreparedImage } from '../images';
import { withNotes, type Note } from '../timeline';
import { Popover } from './Popover';
import { ComposerMenu, GOAL_LABELS, type GoalAction, type GoalCapability } from './ComposerMenu';
import { Dialog } from './Dialog';
import { Lightbox } from './Lightbox';
import { VideoPreview } from './VideoPreview';
import { isVideo, MAX_VIDEOS, prepareVideo, VIDEO_ACCEPT, type PreparedVideo } from '../videos';
import {
  IconArchive,
  AgentMark,
  IconClose,
  IconCheck,
  IconChevron,
  IconCopy,
  IconCube,
  IconEdit,
  IconFork,
  IconHelp,
  IconImport,
  IconInfo,
  IconList,
  IconPaperclip,
  IconPlay,
  IconPin,
  IconPlus,
  IconSend,
  IconSearch,
  IconShield,
  IconSlash,
  IconSparkle,
  IconStop,
  IconTarget,
} from './icons';

/** A passage noted for the next message. The id ties it to its highlight in the conversation. */
export interface DraftNote extends Note {
  id: string;
}

/** What is left unsent in a box: the words, noted passages and pictures. */
interface Draft {
  mentions?: AgentMention[];
  text: string;
  notes: DraftNote[];
  images: PreparedImage[];
  videos?: PreparedVideo[];
  /** The message is on its way out. See `StoredDraft.sending`. */
  sending?: Sending;
  /** A newly prepared handover should put the cursor in its input. */
  focus?: boolean;
}

/** A box's content as the one text it is sent as: the notes, numbered, then the words. */
const asMessage = (text: string, notes: Note[]) => (notes.length ? withNotes(notes, text) : text.trim());

/** How long a send may take before the button says it is still going. */
const SLOW_SEND_MS = 400;

let noteSeq = 0;
const noteId = () => `note-${Date.now()}-${++noteSeq}`;

/**
 * Unsent drafts by thread, so what is typed in one thread stays there: switching away keeps it,
 * switching back brings it back, and another thread starts with its own. Words and notes are also
 * kept on the device and outlast a reload; pictures only last as long as the page.
 */
const drafts = new Map<string, Draft>();

const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

function loadDraft(key: string): Draft | undefined {
  const inMemory = drafts.get(key);
  if (inMemory) return inMemory;
  const store = storage();
  const stored = store ? readDrafts(store)[key] : undefined;
  return stored && { text: stored.text, mentions: stored.mentions, notes: stored.notes.map((n) => ({ ...n, id: noteId() })), images: [], sending: stored.sending };
}

function keepDraft(key: string, draft: Draft | null): void {
  if (draft && (draft.text.trim() || draft.notes.length || draft.images.length || draft.videos?.length || draft.mentions?.length)) drafts.set(key, draft);
  else drafts.delete(key);
  const store = storage();
  if (store) writeDraft(store, key, draft);
}

/** Seeds a newly created thread before the composer opens it, including an immediate durable copy. */
export function prefillComposerDraft(key: string, text: string): void {
  keepDraft(key, { text, notes: [], images: [], focus: true });
}

/** How long typing pauses before the draft is written down. */
const SAVE_DELAY_MS = 400;

interface Props {
  /**
   * Whose draft the box holds: a thread's id, or one key for the new thread being started. Without
   * one the box keeps nothing once it is gone, as for a side chat, which is new each time.
   */
  draftKey?: string;
  running: boolean;
  disabled?: boolean;
  placeholder: string;
  mentionOptions?: AgentMention[];
  collaboration?: (select: (mention: AgentMention) => void, selected: AgentMention[]) => ReactNode;
  mentionDirectories?: string[];
  /** A control of the app's own on an agent's line, such as the model its member starts with. */
  mentionExtra?: (mention: AgentMention) => ReactNode;
  /** The mark of the agent behind a choice, for the @ list. */
  mentionIcon?: (mention: AgentMention) => string | undefined;
  onSend: (text: string, images: PreparedImage[], mentions?: AgentMention[], videos?: PreparedVideo[]) => Promise<void> | void;
  onStop: () => void;
  /** Strip above the text area: which agent and which directory. */
  header: ReactNode;
  planAction?: ReactNode;
  /** Native planning is offered in the add menu only when the agent supports it. */
  planMode?: { active: boolean; disabled: boolean; onChange: (active: boolean) => void };
  /** Controls at the left of the bottom bar, after the add menu. */
  left: ReactNode;
  /** Controls at the right of the bottom bar, before the send button. */
  right: ReactNode;
  /** The agent's own slash commands. */
  commands: SlashCommand[];
  goal?: GoalCapability;
  /** Things the hub does itself, offered in the same menu. */
  actions: HubAction[];
  /** Agent commands left out because a hub action replaces them. */
  hiddenCommands: string[];
  onAction: (id: string) => void;
  /** Why pictures cannot be attached right now, or null when they can. */
  attachBlocked: string | null;
  /** Something worth knowing about how attached pictures will be read, shown on the attach button. */
  attachNote?: string | null;
  onError: (message: string) => void;
  /** Messages sent while a turn was running, waiting to go out. */
  queued: QueuedMessage[];
  onRemoveQueued: (id: string) => void;
  /** Takes a waiting message out of the queue and returns it, to be edited in the box. */
  onEditQueued: (id: string) => Promise<{ text: string; images: OutgoingImage[]; videos?: PreparedVideo[]; mentions?: AgentMention[] }>;
  /** Interrupt the running turn and send this waiting message next. */
  onSendQueuedNow: (id: string) => void;
  /** Text to put back in the box, such as messages that were waiting when the user pressed stop. */
  restore: { text: string; nonce: number; mentions?: AgentMention[] } | null;
  /** A passage noted out of a message, to go along with what is typed. Each one adds to the list. */
  note: (DraftNote & { nonce: number }) | null;
  /** Told which notes are in the box, so their passages can stay highlighted in the conversation. */
  onNotesChange?: (notes: DraftNote[]) => void;
  /** The thread's latest message from the user, as it was sent; null when there is none or it is not known yet. */
  lastSent?: { turnId: string; text: string } | null;
}

const ACTION_ICONS: Record<string, (p: { size?: number }) => JSX.Element> = {
  new: IconEdit,
  model: IconCube,
  permission: IconShield,
  rename: IconEdit,
  pin: IconPin,
  archive: IconArchive,
  fork: IconFork,
  import: IconImport,
  status: IconInfo,
  export: IconCopy,
  help: IconHelp,
};

type Selectable = Exclude<MenuRow, { type: 'heading' }>;

export function Composer({
  draftKey,
  running,
  disabled,
  placeholder,
  onSend,
  onStop,
  header,
  planAction,
  planMode,
  left,
  right,
  commands,
  goal,
  actions,
  hiddenCommands,
  onAction,
  attachBlocked,
  attachNote,
  onError,
  queued,
  onRemoveQueued,
  onEditQueued,
  onSendQueuedNow,
  restore,
  note,
  onNotesChange,
  lastSent = null,
  mentionOptions = [],
  collaboration,
  mentionDirectories = [],
  mentionIcon,
  mentionExtra,
}: Props) {
  const narrow = useIsNarrow();
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<AgentMention[]>([]);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [notes, setNotes] = useState<DraftNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [menuBusy, setMenuBusy] = useState(false);
  const [goalDialog, setGoalDialog] = useState(false);
  const [goalText, setGoalText] = useState('');
  /** The send has been going for a while: a picture uploading over a slow line, an agent waking up. */
  const [slow, setSlow] = useState(false);
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [videos, setVideos] = useState<PreparedVideo[]>([]);
  const [videoPreview, setVideoPreview] = useState<PreparedVideo | null>(null);
  const [preparing, setPreparing] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [catalog, setCatalog] = useState<'all' | 'actions' | 'skills'>('all');
  /** A picture being looked at full size before it goes out. */
  const [preview, setPreview] = useState<PreparedImage | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const revealSelection = useRef(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setGoalDialog(false); setGoalText(''); }, [draftKey]);
  useEffect(() => { setAddOpen(false); }, [draftKey, narrow]);
  useEffect(() => {
    if (!addOpen) return;
    const outside = (event: PointerEvent) => {
      if (!paletteRef.current?.contains(event.target as Node) && !addRef.current?.contains(event.target as Node)) {
        setAddOpen(false);
        setDismissed(true);
      }
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setAddOpen(false);
      setDismissed(true);
      (addRef.current ?? ref.current)?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [addOpen]);

  const runMenuCommand = async (command: string) => {
    setMenuBusy(true);
    try {
      // Menu controls are independent of the unsent draft and its attachments.
      await onSend(command, []);
      setGoalDialog(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally { setMenuBusy(false); }
  };
  const chooseGoal = (action: GoalAction) => {
    if (action === 'set') { setGoalText(''); setGoalDialog(true); }
    else void runMenuCommand(action === 'show' ? '/goal' : `/goal ${action}`);
  };

  const rows = useMemo(() => {
    const query = addOpen ? addQuery : slashQuery(text);
    if (query === null) return [];
    if (addOpen && catalog !== 'all') {
      const entries = commands.filter(c => catalog === 'skills' ? c.kind !== 'command' : c.kind !== 'skill' && c.kind !== 'prompt');
      return searchCommands(query, catalog === 'actions' ? actions.filter(a => !['help', 'skills'].includes(a.id)) : [], entries, [...hiddenCommands, ...(goal ? ['goal'] : [])]);
    }
    const additions: HubAction[] = [{ id: 'composer:attach', label: '添加图片或视频', hint: '', keywords: ['attach', 'image', 'video', '附件'] }];
    if (planMode) additions.push({ id: 'composer:plan', label: '计划模式', hint: planMode.disabled ? '当前轮结束后可切换' : planMode.active ? '已开启，点击关闭' : '先分析和讨论方案', keywords: ['plan', '计划'], disabled: planMode.disabled });
    const goals: HubAction[] = (goal?.actions ?? (goal ? ['set' as const, ...goal.controls] : [])).map(action => {
      const blocked = running ? !goal?.controls.some(c => c === action) : (action === 'set' || action === 'resume') && planMode?.active;
      return { id: `composer:goal:${action}`, label: GOAL_LABELS[action], hint: blocked ? running ? '当前轮结束后可操作' : '先关闭计划模式' : action === 'set' ? '设置要持续完成的目标' : '', keywords: ['目标', 'target'], disabled: !!blocked };
    });
    const group = (label: string, entries: HubAction[]): MenuRow[] => searchCommands(query, entries, []).map(row => row.type === 'heading' ? { ...row, label } : row);
    // Both desktop entry points share one catalog, ordering and filtering behavior.
    return [
      ...(!narrow ? group('添加', [...additions, ...goals.filter(a => a.id.endsWith(':set'))]) : []),
      ...searchCommands(query, actions, commands, hiddenCommands),
      ...(!narrow ? group('目标', goals.filter(a => !a.id.endsWith(':set'))) : []),
    ];
  }, [addOpen, addQuery, catalog, text, narrow, actions, commands, hiddenCommands, planMode, goal, running]);
  const selectable = useMemo(() => rows.filter((r): r is Selectable => r.type !== 'heading' && !(r.type === 'action' && r.action.disabled)), [rows]);
  const menuOpen = addOpen || (rows.length > 0 && !dismissed);

  const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(text);
  const mentionRows = mentionOptions.filter(m => !mentions.some(v => v.id === m.id && v.kind === m.kind) && (!mentionMatch?.[1] || `${m.label} ${m.id}`.toLowerCase().includes(mentionMatch[1].toLowerCase())));
  const mentionOpen = Boolean(mentionMatch && mentionRows.length && !mentionDismissed && !addOpen);
  const taskRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  const chooseMention = (mention: AgentMention, replaceQuery = true) => {
    const existing = mentions.findIndex(m => m.id === mention.id && m.kind === mention.kind);
    const target = existing < 0 ? mentions.length : existing;
    // Mount and focus inside the tap gesture so mobile browsers can open the keyboard.
    flushSync(() => {
      if (existing < 0) setMentions(prev => [...prev, mention]);
      if (replaceQuery) setText(prev => prev.replace(/@[^\s@]*$/, ''));
      setMentionDismissed(true);
    });
    taskRefs.current[target]?.focus();
  };
  // Turned away once, the list stays away for that @: the word after it is the user's own. A new @ asks again.
  const mentioning = mentionMatch !== null;
  useEffect(() => { setMentionActive(0); }, [text]);
  useEffect(() => { if (!mentioning) setMentionDismissed(false); }, [mentioning]);

  // Typing changes the list, so the highlight goes back to the first row and a dismissed menu can reopen.
  useEffect(() => {
    setActive(0);
    setDismissed(false);
  }, [text]);
  useEffect(() => { setActive(0); }, [addQuery, addOpen]);

  // A passage noted out of a message joins the others. Keyed on the nonce: the same passage can be noted twice.
  useEffect(() => {
    if (!note) return;
    const { nonce: _nonce, ...added } = note;
    setNotes((prev) => [...prev, added]);
    ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.nonce]);
  useEffect(() => onNotesChange?.(notes), [notes, onNotesChange]);

  useEffect(() => {
    if (!revealSelection.current) return;
    revealSelection.current = false;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => { if (menuOpen) paletteRef.current?.scrollTo({ top: 0 }); }, [addQuery, text, menuOpen]);

  // Text handed back goes in front of whatever is being typed, so nothing is lost either way.
  useEffect(() => {
    if (!restore) return;
    if (restore.mentions?.length) setMentions(current => [...restore.mentions!, ...current]);
    setText((current) => [restore.text, current].filter((s) => s.trim()).join('\n\n'));
    ref.current?.focus();
    // Keyed on the nonce: the same text can be handed back twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore?.nonce]);

  // Each thread has its own draft. Swapped before paint, so the old text never flashes in the new
  // thread. The pictures' object URLs go with the draft; they are released once it is sent.
  // A send this page never saw succeed: the page was reloaded meanwhile, or the answer got lost on
  // the way back. The box stays marked for as long as it still holds exactly what was sent.
  const inFlight = useRef<Sending | null>(null);
  const unsettled = inFlight.current !== null && asMessage(text, notes) === inFlight.current.text;
  const draftRef = useRef<Draft>({ text, notes, images, videos });
  draftRef.current = { text, notes, images, videos, mentions, ...(unsettled ? { sending: inFlight.current! } : {}) };
  const sendingRef = useRef(false);
  const previousDraftKey = useRef(draftKey);
  useLayoutEffect(() => {
    if (draftKey === undefined) return;
    const previous = previousDraftKey.current;
    previousDraftKey.current = draftKey;
    // Creating a thread changes its draft key before uploads finish. Keep that first message
    // in the new thread so an interrupted upload still has an editable, retryable draft.
    const firstMessage = sendingRef.current && (previous === 'new' || previous?.endsWith(':new'));
    const saved = loadDraft(draftKey) ?? (firstMessage ? draftRef.current : undefined);
    inFlight.current = saved?.sending ?? null;
    setText(saved?.text ?? '');
    setMentions(saved?.mentions ?? []);
    setNotes(saved?.notes ?? []);
    setImages(saved?.images ?? []);
    setVideos(saved?.videos ?? []);
    setVideoPreview(null);
    if (saved?.focus) {
      saved.focus = false;
      ref.current?.focus();
    }
    return () => {
      const draft = draftRef.current;
      // A message on its way out is not a draft: sending a new thread's first message opens the
      // thread mid-send, and the text must not stay behind in the next new thread.
      keepDraft(draftKey, sendingRef.current ? null : draft);
    };
  }, [draftKey]);

  // Written down shortly after typing pauses, so a reload keeps it. The timer reads the box as it
  // is when it fires, so a switch to another thread in between saves under the right one.
  const keyRef = useRef(draftKey);
  keyRef.current = draftKey;
  useEffect(() => {
    if (draftKey === undefined) return;
    const timer = setTimeout(() => {
      if (keyRef.current !== undefined && !sendingRef.current) keepDraft(keyRef.current, draftRef.current);
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draftKey, text, notes, mentions]);
  // Whether that message arrived is for the thread to say. Once a new turn of the user's carries
  // this very text, it is no draft: left in the box it would look unsent, and be sent a second time.
  useEffect(() => {
    const mark = inFlight.current;
    if (!unsettled || !mark || !lastSent) return;
    if (lastSent.turnId === mark.after || lastSent.text.trim() !== mark.text.trim()) return;
    inFlight.current = null;
    draftRef.current.images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    draftRef.current.videos?.forEach(video => URL.revokeObjectURL(video.previewUrl));
    setVideos([]);
    setImages([]);
    setText('');
    setNotes([]);
    setMentions([]);
    if (draftKey !== undefined) keepDraft(draftKey, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unsettled, lastSent?.turnId, lastSent?.text, draftKey]);
  // Without a draft to keep them, thumbnails left in the box are released when it goes away.
  useEffect(
    () => () => {
      if (draftKey === undefined) {
        draftRef.current.images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
        draftRef.current.videos?.forEach(video => URL.revokeObjectURL(video.previewUrl));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const addFiles = async (files: File[]) => {
    const pickedVideos = files.filter(isVideo);
    if (pickedVideos.length) {
      const room = MAX_VIDEOS - videos.length;
      if (pickedVideos.length > room) onError(`一条消息最多 ${MAX_VIDEOS} 个视频`);
      const ready: PreparedVideo[] = [];
      for (const file of pickedVideos.slice(0, Math.max(0, room))) {
        try { ready.push(prepareVideo(file)); } catch (error) { onError(error instanceof Error ? error.message : '视频无法添加'); }
      }
      setVideos(current => [...current, ...ready]);
    }
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (pictures.length === 0) return;
    if (attachBlocked) return onError(attachBlocked);
    const room = MAX_IMAGES - images.length - preparing;
    if (room <= 0) return onError(`一条消息最多 ${MAX_IMAGES} 张图片`);
    if (pictures.length > room) onError(`一条消息最多 ${MAX_IMAGES} 张图片，多出的没有添加`);
    const picked = pictures.slice(0, room);

    setPreparing((n) => n + picked.length);
    const results = await Promise.allSettled(picked.map(prepareImage));
    setPreparing((n) => n - picked.length);

    const ready = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) onError(failed.reason instanceof Error ? failed.reason.message : '有图片无法添加');
    if (ready.length) setImages((prev) => [...prev, ...ready]);
    ref.current?.focus();
  };

  // A waiting message goes back in the box, in front of anything typed, pictures included.
  const editQueued = async (id: string) => {
    try {
      const taken = await onEditQueued(id);
      if (taken.mentions?.length) setMentions(current => [...taken.mentions!, ...current]);
      setText((current) => [taken.text, current].filter((s) => s.trim()).join('\n\n'));
      const room = MAX_IMAGES - images.length - preparing;
      if (taken.images.length > room) onError(`一条消息最多 ${MAX_IMAGES} 张图片，多出的没有放回`);
      const videoRoom = Math.max(0, MAX_VIDEOS - videos.length);
      const returnedVideos = taken.videos ?? [];
      if (returnedVideos.length > videoRoom) onError(`一条消息最多 ${MAX_VIDEOS} 个视频`);
      returnedVideos.slice(videoRoom).forEach(video => URL.revokeObjectURL(video.previewUrl));
      setVideos(current => [...returnedVideos.slice(0, videoRoom), ...current]);
      const back = taken.images.slice(0, Math.max(0, room)).map(restoreImage);
      if (back.length) setImages((prev) => [...back, ...prev]);
      ref.current?.focus();
    } catch (e) {
      // The turn ahead of it may have ended in the meantime, taking the message out with it.
      if (e instanceof ApiError && e.status === 404) onError('这条消息已经发出去了，不能再编辑');
      else onError(e instanceof Error ? e.message : '没能取回这条消息');
    }
  };

  const removeImage = (id: string) => {
    setImages((prev) => {
      const gone = prev.find((img) => img.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((img) => img.id !== id);
    });
  };

  const choose = (row: Selectable) => {
    if (row.type === 'action' && row.action.disabled) return;
    if (row.type === 'action' && row.action.id === 'help') {
      // Everything there is to run is in this menu; show all of it.
      if (addOpen) { setAddQuery(''); searchRef.current?.focus(); }
      else { setText('/'); ref.current?.focus(); }
      return;
    }
    setAddOpen(false);
    setDismissed(true);
    ref.current?.focus();
    if (row.type === 'action') {
      if (!addOpen) setText('');
      const id = row.action.id;
      if (id === 'composer:attach') fileRef.current?.click();
      else if (id === 'composer:plan') planMode?.onChange(!planMode.active);
      else if (id.startsWith('composer:goal:')) chooseGoal(id.slice('composer:goal:'.length) as GoalAction);
      else onAction(id);
    } else {
      setText(current => addOpen ? commandDraft(row.command.name, current, commands) : `/${row.command.name} `);
    }
  };

  const browse = (section: 'actions' | 'skills') => {
    // Mount and focus inside the tap gesture so iOS can bring up the search keyboard.
    flushSync(() => { setCatalog(section); setAddQuery(''); setAddOpen(true); setDismissed(true); });
    searchRef.current?.focus();
  };

  /**
   * Enter in the menu. A command typed out in full that takes nothing after it runs straight away,
   * as in a terminal; otherwise the highlighted entry is filled in for the user to finish.
   */
  const enter = (row: Selectable) => {
    if (!addOpen && row.type === 'command' && !row.command.hint && text.trim() === `/${row.command.name}`) {
      void submit();
      return;
    }
    choose(row);
  };

  const hasContent = text.trim() !== '' || images.length > 0 || videos.length > 0 || notes.length > 0 || mentions.some((m) => m.task?.trim());
  const goalControl = text.trim() === '/goal' ? 'show' : text.trim() === '/goal pause' ? 'pause' : text.trim() === '/goal clear' ? 'clear' : null;
  const immediate = !!goalControl && !!goal?.controls.includes(goalControl) && !images.length && !videos.length && !notes.length && !mentions.length;
  const queueFull = running && !immediate && queued.length >= MAX_QUEUED;
  const canSend = hasContent && !busy && !menuBusy && !disabled && preparing === 0 && !queueFull;

  const submit = async () => {
    if (!canSend) return;
    if (images.length && attachBlocked) return onError(attachBlocked);
    setBusy(true);
    sendingRef.current = true;
    const message = asMessage(text, notes);
    const mark: Sending = { text: message, after: lastSent?.turnId ?? null };
    const sentFrom = draftKey;
    // On the device the draft now says it is on its way. Should the page be reloaded before the
    // send comes back, it is neither lost nor taken for something still to send.
    if (sentFrom !== undefined) keepDraft(sentFrom, { text, notes, images, videos, mentions, sending: mark });
    const slowTimer = setTimeout(() => setSlow(true), SLOW_SEND_MS);
    try {
      await onSend(message, images, mentions, videos);
      setMentions([]);
      // Forgotten at once, not when the box next saves itself: a reload right now must not bring it back.
      if (sentFrom !== undefined) keepDraft(sentFrom, null);
      inFlight.current = null;
      setNotes([]);
      images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      videos.forEach(video => URL.revokeObjectURL(video.previewUrl));
      setVideos([]);
      setImages([]);
      setText('');
    } catch {
      // The caller shows the error; keep the draft and the pictures so nothing is lost. The mark
      // stays too: a send can fail on this side (the page being reloaded, the answer lost on a bad
      // line) after the daemon took the message, and then the thread will show it.
      inFlight.current = mark;
    } finally {
      clearTimeout(slowTimer);
      setSlow(false);
      sendingRef.current = false;
      setBusy(false);
      ref.current?.focus();
    }
  };

  const menuKeyDown = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean => {
    if (menuOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        revealSelection.current = true;
        if (selectable.length) setActive((i) => (i + step + selectable.length) % selectable.length);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const row = selectable[active] ?? selectable[0];
        if (row) { if (e.key === 'Enter') enter(row); else choose(row); }
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setAddOpen(false);
        setDismissed(true);
        ref.current?.focus();
        return true;
      }
    }
    return false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'Escape') { e.preventDefault(); setMentionDismissed(true); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setMentionActive(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + mentionRows.length) % mentionRows.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); chooseMention(mentionRows[mentionActive] ?? mentionRows[0]); return; }
    }
    if (menuKeyDown(e)) return;
    // Desktop: Enter sends, Shift+Enter inserts a newline. Touch keyboards get the send button instead.
    const fine = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;
    if (fine && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/') || isVideo(f))) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes('Files');
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragOver(false);
    void addFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="composer">
      <div className="composer-anchor">
        {menuOpen && (
          <div className={`command-menu${addOpen && catalog !== 'all' ? ' catalog-menu' : ''}`} ref={paletteRef}>
            {addOpen && <label className="pop-search command-search"><IconSearch size={16} /><input ref={searchRef} autoFocus aria-label={catalog === 'all' ? '搜索操作与技能' : catalog === 'skills' ? '搜索技能' : '搜索操作'} placeholder={catalog === 'all' ? '搜索操作、命令或技能' : catalog === 'skills' ? '搜索技能名称或描述' : '搜索操作或命令'} value={addQuery} onChange={e => setAddQuery(e.target.value)} onKeyDown={menuKeyDown} /></label>}
            <div className="command-menu-list" role="listbox" aria-label="命令" ref={listRef}>
            {rows.map((row) => {
              if (row.type === 'heading') {
                return (
                  <div key={`h-${row.label}`} className="command-heading" role="presentation">
                    {row.label}
                  </div>
                );
              }
              const index = selectable.indexOf(row);
              const selected = index >= 0 && row === (selectable[active] ?? selectable[0]);
              const isAction = row.type === 'action';
              const plan = isAction && row.action.id === 'composer:plan';
              const Icon = isAction ? row.action.id === 'composer:attach' ? IconPaperclip : plan ? IconList : row.action.id.startsWith('composer:goal:') ? IconTarget : (ACTION_ICONS[row.action.id] ?? IconSlash) : row.command.kind === 'skill' ? IconSparkle : IconSlash;
              return (
                <button
                  key={isAction ? `a-${row.action.id}` : `c-${row.command.name}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-checked={plan ? planMode?.active : undefined}
                  disabled={isAction && row.action.disabled}
                  data-active={selected}
                  className={`command-item${selected ? ' active' : ''}`}
                  onPointerMove={e => { if (e.pointerType === 'mouse' && index >= 0) { revealSelection.current = false; setActive(index); } }}
                  // Keep focus in the input so the keyboard stays open on phones.
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => choose(row)}
                >
                  <span className="command-icon">
                    <Icon size={16} />
                  </span>
                  <span className="command-content">{isAction ? (
                    <>
                      <span className="command-label">{row.action.label}</span>
                      <span className="command-desc">{row.action.hint}</span>
                    </>
                  ) : (
                    <>
                      <span className="command-name">
                        /{row.command.name}
                        {row.command.hint && <span className="command-hint"> {row.command.hint}</span>}
                      </span>
                      <span className="command-desc">{row.command.description}</span>
                    </>
                  )}</span>
                  {plan && planMode?.active && <span className="command-check"><IconCheck size={16} /></span>}
                </button>
              );
            })}
            {!rows.length && <p className="pop-note">没有匹配的结果</p>}
            </div>
            {addOpen && catalog === 'skills' && actions.some(a => a.id === 'skills') && <button type="button" className="composer-menu-footer" onClick={() => { setAddOpen(false); setDismissed(true); onAction('skills'); }}>管理技能<IconChevron size={14} /></button>}
          </div>
        )}

        <div
          className={`composer-box${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
          }}
          onDrop={onDrop}
        >
          {header && <div className="composer-context">{header}</div>}
          {planAction && <div className="composer-plan-action">{planAction}</div>}

          {queued.length > 0 && (
            <div className="queue" aria-label="排队中的消息">
              {queued.map((q) => (
                <div key={q.id} className="queue-item">
                  <span className="queue-badge">排队</span>
                  <span className="queue-text">
                    {q.text || (q.videos ? '视频' : '图片')}
                    {q.images > 0 && q.text && <span className="muted"> · {q.images} 张图</span>}
                    {!!q.videos && <span className="muted"> · {q.videos} 个视频</span>}
                  </span>
                  <button type="button" className="queue-now" title="打断当前这一轮，马上发送这条" onClick={() => onSendQueuedNow(q.id)}>
                    立即发送
                  </button>
                  <button type="button" className="queue-remove" aria-label="撤回到输入框里编辑" title="编辑" onClick={() => void editQueued(q.id)}>
                    <IconEdit size={13} />
                  </button>
                  <button type="button" className="queue-remove" aria-label="取消这条排队的消息" onClick={() => onRemoveQueued(q.id)}>
                    <IconClose size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {(images.length > 0 || videos.length > 0 || preparing > 0) && (
            <div className="attachments" aria-label="要发送的附件">
              {images.map((img) => (
                <div key={img.id} className="attachment">
                  <button
                    type="button"
                    className="attachment-view"
                    aria-label={`预览 ${img.name}`}
                    title="预览"
                    onClick={() => setPreview(img)}
                  >
                    <img src={img.previewUrl} alt={img.name} />
                  </button>
                  <button type="button" className="attachment-remove" aria-label={`移除 ${img.name}`} onClick={() => removeImage(img.id)}>
                    <IconClose size={12} />
                  </button>
                </div>
              ))}
              {videos.map(video => <div key={video.id} className="attachment video-attachment">
                <button type="button" className="video-card" aria-label={`预览视频：${video.name}`} onClick={() => setVideoPreview(video)}>
                  <IconPlay size={20} /><span><span className="video-name">{video.name}</span><span className="video-size">视频 · {sizeLabel(video.file.size)}</span></span>
                </button>
                <button type="button" className="attachment-remove" aria-label={`移除 ${video.name}`} onClick={() => { URL.revokeObjectURL(video.previewUrl); setVideos(current => current.filter(v => v.id !== video.id)); }}><IconClose size={12} /></button>
              </div>)}
              {Array.from({ length: preparing }, (_, i) => (
                <div key={`p-${i}`} className="attachment pending" aria-label="正在处理图片" />
              ))}
            </div>
          )}

          {notes.length > 0 && (
            <div className="notes" aria-label={`${notes.length} 条注释`}>
              {notes.map((n, i) => (
                <div key={n.id} className="note-strip">
                  <span className="note-num">{i + 1}</span>
                  <span className="note-body">
                    <span className="note-quote" title={n.quote}>
                      {n.quote}
                    </span>
                    {n.comment && <span className="note-comment">{n.comment}</span>}
                  </span>
                  <button
                    type="button"
                    className="quote-remove"
                    aria-label={`移除注释 ${i + 1}`}
                    title="移除注释"
                    onClick={() => setNotes((prev) => prev.filter((x) => x.id !== n.id))}
                  >
                    <IconClose size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {mentionOpen && <div className="coord-mention-menu" role="listbox" aria-label="选择协作智能体">
            {(['member', 'agent'] as const).map(kind => <div key={kind}>
              {mentionRows.some(m => m.kind === kind) && <div className="coord-caption">
                <span>{kind === 'member' ? '本次协作' : '可用实例 · 新建成员'}</span>
                {kind === mentionRows[0]?.kind && <button type="button" className="icon-btn" aria-label="不选择智能体" title="不选择，@ 留作文字" onClick={() => { setMentionDismissed(true); ref.current?.focus(); }}><IconClose size={13} /></button>}
              </div>}
              {mentionRows.map((m, i) => m.kind === kind && (
                <button type="button" role="option" aria-selected={i === mentionActive} className={`pop-item compact${i === mentionActive ? ' selected' : ''}`} key={m.id} onClick={() => chooseMention(m)}>
                  <span className="pop-item-icon">{mentionIcon?.(m) ? <AgentMark path={mentionIcon(m)!} size={16} /> : null}</span>
                  <span className="pop-item-label">{m.label}</span>
                </button>
              ))}
            </div>)}
          </div>}
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder={dragOver ? '松开以添加图片' : placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
            aria-label="消息"
            aria-expanded={menuOpen}
            aria-autocomplete="list"
          />

          {/* One line per agent brought in: what is written there is for that one alone. */}
          {mentions.length > 0 && (
            <div className="coord-rows">
              {mentions.map((m, i) => (
                <div className="coord-row" key={`${m.kind}:${m.id}:${i}`}>
                  {m.kind === 'member' ? (
                    <span className="coord-row-name">@{m.label}</span>
                  ) : (
                    <Popover label="成员工作目录" triggerClassName="coord-row-name" triggerTitle="选择工作目录" trigger={<span>@{m.label}{m.cwd ? ` · ${m.cwd.split('/').pop()}` : ''}</span>}>
                      {close => <>{mentionDirectories.map(dir => <button className="pop-item compact" key={dir} onClick={() => { setMentions(prev => prev.map(v => v === m ? { ...v, cwd: dir } : v)); close(); }}>{dir}</button>)}</>}
                    </Popover>
                  )}
                  <textarea
                    ref={(el) => { taskRefs.current[i] = el; }}
                    rows={1}
                    value={m.task ?? ''}
                    placeholder="只给它的任务，留空由主智能体分工"
                    aria-label={`给 ${m.label} 的任务`}
                    disabled={disabled}
                    onChange={(e) => { const task = e.target.value; setMentions(prev => prev.map(v => v === m ? { ...v, task } : v)); }}
                    onKeyDown={(e) => {
                      // Enter leaves the line for the message; a task is one line of intent, not an essay.
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ref.current?.focus(); }
                    }}
                  />
                  {m.kind === 'agent' && mentionExtra?.(m)}
                  <button type="button" className="icon-btn" aria-label={`移除 ${m.label}`} onClick={() => setMentions(prev => prev.filter(v => v !== m))}><IconClose size={13} /></button>
                </div>
              ))}
            </div>
          )}

          <div className="composer-bar">
            <input
              ref={fileRef}
              type="file"
              accept={`image/*,${VIDEO_ACCEPT}`}
              multiple
              hidden
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = ''; // so picking the same file again fires a change
              }}
            />
            {narrow ? <Popover
              label="添加与模式"
              triggerClassName={`tool-btn icon-only composer-add${planMode?.active ? ' plan-active' : ''}`}
              triggerLabel="添加与模式"
              triggerTitle={planMode?.active ? '添加附件 · 计划模式已开启' : '添加附件与选择模式'}
              panelClassName="composer-add-menu"
              trigger={<IconPlus size={20} />}
              disabled={disabled || menuBusy || busy}
            >
              {close => <ComposerMenu close={close} commands={commands} planMode={planMode} goal={goal} running={running}
                attachTitle={attachBlocked ? `${attachBlocked}；可以添加视频文件` : attachNote ?? '添加图片或视频（视频最大 100 MB）'}
                onAttach={() => fileRef.current?.click()} onGoal={chooseGoal} onBrowse={browse} />}
            </Popover> : <button ref={addRef} type="button" className={`tool-btn icon-only composer-add${planMode?.active ? ' plan-active' : ''}`}
              aria-label="添加与模式" aria-haspopup="listbox" aria-expanded={addOpen} title={planMode?.active ? '添加与命令 · 计划模式已开启' : '添加附件、操作或技能'} disabled={disabled || menuBusy || busy}
              onClick={() => { setCatalog('all'); setAddQuery(''); setAddOpen(!addOpen); setDismissed(true); }}><IconPlus size={20} /></button>}
            {collaboration?.(mention => chooseMention(mention, false), mentions)}
            {left}
            <div className="spacer" />
            {right}
            {running && (
              <button className="send-btn stop" onClick={onStop} aria-label="停止" title="停止这一轮">
                <IconStop size={16} />
              </button>
            )}
            {/* While a turn runs the send button appears only once there is something to queue. */}
            {(!running || hasContent) && (
              <button
                className={`send-btn${slow ? ' sending' : ''}`}
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={slow ? '正在发送' : running && !immediate ? '排队发送' : '发送'}
                title={slow ? '正在发送…' : queueFull ? `最多排 ${MAX_QUEUED} 条` : running ? immediate ? '立即执行目标操作' : '这一轮结束后发送' : undefined}
              >
                {slow ? <span className="send-spinner" aria-hidden="true" /> : <IconSend size={16} />}
              </button>
            )}
          </div>
        </div>
      </div>
      {goalDialog && <Dialog title="设置目标" message="描述要完成的结果，智能体会持续执行。" confirmLabel={menuBusy ? '正在启动…' : '开始执行'}
        confirmDisabled={menuBusy || busy || disabled || running || planMode?.active || !goalText.trim() || /^(pause|resume|clear)$/.test(goalText.trim())}
        onCancel={() => { if (!menuBusy) setGoalDialog(false); }} onConfirm={() => void runMenuCommand(`/goal ${goalText.trim()}`)}>
        <label className="dialog-field"><span>目标</span><textarea autoFocus className="goal-objective" aria-label="目标" placeholder="例如：修复登录问题，补齐回归测试并验证通过" rows={4} value={goalText} disabled={menuBusy} onChange={e => setGoalText(e.target.value)} /></label>
      </Dialog>}
      {videoPreview && <VideoPreview url={videoPreview.previewUrl} name={videoPreview.name} onClose={() => setVideoPreview(null)} />}
      {preview && <Lightbox url={preview.previewUrl} name={preview.name} onClose={() => setPreview(null)} />}
    </div>
  );
}
