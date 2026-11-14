import { useSyncExternalStore } from 'react';
import { currentDiscoveryScope, onDiscoveryScopeChange } from '../services/discoveryViewerScope.ts';

const snapshot = () => JSON.stringify(currentDiscoveryScope());

/** Re-check media permission after an account switch, block, or dismissal. */
export function useMediaScopeKey(): string {
  return useSyncExternalStore(onDiscoveryScopeChange, snapshot, snapshot);
}
