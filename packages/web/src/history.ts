import { Api, AuthError } from './api';
import type { DetailRef, StoredEvent } from './timeline';

export interface HistoryPage { events: StoredEvent[]; snapshotSeq: number; nextCursor: number | null; hasOlder: boolean }
export interface HistoryDetail { version: number; text?: string; input?: unknown; output?: string; content?: unknown; nextCursor: number | null }
export interface HistoryWork { version: number; events: StoredEvent[]; nextCursor: number | null }
export type ResourceKind = 'work' | 'detail' | 'file';

/** Replace only the turns covered by a reconnect snapshot; keep previously paged history. */
export function mergeHistory(previous: StoredEvent[], updates: StoredEvent[]): StoredEvent[] {
  let out = previous;
  for (const ev of updates) {
    if (ev.type === 'history.reset') {
      const turns = new Set<string>(ev.data.turns);
      const events = ev.data.events as StoredEvent[];
      const seqs = new Set(events.map(e => e.seq));
      const newer = out.filter(e => e.seq > ev.seq);
      out = [...out.filter(e => e.seq <= ev.seq && !turns.has(e.turnId ?? '') && !seqs.has(e.seq)), ...events, ...newer].sort((a,b) => a.seq - b.seq);
    } else if (!out.length || ev.seq > out[out.length - 1].seq) {
      out = [...out, ev];
    }
  }
  return out;
}

export async function historyPage(api: Api, id: string, before?: number, after?: number): Promise<HistoryPage> {
  if (api.demo) {
    const events = before ? await api.eventsBefore(id, before) : await api.eventsTail(id);
    const nextCursor = (events[0]?.seq ?? 0) > 1 ? events[0].seq : null;
    return { events, nextCursor, hasOlder: nextCursor !== null, snapshotSeq: events.at(-1)?.seq ?? 0 };
  }
  return api.historyPage(id, before, after);
}

/** All conversation surfaces share snapshot/stream ordering and batched delivery. */
export async function watchHistory(api: Api, id: string, signal: AbortSignal, callbacks: {
  page: (page: HistoryPage) => void;
  events: (events: StoredEvent[]) => void;
  error: (error: unknown) => void;
  connection?: (connected: boolean) => void;
  minimumSeq?: number;
}) {
  let after = 0;
  let loaded = false;
  let buffer: StoredEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    const batch = buffer; buffer = [];
    if (!signal.aborted && batch.length) callbacks.events(batch);
  };
  try {
    while (!signal.aborted) {
      try {
        if (!loaded) {
          const page = await historyPage(api, id, undefined, callbacks.minimumSeq);
          if (signal.aborted) return;
          after = page.snapshotSeq; callbacks.page(page); loaded = true;
        }
        callbacks.connection?.(true);
        await api.stream(`/api/threads/${id}/stream?view=summary&after=${after}`, (ev: StoredEvent) => {
          after = Math.max(after, ev.seq);
          buffer.push(ev);
          timer ??= setTimeout(flush, 40);
        }, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (!loaded || error instanceof AuthError) callbacks.error(error);
        if (error instanceof AuthError) return;
      }
      flush(); callbacks.connection?.(false);
      await new Promise<void>(resolve => {
        if (signal.aborted) return resolve();
        const done = () => { clearTimeout(wait); signal.removeEventListener('abort', done); resolve(); };
        const wait = setTimeout(done, 1500);
        signal.addEventListener('abort', done, { once: true });
      });
    }
  } finally { clearTimeout(timer); }
}

/** Scoped to one mounted thread/API instance; bound memory and share concurrent requests. */
let clientIdentity = 0;
export class HistoryClient {
  readonly identity = ++clientIdentity;
  private cache = new Map<string, { value: unknown; bytes: number }>();
  private pending = new Map<string, Promise<any>>();
  private bytes = 0;
  constructor(readonly api: Api, readonly threadId: string) {}
  private key(kind: ResourceKind, ref: DetailRef, path?: string, cursor?: number) { return JSON.stringify([kind, ref.turnId, ref.id, ref.version, path, cursor]); }
  invalidate(kind: ResourceKind, ref: DetailRef, path?: string) {
    const key = this.key(kind, ref, path);
    this.bytes -= this.cache.get(key)?.bytes ?? 0;
    this.cache.delete(key);
  }
  remember(kind: ResourceKind, ref: DetailRef, value: unknown, path?: string, cursor?: number) {
    const key = this.key(kind, ref, path, cursor);
    const bytes = JSON.stringify(value).length * 2;
    if (bytes > 8 * 1024 * 1024) return;
    this.bytes -= this.cache.get(key)?.bytes ?? 0;
    this.cache.set(key, { value, bytes }); this.bytes += bytes;
    while (this.bytes > 8 * 1024 * 1024 || this.cache.size > 100) {
      const first = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(first)!.bytes; this.cache.delete(first);
    }
  }
  load<T>(kind: ResourceKind, ref: DetailRef, path?: string, cursor?: number): Promise<T> {
    const key = this.key(kind, ref, path, cursor);
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return Promise.resolve(hit.value as T); }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = (kind === 'work' ? this.api.historyWork(this.threadId, ref, cursor) : this.api.historyDetail(this.threadId, ref, cursor, kind === 'file' ? path : undefined))
      .then(value => {
        this.remember(kind, ref, value, path, cursor);
        return value;
      }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request as Promise<T>;
  }
}
