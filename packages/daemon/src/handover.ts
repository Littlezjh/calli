import type { StoredEvent } from './events.js';

/**
 * Handing a thread's task to another agent: the current agent writes a summary for its successor
 * while it still can (it knows its own context best), and when that is no longer possible — the
 * quota ran out, the agent is gone — the hub writes one from the event log, which holds every
 * turn, tool call and diff anyway. The summary is text for a person to paste into a new thread;
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
    '## 关键决定和注意事项 — 容易踩的坑、用户特别提过的要求',
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
  return events
    .filter((e) => e.type === 'message.delta' && typeof e.data.text === 'string')
    .map((e) => e.data.text)
    .join('');
}

const trunc = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * The summary the hub writes itself, from nothing but the event log. Sections the log cannot
 * answer are left out rather than guessed at; the successor is told to check the repository.
 */
export function synthesizeHandover(events: StoredEvent[], opts: { title: string; from: string; target: string }): string {
  // Hub-injected handover turns are not part of the conversation: not the user's asks, and not
  // where the thread's story ends. Imported terminal history is real conversation and stays.
  const handoverTurns = new Set(
    events.filter((e) => e.type === 'turn.started' && e.data.handover).map((e) => e.turnId as string),
  );
  const asks = events
    .filter((e) => e.type === 'turn.started' && !e.data.handover)
    .map((e) => String(e.data.text ?? '').trim())
    .filter(Boolean);

  const turnIds = [...new Set(events.filter((e) => e.turnId && !handoverTurns.has(e.turnId)).map((e) => e.turnId as string))];
  const lastTurnEvents = turnIds.length ? events.filter((e) => e.turnId === turnIds[turnIds.length - 1]) : [];
  const lastAnswer = trunc(turnMessage(lastTurnEvents).trim(), 800);
  const lastError = [...events].reverse().find((e) => e.type === 'turn.error');
  const plan = [...events].reverse().find((e) => e.type === 'plan.updated');
  const files = changedFiles(events).slice(0, 30);

  const lines: string[] = [`# 交接摘要（hub 从过程记录合成）`, '', `- 原线程：${opts.title}（${opts.from}）`, `- 接手：${opts.target}`, ''];

  if (asks.length) {
    lines.push('## 用户的要求');
    const shown = asks.slice(0, 5).map((a, i) => `${i + 1}. ${trunc(a, 300)}`);
    if (asks.length > 5) shown.push(`……共 ${asks.length} 轮，完整要求见原线程。`);
    lines.push(...shown, '');
  }
  if (files.length) {
    lines.push('## 改过的文件');
    lines.push(...files.map((f) => `- ${f}`), '');
  }
  if (plan) {
    const entries = (plan.data.entries ?? []) as Array<Record<string, unknown>>;
    if (entries.length) {
      lines.push('## 计划清单（最后一次更新）');
      lines.push(
        ...entries.map((en) => {
          const done = en.status === 'completed';
          return `- [${done ? 'x' : ' '}] ${trunc(String(en.content ?? ''), 160)}`;
        }),
        '',
      );
    }
  }
  if (lastAnswer) {
    lines.push('## 最后的回答');
    lines.push(`> ${lastAnswer.replace(/\n/g, '\n> ')}`, '');
  }
  if (lastError) {
    const why = [lastError.data.code, lastError.data.error].filter(Boolean).join('：');
    if (why) lines.push('## 中断原因', String(why), '');
  }
  lines.push('> 这份摘要由 hub 从过程记录自动合成，可能不全。接手后先读目录里的代码和 git log 对齐现状。');
  return lines.join('\n');
}
