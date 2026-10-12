/** Unsent words in a thread's box, kept on this device so a reload does not lose them. */
export interface StoredDraft {
  text: string;
  quote: string | null;
  /** When it was last typed in, so the oldest go first once there are too many. */
  at: number;
}

export const DRAFTS_KEY = 'rah.drafts';

/** Enough for every thread in use; drafts left in threads long gone make room for new ones. */
export const MAX_DRAFTS = 50;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

export function readDrafts(storage: Storage): Record<string, StoredDraft> {
  try {
    const parsed = JSON.parse(storage.getItem(DRAFTS_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, StoredDraft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, Partial<StoredDraft>>)) {
      if (value && typeof value.text === 'string') {
        out[key] = { text: value.text, quote: typeof value.quote === 'string' ? value.quote : null, at: Number(value.at) || 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Keeps `draft` under `key`, or forgets it when there is nothing left to keep. */
export function writeDraft(storage: Storage, key: string, draft: { text: string; quote: string | null } | null, now = Date.now()): void {
  const all = readDrafts(storage);
  if (draft && (draft.text.trim() || draft.quote !== null)) all[key] = { ...draft, at: now };
  else if (key in all) delete all[key];
  else return;
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_DRAFTS);
  try {
    storage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or unavailable: the draft still lasts until the page reloads.
  }
}
