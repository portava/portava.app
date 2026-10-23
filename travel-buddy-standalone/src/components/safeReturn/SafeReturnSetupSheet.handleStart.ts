/**
 * SafeReturnSetupSheet — session-start logic.
 *
 * Extracted from the component's handleStart() so that the session-start
 * flow can be covered by node:test without a React renderer:
 *
 *   A) createSession succeeds + startSession succeeds
 *      → onStarted(sessionId) is called
 *      → onClose() is called
 *      → outcome: 'started'
 *
 *   B) createSession returns ok:false with error:'conflict'
 *      → neither callback fires
 *      → outcome: 'conflict'  (caller shows "Session already active" alert)
 *
 *   C) createSession returns ok:false (other error)
 *      → neither callback fires
 *      → outcome: 'createFailed'
 *
 *   D) startSession returns ok:false
 *      → neither callback fires
 *      → outcome: 'startFailed'
 *
 *   E) createSession succeeds WITH `warnings: ['trusted_contacts_not_saved']`
 *      and startSession succeeds
 *      → onStarted + onClose fire (the timer IS running)
 *      → outcome: 'startedContactsNotSaved' — the caller must tell the
 *        traveller that the people they chose will NOT be alerted. This used to
 *        be reported as a plain 'started'.
 *
 * Deliberately dependency-free (no React, no React Native, no Supabase)
 * so it can be imported by node:test + tsx/esm with no shimming.
 *
 * The startLock guard and setSaving calls remain in the component
 * (they are React-layer concerns: useRef and useState).
 *
 * Run tests with:
 *   node --import tsx/esm --test \
 *     src/components/__tests__/SafeReturnSetupSheet.integration.test.ts
 */

/** Outcomes from the session-start flow. The component maps each to an Alert. */
export type HandleStartOutcome =
  | 'started'      // onStarted + onClose already fired
  | 'conflict'     // createSession: another session is active
  | 'createFailed' // createSession: server / network error
  | 'startFailed'  // createSession ok but startSession failed
  | 'startedContactsNotSaved'; // started, but the server could not save the trusted contacts — nobody will be alerted

export interface HandleStartDeps {
  /** Calls the real createSession service with already-assembled parameters. */
  createSession: () => Promise<{
    ok: boolean;
    session?: { id: string };
    error?: string;
    /** POST /me/safe-return/sessions — e.g. 'trusted_contacts_not_saved' on a 201. */
    warnings?: string[];
  }>;
  /** Calls the real startSession service. */
  startSession: (id: string) => Promise<{
    ok: boolean;
    session?: { id: string };
    error?: string;
  }>;
  /** Forwarded from SafeReturnSetupSheet props. */
  onStarted?: (sessionId: string) => void;
  /** Forwarded from SafeReturnSetupSheet props. */
  onClose: () => void;
}

/**
 * Core logic of SafeReturnSetupSheet.handleStart().
 *
 * Does NOT include the startLock guard or React state mutations — those remain
 * in the component. Callers act on the returned outcome and show Alerts
 * for non-'started' results.
 */
export async function runHandleStart(deps: HandleStartDeps): Promise<HandleStartOutcome> {
  const created = await deps.createSession();

  if (!created.ok || !created.session) {
    return created.error === 'conflict' ? 'conflict' : 'createFailed';
  }

  const started = await deps.startSession(created.session.id);

  if (started.ok && started.session) {
    deps.onStarted?.(started.session.id);
    deps.onClose();
    return created.warnings?.includes('trusted_contacts_not_saved') ? 'startedContactsNotSaved' : 'started';
  }

  return 'startFailed';
}
