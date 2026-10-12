import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ApiError, MAX_QUEUED, type OutgoingImage, type QueuedMessage, type SlashCommand } from '../api';
import { buildMenu, type HubAction, type MenuRow } from '../commands';
import { readDrafts, writeDraft } from '../drafts';
import { MAX_IMAGES, prepareImage, restoreImage, type PreparedImage } from '../images';
import { withNotes, type Note } from '../timeline';
import { Lightbox } from './Lightbox';
import {
  IconArchive,
  IconClose,
  IconCopy,
  IconCube,
  IconEdit,
  IconFork,
  IconHelp,
  IconImport,
  IconInfo,
  IconPaperclip,
  IconPin,
  IconSend,
  IconShield,
  IconSlash,
  IconSparkle,
  IconStop,
} from './icons';

/** A passage noted for the next message. The id ties it to its highlight in the conversation. */
export interface DraftNote extends Note {
  id: string;
}

/** What is left unsent in a box: the words, noted passages and pictures. */
interface Draft {
  text: string;
  notes: DraftNote[];
  images: PreparedImage[];
}

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
  return stored && { text: stored.text, notes: stored.notes.map((n) => ({ ...n, id: noteId() })), images: [] };
}

function keepDraft(key: string, draft: Draft | null): void {
  if (draft && (draft.text.trim() || draft.notes.length || draft.images.length)) drafts.set(key, draft);
  else drafts.delete(key);
  const store = storage();
  if (store) writeDraft(store, key, draft);
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
  onSend: (text: string, images: PreparedImage[]) => Promise<void> | void;
  onStop: () => void;
  /** Strip above the text area: which agent and which directory. */
  header: ReactNode;
  /** Controls at the left of the bottom bar, after the attach button. */
  left: ReactNode;
  /** Controls at the right of the bottom bar, before the send button. */
  right: ReactNode;
  /** The agent's own slash commands. */
  commands: SlashCommand[];
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
  onEditQueued: (id: string) => Promise<{ text: string; images: OutgoingImage[] }>;
  /** Interrupt the running turn and send this waiting message next. */
  onSendQueuedNow: (id: string) => void;
  /** Text to put back in the box, such as messages that were waiting when the user pressed stop. */
  restore: { text: string; nonce: number } | null;
  /** A passage noted out of a message, to go along with what is typed. Each one adds to the list. */
  note: (DraftNote & { nonce: number }) | null;
  /** Told which notes are in the box, so their passages can stay highlighted in the conversation. */
  onNotesChange?: (notes: DraftNote[]) => void;
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
  left,
  right,
  commands,
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
}: Props) {
  const [text, setText] = useState('');
  const [notes, setNotes] = useState<DraftNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  /** A picture being looked at full size before it goes out. */
  const [preview, setPreview] = useState<PreparedImage | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildMenu(text, actions, commands, hiddenCommands), [text, actions, commands, hiddenCommands]);
  const selectable = useMemo(() => rows.filter((r): r is Selectable => r.type !== 'heading'), [rows]);
  const menuOpen = selectable.length > 0 && !dismissed;

  // Typing changes the list, so the highlight goes back to the first row and a dismissed menu can reopen.
  useEffect(() => {
    setActive(0);
    setDismissed(false);
  }, [text]);

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
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, menuOpen]);

  // Text handed back goes in front of whatever is being typed, so nothing is lost either way.
  useEffect(() => {
    if (!restore) return;
    setText((current) => [restore.text, current].filter((s) => s.trim()).join('\n\n'));
    ref.current?.focus();
    // Keyed on the nonce: the same text can be handed back twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restore?.nonce]);

  // Each thread has its own draft. Swapped before paint, so the old text never flashes in the new
  // thread. The pictures' object URLs go with the draft; they are released once it is sent.
  const draftRef = useRef<Draft>({ text, notes, images });
  draftRef.current = { text, notes, images };
  const sendingRef = useRef(false);
  useLayoutEffect(() => {
    if (draftKey === undefined) return;
    const saved = loadDraft(draftKey);
    setText(saved?.text ?? '');
    setNotes(saved?.notes ?? []);
    setImages(saved?.images ?? []);
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
  }, [draftKey, text, notes]);
  // Without a draft to keep them, thumbnails left in the box are released when it goes away.
  useEffect(
    () => () => {
      if (draftKey === undefined) draftRef.current.images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const addFiles = async (files: File[]) => {
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
      setText((current) => [taken.text, current].filter((s) => s.trim()).join('\n\n'));
      const room = MAX_IMAGES - images.length - preparing;
      if (taken.images.length > room) onError(`一条消息最多 ${MAX_IMAGES} 张图片，多出的没有放回`);
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
    if (row.type === 'action' && row.action.id === 'help') {
      // Everything there is to run is in this menu; show all of it.
      setText('/');
      ref.current?.focus();
      return;
    }
    if (row.type === 'action') {
      setText('');
      onAction(row.action.id);
    } else {
      setText(`/${row.command.name} `);
    }
    ref.current?.focus();
  };

  /**
   * Enter in the menu. A command typed out in full that takes nothing after it runs straight away,
   * as in a terminal; otherwise the highlighted entry is filled in for the user to finish.
   */
  const enter = (row: Selectable) => {
    if (row.type === 'command' && !row.command.hint && text.trim() === `/${row.command.name}`) {
      void submit();
      return;
    }
    choose(row);
  };

  const hasContent = text.trim() !== '' || images.length > 0 || notes.length > 0;
  // While a turn runs, sending means queueing, up to a limit.
  const queueFull = running && queued.length >= MAX_QUEUED;
  const canSend = hasContent && !busy && !disabled && preparing === 0 && !queueFull;

  const submit = async () => {
    if (!canSend) return;
    if (images.length && attachBlocked) return onError(attachBlocked);
    setBusy(true);
    sendingRef.current = true;
    try {
      await onSend(notes.length ? withNotes(notes, text) : text.trim(), images);
      setNotes([]);
      images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setImages([]);
      setText('');
    } catch {
      // The caller shows the error; keep the draft and the pictures so nothing is lost.
    } finally {
      sendingRef.current = false;
      setBusy(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + selectable.length) % selectable.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        enter(selectable[active]);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        choose(selectable[active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // Desktop: Enter sends, Shift+Enter inserts a newline. Touch keyboards get the send button instead.
    const fine = typeof window !== 'undefined' && window.matchMedia?.('(pointer: fine)').matches;
    if (fine && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
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

  let selectableIndex = -1;

  return (
    <div className="composer">
      <div className="composer-anchor">
        {menuOpen && (
          <div className="command-menu" role="listbox" aria-label="命令" ref={listRef}>
            {rows.map((row) => {
              if (row.type === 'heading') {
                return (
                  <div key={`h-${row.label}`} className="command-heading" role="presentation">
                    {row.label}
                  </div>
                );
              }
              selectableIndex += 1;
              const index = selectableIndex;
              const isAction = row.type === 'action';
              const Icon = isAction ? (ACTION_ICONS[row.action.id] ?? IconSlash) : row.command.kind === 'skill' ? IconSparkle : IconSlash;
              return (
                <button
                  key={isAction ? `a-${row.action.id}` : `c-${row.command.name}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  className={`command-item${index === active ? ' active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  // mousedown, not click: keeps focus in the textarea so the keyboard stays open on phones.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(row);
                  }}
                >
                  <span className="command-icon">
                    <Icon size={16} />
                  </span>
                  {isAction ? (
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
                  )}
                </button>
              );
            })}
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

          {queued.length > 0 && (
            <div className="queue" aria-label="排队中的消息">
              {queued.map((q) => (
                <div key={q.id} className="queue-item">
                  <span className="queue-badge">排队</span>
                  <span className="queue-text">
                    {q.text || '图片'}
                    {q.images > 0 && q.text && <span className="muted"> · {q.images} 张图</span>}
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

          {(images.length > 0 || preparing > 0) && (
            <div className="attachments" aria-label="要发送的图片">
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

          <div className="composer-bar">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])]);
                e.target.value = ''; // so picking the same file again fires a change
              }}
            />
            <button
              type="button"
              className={`tool-btn icon-only${attachBlocked ? ' blocked' : ''}`}
              aria-label="添加图片"
              title={attachBlocked ?? attachNote ?? '添加图片（也可以粘贴或拖进来）'}
              disabled={disabled}
              onClick={() => (attachBlocked ? onError(attachBlocked) : fileRef.current?.click())}
            >
              <IconPaperclip size={17} />
            </button>
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
                className="send-btn"
                onClick={() => void submit()}
                disabled={!canSend}
                aria-label={running ? '排队发送' : '发送'}
                title={queueFull ? `最多排 ${MAX_QUEUED} 条` : running ? '这一轮结束后发送' : undefined}
              >
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {preview && <Lightbox url={preview.previewUrl} onClose={() => setPreview(null)} />}
    </div>
  );
}
