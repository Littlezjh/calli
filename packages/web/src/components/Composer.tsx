import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { MAX_QUEUED, type QueuedMessage, type SlashCommand } from '../api';
import { buildMenu, type HubAction, type MenuRow } from '../commands';
import { MAX_IMAGES, prepareImage, type PreparedImage } from '../images';
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

interface Props {
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
  /** Interrupt the running turn and send this waiting message next. */
  onSendQueuedNow: (id: string) => void;
  /** Text to put back in the box, such as messages that were waiting when the user pressed stop. */
  restore: { text: string; nonce: number } | null;
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
  onSendQueuedNow,
  restore,
}: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [preparing, setPreparing] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
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

  // Thumbnails are object URLs; release whatever is left when the composer goes away.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((img) => URL.revokeObjectURL(img.previewUrl)), []);

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

  const hasContent = text.trim() !== '' || images.length > 0;
  // While a turn runs, sending means queueing, up to a limit.
  const queueFull = running && queued.length >= MAX_QUEUED;
  const canSend = hasContent && !busy && !disabled && preparing === 0 && !queueFull;

  const submit = async () => {
    if (!canSend) return;
    if (images.length && attachBlocked) return onError(attachBlocked);
    setBusy(true);
    try {
      await onSend(text.trim(), images);
      images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setImages([]);
      setText('');
    } catch {
      // The caller shows the error; keep the draft and the pictures so nothing is lost.
    } finally {
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
                  <img src={img.previewUrl} alt={img.name} />
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
    </div>
  );
}
