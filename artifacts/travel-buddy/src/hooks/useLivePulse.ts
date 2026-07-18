/**
 * useLivePulse — fetches and subscribes to live-event pulse data for a given
 * city context. Returns an opaque result object; consumers call .refresh() to
 * force a re-fetch (e.g. on tab focus or pull-to-refresh).
 */
import { useCallback, useState } from 'react';

export interface UseLivePulseOptions {
  /** 'currentCity' | 'myPlans' — determines which data source to query. */
  context: 'currentCity' | 'myPlans';
  citySlug?: string;
  lat?: number;
  lng?: number;
}

export interface UseLivePulseResult {
  /** Re-fetch live-event data immediately. */
  refresh: () => void;
}

export function useLivePulse(_options: UseLivePulseOptions): UseLivePulseResult {
  // Placeholder: future implementation will poll /api/pulse/live and update
  // a shared store. For now, refresh is a no-op so existing screens compile.
  const [, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  return { refresh };
}
