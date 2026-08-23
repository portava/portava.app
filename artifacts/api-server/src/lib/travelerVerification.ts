/**
 * travelerVerification — one place that answers "is this TRAVELLER verified?"
 *
 * ── THE BUG THIS REPLACES ───────────────────────────────────────────────────
 * Four separate sites read the requesting traveller's identity, age and phone
 * from `rent_buddy_profiles` — the BUDDY table. A row exists there only if that
 * user applied to become a buddy, so an ordinary traveller had no row, and the
 * booking gate's `if (!travProf?.date_of_birth)` hard-403'd every genuine
 * traveller with `age_verification_required`. The gate could only be satisfied
 * by users who had applied to be buddies.
 *
 * The four sites were rentABuddy.ts (booking gate, high-risk gate,
 * /me/eligibility) and rentABuddyRollout.ts (MVP-mode gate). Routing them all
 * through here is what stops them drifting apart again.
 *
 * ── WHERE EACH SIGNAL ACTUALLY LIVES ────────────────────────────────────────
 * AGE — `profiles.date_of_birth`, with NO `dob_verified` gate. Nothing in the
 *   codebase ever writes `dob_verified = true` (only the migration default and
 *   two seed scripts), so gating on it would block everyone forever. Every
 *   other age gate in the app reads `date_of_birth` alone: profile.ts,
 *   events.ts, meetups.ts, requests.ts, discovery.ts. This matches them.
 *
 * ID — a disjunction over the columns the two real writers actually set:
 *   `verification_level !== 'none'` (routes/verification.ts) or
 *   `verification_status === 'verified'` / `verified === true` (admin.ts), with
 *   `id_verified_at` as a third. Note `profiles` has NO `id_verified` boolean —
 *   that column exists only on `rent_buddy_profiles`, which is precisely the
 *   confusion that produced the original bug.
 *
 * PHONE — `profiles.phone_verified_at`, written only by
 *   PhoneVerificationService after a confirmed SMS challenge. Until migration
 *   2142 this signal did not exist anywhere in the product outside the buddy
 *   table, which is why `require_phone_verification` was unsatisfiable for
 *   travellers no matter which table was read.
 *
 * Reads are fail-CLOSED: a missing row or a failed query yields "not verified"
 * rather than an exception or a pass. Any caller that forgets to select a
 * column therefore gets "unverified", never a spurious pass.
 */

import { calculateUserAge } from "./ageEligibility.js";

/**
 * Columns a caller must SELECT for `travelerIdentityFromProfile` to work.
 * Use this constant rather than hand-writing the list — a forgotten column
 * silently degrades to "unverified".
 */
export const TRAVELER_IDENTITY_COLUMNS =
  "date_of_birth, phone_verified_at, id_verified_at, verification_level, verification_status, verified";

export interface TravelerIdentity {
  /** Raw DOB from profiles, or null. Never returned to clients. */
  dateOfBirth: string | null;
  /** Age in whole years, or null when no DOB is on file. */
  age: number | null;
  idVerified: boolean;
  phoneVerified: boolean;
}

/** Derive the traveller's identity signals from an already-fetched profiles row. */
export function travelerIdentityFromProfile(row: Record<string, any> | null | undefined): TravelerIdentity {
  if (!row) {
    return { dateOfBirth: null, age: null, idVerified: false, phoneVerified: false };
  }

  const dateOfBirth = (row["date_of_birth"] as string | null) ?? null;

  // EVIDENCE-BEARING COLUMNS ONLY.
  //
  // `verification_level` is set by the real verification flow (routes/
  // verification.ts); `id_verified_at` is a timestamp of an actual ID check;
  // `verification_status = 'verified'` is written by the audited admin action in
  // admin.ts, which also logs a moderation record. Each of those corresponds to
  // something having happened.
  //
  // The bare `verified` boolean is deliberately NOT accepted. It doubles as the
  // generic display badge across the app (profile cards, map travellers, Compass
  // output) and is set directly by seed scripts, so it evidences nothing about
  // identity. Accepting it here would be the same defect as the high-risk
  // booking gate accepting `verification_status === 'verified'` on its own:
  // trusting a label instead of a check. Dropping it costs nothing, because the
  // admin path that legitimately sets `verified` sets `verification_status` in
  // the same statement.
  const idVerified =
    (typeof row["verification_level"] === "string" && row["verification_level"] !== "none") ||
    row["verification_status"] === "verified" ||
    Boolean(row["id_verified_at"]);

  return {
    dateOfBirth,
    age: calculateUserAge(dateOfBirth),
    idVerified,
    phoneVerified: Boolean(row["phone_verified_at"]),
  };
}

/** Fetch and derive in one call. Fails closed on any error. */
export async function loadTravelerIdentity(db: any, userId: string): Promise<TravelerIdentity> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select(TRAVELER_IDENTITY_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (error) return travelerIdentityFromProfile(null);
    return travelerIdentityFromProfile(data as any);
  } catch {
    return travelerIdentityFromProfile(null);
  }
}
