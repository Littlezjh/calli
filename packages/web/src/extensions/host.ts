/**
 * The `WebHost` an extension view receives: the thread summaries, the stream's health, a few
 * actions and the host components. It is built from what the page already holds (App's thread
 * list, refreshed from /api/stream), so a view adds no requests of its own and never sees the
 * token, the raw Api or anything outside the summaries.
 */
import type { ExtensionState, ThreadSummary } from '@rah/extension-api';
import type { AgentInfo as HostAgentInfo, ConnectionState, WebHost, WebHostStorage, WebHostUi } from '@rah/extension-api/web';
import type { AgentInfo } from '../api';
import { locale } from '../i18n';
import { hasPermission } from './permissions';

export interface HostInputs {
  extension: ExtensionState | null;
  threads: ThreadSummary[];
  connection: ConnectionState;
  /** ISO time of the last thread list read from the daemon. */
  observedAt: string | null;
  agents: AgentInfo[];
}

export interface LiveHost {
  /** Everything but `narrow`, which the view passes in on each render. */
  host: Omit<WebHost, 'narrow'>;
  /** Hands in what the page holds now; subscribers hear about what actually changed. */
  update(next: HostInputs): void;
}

/** Per device, under `rah.ext.<id>.`, so one extension cannot read or clobber another's keys. */
export function extensionStorage(extensionId: string, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): WebHostStorage {
  const prefix = `rah.ext.${extensionId}.`;
  return {
    get(key) {
      try {
        return store?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null) store?.removeItem(prefix + key);
        else store?.setItem(prefix + key, value);
      } catch {
        // Storage full or unavailable: the choice lasts as long as the page.
      }
    },
  };
}

export function createWebHost(
  extensionId: string,
  initial: HostInputs,
  deps: { openThread: (id: string) => void; ui: (agents: () => AgentInfo[]) => WebHostUi; storage?: WebHostStorage; onError?: (error: unknown) => void },
): LiveHost {
  let inputs = initial;
  const allowed = (value: HostInputs) => value.extension?.manifest.id === extensionId && hasPermission(value.extension, 'events.summary');
  let threadsKey = JSON.stringify(allowed(initial) ? initial.threads : []);
  function notify<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try { listener(value); } catch (error) {
        deps.onError?.(error);
      }
    }
  }
  const threadListeners = new Set<(threads: ThreadSummary[]) => void>();
  const connectionListeners = new Set<(state: ConnectionState) => void>();
  const ui = deps.ui(() => inputs.agents);

  const host: Omit<WebHost, 'narrow'> = {
    extensionId,
    threads: {
      snapshot: () => allowed(inputs) ? inputs.threads : [],
      subscribe(listener) {
        threadListeners.add(listener);
        return () => void threadListeners.delete(listener);
      },
    },
    connection: {
      state: () => inputs.connection,
      observedAt: () => inputs.observedAt,
      subscribe(listener) {
        connectionListeners.add(listener);
        return () => void connectionListeners.delete(listener);
      },
    },
    agents: (): HostAgentInfo[] => inputs.agents.map((a) => ({ id: a.id, label: a.label, available: a.available })),
    navigate: { openThread: (id) => deps.openThread(id) },
    locale,
    storage: deps.storage ?? extensionStorage(extensionId),
    ui,
  };

  return {
    host,
    update(next) {
      const before = inputs;
      inputs = next;
      // The page re-reads the list on every event; listeners hear only when a summary changed.
      const key = JSON.stringify(allowed(next) ? next.threads : []);
      if (key !== threadsKey || allowed(next) !== allowed(before)) {
        threadsKey = key;
        if (allowed(next)) notify(threadListeners, next.threads);
      }
      if (next.connection !== before.connection || next.observedAt !== before.observedAt) notify(connectionListeners, next.connection);
    },
  };
}
