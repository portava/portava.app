import { useSyncExternalStore } from 'react';
import { currentDiscoveryScope, onDiscoveryScopeChange } from '../../../services/discoveryViewerScope.ts';

function currentEpoch(): number {
  return currentDiscoveryScope().epoch;
}

export function useInputAccountEpoch(): number {
  return useSyncExternalStore(onDiscoveryScopeChange, currentEpoch, currentEpoch);
}
