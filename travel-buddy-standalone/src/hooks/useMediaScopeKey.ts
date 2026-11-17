import { useSyncExternalStore } from 'react';
import { currentDiscoveryScope, onDiscoveryScopeChange } from '../services/discoveryViewerScope.ts';

// Presentation revision only: credentials still come exclusively from
// apiToken. A same-account refresh must replace rendered request headers
// without invalidating unrelated Discovery or offline business-data caches.
let credentialRevision = 0;
const credentialListeners = new Set<() => void>();
export function notifyMediaCredentialsChanged(): void {
  credentialRevision++;
  for (const listener of [...credentialListeners]) listener();
}
const snapshot = () => JSON.stringify([currentDiscoveryScope(), credentialRevision]);
function subscribe(listener: () => void): () => void {
  const off = onDiscoveryScopeChange(listener);
  credentialListeners.add(listener);
  return () => { off(); credentialListeners.delete(listener); };
}

/** Re-check media permission after an account switch, block, or dismissal. */
export function useMediaScopeKey(): string {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
