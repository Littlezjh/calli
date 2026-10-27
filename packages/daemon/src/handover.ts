import { replaceMessageTail, type StoredEvent } from './events.js';

/** Authoritative session coordinates, prepended regardless of how the progress summary was written. */
export function handoverContext(info: {
  threadId: string;
  title?: string;
  agentId: string;
  agentLabel: string;
  adapter: string;
  cwd: string;
  cwdReal: string;
  worktree?: { root: string; branch: string | null; main: string } | null;
  sessionId: string | null;
  configDir?: string;
  sessionPath?: string | null;
  resumeCommand: string | null;
}): string {
  const lines = [
    '# 交接信息', '',
    `- Agent 实例：${info.agentLabel}（实例 ID：${info.agentId}；类型：${info.adapter}）`,
    `- 项目工作目录（cwd）：${info.cwd}`,
    ...(info.cwdReal !== info.cwd ? [`- 工作目录真实路径：${info.cwdReal}`] : []),
    ...(info.worktree ? [
      `- 当前 worktree：${info.worktree.root}`,
      `- 当前分支：${info.worktree.branch ?? '游离 HEAD'}`,
      `- 主仓库（仅供定位）：${info.worktree.main}`,
    ] : []),
    `- Agent 配置/数据目录：${info.configDir ?? '未能确定'}`,
    `- Session ID：${info.sessionId ?? '尚未创建（还没有 agent 会话）'}`,
    `- Session 文件地址：${info.sessionPath ?? (info.sessionId ? '未找到实际会话文件；请使用上面的实例与 Session ID 定位' : '尚未创建')}`,
    `- Hub 线程 ID：${info.threadId}`, '',
    '## 只读查阅来源历史', '',
    '以下命令只在 hub 里新建的接手会话中可用。',
    `- 来源 Session ID：${info.sessionId ?? '尚未创建'}；来源简介：${info.title ?? '未命名任务'}（进度见交接摘要）。`,
    '- `calli handover`：查看本线程及逐级来源的会话信息。',
    `- \`calli history ${info.threadId}\`：查看历史；翻页和全文续读按返回的 nextCursor 和 command 继续，参数见 \`calli --help\`。`,
    '', '## 接手要求', '',
    '请直接接着完成任务，将命令执行和文件操作的工作目录设为上面的 cwd。原线程使用 worktree 时，沿用同一个 worktree、当前分支及未提交改动，不要切回主仓库或另建 worktree。',
    '动手前先核对现状：用 `git status`、`git diff` 和最近的提交确认工作区，与交接摘要对照。原 agent 可能在一轮中途被切断，摘要可能不全，也可能有改到一半的文件。',
    '再跑项目自带的初始化或检查命令（如 `init.sh`，或 README、AGENTS.md 里写的测试命令），确认现状能跑。发现坏的先修好，再接着做摘要里的下一步。',
    '使用你自己的 agent 会话继续工作；上面的原 agent 实例、配置目录和 Session ID 用于只读查阅原始历史。不要要求用户重新配置工作目录或手动新开会话。',
    '多个同类 agent 使用各自的配置/数据目录，读取历史时请按实例和 Session ID 定位。',
  ];
  if (info.resumeCommand) lines.push('', '## 原 agent 的恢复命令（仅供参考，接手无需执行）', '', info.resumeCommand);
  return lines.join('\n');
}

/**
 * Handing a thread's task to another agent: the current agent writes a summary for its successor
 * while it still can (it knows its own context best), and when that is no longer possible — the
 * quota ran out, the agent is gone — the hub writes one from the event log, which holds every
 * turn, tool call and diff anyway. The summary is text for a person to give to a successor;
 * the hub does not create that thread or leave files behind.
 */

/** The prompt the current agent is asked to answer in its own session. */
export function handoverPrompt(targetLabel: string): string {
  return [
    `请写一份交接摘要，交给另一个 agent（${targetLabel}）接手这个任务继续做。`,
    '它会读你写的摘要，但看不到这段对话，也不要假设它了解任何背景。',
    '用 Markdown，包含这些小节：',
    '## 任务 — 用户想做什么，一两句话',
    '## 已完成 — 到现在为止做成了什么',
    '## 未完成 / 下一步 — 还剩什么，建议从哪里继续',
    '## 改过的文件 — 哪些文件动过、为什么',
    '## 验证情况 — 跑过哪些测试或检查、结果如何；哪些改动还没验证；有没有改到一半、现在跑不通的文件',
    '## 关键决定和注意事项 — 容易踩的坑、用户特别提过的要求',
    '每节几行即可，整体不超过 30 行：对方可以自己查阅原对话，细节不必复述。',
    '直接输出摘要本身，不要寒暄，也不要解释你在做什么。',
  ].join('\n');
}

/** What one diff-carrying tool event changed: paths, in order, without duplicates. */
function changedFiles(events: StoredEvent[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const ev of events) {
    if (!ev.type.startsWith('tool.')) continue;
    const content = (ev.data.content ?? []) as Array<Record<string, unknown>>;
    for (const item of content) {
      if (item.type !== 'diff' || typeof item.path !== 'string') continue;
      if (!seen.has(item.path)) {
        seen.add(item.path);
        paths.push(item.path);
      }
    }
  }
  return paths;
}

