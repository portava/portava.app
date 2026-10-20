/**
 * observedOwnerSessionFixture — seeds the OBSERVED SDK auth session for suites
 * that render the real GlobalPlacePicker as a signed-in viewer.
 *
 * WHY THIS EXISTS
 * ===============
 * For a non-anonymous Discovery viewer the picker leases its selection from
 * captureMessagingOwnerRequest() (services/messagingOwnerRequest.ts), which only
 * trusts an identity delivered by the Supabase auth listener and refuses unless
 * that owner matches the viewer. A fixture that only calls
 * setDiscoveryViewerFromSession(owner) names a viewer but has no observed
 * session, so every row refuses. That refusal is correct product behaviour; the
 * fixture was incomplete.
 *
 * This helper completes it the way production does: it re-initialises the REAL
 * owner observer and delivers SIGNED_IN through the auth listeners the observer
 * registered. Nothing in the owner/lease path is mocked into success.
 *
 * REQUIREMENT
 * ===========
 * The suite's `supabase.auth` must record onAuthStateChange listeners on an
 * `auth.listeners` Set (an SDK transport stub; see the jest.mock blocks in the
 * consuming suites). Without it seeding throws instead of silently passing.
 */
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { supabase } from '../../lib/supabase.ts';
import { disposeMessagingOwnerObserver, initializeMessagingOwnerObserver } from '../messagingOwnerRequest.ts';

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void;

function authListeners(): Set<AuthListener> {
  const listeners = (supabase.auth as unknown as { listeners?: Set<AuthListener> }).listeners;
  if (!(listeners instanceof Set)) {
    throw new Error('observedOwnerSessionFixture: supabase.auth has no recorded `listeners` Set — stub the auth SDK first.');
  }
  return listeners;
}

/** A JWT-shaped access token whose claims carry the owner (`sub`) and `session_id`. */
export function observedOwnerAccessToken(ownerId: string, sessionId: string): string {
  return 'e30.' + btoa(JSON.stringify({ sub: ownerId, session_id: sessionId })) + '.synthetic';
}

export function observedOwnerSession(ownerId: string, sessionId: string): Session {
  return { access_token: observedOwnerAccessToken(ownerId, sessionId), user: { id: ownerId } } as unknown as Session;
}

/** Delivers one auth event to every listener the SDK stub recorded (as the SDK's notify does). */
export function emitObservedAuthEvent(event: AuthChangeEvent, session: Session | null): void {
  for (const listener of [...authListeners()]) listener(event, session);
}

/**
 * Re-initialises the real owner observer and signs `ownerId` in with `sessionId`.
 * Call it in beforeEach alongside setDiscoveryViewerFromSession(ownerId).
 */
export function seedObservedOwnerSession(ownerId: string, sessionId: string): Session {
  disposeMessagingOwnerObserver();
  initializeMessagingOwnerObserver();
  const session = observedOwnerSession(ownerId, sessionId);
  emitObservedAuthEvent('SIGNED_IN', session);
  return session;
}

/** Tears the observer down so no identity leaks into the next test. */
export function disposeObservedOwnerSession(): void {
  disposeMessagingOwnerObserver();
}
