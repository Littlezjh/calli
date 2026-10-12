import { useState, type ReactNode } from 'react';
import { ApiError, type AgentInfo, type Api, type Section, type Thread, type Todo } from '../api';
import { copyText } from '../clipboard';
import { folderName } from '../paths';
import { ChoiceDialog, Dialog } from './Dialog';
import { HandoverDialog } from './HandoverDialog';
import { Menu, type MenuEntry } from './Menu';
import { IconArchive, IconCheck, IconCopy, IconDot, IconEdit, IconFork, IconHand, IconList, IconPin, IconPlus, IconTerminal, IconTrash, IconWorktree } from './icons';
import type { ToastState } from './Toast';

interface Deps {
  api: Api | null;
  agents: AgentInfo[];
  sections: Section[];
  /** The plan page's list, for the "关联到计划" submenu. */
  todos: Todo[];
  /** A plan was linked or unlinked here: reload the list. */
  onTodosChange: () => void;
  /** A thread changed. One that now has `archivedAt` should leave the sidebar. */
  onThreadChange: (thread: Thread) => void;
  onThreadRemove: (id: string) => void;
  /** A thread was made here and should be shown. */
  onThreadOpen: (thread: Thread) => void;
  /** The user marked a thread unread by hand. If it is the one on screen, it has to be left to stay unread. */
  onMarkedUnread: (thread: Thread) => void;
  /** Sections were added, renamed or removed: reload them (and the threads filed under them). */
  onSectionsChange: () => void;
  /** Opens the web terminal, from a menu item tied to the thread's directory. */
  onOpenTerminal: () => void;
  onError: (e: unknown) => void;
  toast: (t: ToastState | null) => void;
  /** The whole conversation as Markdown, for the copy menu. */
  markdownOf: (thread: Thread) => Promise<string>;
}

type MenuState = { x: number; y: number } & ({ thread: Thread } | { section: Section });

type DialogState =
  | { kind: 'rename'; thread: Thread }
  | { kind: 'delete'; thread: Thread }
  /** The worktree to be deleted holds work that exists nowhere else: asked once more, with the count. */
  | { kind: 'delete-worktree'; thread: Thread; agentSession: boolean; changes: number; commits: number }
  /** Where the copy should run: beside the original, or in a git worktree of its own. */
  | { kind: 'fork'; thread: Thread; turnId?: string; branch: string | null; changes: number }
  | { kind: 'new-section'; thread: Thread | null }
  | { kind: 'rename-section'; section: Section }
  | { kind: 'delete-section'; section: Section }
  /** Get source-session coordinates and progress for another agent to continue in the same directory. */
  | { kind: 'handover'; thread: Thread };

export type ThreadAction = 'rename' | 'pin' | 'fork' | 'archive' | 'restore' | 'delete';

/** Why a thread cannot be forked right now, or null when it can. */
export function forkBlocked(thread: Thread): string | null {
  if (!thread.agentSessionId) return '还没有对话可以分叉，先发一条消息';
  if (thread.status === 'running') return '等这一轮结束后再分叉';
  return null;
}

/**
 * Everything that can be done to a thread or a section from a menu: the menu itself, the dialogs
 * it leads to, and the requests behind them. One instance serves the sidebar, the thread header,
 * the archive and the slash menu, so an action behaves the same wherever it is started.
 */