/** The assistant text of a stretch of events, joined from its fragments. */
export function turnMessage(events: StoredEvent[]): string {
  return events.reduce((text, event) => event.type === 'message.replace'
    ? replaceMessageTail(text, event.data)
    : event.type === 'message.delta' && typeof event.data.text === 'string' ? text + event.data.text : text, '');
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What the event log can say about a thread, leaving out the hub's own handover turns. */
function logFacts(events: StoredEvent[]) {
  // Hub-injected handover turns are not part of the conversation: not the user's asks, and not
  // where the thread's story ends. Imported terminal history is real conversation and stays.
  const handoverTurns = new Set(
    events.filter((e) => e.type === 'turn.started' && e.data.handover).map((e) => e.turnId as string),
  );
  const asks = events
    .filter((e) => e.type === 'turn.started' && !e.data.handover)
    .map((e) => String(e.data.displayText ?? e.data.text ?? '').trim())
    .filter(Boolean);
  const turnIds = [...new Set(events.filter((e) => e.turnId && !handoverTurns.has(e.turnId)).map((e) => e.turnId as string))];
  const lastTurnEvents = turnIds.length ? events.filter((e) => e.turnId === turnIds[turnIds.length - 1]) : [];
  const lastError = [...events].reverse().find((e) => e.type === 'turn.error');
  const lastFailed = lastTurnEvents.some((e) => e.type === 'turn.error');
  const plan = [...events].reverse().find((e) => e.type === 'plan.updated');
  return {
    asks,
    lastFailed,
    lastAnswer: turnMessage(lastTurnEvents).trim(),
    why: lastError ? [lastError.data.code, lastError.data.error].filter(Boolean).join('：') : '',
    plan: (plan?.data.entries ?? []) as Array<Record<string, unknown>>,
    files: changedFiles(events),
  };
}

/**
 * The summary the hub writes itself, from nothing but the event log. Sections the log cannot
 * answer are left out rather than guessed at; the successor is told to check the repository.
 */
export function synthesizeHandover(events: StoredEvent[], opts: { title: string; from: string; target: string }): string {
  const { asks, lastAnswer, why, plan, files } = logFacts(events);
  const lines: string[] = [`# 交接摘要（hub 从过程记录合成）`, '', `- 原线程：${opts.title}（${opts.from}）`, `- 接手：${opts.target}`, ''];

  if (asks.length) {
    lines.push('## 用户的要求');
    const shown = asks.slice(0, 5).map((a, i) => `${i + 1}. ${trunc(a, 300)}`);
    if (asks.length > 5) shown.push(`……共 ${asks.length} 轮，完整要求见原线程。`);
    lines.push(...shown, '');
  }
  if (files.length) {
    lines.push('## 改过的文件');
    lines.push(...files.slice(0, 30).map((f) => `- ${f}`), '');
  }
  if (plan.length) {
    lines.push('## 计划清单（最后一次更新）');
    lines.push(...plan.map((en) => `- [${en.status === 'completed' ? 'x' : ' '}] ${trunc(String(en.content ?? ''), 160)}`), '');
  }
  if (lastAnswer) {
    lines.push('## 最后的回答');
    lines.push(`> ${trunc(lastAnswer, 800).replace(/\n/g, '\n> ')}`, '');
  }
  if (why) lines.push('## 中断原因', why, '');
  lines.push('> 这份摘要由 hub 从过程记录自动合成，可能不全，也不知道哪些改动验证过。接手后先用 git status 和 git log 对齐现状，跑一遍项目的检查。');
  return lines.join('\n');
}

/**
 * The short handover for a successor the hub starts itself. It can read the source with `calli`,
 * so it gets where to look and how, plus a few lines of where things stood, not a retelling.
 */
export function handoverBrief(info: {
  threadId: string;
  from: string;
  cwd: string;
  worktree?: { root: string; branch: string | null } | null;
  lead?: boolean;
}): string {
  const place = info.worktree
    ? `${info.cwd}（worktree ${info.worktree.root}，分支 ${info.worktree.branch ?? '游离 HEAD'}）`
    : info.cwd;
  return [
    '# 接手',
    '',
    `你接手 ${info.from} 在 hub 线程 ${info.threadId} 里的任务，看不到原对话。需要时自己读（找不到 calli 就用 "$CALLI_BIN_DIR/calli"）：`,
    '- `calli handover`：来源会话信息',
    `- \`calli history ${info.threadId}\`：按轮读问答和工具调用，按返回的 command 翻页`,
    '',
    `工作目录 ${place}。沿用它和未提交的改动，先用 git status、git diff 对齐现状再继续。`,
    ...(info.lead ? ['', '你现在是本次协作的主控：成员的结果会投给你，用 `calli status` 查看成员和未交回的任务。'] : []),
  ].join('\n');
}

/** A few lines of where the thread stood, for the brief handover. The rest is in `calli history`. */
export function synthesizeBrief(events: StoredEvent[]): string {
  const { asks, lastFailed, lastAnswer, why, plan, files } = logFacts(events);
  // A failed last ask is carried over word for word after the brief; it is not repeated here.
  const ask = lastFailed ? asks.at(-2) : asks.at(-1);
  const open = plan.filter((en) => en.status !== 'completed').slice(0, 5);
  const lines = [
    ...(ask ? [`- 最近的要求：${trunc(ask.replace(/\s+/g, ' '), 200)}`] : []),
    ...(lastAnswer ? [`- 最后的回答：${trunc(lastAnswer.replace(/\s+/g, ' '), 300)}`] : []),
    ...(open.length ? [`- 未完成的计划：${open.map((en) => trunc(String(en.content ?? ''), 80)).join('；')}`] : []),
    ...(files.length ? [`- 改过的文件：${files.slice(0, 8).join('、')}${files.length > 8 ? ` 等 ${files.length} 个` : ''}`] : []),
    ...(why ? [`- 中断原因：${trunc(why, 160)}`] : []),
  ];
  return lines.length ? ['## 进度（hub 从记录整理，可能不全）', ...lines].join('\n') : '';
}
