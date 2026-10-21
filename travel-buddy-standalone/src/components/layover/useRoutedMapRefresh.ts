import { useEffect, useRef } from 'react';
import { routedMapExpiry, type RoutedMapData } from '../../lib/layoverRoutedMap.ts';

/** One refresh per expired answer/version. A failed or unchanged response cannot create a paid request loop. */
export function useRoutedMapRefresh(sessionId: string | undefined, data: RoutedMapData | null, currentSnapshotId: string | null | undefined, refresh: () => Promise<void>, nowMs: number): void {
  const attempted = useRef(new Set<string>());
  const expiry = routedMapExpiry(data);
  const staleReason = data?.cards.some(c => c.routing.absence === 'route_stale') ?? false;
  const mismatched = !!data?.snapshotId && !!currentSnapshotId && data.snapshotId !== currentSnapshotId;
  const snapshotId = data?.snapshotId;
  useEffect(() => {
    if (!sessionId || !snapshotId || (expiry === null && !staleReason && !mismatched)) return;
    const key = `${sessionId}:${snapshotId}:${currentSnapshotId}:${expiry}:${staleReason}`;
    if (attempted.current.has(key)) return;
    const fire = () => { attempted.current.add(key); void refresh(); };
    if (staleReason || mismatched || (expiry !== null && expiry <= nowMs)) { fire(); return; }
    const timer = setTimeout(fire, Math.min(2147483647, Math.max(1, expiry! - nowMs + 1)));
    return () => clearTimeout(timer);
  }, [sessionId, snapshotId, currentSnapshotId, expiry, staleReason, mismatched, refresh, nowMs]);
}
