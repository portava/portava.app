/**
 * useOfflineLens — useLensProjection for a fetcher that may answer from the
 * offline media cache (mediaOffline.ts), plus the one thing §39 then demands of
 * the screen: the "Cached · updated 2h ago" label, exposed as `cachedLabel`
 * whenever what is on screen came from the cache, and null the moment a live
 * answer replaces it. A surface that shows cached content without rendering
 * this label is presenting old intelligence as current.
 */
import { useCallback, useState } from 'react';
import { useLensProjection, type UseLensProjectionResult } from '../../features/media/hooks/useLensProjection.ts';
import type { OfflineResult } from './mediaOffline.ts';

export interface UseOfflineLensResult<T> extends UseLensProjectionResult<T> {
  cachedLabel: string | null;
}

export function useOfflineLens<T>(
  fetcher: (opts: { signal: AbortSignal }) => Promise<OfflineResult<T>>,
  isEmpty: (data: T) => boolean,
  deps: readonly unknown[] = [],
): UseOfflineLensResult<T> {
  const [cachedLabel, setCachedLabel] = useState<string | null>(null);
  const wrapped = useCallback(
    async (opts: { signal: AbortSignal }) => {
      const r = await fetcher(opts);
      if (!opts.signal.aborted) setCachedLabel(r.ok && r.offline ? r.offline.label : null);
      return r;
    },
    [fetcher],
  );
  const lens = useLensProjection<T>(wrapped, isEmpty, deps);
  return { ...lens, cachedLabel };
}
