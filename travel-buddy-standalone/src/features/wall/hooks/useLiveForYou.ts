/**
 * useLiveForYou — the compact Live For You strip's own data source (spec §4/§31).
 *
 * REFRESHES INDEPENDENTLY of feed pagination (spec §28): its own short TTL, its
 * own request. Two mechanisms keep it honest about "no stale live labels"
 * (spec §4):
 *   1. a periodic refetch (short `ttlMs`), and
 *   2. a ticking clock that expires any item past its `validUntil` between
 *      refetches, so a stale item silently drops out rather than lingering with
 *      a live label.
 *
 * FAIL-SOFT (spec TABLE 5): if Live Intelligence is unavailable the strip
 * degrades — only still-valid items are ever returned, and the feed is never
 * blocked or affected by a live-strip failure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchLiveForYou } from '../services/wallApi.ts';
import type { LiveForYouItem } from '../types/liveForYou.ts';
import { useInputAccountEpoch } from '../../../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../../../services/discoveryViewerScope.ts';

const DEFAULT_TTL_MS = 60_000; // refetch cadence
const CLOCK_TICK_MS = 20_000; // how often to re-evaluate validUntil
export const MAX_LIVE_ITEMS = 4; // spec §4 — the strip shows at most 4

export interface UseLiveForYouOptions {
  /** When false, the hook idles and returns an empty strip (feature gate). */
  enabled?: boolean;
  ttlMs?: number;
  limit?: number;
}

export interface UseLiveForYouResult {
  /** Only items still within `validUntil` — safe to show with a live label. */
  items: LiveForYouItem[];
  loading: boolean;
  error: string | null;
  degraded: boolean;
  /** True when items were fetched but every one has since expired. */
  stale: boolean;
  refresh: () => void;
}

function isValid(item: LiveForYouItem, nowMs: number): boolean {
  const until = Date.parse(item.validUntil);
  // A missing/unparseable horizon is treated as already-expired: we never show
  // a live label we cannot vouch for (spec §4).
  return Number.isFinite(until) && until > nowMs;
}

export function useLiveForYou(opts: UseLiveForYouOptions = {}): UseLiveForYouResult {
  const enabled = opts.enabled !== false;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const limit = opts.limit ?? MAX_LIVE_ITEMS;

  const [rawItems, setRawItems] = useState<LiveForYouItem[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const accountEpoch = useInputAccountEpoch();
  const context = useMemo(() => ({
    active: false,
    scope: currentDiscoveryScope(),
    request: null as AbortController | null,
    queued: false,
  }), [enabled, limit, accountEpoch]);
  const dataContext = useRef<typeof context | null>(null);

  const refetch = useCallback(async (queueIfBusy = false) => {
    if (!enabled || !context.active || !isCurrentDiscoveryScope(context.scope)) return;
    if (context.request) {
      if (queueIfBusy) context.queued = true;
      return;
    }
    const request = new AbortController();
    context.request = request;
    const current = () => context.active && context.request === request && isCurrentDiscoveryScope(context.scope);
    try {
      const res = await fetchLiveForYou({ limit, signal: request.signal });
      if (!current()) return;
      dataContext.current = context;
      if (res.ok) {
        setError(null);
        setDegraded(res.degraded);
        setRawItems(res.liveForYou.slice(0, limit));
      } else if (res.error !== 'aborted') {
        // Live Intelligence unavailable — degrade, never block the feed.
        setError(res.error);
        setDegraded(true);
      }
    } catch {
      if (current()) {
        dataContext.current = context;
        setError('Live updates could not load. Please try again.');
        setDegraded(true);
      }
    } finally {
      if (current()) {
        setLoading(false);
        context.request = null;
        if (context.queued) {
          context.queued = false;
          void refetch();
        }
      }
    }
  }, [enabled, limit, context]);

  // Initial + periodic refetch.
  useEffect(() => {
    context.active = true;
    setRawItems([]);
    setError(null);
    setDegraded(false);
    setLoading(enabled);
    if (!enabled) {
      return () => { context.active = false; };
    }
    void refetch();
    const timer = setInterval(() => {
      void refetch();
    }, ttlMs);
    return () => {
      clearInterval(timer);
      context.active = false;
      context.queued = false;
      context.request?.abort();
      context.request = null;
    };
  }, [enabled, ttlMs, refetch, context]);

  // Ticking clock so items expire between refetches.
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  const items = useMemo(
    () => enabled && dataContext.current === context
      ? rawItems.filter((it) => isValid(it, nowMs)).slice(0, MAX_LIVE_ITEMS)
      : [],
    [rawItems, nowMs, context, enabled],
  );

  const stale = rawItems.length > 0 && items.length === 0;

  const refresh = useCallback(() => {
    setNowMs(Date.now());
    void refetch(true);
  }, [refetch]);

  return { items, loading, error, degraded, stale, refresh };
}