export function useThreadActions(deps: Deps) {
  const { api, agents, sections, todos, onTodosChange, onThreadChange, onThreadRemove, onThreadOpen, onMarkedUnread, onSectionsChange, onOpenTerminal, onError, toast, markdownOf } = deps;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const patch = async (thread: Thread, body: Parameters<Api['updateThread']>[1], then?: () => void) => {
    if (!api) return;
    try {
      onThreadChange(await api.updateThread(thread.id, body));
      then?.();
    } catch (e) {
      onError(e);
    }
  };

  // The agent copies its side of the conversation, which can take a few seconds. With a turn, the
  // copy ends where that turn ended; the agent's own history is read to find that place.
  //
  // `where` is left out when the user has not been asked yet. They are asked only when there is
  // something to choose: the agent can move a copy, and the thread stands in a git repository.
  const fork = async (thread: Thread, turnId?: string, where?: 'here' | 'worktree') => {
    if (!api) return;
    const blocked = forkBlocked(thread);
    if (blocked) return toast({ message: blocked });
    if (!where && agents.find((a) => a.id === thread.agent)?.capabilities.forkInto) {
      // An older daemon has no such question to answer; then the copy is made in place, as before.
      const options = await api.forkOptions(thread.id).catch(() => null);
      if (options?.worktree.available) {
        return setDialog({ kind: 'fork', thread, turnId, branch: options.worktree.branch ?? null, changes: options.worktree.changes ?? 0 });
      }
    }
    toast({ message: where === 'worktree' ? '正在新建工作树并分叉…' : '正在分叉…', busy: true });
    try {
      const copy = await api.forkThread(thread.id, { turnId, worktree: where === 'worktree' });
      onThreadOpen(copy);
      toast({ message: where === 'worktree' && copy.worktree ? `已分叉到新工作树，分支 ${copy.worktree.branch}` : '已分叉，现在在新线程里' });
    } catch (e) {
      toast(null);
      // The agent keeps its own record of the conversation. A turn it has no record of (one that
      // never reached it, say) is not a place its copy can stop.
      if (turnId && e instanceof Error && /own history|cannot stop a copy|whole conversation/.test(e.message)) {
        return toast({ message: '这一轮在 agent 自己的记录里对不上，没法从这里分叉；可以从最后一条回答分叉整个线程' });
      }
      onError(e);
    }
  };

  const run = (action: ThreadAction, thread: Thread) => {
    switch (action) {
      case 'fork':
        return void fork(thread);
      case 'rename':
        return setDialog({ kind: 'rename', thread });
      case 'pin':
        return void patch(thread, { pinned: !thread.pinned });
      case 'archive':
        return void patch(thread, { archived: true }, () =>
          toast({ message: '已归档', action: { label: '撤销', run: () => void patch(thread, { archived: false }) } }),
        );
      case 'restore':
        return void patch(thread, { archived: false }, () => toast({ message: '已恢复' }));
      case 'delete':
        return setDialog({ kind: 'delete', thread });
    }
  };

  const copy = async (value: string | null | Promise<string>, what: string) => {
    try {
      const text = await value;
      if (!text) return;
      toast({ message: (await copyText(text)) ? `已复制${what}` : '复制失败，请手动选中文字复制' });
    } catch (e) {
      onError(e);
    }
  };

  const threadItems = (thread: Thread): MenuEntry[] => {
    const filed = sections.some((s) => s.id === thread.sectionId);
    const linkedTodoIds = new Set(todos.filter((t) => t.threads.some((it) => it.id === thread.id)).map((t) => t.id));
    const planChoices = todos.filter((t) => !t.parentId).slice(0, 30);
    return [
      { id: 'terminal', label: '打开终端', icon: IconTerminal, onSelect: onOpenTerminal },
      { id: 'rename', label: '重命名', icon: IconEdit, onSelect: () => run('rename', thread) },
      { id: 'pin', label: thread.pinned ? '取消置顶' : '置顶', icon: IconPin, onSelect: () => run('pin', thread) },
      {
        id: 'unread',
        label: thread.unread ? '标记为已读' : '标记为未读',
        icon: IconDot,
        onSelect: () => void patch(thread, { unread: !thread.unread }, thread.unread ? undefined : () => onMarkedUnread(thread)),
      },
      'separator',
      {
        id: 'section',
        label: '移到分区',
        icon: IconList,
        submenu: [
          ...sections.map((s) => ({
            id: `section-${s.id}`,
            label: s.name,
            checked: s.id === thread.sectionId,
            onSelect: () => void patch(thread, { sectionId: s.id === thread.sectionId ? null : s.id }),
          })),
          ...(filed ? [{ id: 'unfile', label: '移出分区', onSelect: () => void patch(thread, { sectionId: null }) }] : []),
          ...(sections.length ? (['separator'] as MenuEntry[]) : []),
          { id: 'new-section', label: '新建分区…', icon: IconPlus, onSelect: () => setDialog({ kind: 'new-section', thread }) },
        ],
      },
      {
        id: 'todo',
        label: '关联到计划',
        icon: IconCheck,
        disabled: planChoices.length === 0,
        submenu: [
          ...planChoices.map((t) => ({
            id: `todo-${t.id}`,
            label: t.text,
            checked: linkedTodoIds.has(t.id),
            onSelect: () =>
              void guard(async () => {
                if (!api) return;
                if (linkedTodoIds.has(t.id)) await api.unlinkTodo(t.id, thread.id);
                else await api.linkTodo(t.id, thread.id);
                onTodosChange();
              }),
          })),
          ...(planChoices.length ? (['separator'] as MenuEntry[]) : []),
          {
            id: 'new-todo',
            label: '新建计划…',
            icon: IconPlus,
            onSelect: () =>
              void guard(async () => {
                if (!api) return;
                const todo = await api.createTodo(thread.title || folderName(thread.cwd));
                await api.linkTodo(todo.id, thread.id);
                onTodosChange();
              }),
          },
        ],
      },
      {
        id: 'copy',
        label: '复制',
        icon: IconCopy,
        submenu: [
          { id: 'copy-md', label: '整段对话（Markdown）', onSelect: () => void copy(markdownOf(thread), '对话') },
          {
            id: 'copy-resume',
            label: '终端恢复命令',
            disabled: !thread.resumeCommand,
            onSelect: () => void copy(thread.resumeCommand, '恢复命令'),
          },
          {
            id: 'copy-id',
            label: '会话 ID',
            disabled: !thread.agentSessionId,
            onSelect: () => void copy(thread.agentSessionId, '会话 ID'),
          },
          { id: 'copy-cwd', label: '工作目录', onSelect: () => void copy(thread.cwd, '工作目录') },
        ],
      },
      ...(agents.find((a) => a.id === thread.agent)?.capabilities.fork
        ? [{ id: 'fork', label: '分叉', icon: IconFork, disabled: forkBlocked(thread) !== null, onSelect: () => run('fork', thread) }]
        : []),
      { id: 'handover', label: '交接', icon: IconHand, onSelect: () => setDialog({ kind: 'handover', thread }) },
      'separator',
      thread.archivedAt
        ? { id: 'restore', label: '恢复', icon: IconArchive, onSelect: () => run('restore', thread) }
        : { id: 'archive', label: '归档', icon: IconArchive, onSelect: () => run('archive', thread) },
      { id: 'delete', label: '永久删除', icon: IconTrash, danger: true, onSelect: () => run('delete', thread) },
    ];
  };

  const sectionItems = (section: Section): MenuEntry[] => [
    { id: 'rename', label: '重命名分区', icon: IconEdit, onSelect: () => setDialog({ kind: 'rename-section', section }) },
    { id: 'delete', label: '删除分区', icon: IconTrash, danger: true, onSelect: () => setDialog({ kind: 'delete-section', section }) },
  ];

  const close = () => setDialog(null);
  const guard = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (e) {
      onError(e);
    }
    close();
  };

  const removeThread = async (thread: Thread, opts: { agentSession: boolean; worktree: boolean; force?: boolean }) => {
    if (!api) return;
    try {
      await api.deleteThread(thread.id, opts);
      onThreadRemove(thread.id);
      toast({ message: opts.worktree ? '已删除，工作树和分支也删了' : '已删除' });
    } catch (e) {
      const details = e instanceof ApiError ? e.details : {};
      // Nothing has been deleted in either case; the thread is still there to decide about.
      if (details.code === 'worktree_dirty') {
        return setDialog({ kind: 'delete-worktree', thread, agentSession: opts.agentSession, changes: Number(details.changes) || 0, commits: Number(details.commits) || 0 });
      }
      if (details.code === 'worktree_shared') toast({ message: '还有别的线程在用这个工作树，什么都没删。先删那些线程，或者不勾选删除工作树' });
      else onError(e);
    }
    close();
  };

  let dialogNode: ReactNode = null;
  if (dialog && api) {
    if (dialog.kind === 'rename') {
      const { thread } = dialog;
      dialogNode = (
        <Dialog
          title="重命名线程"
          input={{ initial: thread.title, label: '线程名称' }}
          confirmLabel="保存"
          onConfirm={(title) => void guard(async () => onThreadChange(await api.updateThread(thread.id, { title: title ?? thread.title })))}
          onCancel={close}
        />
      );
    } else if (dialog.kind === 'delete') {
      const { thread } = dialog;
      const agent = agents.find((a) => a.id === thread.agent);
      const canDeleteSession = Boolean(agent?.capabilities.deleteSession && thread.agentSessionId);
      const tree = thread.worktree ?? null;
      // The checkboxes that apply, in the order they are shown.
      const extras = [
        ...(canDeleteSession
          ? [{ id: 'session', label: `同时删除 ${agent?.label ?? thread.agent} 里的会话`, hint: '删除后在终端里也无法继续这次对话' }]
          : []),
        ...(tree ? [{ id: 'worktree', label: '同时删除工作树和分支', hint: `${tree.branch}，在 ${folderName(tree.of)}/.worktrees 下` }] : []),
      ];
      dialogNode = (
        <Dialog
          title="永久删除这个线程？"
          message={`“${thread.title}” 在这里的记录和图片会被删除，无法恢复。${agent?.label ?? thread.agent} 自己保存的会话默认不动，还能在终端里继续。${tree ? '工作树里的文件默认也不动。' : ''}`}
          options={extras}
          confirmLabel="永久删除"
          danger
          onConfirm={(_, checked) => {
            const picked = (id: string) => checked[extras.findIndex((x) => x.id === id)] === true;
            void removeThread(thread, { agentSession: picked('session'), worktree: picked('worktree') });
          }}
          onCancel={close}
        />
      );
    } else if (dialog.kind === 'delete-worktree') {
      const { thread, agentSession, changes, commits } = dialog;
      const left = [changes > 0 && `${changes} 个文件没有提交`, commits > 0 && `${commits} 个提交只在这个分支上`].filter(Boolean).join('，');
      dialogNode = (
        <Dialog
          title="工作树里还有没存到别处的东西"
          message={`${left}。连工作树一起删除后，这些就找不回来了。`}
          confirmLabel="仍然删除"
          danger
          onConfirm={() => void removeThread(thread, { agentSession, worktree: true, force: true })}
          onCancel={close}
        />
      );
    } else if (dialog.kind === 'fork') {
      const { thread, turnId, branch, changes } = dialog;
      const carried = changes > 0 ? `，${changes} 个没提交的改动一起带过去` : '';
      dialogNode = (
        <ChoiceDialog
          title="从这里分叉"
          choices={[
            { id: 'here', icon: <IconFork size={18} />, label: '在当前目录分叉', hint: '和原线程用同一份文件' },
            {
              id: 'worktree',
              icon: <IconWorktree size={18} />,
              label: '在新工作树分叉',
              hint: `从${branch ? ` ${branch} ` : '当前提交'}新开一个分支和一份文件${carried}`,
            },
          ]}
          onPick={(id) => {
            close();
            void fork(thread, turnId, id === 'worktree' ? 'worktree' : 'here');
          }}
          onCancel={close}
        />
      );
    } else if (dialog.kind === 'new-section') {
      const { thread } = dialog;
      dialogNode = (
        <Dialog
          title="新建分区"
          message="分区是你自己起名的分组，比如一个需求或一个阶段。"
          input={{ initial: '', label: '分区名称' }}
          confirmLabel="创建"
          onConfirm={(name) =>
            void guard(async () => {
              const section = await api.createSection(name ?? '');
              if (thread) onThreadChange(await api.updateThread(thread.id, { sectionId: section.id }));
              onSectionsChange();
            })
          }
          onCancel={close}
        />
      );
    } else if (dialog.kind === 'rename-section') {
      const { section } = dialog;
      dialogNode = (
        <Dialog
          title="重命名分区"
          input={{ initial: section.name, label: '分区名称' }}
          confirmLabel="保存"
          onConfirm={(name) =>
            void guard(async () => {
              await api.renameSection(section.id, name ?? section.name);
              onSectionsChange();
            })
          }
          onCancel={close}
        />
      );
    } else if (dialog.kind === 'handover') {
      const { thread } = dialog;
      dialogNode = (
        <HandoverDialog api={api} thread={thread} onClose={close} />
      );
    } else {
      const { section } = dialog;
      dialogNode = (
        <Dialog
          title={`删除分区“${section.name}”？`}
          message="里面的线程不会被删除，会回到各自的项目下。"
          confirmLabel="删除分区"
          danger
          onConfirm={() =>
            void guard(async () => {
              await api.deleteSection(section.id);
              onSectionsChange();
            })
          }
          onCancel={close}
        />
      );
    }
  }

  const layer = (
    <>
      {menu && (
        <Menu
          label={'thread' in menu ? menu.thread.title : menu.section.name}
          x={menu.x}
          y={menu.y}
          items={'thread' in menu ? threadItems(menu.thread) : sectionItems(menu.section)}
          onClose={() => setMenu(null)}
        />
      )}
      {dialogNode}
    </>
  );

  return {
    openThreadMenu: (thread: Thread, x: number, y: number) => setMenu({ thread, x, y }),
    openSectionMenu: (section: Section, x: number, y: number) => setMenu({ section, x, y }),
    copyConversation: (thread: Thread) => void copy(markdownOf(thread), '对话'),
    newSection: () => setDialog({ kind: 'new-section', thread: null }),
    /** Forks so that the copy ends with the given turn. */
    forkAt: (thread: Thread, turnId: string) => void fork(thread, turnId),
    run,
    layer,
  };
}
