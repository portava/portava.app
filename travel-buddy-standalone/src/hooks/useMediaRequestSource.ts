import { useEffect, useMemo, useState } from 'react';
import { useMediaScopeKey } from './useMediaScopeKey.ts';
import { hydratedMediaSource, resolveMediaRequestSources, type MediaRequestSource } from '../services/mediaRequestSource.ts';

/** Native players need headers; browser players need the same-origin cookie
 * installed before mounting. A changed account never renders the old source. */
export function useMediaRequestSource(uri: string): MediaRequestSource | null {
  const scope = useMediaScopeKey();
  const key = JSON.stringify([scope, uri]);
  const [ready, setReady] = useState<{ key: string; source: MediaRequestSource | null } | null>(null);
  const direct = useMemo(() => hydratedMediaSource(uri), [uri]);
  useEffect(() => {
    if (!uri || direct) return;
    let cancelled = false;
    void resolveMediaRequestSources({ source: uri }).then(sources => {
      if (!cancelled) setReady({ key, source: sources.source ?? null });
    }).catch(() => { if (!cancelled) setReady({ key, source: null }); });
    return () => { cancelled = true; };
  }, [uri, key, Boolean(direct)]);
  return direct ?? (ready?.key === key ? ready.source : null);
}
