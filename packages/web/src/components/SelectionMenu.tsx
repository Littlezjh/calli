import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import { IconCopy, IconQuote, IconSideChat } from './icons';

interface Props {
  onQuote: (text: string) => void;
  onSideAsk: (text: string) => void;
}

/** Rough size of the menu, so it can be centred on the selection without waiting for layout. */
const MENU_WIDTH = 250;
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

/**
 * The menu that follows a text selection in the conversation: quote it into the composer, copy it,
 * or ask about it in the side chat. The browser's own menu (where it shows one) stays as it is.
 */
export function SelectionMenu({ onQuote, onSideAsk }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // The selection can vanish between tapping the button and its click; the text is taken first.
  const textRef = useRef('');

  useEffect(() => {
    const read = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setPos(null);
      const text = sel.toString().trim();
      if (!text || !selectable(sel.anchorNode) || !selectable(sel.focusNode)) return setPos(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return setPos(null);

      textRef.current = text;
      const left = Math.min(Math.max(rect.left + rect.width / 2 - MENU_WIDTH / 2, MARGIN), window.innerWidth - MENU_WIDTH - MARGIN);
      const above = rect.top - MENU_HEIGHT - 12;
      const top =
        above >= MARGIN ? above : Math.min(rect.bottom + 12, window.innerHeight - MENU_HEIGHT - MARGIN);
      setPos({ top, left });
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

  if (!pos) return null;

  // Touch clears a selection before a tap can land as a click, so touch acts at touch-start;
  // mouse keeps the selection alive until the click by swallowing the mousedown.
  const act = (fn: (text: string) => void) => () => {
    document.getSelection()?.removeAllRanges();
    fn(textRef.current);
  };

  return (
    <div className="selection-menu" style={{ top: pos.top, left: pos.left }} role="toolbar" aria-label="对选中文字的操作">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={(e) => {
          e.preventDefault();
          act(onQuote)();
        }}
        onClick={act(onQuote)}
      >
        <IconQuote size={14} />
        引用
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={(e) => {
          e.preventDefault();
          void copyText(textRef.current);
          document.getSelection()?.removeAllRanges();
        }}
        onClick={() => {
          void copyText(textRef.current);
          document.getSelection()?.removeAllRanges();
        }}
      >
        <IconCopy size={14} />
        拷贝
      </button>
      <button
        type="button"
        className="selection-ask"
        onMouseDown={(e) => e.preventDefault()}
        onTouchStart={(e) => {
          e.preventDefault();
          act(onSideAsk)();
        }}
        onClick={act(onSideAsk)}
      >
        <IconSideChat size={14} />
        在侧边栏提问
      </button>
    </div>
  );
}
