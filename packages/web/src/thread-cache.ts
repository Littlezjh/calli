import type { Thread } from './api';

const KEY = 'calli.threads.v1';
/** Enough to fill the sidebar at once; the live list replaces it a moment later anyway. */
const MAX_STORED = 200;
const MAX_HOSTS = 8;

interface Stored { at: string; threads: Thread[] }

/** This page's lists, whole, so switching machines back and forth needs no storage at all. */
const memory = new Map<string, Stored>();

const hostKey = (hostId: string | null) => hostId ?? '';

function stored(): Record<string, Stored> {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([, v]) => {
      const s = v as Stored | null;
      return s && typeof s.at === 'string' && Array.isArray(s.threads) && s.threads.every(t => t && typeof t.id === 'string');
    })) as Record<string, Stored>;
  } catch {
    return {};
  }
}

/** The list last read from a machine (null is the hub's own), and when; null if never read on this device. */
export function cachedThreads(hostId: string | null): Stored | null {
  return memory.get(hostKey(hostId)) ?? stored()[hostKey(hostId)] ?? null;
}

export function rememberThreads(hostId: string | null, threads: Thread[], at: string): void {
  memory.set(hostKey(hostId), { at, threads });
  try {
    const recent = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_STORED);
    const entries = Object.entries({ ...stored(), [hostKey(hostId)]: { at, threads: recent } });
    entries.sort((a, b) => b[1].at.localeCompare(a[1].at));
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries.slice(0, MAX_HOSTS))));
  } catch {
    // Storage full or disabled: this page still keeps the list in memory.
  }
}

/** Another hub, or signed out: what was read from the last one is not this one's. */
export function clearThreadCache(): void {
  memory.clear();
  try { localStorage.removeItem(KEY); } catch { /* Storage may be disabled. */ }
}
