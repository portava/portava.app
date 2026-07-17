/**
 * usePassportSectionOrder — persisted, user-reorganizable section ordering.
 *
 * The Passport page renders its sections from an ordered key array instead of
 * hardcoded JSX order, so users can reorganize sections. This hook owns that
 * array: it loads a saved order from AsyncStorage, falls back to the given
 * defaults, and persists changes.
 *
 * Unknown saved keys are dropped and newly added defaults are appended, so
 * shipping new sections never breaks an existing saved order.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_PREFIX = 'passport.sectionOrder.v1.';

function reconcile(saved: string[], defaults: string[]): string[] {
  const valid = saved.filter((k) => defaults.includes(k));
  const missing = defaults.filter((k) => !valid.includes(k));
  return [...valid, ...missing];
}

export function usePassportSectionOrder(
  scope: string,
  defaults: string[],
): {
  order: string[];
  setOrder: (next: string[]) => void;
  moveSection: (key: string, direction: -1 | 1) => void;
  resetOrder: () => void;
} {
  const [order, setOrderState] = useState<string[]>(defaults);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_PREFIX + scope)
      .then((raw) => {
        if (!alive || !raw) return;
        try {
          const saved = JSON.parse(raw);
          if (Array.isArray(saved)) setOrderState(reconcile(saved, defaults));
        } catch {
          /* corrupted value — keep defaults */
        }
      })
      .catch(() => {});
    return () => { alive = false; };
    // defaults are a stable literal per call site
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const persist = useCallback((next: string[]) => {
    setOrderState(next);
    AsyncStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(next)).catch(() => {});
  }, [scope]);

  const moveSection = useCallback((key: string, direction: -1 | 1) => {
    setOrderState((cur) => {
      const idx = cur.indexOf(key);
      const to = idx + direction;
      if (idx < 0 || to < 0 || to >= cur.length) return cur;
      const next = cur.slice();
      next.splice(idx, 1);
      next.splice(to, 0, key);
      AsyncStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [scope]);

  const resetOrder = useCallback(() => {
    persist(defaults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist]);

  return { order, setOrder: persist, moveSection, resetOrder };
}
