import type { Todo } from './api';
import { formatDate, formatTime, t } from './i18n';

/** Where a matter sits on the desk: someone waits on you, you are on it, it waits on others, it can wait. */
export type Lane = 'you' | 'doing' | 'wait' | 'later';
export const LANES: Lane[] = ['you', 'doing', 'wait', 'later'];

/** What the desk reads from a plan. `lane` and `notePreview` come from the daemon when it has them. */
export type DeskTodo = Todo & { lane?: Lane | null; notePreview?: string | null; updatedAt?: string };

/** One matter with the material stacked under it. */
export interface Pile {
  todo: DeskTodo;
  children: DeskTodo[];
  lane: Lane;
  /** Whether the lane came from the person, not from the dates. */
  pinned: boolean;
  /** Whole days since anything happened to it. */
  idleDays: number;
  /** Cards it would spread into: the note, each sub-item list, each thread, each proposal. */
  cards: number;
  /** Due by the end of today, or already past. */
  dueSoon: boolean;
  overdue: boolean;
}

export interface Desk {
  lanes: Record<Lane, Pile[]>;
  /** Suggestions an agent made that the person has not taken yet. */
  inbox: DeskTodo[];
  /** The few to do first: the head of the "you" lane. */
  first: Pile[];
  week: WeekDay[];
  doneThisWeek: number;
  /** Open matters untouched for three days or more, outside "later". */
  stale: number;
}

export interface WeekDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  /** Matters finished that day; null for days still ahead. */
  done: number | null;
}

const DAY = 86_400_000;
const endOfDay = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
const localDate = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;

/** The last time anything happened to a plan that the list can see. */
export function lastActivity(todo: DeskTodo): number {
  const times = [todo.updatedAt ?? todo.createdAt, todo.noteUpdatedAt, todo.doneAt, ...todo.threads.map((th) => th.updatedAt)]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => Date.parse(v))
    .filter(Number.isFinite);
  return Math.max(0, ...times);
}

/**
 * The lane a plan falls in. A lane the person set wins; otherwise a plan waiting on someone waits,
 * one due by tonight or asking to be confirmed needs you, a paused follow-up can wait, and the rest
 * is in hand.
 */
export function laneOf(todo: DeskTodo, now = new Date()): Lane {
  if (todo.lane && LANES.includes(todo.lane)) return todo.lane;
  if (todo.state === 'waiting') return 'wait';
  if (todo.dueAt && Date.parse(todo.dueAt) < endOfDay(now)) return 'you';
  if (todo.proposals?.some((p) => p.kind === 'done')) return 'you';
  if (todo.followUpPaused) return 'later';
  return 'doing';
}

function pile(todo: DeskTodo, children: DeskTodo[], now: Date): Pile {
  const due = todo.dueAt ? Date.parse(todo.dueAt) : NaN;
  return {
    todo,
    children,
    lane: laneOf(todo, now),
    pinned: Boolean(todo.lane && LANES.includes(todo.lane)),
    idleDays: Math.max(0, Math.floor((now.getTime() - pileActivity({ todo, children })) / DAY)),
    cards: (todo.hasNote ? 1 : 0) + (children.length ? 1 : 0) + todo.threads.length + (todo.proposals?.length ?? 0),
    dueSoon: Number.isFinite(due) && due < endOfDay(now),
    overdue: Number.isFinite(due) && due < now.getTime(),
  };
}

/** A due date as it matters now: how late, today's time, tomorrow, or else just the date. */
export function dueLabel(dueAt: string, now: Date): { text: string; overdue: boolean } {
  const due = new Date(dueAt);
  const dayOf = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const days = Math.round((dayOf(due) - dayOf(now)) / DAY);
  const overdue = due.getTime() < now.getTime();
  if (days < 0) return { text: t('desk.overdueDays', -days), overdue };
  if (days === 0) return { text: t('desk.dueToday', formatTime(due, { hour: '2-digit', minute: '2-digit' })), overdue };
  if (days === 1) return { text: t('desk.dueTomorrow'), overdue };
  return { text: formatDate(due, { month: 'numeric', day: 'numeric' }), overdue };
}

/** First what is overdue or due soonest, then what has sat longest. */
function byUrgency(a: Pile, b: Pile): number {
  const da = a.todo.dueAt ? Date.parse(a.todo.dueAt) : Infinity;
  const db = b.todo.dueAt ? Date.parse(b.todo.dueAt) : Infinity;
  return da - db || b.idleDays - a.idleDays || a.todo.position - b.todo.position;
}

export function buildDesk(todos: DeskTodo[], now = new Date()): Desk {
  const kids = new Map<string, DeskTodo[]>();
  for (const todo of todos) if (todo.parentId) kids.set(todo.parentId, [...(kids.get(todo.parentId) ?? []), todo]);
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position);
  const top = todos.filter((todo) => !todo.parentId);
  const lanes: Record<Lane, Pile[]> = { you: [], doing: [], wait: [], later: [] };
  for (const todo of top) {
    if (todo.done || todo.proposed) continue;
    const p = pile(todo, kids.get(todo.id) ?? [], now);
    lanes[p.lane].push(p);
  }
  for (const lane of LANES) lanes[lane].sort(byUrgency);

  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const week: WeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return { date: localDate(day), done: day.getTime() > now.getTime() ? null : 0 };
  });
  for (const todo of top) {
    if (!todo.done || !todo.doneAt) continue;
    const day = week.find((d) => d.date === localDate(new Date(todo.doneAt!)));
    if (day && day.done !== null) day.done += 1;
  }

  const open = LANES.filter((lane) => lane !== 'later').flatMap((lane) => lanes[lane]);
  return {
    lanes,
    inbox: top.filter((todo) => todo.proposed && !todo.done),
    first: lanes.you.slice(0, 3),
    week,
    doneThisWeek: week.reduce((n, d) => n + (d.done ?? 0), 0),
    stale: open.filter((p) => p.idleDays >= 3).length,
  };
}

/** Finishing a step also advances its matter, even when its own note has not changed yet. */
function pileActivity(pile: Pick<Pile, 'todo' | 'children'>): number {
  return Math.max(lastActivity(pile.todo), ...pile.children.map(lastActivity));
}

/** The desk by time instead: what moved today, yesterday, and before. */
export type Period = 'today' | 'yesterday' | 'earlier';
export function byPeriod(piles: Pile[], now = new Date()): Record<Period, Pile[]> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const out: Record<Period, Pile[]> = { today: [], yesterday: [], earlier: [] };
  for (const p of piles) {
    const at = pileActivity(p);
    out[at >= today ? 'today' : at >= yesterday ? 'yesterday' : 'earlier'].push(p);
  }
  for (const list of Object.values(out)) list.sort((a, b) => pileActivity(b) - pileActivity(a));
  return out;
}

/** The continuation note in its sections, "next step" first. Headings are agent protocol, kept as written. */
const NEXT_STEP_HEADING = '下一步';
export { NEXT_STEP_HEADING as NEXT_STEP };
export function noteSections(text: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; lines: string[] }> = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (heading) sections.push({ title: heading[1].trim(), lines: [] });
    else {
      if (!sections.length) sections.push({ title: '', lines: [] });
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections
    .map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }))
    .filter((s) => s.body)
    .sort((a, b) => Number(b.title === NEXT_STEP_HEADING) - Number(a.title === NEXT_STEP_HEADING));
}

/** A small, steady tilt per matter, so the desk looks laid by hand and stays put between renders. */
export function tilt(id: string, range = 1.6): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.round(((((h % 1000) + 1000) % 1000) / 1000 * 2 - 1) * range * 10) / 10;
}
