/**
 * With the board's `progress.report` granted, agents say where their thread stands in one
 * protocol line at the end of a turn: `[进度] 待验收：说明`. The line stays in the reply the person
 * reads; the hub only reads it back. Agents can say the work needs more time, needs the person,
 * or is ready to check — never that it is done: the person marks that.
 */

import type { InjectionGate } from './injections.js';

/** `backlog` is the person's alone: agents cannot report it (see STAGES). */
export type ProgressStage = 'doing' | 'review' | 'blocked' | 'backlog';
export const PROGRESS_STAGES: readonly ProgressStage[] = ['backlog', 'doing', 'review', 'blocked'];

export interface ProgressReport {
  stage: ProgressStage;
  note: string;
  at: string;
  /** Set when the person placed the thread from its menu rather than the agent reporting. */
  by?: 'user';
  /**
   * Set by `等外部`: the thread waits on an external event nobody has to tend (CI, a deployment,
   * another session). The stage stays `doing` — the board shows it as work under way.
   */
  wait?: { what: string; minutes?: number };
}

/** Protocol words agents write; not translated. */
const STAGES: Record<string, ProgressStage> = { 进行中: 'doing', 待验收: 'review', 需要你: 'blocked', 等外部: 'doing' };
const LINE = /^\s*[*_`>-]*\s*\[进度\]\s*(进行中|待验收|需要你|等外部)\s*(?:[:：\-—]\s*)?(.*?)[*_`\s]*$/;
const MAX_NOTE = 200;
/** "约 10 分钟", "1 小时", "5 min" — the first duration the note names, in minutes. */
const DURATION = /(\d+(?:\.\d+)?)\s*(分钟|分(?!钟)|min(?:ute)?s?|小时|时|hours?)/i;
const MINUTES_PER: Record<string, number> = { 分钟: 1, 分: 1, min: 1, mins: 1, minute: 1, minutes: 1, 小时: 60, 时: 60, h: 60, hour: 60, hours: 60 };
/** A duration clause at the very end of the note: "等 CI 跑完，约 10 分钟" waits for "等 CI 跑完". */
const TRAILING_DURATION = /[,，、;；]?\s*(?:约|大约|大概)?\s*\d+(?:\.\d+)?\s*(?:分钟|分(?!钟)|min(?:ute)?s?|小时|时|hours?)\s*(?:左右|之?后)?\s*$/;

/** What an `等外部` note says: the thing it waits for, and how long it said that would take. */
function parseWait(note: string): { what: string; minutes?: number } {
  const found = DURATION.exec(note);
  const per = found ? MINUTES_PER[found[2].toLowerCase()] ?? MINUTES_PER[found[2]] : undefined;
  const minutes = found && per ? Math.round(Number(found[1]) * per) : undefined;
  const what = note.replace(TRAILING_DURATION, '').trim() || note;
  return { what, ...(minutes && minutes > 0 ? { minutes } : {}) };
}

/** The last progress line in a turn's answer, or null when the agent did not write one. */
export function parseProgress(answer: string): { stage: ProgressStage; note: string; wait?: { what: string; minutes?: number } } | null {
  let found: { stage: ProgressStage; note: string; wait?: { what: string; minutes?: number } } | null = null;
  for (const line of answer.split('\n')) {
    const match = LINE.exec(line);
    if (match) {
      const note = match[2].trim().slice(0, MAX_NOTE);
      found = { stage: STAGES[match[1]], note, ...(match[1] === '等外部' ? { wait: parseWait(note) } : {}) };
    }
  }
  return found;
}

/** Appended to what the person sent, the way collaboration appends its own; never shown to them. */
const MARK = '<calli-progress>';
/** The mark from before the rename to Calli, still in older messages. */
const LEGACY_MARK = '<limi-progress>';
const BLOCK = `${MARK}\n本轮结束时，在回复最后单独写一行进度：\n[进度] 进行中|待验收|需要你|等外部：一句话说明\n进行中：还有工作要做；待验收：你认为已经做完，请用户检查；需要你：没有用户就无法继续；等外部：在等不需要用户的外部事件（CI、部署、另一个会话），写明等什么、大约多久。是否完成由用户确认，不要说已完成。\n</calli-progress>`;

/** `gate` leaves the block out when the agent has it in view already. */
export function progressInstructions(text: string, gate?: InjectionGate): string {
  if (text.includes(MARK) || text.includes(LEGACY_MARK) || gate?.('progress', BLOCK) === false) return text;
  return `${text}\n\n${BLOCK}`;
}
