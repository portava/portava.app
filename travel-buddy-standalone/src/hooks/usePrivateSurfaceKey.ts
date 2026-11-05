import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currentDiscoveryScope, onDiscoveryScopeChange } from '../services/discoveryViewerScope.ts';
import { captureMessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';

/** Remount private screens on account, session or privacy-scope replacement. */
export function usePrivateSurfaceKey(): string {
  const [revision, setRevision] = useState(0);
  const owner = useRef(captureMessagingOwnerRequest());
  const scope = useSyncExternalStore(onDiscoveryScopeChange, () => {
    const value = currentDiscoveryScope();
    return `${value.viewer}:${value.epoch}`;
  });
  useEffect(() => {
    let mounted = true;
    const subscription = isSupabaseConfigured ? supabase.auth.onAuthStateChange(() => {
      // The observer must finish consuming the SDK event before comparing it.
      queueMicrotask(() => {
        if (!mounted || owner.current?.isCurrent()) return;
        owner.current = captureMessagingOwnerRequest();
        setRevision(value => value + 1);
      });
    }).data.subscription : null;
    return () => { mounted = false; subscription?.unsubscribe(); };
  }, []);
  return `${scope}:${revision}`;
}
