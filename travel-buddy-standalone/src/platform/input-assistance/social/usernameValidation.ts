/**
 * Global Input Intelligence — Phase 4 (Social Identity): username validation rules.
 *
 * The SINGLE canonical rule set for the `username` InputContext (§5, §23). Both
 * username entry points — the profile identity editor
 * (`app/profile/edit/identity.tsx`) and onboarding step 1
 * (`app/(auth)/onboarding.tsx`) — resolve their sanitize + min-length +
 * availability-interpretation through this module, so a handle accepted at one
 * entry point can never be rejected at the other (the exact divergence the
 * client audit flagged: onboarding had NO availability check and NO min-length,
 * so a 1–2-char handle passed signup and was later rejected on the identity
 * screen).
 *
 * §23 (Validation and Correction While Typing): username validation is
 * non-blocking and immediate; this module owns only the *rules* (pure, testable),
 * not the field's state machine or the network call. The availability check
 * itself is the app's existing `checkUsername` service — this module only
 * interprets its result, so there is one rule set, never two.
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */

/** Minimum username length. Matches the identity screen's `cleaned.length < 3`
 *  guard and its "3-24 chars" field hint. */
export const USERNAME_MIN_LENGTH = 3;

/**
 * Maximum username length. Reconciles the audit's noted mismatch on the identity
 * screen (`maxLength={30}` input vs the "3-24 chars" hint + file-header comment):
 * 24 is the hint's upper bound and the canonical cap both fields now enforce.
 */
export const USERNAME_MAX_LENGTH = 24;

/** The message shown when a non-empty handle is below the minimum length. Kept
 *  identical to the identity screen's existing copy so the two entry points read
 *  the same. */
export const USERNAME_TOO_SHORT_MESSAGE = 'At least 3 characters required';

/** Fallback message when the availability endpoint reports "taken" with no reason. */
export const USERNAME_UNAVAILABLE_MESSAGE = 'Username not available';

/**
 * Canonical username sanitizer — the exact transform the identity screen already
 * applies: strip a leading `@`, lowercase, and drop every character outside
 * `[a-z0-9_.]`. Onboarding previously used a looser variant that did NOT strip a
 * leading `@`; routing both through this function removes that divergence.
 */
export function sanitizeUsername(raw: string): string {
  return raw
    .replace(/^@+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, USERNAME_MAX_LENGTH);
}

/**
 * Synchronous syntax check for an already-sanitized handle. Returns a
 * human-readable error string when the handle is present but too short, else
 * `null`. An empty handle returns `null` (callers decide whether the field is
 * required — it is optional at onboarding, dirty-gated on the identity screen).
 */
export function usernameSyntaxError(sanitized: string): string | null {
  if (sanitized.length === 0) return null;
  if (sanitized.length < USERNAME_MIN_LENGTH) return USERNAME_TOO_SHORT_MESSAGE;
  return null;
}

/** True when a sanitized handle is long enough to send to the availability check. */
export function isUsernameCheckable(sanitized: string): boolean {
  return sanitized.length >= USERNAME_MIN_LENGTH;
}

/** Result shape of the app's `checkUsername` service. */
export interface UsernameAvailabilityResult {
  available: boolean;
  reason?: string;
}

/** Interpreted availability state — the single mapping both screens use. */
export interface InterpretedAvailability {
  status: 'available' | 'taken';
  message: string | null;
}

/**
 * Interpret a `checkUsername` response into the status + message both entry
 * points render. Available → no message; taken → the server's reason, or the
 * shared fallback. This mirrors the identity screen's existing branch exactly.
 */
export function interpretAvailability(
  res: UsernameAvailabilityResult,
): InterpretedAvailability {
  if (res.available) return { status: 'available', message: null };
  return { status: 'taken', message: res.reason ?? USERNAME_UNAVAILABLE_MESSAGE };
}
