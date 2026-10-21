import type { MemoryDocument, MemoryFile, MemorySource } from '@rah/extension-api';
import type { Coordination, Thread } from '../../web/src/api';
import type { DemoData } from '../../web/src/demo/data';
import type { StoredEvent } from '../../web/src/timeline';

export const TEAM_ID = 'showcase-team';
export const MEMBER_IDS = ['showcase-builder', 'showcase-reviewer'];
export const MEMBER_TASKS = ['实现设置页深色模式，覆盖跟随系统、手动切换与刷新后恢复。', '独立审查深色模式的状态保存、键盘操作和手机布局，返回问题与验收结论。'];
export const MEMBER_RESULTS = ['已补上主题切换与偏好保存，三个示例检查通过。请主控继续验收。', '已核对状态恢复、键盘选择与手机布局；本次示例审查未发现阻塞问题。'];

/** Fictional workspace only; never reads the visitor's agents, files or memory. */
export function addExamples(data: DemoData): Coordination {
  const at = new Date().toISOString();
  const base = data.threads[0];
  const thread = (id: string, title: string, agent: string, extra: Partial<Thread> = {}): Thread => ({
    ...structuredClone(base), id, title, agent, status: 'idle', workMode: 'execute', model: null, effort: null,
    agentSessionId: null, sectionId: null, pinned: false, unread: false, waiting: false,
    waitingReason: null, runningSince: null, preview: null, queued: [], doneAt: null, report: null,
    createdAt: at, updatedAt: at, ...extra,
  });
  const lead = thread(TEAM_ID, '协作：为设置页添加深色模式', 'claude');
  const members = MEMBER_IDS.map((id, i) => thread(id, i ? '独立审查深色模式' : '实现设置页深色模式', i ? 'pi' : 'codex', {
    coordination: { rootId: TEAM_ID, children: 0, paused: false, doing: MEMBER_TASKS[i] },
  }));
  const cards = [
    thread('showcase-progress', '优化商品搜索速度', 'codex', { report: { stage: 'doing', note: '索引改造已提交，正在等示例基准测试结果。', at } }),
    thread('showcase-blocked', '确认上线时段', 'claude', { report: { stage: 'blocked', note: '请确认今晚还是明早上线，之后继续整理发布步骤。', at } }),
    thread('showcase-review', '修复购物车数量显示', 'codex', { unread: true, report: { stage: 'review', note: '示例测试通过，请检查手机布局后勾选完成。', at } }),
    thread('showcase-done', '更新项目安装说明', 'pi', { doneAt: at }),
  ];
  data.threads.push(lead, ...members, ...cards);
  for (const t of [lead, ...members, ...cards]) {
    const created: StoredEvent = { threadId: t.id, turnId: null, seq: 1, ts: at, type: 'thread.created', data: {} };
    data.events[t.id] = [created];
    if (cards.includes(t)) data.events[t.id].push(
      { ...created, seq: 2, turnId: `sample-${t.id}`, type: 'turn.started', data: { text: t.title } },
      { ...created, seq: 3, turnId: `sample-${t.id}`, type: 'message.delta', data: { text: t.report?.note ?? '安装步骤已整理，用户已验收。这是虚构的示例会话。' } },
      { ...created, seq: 4, turnId: `sample-${t.id}`, type: 'turn.done', data: { stopReason: 'end_turn' } },
    );
  }
  return { rootId: TEAM_ID, paused: false, directories: [lead.cwd], agents: ['claude', 'codex', 'pi'], messages: [],
    members: members.map((t, i) => ({ id: t.id, name: i ? 'pi 审查' : 'Codex 实现', thread: t, latest: null })),
  };
}

export function memoryExamples(): { sources: MemorySource[]; files: MemoryFile[]; documents: MemoryDocument[] } {
  const at = new Date().toISOString();
  const entries = [
    { id: 'sample-preferences', path: 'preferences.md', kind: 'durable' as const, title: '项目偏好：简单、清楚、手机优先', excerpt: '优先使用现有组件；重要异常直接显示，详情按需展开。', text: '# 项目偏好：简单、清楚、手机优先\n\n这是一条虚构记忆，用来体验只读查看。\n\n- 优先复用现有组件，保持颜色和间距一致。\n- 重要异常直接显示，详情按需展开。\n- 界面改动同时检查桌面、手机和亮暗模式。\n\n记忆由 agent 自己维护；Limi 展示已有内容，不生成或跨 agent 同步。' },
    { id: 'sample-summary', path: 'summaries/theme.md', kind: 'summary' as const, title: '设置页主题改造', excerpt: '主题支持系统、浅色、深色三种选择；刷新后恢复偏好。', text: '# 设置页主题改造\n\n示例项目使用一个主题入口，统一更新页面颜色。\n\n1. 默认跟随系统。\n2. 手动选择后保存偏好。\n3. 刷新页面恢复选择。\n\n这是虚构的会话摘要。' },
    { id: 'sample-evidence', path: 'evidence/mobile-check.md', kind: 'evidence' as const, title: '手机菜单检查记录', excerpt: '检查选项是否在视口内，以及触摸选择、关闭和刷新。', text: '# 手机菜单检查记录\n\n虚构的检查记录：\n\n- 三个主题选项都能看到。\n- 选择浅色后立即更新。\n- 刷新页面后保留选择。\n\n这份示例不代表你自己的项目通过了检查。' },
  ];
  return {
    sources: [{ id: 'sample-codex', agents: [{ id: 'codex', label: 'Codex · 示例记忆' }] }],
    files: entries.map(({ text, ...f }) => ({ ...f, bytes: new TextEncoder().encode(text).length, modifiedAt: at })),
    documents: entries.map(({ id, text }) => ({ id, text, modifiedAt: at, truncated: false })),
  };
}

/** These accounts and sessions exist only in the website's memory. */
export function handoverExample(): { source: Thread; successor: Thread } {
  const at = new Date().toISOString();
  const source: Thread = {
    id: 'sample-handover-source', agent: 'claude', title: 'handover', cwd: '/sample/project',
    agentSessionId: null, status: 'idle', pinned: false, permissionMode: 'full_access', model: 'Opus', effort: null,
    terminalActivity: false, waiting: false, resumeCommand: '', cwdReal: '/sample/project',
    archivedAt: null, sectionId: null, forkedFrom: null, unread: false, preview: null, schedule: null,
    doneAt: null, createdAt: at, updatedAt: at, queued: [],
    autoHandover: { enabled: true, source: 'thread', override: true },
  };
  return { source, successor: { ...source, id: 'sample-handover-successor', agent: 'sample-claude-2',
    handover: { sourceId: source.id, agent: source.agent, title: source.title } } };
}
