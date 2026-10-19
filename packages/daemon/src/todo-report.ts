/**
 * Agents working on a plan item say where it stands in one protocol line at the end of a turn:
 * `[计划状态] 待验收：说明`. The line stays in the reply the person reads; the hub only reads it
 * back. Agents can say an item needs more work, needs the person, or is ready to check — never
 * that it is done: the person ticks it.
 */

export type TodoReportStage = 'doing' | 'review' | 'blocked';

export interface TodoReport {
  stage: TodoReportStage;
  note: string;
  threadId: string;
  at: string;
}

/** Protocol words agents write; not translated. */
const STAGES: Record<string, TodoReportStage> = { 进行中: 'doing', 待验收: 'review', 需要你: 'blocked' };
const LINE = /^\s*[*_`>-]*\s*\[计划状态\]\s*(进行中|待验收|需要你)\s*(?:[:：\-—]\s*)?(.*?)[*_`\s]*$/;
const MAX_NOTE = 200;
const MAX_ITEM = 120;

/** The last report line in a turn's answer, or null when the agent did not write one. */
export function parseTodoReport(answer: string): { stage: TodoReportStage; note: string } | null {
  let found: { stage: TodoReportStage; note: string } | null = null;
  for (const line of answer.split('\n')) {
    const match = LINE.exec(line);
    if (match) found = { stage: STAGES[match[1]], note: match[2].trim().slice(0, MAX_NOTE) };
  }
  return found;
}

const clip = (text: string) => (text.length > MAX_ITEM ? `${text.slice(0, MAX_ITEM)}…` : text);

/**
 * Appended to what the person sent in a thread linked to open plan items, the way collaboration
 * appends its own. `items` are the items' texts, a sub-item as `plan › sub-item`.
 */
export function todoInstructions(text: string, items: string[]): string {
  if (!items.length || text.includes('<limi-plan>')) return text;
  const names = items.map((item) => `「${clip(item)}」`).join('、');
  return `${text}\n\n<limi-plan>\n这个线程在做计划项${names}。本轮结束时，在回复最后单独写一行进度：\n[计划状态] 进行中|待验收|需要你：一句话说明\n进行中：还有工作要做；待验收：你认为已经做完，请用户检查；需要你：没有用户就无法继续。是否完成由用户确认，不要说已完成。\n</limi-plan>`;
}
