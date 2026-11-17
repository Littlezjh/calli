import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentSession } from './adapters/types.js';

export interface WarmSession {
  id: string;
  threadId: string;
  cwd: string;
  key: string;
  adapter: AgentAdapter;
  ready: Promise<AgentSession | null>;
  adopt(): void;
  dispose(): Promise<void>;
}

/** Unsent drafts own no transcript in Calli. Keep at most two speculative native sessions. */
export class SessionWarmups {
  private readonly entries = new Map<string, WarmSession>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly startupMs = 30_000) {}

  start(input: Omit<WarmSession, 'id' | 'ready' | 'dispose' | 'adopt'>, start: (signal: AbortSignal) => Promise<AgentSession>, cleanup: () => void): WarmSession {
    while (this.entries.size >= 2) void this.remove(this.entries.keys().next().value!);
    const id = randomUUID(), controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), this.startupMs);
    deadline.unref();
    let expiry: ReturnType<typeof setTimeout>;
    let disposed = false;
    let adopted = false;
    const ready = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return start(controller.signal); }).then(async session => {
      if (controller.signal.aborted) { await session.close(); return null; }
      return session;
    }).catch(() => null).finally(() => clearTimeout(deadline));
    const entry: WarmSession = { ...input, id, ready, adopt: () => { adopted = true; clearTimeout(expiry); }, dispose: async () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(expiry);
      controller.abort();
      const session = await ready;
      await session?.close().catch(() => undefined);
      if (!adopted) cleanup();
    } };
    expiry = setTimeout(() => { void this.remove(id); }, this.ttlMs);
    expiry.unref();
    // Taking an entry transfers both its process and directory to a real thread.
    this.entries.set(id, entry);
    void ready.then(session => { if (!session && this.entries.get(id) === entry) void this.remove(id); });
    return entry;
  }

  take(id: string | undefined, key: string, adapter: AgentAdapter): WarmSession | null {
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry) return null;
    this.entries.delete(entry.id);
    if (entry.key !== key || entry.adapter !== adapter) { void entry.dispose(); return null; }
    // Disable expiry without cancelling a process still starting. Its startup deadline stays bounded.
    entry.adopt();
    return entry;
  }

  async remove(id: string): Promise<void> {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    await entry?.dispose();
  }

  async shutdown(): Promise<void> { await Promise.all([...this.entries.keys()].map(id => this.remove(id))); }
}
