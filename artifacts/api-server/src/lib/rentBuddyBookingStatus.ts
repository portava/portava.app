/**
 * Rent-a-Buddy booking status sets.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The booking status enum has 14 values, and the guards and list filters that
 * key on it were written at different times against different halves of it.
 * The result was a family of at least eight defects with one shared shape:
 * a guard admits a status the code never writes, and omits one it always does.
 *
 * Two mismatches drive nearly all of them:
 *
 *   PRE-ACCEPT   The canonical route POST /rent-a-buddy/bookings writes
 *                "requested" (rentABuddy.ts:1306), but most guards listed only
 *                "pending". "requested" is the INTENDED value, not the
 *                anomaly — migrations/0113_rent_buddy_lifecycle_fixes.sql:17-21
 *                says so outright: "Task spec requires status = requested on
 *                creation (not pending). pending is kept for backward compat
 *                with any existing rows." The other four creation paths still
 *                write "pending", so both must be accepted.
 *
 *   POST-ACCEPT  Accept writes "scheduled" (rentABuddy.ts:1571), but guards
 *                listed "confirmed". NO route writes "confirmed" to
 *                rent_buddy_bookings anywhere in src/ — it is dead in this
 *                lifecycle. It is retained in these sets ONLY because existing
 *                production rows may carry it; nothing new will ever have it.
 *
 * This module is deliberately the single definition. Widening was chosen over
 * normalising what the creation paths write, because normalisation cannot fix
 * the post-accept half at all — that mismatch originates at a TRANSITION site,
 * not a creation site — and because it would not repair rows that already exist.
 */

/** Awaiting the buddy's response. Both values are live: see PRE-ACCEPT above. */
export const AWAITING_BUDDY_STATUSES = ["pending", "requested"] as const;

/**
 * The buddy has accepted and the session has not started.
 * "confirmed" is legacy-only — retained for existing rows, never written.
 */
export const ACCEPTED_STATUSES = ["confirmed", "scheduled"] as const;

/** Anything not yet started: awaiting a response, or accepted and upcoming. */
export const UPCOMING_STATUSES = [
  ...AWAITING_BUDDY_STATUSES,
  ...ACCEPTED_STATUSES,
] as const;

/**
 * States a booking may be cancelled from.
 *
 * Equal to UPCOMING_STATUSES: once a session is in_progress it is ended via the
 * completion or safety routes, not cancelled, and every later state is terminal
 * or under adjudication. Named separately from UPCOMING_STATUSES so that a
 * future divergence between "is upcoming" and "may be cancelled" is an explicit
 * edit rather than a silent coupling.
 */
export const CANCELLABLE_STATUSES = [...UPCOMING_STATUSES] as const;

/** States a change-request may be raised from. Same reasoning as cancellation. */
export const CHANGE_ALLOWED_STATUSES = [...UPCOMING_STATUSES] as const;

/**
 * States an add-on may be attached to.
 *
 * Previously ["pending", "confirmed"], which in practice admitted only
 * "pending": it omitted "requested" (so no canonically-created booking ever
 * qualified) and "scheduled" (so none qualified after acceptance either), while
 * listing a value nothing writes. Add-ons were unattachable at every point in a
 * canonical booking's life.
 */
export const ADDON_ALLOWED_STATUSES = [...UPCOMING_STATUSES] as const;

/**
 * States in which a booking may have its chat thread OPENED.
 *
 * Previously an inline ["confirmed","scheduled","in_progress","completed","disputed"],
 * which omitted two statuses the code actually writes:
 * completed_pending_traveler_confirmation (the buddy has marked the session
 * complete) and no_show_pending (a no-show is reported and in its grace period).
 * Those are precisely the moments the two parties most need to talk, and the
 * guard refused them.
 *
 * "confirmed" is carried only for legacy rows — no route writes it. Cancelled,
 * declined and expired are deliberately absent: an existing thread is still
 * returned for those (the caller checks for one BEFORE this guard), but no new
 * thread is minted for a booking that was never accepted.
 */
export const THREAD_ALLOWED_STATUSES = [
  ...ACCEPTED_STATUSES,
  "in_progress",
  "completed_pending_traveler_confirmation",
  "completed",
  "no_show_pending",
  "disputed",
] as const;

/** Convenience for `.includes()` against a value typed as plain string. */
export function isOneOf(statuses: readonly string[], status: unknown): boolean {
  return typeof status === "string" && statuses.includes(status);
}
