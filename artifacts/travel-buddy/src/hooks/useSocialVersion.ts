/**
 * useSocialVersion — lightweight in-memory pub/sub for social graph mutations.
 *
 * Any hook that mutates follow/friend relationships calls `bumpSocialVersion()`
 * after a successful server write. Any hook that displays derived counts
 * (e.g. follower count on a public passport) subscribes via `useSocialVersion()`
 * and re-fetches when the counter increments.
 *
 * No AsyncStorage persistence — the signal is intentionally ephemeral. A cold
 * mount always fetches fresh data from the server; this only keeps already-
 * mounted screens in sync without a full React Query / context provider.
 */
import { useState, useEffect } from 'react';

let _version = 0;
const _listeners = new Set<() => void>();

/** Call after any successful follow / unfollow / friend-remove write. */
export function bumpSocialVersion(): void {
  _version += 1;
  _listeners.forEach((fn) => fn());
}

/**
 * Returns the current social version counter.  The returned number increments
 * each time `bumpSocialVersion` is called, triggering a re-render in every
 * subscribed component.
 */
export function useSocialVersion(): number {
  const [version, setVersion] = useState(_version);

  useEffect(() => {
    // Sync in case a bump happened between render and effect.
    setVersion(_version);
    const handler = () => setVersion((v) => v + 1);
    _listeners.add(handler);
    return () => { _listeners.delete(handler); };
  }, []);

  return version;
}
