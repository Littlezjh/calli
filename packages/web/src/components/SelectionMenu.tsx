import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import { copyText } from '../clipboard';
import { IconArrowUp, IconCopy, IconQuote, IconSideChat } from './icons';

interface Props {
  /** A passage noted for the next message, with what the user says about it (may be empty). */
  onNote: (quote: string, comment: string, range: Range) => void;
  onSideAsk: (text: string) => void;
}

/** Rough size of the menu, so it can be centred on the selection without waiting for layout. */
const MENU_WIDTH = 250;
const COMMENT_WIDTH = 320;
const MENU_HEIGHT = 42;
/** Kept away from the viewport edges by this much. */
const MARGIN = 8;

/**
 * What the browser reports as a selection worth acting on: text picked out of the thread's
 * messages, and nowhere text is being edited or another layer is lying over the thread.
 */
function selectable(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  if (!el?.closest('.thread')) return false;
  return !el.closest('textarea, input, [contenteditable="true"], .side-chat, .lightbox, .dialog-scrim');
}

/** Centred on the passage, above it when there is room, below it otherwise. */
function placeNear(rect: DOMRect, width: number): { top: number; left: number } {
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, MARGIN), window.innerWidth - width - MARGIN);
  const above = rect.top - MENU_HEIGHT - 12;
  const top = above >= MARGIN ? above : Math.min(rect.bottom + 12, window.innerHeight - MENU_HEIGHT - MARGIN);
  return { top, left };
}

/**
 * The menu that follows a text selection in the conversation: note it for the next message (with
 * an optional comment, like Codex), copy it, or ask about it in the side chat. The browser's own
 * menu (where it shows one) stays as it is.
 */
export function SelectionMenu({ onNote, onSideAsk }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Writing a comment: the field takes the focus, which clears the selection, so the passage is
  // held here until the note is added or dropped.
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState('');
  const commentingRef = useRef(false);
  commentingRef.current = commenting;
  // The selection can vanish between tapping the button and its click; text and range are taken first.
  const textRef = useRef('');
  const rangeRef = useRef<Range | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => {
      if (commentingRef.current) {
        // The passage scrolls with the page; the field follows it.
        const range = rangeRef.current;
        if (range) setPos(placeNear(range.getBoundingClientRect(), COMMENT_WIDTH));
        return;
      }
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setPos(null);
      const text = sel.toString().trim();
      if (!text || !selectable(sel.anchorNode) || !selectable(sel.focusNode)) return setPos(null);
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return setPos(null);

      textRef.current = text;
      rangeRef.current = range.cloneRange();
      setPos(placeNear(rect, MENU_WIDTH));
    };

    document.addEventListener('selectionchange', read);
    // The menu is fixed to the viewport; when the page scrolls under it, it follows the selection.
    window.addEventListener('scroll', read, true);
    window.addEventListener('resize', read);
    return () => {
      document.removeEventListener('selectionchange', read);
      window.removeEventListener('scroll', read, true);
      window.removeEventListener('resize', read);
    };
  }, []);

  // The field took the focus and with it the selection; the passage stays marked while it is written about.
  useEffect(() => {
    const registry = typeof CSS !== 'undefined' ? (CSS as unknown as { highlights?: Map<string, unknown> }).highlights : undefined;
    const range = rangeRef.current;
    if (!commenting || !range || !registry || typeof Highlight === 'undefined') return;
    registry.set('rah-note-pending', new Highlight(range));
    return () => void registry.delete('rah-note-pending');
  }, [commenting]);

  // A press anywhere else drops a comment being written.
  useEffect(() => {
    if (!commenting) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !e.composedPath().includes(rootRef.current)) close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [commenting]);

  const close = () => {
    setCommenting(false);
    setComment('');
    setPos(null);
  };

  if (!pos) return null;

  // Touch clears a selection before a tap can land as a click, so touch acts at touch-start;
  // mouse keeps the selection alive until the click by swallowing the mousedown.
  const act = (fn: () => void) => ({
    onMouseDown: (e: ReactMouseEvent) => e.preventDefault(),
    onTouchStart: (e: ReactTouchEvent) => {
      e.preventDefault();
      fn();
    },
    onClick: fn,
  });

  const startComment = () => {
    const range = rangeRef.current;
    if (range) setPos(placeNear(range.getBoundingClientRect(), COMMENT_WIDTH));
    setCommenting(true);
  };

  const addNote = () => {
    const range = rangeRef.current;
    if (range) onNote(textRef.current, comment.trim(), range);
    document.getSelection()?.removeAllRanges();
    close();
  };

  if (commenting) {
    return (
      <div ref={rootRef} className="selection-menu commenting" style={{ top: pos.top, left: pos.left, width: COMMENT_WIDTH }} role="dialog" aria-label="添加注释">
        <input
          autoFocus
          className="selection-comment"
          value={comment}
          placeholder="添加可选评论…"
          aria-label="对这段的评论，可以不写"
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              addNote();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
        />
        <button type="button" className="selection-add" aria-label="添加注释" title="添加注释（回车）" onClick={addNote}>
          <IconArrowUp size={15} />
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="selection-menu" style={{ top: pos.top, left: pos.left }} role="toolbar" aria-label="对选中文字的操作">
      <button type="button" {...act(startComment)}>
        <IconQuote size={14} />
        注释
      </button>
      <button
        type="button"
        {...act(() => {
          void copyText(textRef.current);
          document.getSelection()?.removeAllRanges();
        })}
      >
        <IconCopy size={14} />
        拷贝
      </button>
      <button
        type="button"
        className="selection-ask"
        {...act(() => {
          document.getSelection()?.removeAllRanges();
          onSideAsk(textRef.current);
        })}
      >
        <IconSideChat size={14} />
        在侧边栏提问
      </button>
    </div>
  );
}
