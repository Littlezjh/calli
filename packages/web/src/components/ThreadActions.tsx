import { useState, type ReactNode } from 'react';
import type { AgentInfo, Api, Section, Thread } from '../api';
import { copyText } from '../clipboard';
import { Dialog } from './Dialog';
import { Menu, type MenuEntry } from './Menu';
import { IconArchive, IconCopy, IconDot, IconEdit, IconFork, IconList, IconPin, IconPlus, IconTrash } from './icons';
import type { ToastState } from './Toast';

interface Deps {
  api: Api | null;
  agents: AgentInfo[];
  sections: Section[];
  /** A thread changed. One that now has `archivedAt` should leave the sidebar. */
  onThreadChange: (thread: Thread) => void;
  onThreadRemove: (id: string) => void;
  /** A thread was made here and should be shown. */
  onThreadOpen: (thread: Thread) => void;
  /** The user marked a thread unread by hand. If it is the one on screen, it has to be left to stay unread. */
  onMarkedUnread: (thread: Thread) => void;
  /** Sections were added, renamed or removed: reload them (and the threads filed under them). */
  onSectionsChange: () => void;
  onError: (e: unknown) => void;
  toast: (t: ToastState | null) => void;
  /** The whole conversation as Markdown, for the copy menu. */
  markdownOf: (thread: Thread) => Promise<string>;
}

type MenuState = { x: number; y: number } & ({ thread: Thread } | { section: Section });

type DialogState =
  | { kind: 'rename'; thread: Thread }
  | { kind: 'delete'; thread: Thread }
  | { kind: 'new-section'; thread: Thread | null }
  | { kind: 'rename-section'; section: Section }
  | { kind: 'delete-section'; section: Section };

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
  const { api, agents, sections, onThreadChange, onThreadRemove, onThreadOpen, onMarkedUnread, onSectionsChange, onError, toast, markdownOf } = deps;
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

  // The agent copies its side of the conversation, which can take a few seconds.
  const fork = async (thread: Thread) => {
    if (!api) return;
    const blocked = forkBlocked(thread);
    if (blocked) return toast({ message: blocked });
    toast({ message: '正在分叉…', busy: true });
    try {
      onThreadOpen(await api.forkThread(thread.id));
      toast({ message: '已分叉，现在在新线程里' });
    } catch (e) {
      toast(null);
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
    return [
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
      dialogNode = (
        <Dialog
          title="永久删除这个线程？"
          message={`“${thread.title}” 在这里的记录和图片会被删除，无法恢复。${agent?.label ?? thread.agent} 自己保存的会话默认不动，还能在终端里继续。`}
          option={
            canDeleteSession
              ? { label: `同时删除 ${agent?.label ?? thread.agent} 里的会话`, hint: '删除后在终端里也无法继续这次对话' }
              : undefined
          }
          confirmLabel="永久删除"
          danger
          onConfirm={(_, agentSession) =>
            void guard(async () => {
              await api.deleteThread(thread.id, { agentSession });
              onThreadRemove(thread.id);
              toast({ message: '已删除' });
            })
          }
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
    run,
    layer,
  };
}
