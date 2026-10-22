import { useEffect, useRef } from 'react';
import { routedMapExpiry, type RoutedMapData } from '../../lib/layoverRoutedMap.ts';

/** The closest two automatic refreshes for an already-expired answer may be. */
export const EXPIRED_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Bounded automatic refresh of the layover's routed map. A failed or unchanged response cannot create a paid request loop.
 *
 * No key may hold a snapshot id. While layover_canonical_snapshot_enabled is off, BOTH ids are new on every read: the
 * overview certifies a new snapshot per GET, and with layover_safety_engine_enabled on the recommendations GET
 * regenerates with Date.now() inside the input hash (routes/airport.ts, LayoverFeasibility.ts). Any key built from them
 * was new after every refresh, so a mismatch refreshed forever — on the owner's iPhone (2026-10-22) one session wrote
 * 150 certified computations and 72 regenerations in four minutes. So:
 *   - a snapshot mismatch or a `route_stale` card refreshes ONCE per screen (per session) — if that refresh does not
 *     bring matching routes, another one will not either;
 *   - an expiring answer refreshes at its expiry, and one that is ALREADY expired refreshes at most once per
 *     EXPIRED_REFRESH_MIN_INTERVAL_MS, so an envelope that arrives expired cannot spin either.
 */
export function useRoutedMapRefresh(sessionId: string | undefined, data: RoutedMapData | null, currentSnapshotId: string | null | undefined, refresh: () => Promise<void>, nowMs: number): void {
  const attempted = useRef(new Set<string>());
  const lastExpiredFireAt = useRef<number>(Number.NEGATIVE_INFINITY);
  const expiry = routedMapExpiry(data);
  const staleReason = data?.cards.some(c => c.routing.absence === 'route_stale') ?? false;
  const mismatched = !!data?.snapshotId && !!currentSnapshotId && data.snapshotId !== currentSnapshotId;
  const snapshotId = data?.snapshotId;
  useEffect(() => {
    if (!sessionId || !snapshotId || (expiry === null && !staleReason && !mismatched)) return;
    const reason = staleReason ? 'stale' : mismatched ? 'mismatch' : 'expiry';
    const key = reason === 'expiry' ? `${sessionId}:expiry:${expiry}` : `${sessionId}:${reason}`;
    if (attempted.current.has(key)) return;
    const fire = () => {
      attempted.current.add(key);
      if (reason === 'expiry') lastExpiredFireAt.current = Date.now();
      void refresh();
    };
    if (reason !== 'expiry') { fire(); return; }
    const due = Math.max(expiry!, lastExpiredFireAt.current + EXPIRED_REFRESH_MIN_INTERVAL_MS);
    if (due <= nowMs) { fire(); return; }
    const timer = setTimeout(fire, Math.min(2147483647, Math.max(1, due - nowMs + 1)));
    return () => clearTimeout(timer);
  }, [sessionId, snapshotId, currentSnapshotId, expiry, staleReason, mismatched, refresh, nowMs]);
}
