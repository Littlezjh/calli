// Limi plan items (the plan page) as the host hands them to views holding `worksource.read`.
// The text is content the user wrote, so it never travels with `events.summary` alone.

/**
 * What a linked thread's agent last said about an item, at the end of a turn:
 * - `doing`   — more work to do, e.g. waiting on CI.
 * - `review`  — the agent thinks it is done and asks the person to check.
 * - `blocked` — the agent cannot continue without the person.
 * Agents never mark an item done; only the person does.
 */
export type TodoReportStage = 'doing' | 'review' | 'blocked';

export interface TodoReport {
  stage: TodoReportStage;
  /** One line from the agent; may be empty. */
  note: string;
  /** The thread whose turn said it. */
  threadId: string;
  /** ISO time the turn ended. */
  at: string;
}

/** A top-level plan item. Sub-items are its checklist, folded into `items` and `threadIds`. */
export interface TodoSummary {
  id: string;
  text: string;
  done: boolean;
  doneAt: string | null;
  createdAt: string;
  /**
   * Threads linked to the item or to one of its open sub-items. May name threads the thread
   * list does not carry (archived, or on a team), which count as finished work.
   */
  threadIds: string[];
  /** Sub-items ticked off and in total; `{ done: 0, total: 0 }` without sub-items. */
  items: { done: number; total: number };
  /** Latest report from a linked thread's agent, cleared when the person ticks the item. */
  report: TodoReport | null;
}
