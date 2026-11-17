import { useEffect, useRef } from 'react';
import type { Api, DraftSessionInput } from './api';

/** Speculation never blocks sending. Only an identical draft may consume its process. */
export function useDraftWarmup(api: Api, input: DraftSessionInput | null) {
  const key = input ? JSON.stringify(input) : null;
  const current = useRef<{ api: Api; key: string; id: string; consumed: boolean } | null>(null);
  useEffect(() => {
    if (!key || api.demo) return;
    let stopped = false;
    const timer = setTimeout(() => {
      void api.warmDraft(JSON.parse(key)).then(({ id }) => {
        if (!id) return;
        if (stopped) { void api.cancelWarmDraft(id).catch(() => undefined); return; }
        current.current = { api, key, id, consumed: false };
      }).catch(() => { /* A speculative failure leaves the ordinary send path available. */ });
    }, 400);
    return () => {
      stopped = true;
      clearTimeout(timer);
      const entry = current.current;
      if (entry?.api === api && entry.key === key) {
        current.current = null;
        if (!entry.consumed) void api.cancelWarmDraft(entry.id).catch(() => undefined);
      }
    };
  }, [api, key]);
  return () => {
    const entry = current.current;
    if (!entry || entry.api !== api || entry.key !== key || entry.consumed) return undefined;
    entry.consumed = true;
    return entry.id;
  };
}
