import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react';
import type { Api, Thread, Todo } from '../api';
import { buildTodoBoard, linkableThreads, type TodoNode } from '../todos';
import { Dialog } from './Dialog';
import { Menu, type MenuEntry } from './Menu';
import { IconCheck, IconChevron, IconClose, IconList, IconMore, IconPlus } from './icons';

interface Props {
  api: Api;
  /** The whole list, owned by App: the thread menu needs it too. */
  todos: Todo[];
  /** All live threads, for the link submenu. */
  threads: Thread[];
  /** Changes when the daemon broadcasts a plan or thread change, so the list reloads. */
  refreshKey: number;
  onReload: () => void;
  /** Opens a linked thread and closes the panel. */
  onOpenThread: (id: string) => void;
  onClose: () => void;
  onError: (e: unknown) => void;
}

function below(e: MouseEvent<HTMLElement>): [number, number] {
  const rect = e.currentTarget.getBoundingClientRect();
  return [rect.left, rect.bottom + 4];
}

const MAX_LINK_CHOICES = 30;

/**
 * Enter that means "done typing". While an input method is composing (pinyin picking its
 * characters), Enter belongs to it and must not submit half a word.
 */
const isCommit = (e: ReactKeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && !e.nativeEvent.isComposing;

/** How many plans a thread is already linked to, for the thread menu's "checked" marks. */
export function todoLinkCount(todos: Todo[], threadId: string): number {
  return todos.filter((t) => t.threads.some((thread) => thread.id === threadId)).length;
}

/**
 * The plan page: the user's own long-lived list. Plans can be struck through and linked to
 * threads, so the work happening in threads and the plan it serves stay side by side.
 */
export function TodosPanel({ api, todos, threads, refreshKey, onReload, onOpenThread, onClose, onError }: Props) {
  const [adding, setAdding] = useState('');
  // The plan a sub-item is being typed under, with what has been typed so far.
  const [child, setChild] = useState<{ parentId: string; text: string } | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [menu, setMenu] = useState<{ todo: Todo; x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<Todo | null>(null);
  const [showDone, setShowDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Escape closes the innermost thing: a menu or dialog on top, or a field that used it to
    // cancel (it marks the event handled), before it closes the panel.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !menu && !deleting) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, menu, deleting]);

  // Reload when anything changes on the server: plan edits from another device, or thread
  // states that the chips show.
  useEffect(() => {
    if (refreshKey > 0) onReload();
    // onReload only refetches; it is not a reason to run again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
      onReload();
    } catch (e) {
      onError(e);
    }
  };

  const board = buildTodoBoard(todos);

  const add = async (parentId: string | null, text: string) => {
    const value = text.trim();
    if (!value) return;
    await act(() => api.createTodo(value, parentId));
  };

  const toggle = (todo: Todo) => void act(() => api.updateTodo(todo.id, { done: !todo.done }));

  const saveEdit = () => {
    const next = editing;
    setEditing(null);
    if (!next) return;
    const value = next.text.trim();
    const current = todos.find((t) => t.id === next.id);
    if (!value || !current || current.text === value) return;
    void act(() => api.updateTodo(next.id, { text: value }));
  };

  const menuEntries = (todo: Todo): MenuEntry[] => {
    const isTop = todo.parentId === null;
    const choices = linkableThreads(todos, todo.id, threads).slice(0, MAX_LINK_CHOICES);
    return [
      ...(isTop
        ? [{ id: 'add-child', label: '加子项', icon: IconPlus, onSelect: () => setChild({ parentId: todo.id, text: '' }) }]
        : []),
      {
        id: 'link',
        label: '关联线程',
        icon: IconList,
        disabled: choices.length === 0,
        submenu: choices.map((t) => ({
          id: `link-${t.id}`,
          label: t.title || t.cwd,
          onSelect: () => void act(() => api.linkTodo(todo.id, t.id)),
        })),
      },
      'separator',
      { id: 'delete', label: '删除', icon: IconClose, danger: true, onSelect: () => setDeleting(todo) },
    ];
  };

  const chip = (todo: Todo, thread: Thread) => (
    <span key={thread.id} className={`todo-chip${thread.archivedAt ? ' archived' : ''}`}>
      <span className={`todo-chip-dot ${thread.status}${thread.waiting ? ' waiting' : ''}`} />
      <button type="button" className="todo-chip-name" title={`打开线程：${thread.title}`} onClick={() => onOpenThread(thread.id)}>
        {thread.title || thread.cwd}
      </button>
      <button
        type="button"
        className="todo-chip-unlink"
        aria-label="取消关联这个线程"
        onClick={() => void act(() => api.unlinkTodo(todo.id, thread.id))}
      >
        <IconClose size={11} />
      </button>
    </span>
  );

  const row = (todo: TodoNode, isChild: boolean) => {
    const editingThis = editing?.id === todo.id;
    return (
      <div key={todo.id} className={isChild ? 'todo child' : 'todo'}>
        <div className="todo-line">
          <button
            type="button"
            className={`todo-check${todo.done ? ' done' : ''}`}
            aria-label={todo.done ? '标记为未完成' : '标记为已完成'}
            onClick={() => toggle(todo)}
          >
            {todo.done && <IconCheck size={12} />}
          </button>
          {editingThis ? (
            <input
              className="todo-edit"
              value={editing.text}
              autoFocus
              onChange={(e) => setEditing({ id: todo.id, text: e.target.value })}
              onBlur={saveEdit}
              onKeyDown={(e) => {
                if (isCommit(e)) saveEdit();
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(null);
                }
              }}
              aria-label="编辑计划"
            />
          ) : (
            <button
              type="button"
              className={`todo-text${todo.done ? ' done' : ''}`}
              title="点击编辑"
              onClick={() => setEditing({ id: todo.id, text: todo.text })}
            >
              {todo.text}
            </button>
          )}
          <button
            type="button"
            className="row-more"
            aria-label={`计划“${todo.text}”的更多操作`}
            onClick={(e) => {
              const [x, y] = below(e);
              setMenu({ todo, x, y });
            }}
          >
            <IconMore size={15} />
          </button>
        </div>
        {todo.threads.length > 0 && <div className="todo-chips">{todo.threads.map((t) => chip(todo, t))}</div>}
        {(todo.children.length > 0 || child?.parentId === todo.id) && (
          <div className="todo-children">
            {todo.children.map((c) => row(c, true))}
            {child?.parentId === todo.id && (
              <input
                className="todo-add child"
                autoFocus
                placeholder="加一个子项，回车确认"
                value={child.text}
                onChange={(e) => setChild({ parentId: todo.id, text: e.target.value })}
                onKeyDown={(e) => {
                  // Stays open for the next one: sub-items tend to come several at a time. Enter
                  // on an empty line, or Escape, is how it is put away. Not losing focus: the menu
                  // that opened it takes focus back as it closes, which would shut it at once.
                  if (isCommit(e)) {
                    if (child.text.trim()) void add(todo.id, child.text);
                    setChild(child.text.trim() ? { parentId: todo.id, text: '' } : null);
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setChild(null);
                  }
                }}
                aria-label="新子项"
              />
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    // Only a click on the dimmed backdrop itself closes the page. The menu and the confirmation
    // below are drawn over it, and a click in them is not a click "outside".
    <div
      className="dialog-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="panel todos-panel" role="dialog" aria-modal="true" aria-labelledby="todos-title">
        <header className="panel-head">
          <h2 id="todos-title" className="panel-title">
            <IconList size={20} /> 计划
          </h2>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose size={18} />
          </button>
        </header>
        <p className="panel-hint">长期的计划，做完划掉；计划可以关联线程，跟着线程推进。</p>

        <div className="panel-list todos-list">
          {board.open.length === 0 && board.done.length === 0 && (
            <p className="panel-empty">还没有计划。在下面输入第一条，回车添加。</p>
          )}
          {board.open.map((n) => row(n, false))}

          {board.done.length > 0 && (
            <div className="todos-done-group">
              <button type="button" className="todos-done-head" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                <IconChevron size={13} open={showDone} />
                已完成 {board.done.length}
              </button>
              {showDone && board.done.map((n) => row(n, false))}
            </div>
          )}
        </div>

        <div className="todos-foot">
          <IconPlus size={15} />
          <input
            ref={inputRef}
            className="todo-add"
            placeholder="添加一条计划，回车确认"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (isCommit(e) && adding.trim()) {
                void add(null, adding);
                setAdding('');
              }
            }}
            aria-label="新计划"
          />
        </div>
      </div>

      {menu && (
        <Menu
          label="计划操作"
          x={menu.x}
          y={menu.y}
          items={menuEntries(menu.todo)}
          onClose={() => setMenu(null)}
        />
      )}
      {deleting && (
        <Dialog
          title="删除计划"
          message={deleting.parentId ? '删除这个子项？' : '删除这条计划？它的子项和线程关联会一起删除。'}
          confirmLabel="删除"
          danger
          onConfirm={() => {
            setDeleting(null);
            void act(() => api.deleteTodo(deleting.id));
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
