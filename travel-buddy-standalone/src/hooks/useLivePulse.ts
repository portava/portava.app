/**
 * useLivePulse — manages state for the Live Pulse smart rail.
 *
 * Features:
 *  - Fetch on mount, on context change, and every 3 minutes while active.
 *  - Dismissed items are excluded from the returned list.
 *  - Exposes refresh(), dismiss(id), and changeContext(ctx).
 *  - Post-action refresh trigger via triggerRefresh().
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getLivePulseItems,
  dismissLivePulseItem,
  isLivePulseDismissed,
  type LivePulseItem,
  type LivePulseContext,
  type GetLivePulseParams,
} from '../services/livePulse.ts';

const AUTO_REFRESH_MS = 3 * 60 * 1000; // 3 minutes

export interface UseLivePulseOptions {
  context?: LivePulseContext;
  citySlug?: string | null;
  lat?: number | null;
  lng?: number | null;
  /** Disable auto-fetch (e.g. screen not mounted). Default: false. */
  paused?: boolean;
}

export interface UseLivePulseResult {
  items: LivePulseItem[];
  loading: boolean;
  error: string | null;
  /**
   * Session UUID the server stamped on the rank_events serve rows for the
   * items currently in `items` — null when the server did not return one.
   *
   * Kept in lockstep with `items`: both are written together in the success
   * branch and neither is touched on a failed fetch, so this always identifies
   * the batch the user is actually looking at. Forward it to any outcome
   * reported from a Live Pulse card (surface 'live_pulse') so the outcome route
   * can narrow its impression lookup to this serve instead of picking whichever
   * live_pulse impression happens to be most recent.
   *
   * This is a precision improvement only. Live Pulse cards are safe from
   * cross-surface mis-attribution because they report under their own surface,
   * not because a session is present — nothing here is load-bearing.
   */
  sessionId: string | null;
  refresh: () => void;
  dismiss: (id: string) => void;
  changeContext: (ctx: LivePulseContext) => void;
}

export function useLivePulse(opts: UseLivePulseOptions = {}): UseLivePulseResult {
  const { citySlug, lat, lng, paused = false } = opts;

  /**
   * Context resolution:
   * - If the caller provides `opts.context`, it always wins (external source of truth).
   * - Internal state (`internalContext`) is used when `opts.context` is undefined, so
   *   `changeContext()` calls work for uncontrolled usage.
   * This means external prop changes are immediately picked up without a stale render.
   */
  const [internalContext, setInternalContext] = useState<LivePulseContext>(opts.context ?? 'myPlans');
  const context: LivePulseContext = opts.context ?? internalContext;

  const [allItems, setAllItems] = useState<LivePulseItem[]>([]);
  // Serve session for whatever is in `allItems`. Written only where allItems is
  // written, so an outcome can never be tagged with a session that served a
  // different batch of cards.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState(0);

  // Use a ref to avoid stale closure in the timer callback
  const fetchRef = useRef<() => void>(() => { /* noop */ });

  const doFetch = useCallback(async () => {
    if (paused) return;
    setLoading(true);
    setError(null);
    const params: GetLivePulseParams = { context, citySlug, lat, lng };
    const result = await getLivePulseItems(params);
    setLoading(false);
    if (result.ok) {
      setAllItems(result.items);
      setSessionId(result.sessionId);
    } else {
      // Leave items AND sessionId untouched: on a failed refresh the previously
      // served cards stay on screen, so they keep the session that served them.
      setError(result.error);
    }
  }, [context, citySlug, lat, lng, paused]);

  fetchRef.current = doFetch;

  // Fetch on mount and whenever effective context or location changes
  useEffect(() => {
    fetchRef.current();
  }, [context, citySlug, lat, lng]);

  // Auto-refresh every 3 minutes while not paused
  useEffect(() => {
    if (paused) return;
    const timer = setInterval(() => fetchRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [paused]);

  const refresh = useCallback(() => {
    doFetch();
  }, [doFetch]);

  const dismiss = useCallback((id: string) => {
    dismissLivePulseItem(id);
    setDismissedVersion((v) => v + 1);
  }, []);

  /**
   * changeContext: sets internal context state. Has no effect when
   * opts.context is provided (external context takes precedence).
   */
  const changeContext = useCallback((ctx: LivePulseContext) => {
    setInternalContext(ctx);
  }, []);

  // Filter dismissed items (reactive on dismissedVersion)
  const items = allItems.filter((item) => !isLivePulseDismissed(item.id));
  // Silence the unused var warning — dismissedVersion drives re-render
  void dismissedVersion;

  return { items, loading, error, sessionId, refresh, dismiss, changeContext };
}
