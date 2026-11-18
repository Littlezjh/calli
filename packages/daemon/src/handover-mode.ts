import type { DatabaseSync } from 'node:sqlite';

export type HandoverMode = 'continue' | 'branch';
export interface HandoverLink {
  sourceId: string;
  title: string;
  agent: string;
  mode?: HandoverMode;
  /** The user split an automatic continuation back into independent conversations. */
  detached?: boolean;
  /** Source event boundary at creation; sequence numbers avoid equal timestamp ambiguity. */
  sourceSeq?: number;
  /** How the work was carried over: the source's session copied as it was, or a written summary. */
  method?: 'resume' | 'summary';
}

/**
 * The thread went back to an older conversation: `sourceId` is the chain head that handed it over,
 * `afterSeq` the last event of this thread before the return prompt. Events up to `afterSeq` are the
 * thread's own earlier part of the chain; later ones are the part after the return.
 */
export interface HandbackLink {
  sourceId: string;
  afterSeq: number;
  /** The last event of the thread that handed over, at the return: what follows it stays out of the chain's reading. */
  sourceSeq: number;
  at: string;
}

/** Whether the source started a turn after the handover: from then on the two go their own ways. */
export function handoverSourceMoved(db: DatabaseSync, link: HandoverLink, createdAt: string): boolean {
  return Boolean(link.sourceSeq === undefined
    ? db.prepare("SELECT 1 FROM events WHERE thread_id=? AND type='turn.started' AND ts>? LIMIT 1").get(link.sourceId, createdAt)
    : db.prepare("SELECT 1 FROM events WHERE thread_id=? AND type='turn.started' AND seq>? LIMIT 1").get(link.sourceId, link.sourceSeq));
}

/**
 * Derive the display relation from facts without rewriting stored links. A continuation stays one
 * while the source goes on by itself: its own later turns are follow-ups (see `handoverFollowups`),
 * they do not split it from the chain.
 */
export function effectiveHandoverMode(link: HandoverLink): HandoverMode {
  return link.mode !== 'continue' || link.detached ? 'branch' : 'continue';
}

/**
 * How many turns the source took on its own after a continuation was made from it, up to the point
 * it returned to the chain (`until`, exclusive) when it did. The merged reading leaves them out and
 * says so; a hub-started turn (a summary, a teammate's delivery) is not one.
 */
export function handoverFollowups(db: DatabaseSync, link: HandoverLink, createdAt: string, until?: number): number {
  const after = link.sourceSeq;
  const rows = after === undefined
    ? db.prepare("SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND type='turn.started' AND ts>? AND json_extract(data, '$.handover') IS NULL AND json_extract(data, '$.coordination') IS NULL AND json_extract(data, '$.background') IS NULL").get(link.sourceId, createdAt)
    : db.prepare("SELECT COUNT(*) AS n FROM events WHERE thread_id=? AND type='turn.started' AND seq>? AND seq<? AND json_extract(data, '$.handover') IS NULL AND json_extract(data, '$.coordination') IS NULL AND json_extract(data, '$.background') IS NULL").get(link.sourceId, after, until ?? Number.MAX_SAFE_INTEGER);
  return Number(rows?.n ?? 0);
}
