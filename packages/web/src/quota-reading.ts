import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { Api, PlanQuota } from './api';

export const QUOTA_REFRESH_MS = 60_000;
export type QuotaReading = { quota: PlanQuota | null; loading: boolean; error: string | null; failedAt: string | null };

/** A mounted account has one refresh loop and one snapshot across every quota surface. */
export function createQuotaReading(api: Api, agent: string) {
  let snapshot: QuotaReading = { quota: api.cachedAgentQuota(agent), loading: false, error: null, failedAt: null };
  const listeners = new Set<() => void>();
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const publish = (next: QuotaReading) => { snapshot = next; listeners.forEach(listener => listener()); };
  const read = (refresh = false): Promise<void> => {
    if (pending) return pending;
    publish({ ...snapshot, loading: true });
    pending = api.agentQuota(agent, refresh).then(
      quota => publish({ quota, loading: false, error: null, failedAt: null }),
      error => publish({ quota: api.cachedAgentQuota(agent), loading: false, error: error instanceof Error ? error.message : String(error), failedAt: new Date().toISOString() }),
    ).finally(() => { pending = null; });
    return pending;
  };
  return {
    getSnapshot: () => snapshot,
    refresh: () => read(true),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        void read();
        timer = setInterval(() => { if (!document.hidden) void read(); }, QUOTA_REFRESH_MS);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer) { clearInterval(timer); timer = null; }
      };
    },
  };
}

const stores = new WeakMap<Api, Map<string, ReturnType<typeof createQuotaReading>>>();

function quotaReadingFor(api: Api, agent: string) {
  let accounts = stores.get(api);
  if (!accounts) { accounts = new Map(); stores.set(api, accounts); }
  let reading = accounts.get(agent);
  if (!reading) { reading = createQuotaReading(api, agent); accounts.set(agent, reading); }
  return reading;
}

export const refreshQuota = (api: Api, agent: string) => quotaReadingFor(api, agent).refresh();

export function useAgentQuota(api: Api, agent: string) {
  const store = useMemo(() => quotaReadingFor(api, agent), [api, agent]);
  const reading = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...reading, refresh: store.refresh };
}

/** Full quota navigation is supplied by the hub, so inspecting an account never selects it. */
export const QuotaNavigation = createContext<(() => void) | null>(null);
export const useQuotaNavigation = () => useContext(QuotaNavigation);
