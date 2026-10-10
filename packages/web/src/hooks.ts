import { useEffect, useState } from 'react';

/** True on phone-width screens, where menus are bottom sheets instead of floating panels. */
export function useIsNarrow(): boolean {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/** A set of string keys kept in localStorage, for things like which sidebar groups are collapsed. */
export function useStoredSet(key: string): [Set<string>, (value: string) => void] {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (value: string) => {
    setSet((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        // Storage unavailable: the choice lasts until the page reloads.
      }
      return next;
    });
  };
  return [set, toggle];
}
