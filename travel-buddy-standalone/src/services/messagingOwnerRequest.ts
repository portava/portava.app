import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken } from './apiToken.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope, viewerKeyForToken } from './discoveryViewerScope.ts';

interface OwnerIdentity {
  readonly ownerId: string;
  readonly sessionId: string;
}

interface OwnerObserver {
  auth: typeof supabase.auth;
  active: boolean;
  observed: boolean;
  revision: number;
  identity: OwnerIdentity | null;
  unsubscribe: (() => void) | null;
}

export interface MessagingOwnerRequest extends OwnerIdentity {
  readonly isCurrent: () => boolean;
  readonly invalidate: () => void;
}

const observerKey = Symbol.for('portava.messagingOwnerRequest.observer');
const registry = globalThis as typeof globalThis & { [observerKey]?: OwnerObserver };

function tokenSessionId(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const encoded = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload: unknown = JSON.parse(globalThis.atob(encoded + '='.repeat((4 - encoded.length % 4) % 4)));
    if (!payload || typeof payload !== 'object' || !('session_id' in payload)) return null;
    return typeof payload.session_id === 'string' && payload.session_id.trim().length > 0 ? payload.session_id : null;
  } catch { return null; }
}

function sessionIdentity(session: Session | null): OwnerIdentity | null {
  const ownerId = session?.user?.id;
  const token = session?.access_token;
  if (typeof ownerId !== 'string' || !ownerId || typeof token !== 'string'
    || viewerKeyForToken(token) !== `u:${ownerId}`) return null;
  const sessionId = tokenSessionId(token);
  return sessionId ? Object.freeze({ ownerId, sessionId }) : null;
}

export { sessionIdentity as messagingSessionIdentity };

export function disposeMessagingOwnerObserver(): void {
  const observer = registry[observerKey];
  if (!observer) return;
  observer.active = false;
  observer.identity = null;
  observer.revision += 1;
  delete registry[observerKey];
  observer.unsubscribe?.();
  observer.unsubscribe = null;
}

export function initializeMessagingOwnerObserver(): void {
  if (!isSupabaseConfigured) return;
  if (registry[observerKey]?.auth === supabase.auth) return;
  disposeMessagingOwnerObserver();
  const observer: OwnerObserver = {
    auth: supabase.auth, active: true, observed: false, revision: 0, identity: null, unsubscribe: null,
  };
  registry[observerKey] = observer;
  try {
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!observer.active || registry[observerKey] !== observer) return;
      if (event === 'INITIAL_SESSION' && observer.observed) return;
      observer.observed = true;
      const identity = event === 'SIGNED_OUT' ? null : sessionIdentity(session);
      if (event === 'SIGNED_OUT' || observer.identity?.ownerId !== identity?.ownerId
        || observer.identity?.sessionId !== identity?.sessionId) observer.revision += 1;
      observer.identity = identity;
    });
    observer.unsubscribe = () => data.subscription.unsubscribe();
  } catch {
    observer.active = false;
    observer.identity = null;
  }
}

export function captureMessagingOwnerRequest(): MessagingOwnerRequest | null {
  initializeMessagingOwnerObserver();
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

export function assertMessagingOwnerRequest(request: MessagingOwnerRequest): void {
  if (!request.isCurrent()) throw new Error('The signed-in messaging session changed.');
}

export async function messagingOwnerToken(request: MessagingOwnerRequest): Promise<string | null> {
  if (!request.isCurrent()) return null;
  try {
    const token = await freshToken();
    if (request.isCurrent() && token && viewerKeyForToken(token) === `u:${request.ownerId}`
      && tokenSessionId(token) === request.sessionId) return token;
  } catch {}
  request.invalidate();
  return null;
}

initializeMessagingOwnerObserver();
