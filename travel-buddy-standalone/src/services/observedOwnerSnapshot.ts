import { currentDiscoveryScope, isCurrentDiscoveryScope } from './discoveryViewerScope.ts';

export interface MessagingOwnerRequest {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly isCurrent: () => boolean;
  readonly invalidate: () => void;
}

/** Read-only shape of the SDK observer registered by messagingOwnerRequest. */
interface ObservedOwner {
  active: boolean;
  observed: boolean;
  revision: number;
  identity: { ownerId: string; sessionId: string } | null;
}
const observerKey = Symbol.for('portava.messagingOwnerRequest.observer');
const registry = globalThis as typeof globalThis & { [observerKey]?: ObservedOwner };

/**
 * Capture BEFORE any lazy import or token refresh. No SDK imports are needed
 * to read an already observed session. An uninitialized observer fails closed.
 */
export function captureObservedOwnerSnapshot(): MessagingOwnerRequest | null {
  const observer = registry[observerKey];
  const identity = observer?.identity;
  const scope = Object.freeze(currentDiscoveryScope());
  if (!observer?.active || !observer.observed || !identity || scope.viewer !== `u:${identity.ownerId}`) return null;
  const revision = observer.revision;
  let valid = true;
  return Object.freeze({
    ...identity,
    isCurrent: () => valid && observer.active && registry[observerKey] === observer
      && observer.revision === revision && isCurrentDiscoveryScope(scope),
    invalidate: () => { valid = false; },
  });
}
