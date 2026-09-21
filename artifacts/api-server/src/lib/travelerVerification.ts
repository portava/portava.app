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
export async function loadTravelerIdentity(db: any, userId: string): Promise<TravelerIdentityChecked> {
  const [row, signal] = await Promise.all([
    readTravelerProfileRow(db, userId),
    readVerifiedAgeSignal(db, userId),
  ]);
  return applyVerifiedAgeSignal(travelerIdentityFromProfile(row), signal);
}

async function readTravelerProfileRow(db: any, userId: string): Promise<Record<string, any> | null> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select(TRAVELER_IDENTITY_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (error) return null;
    return (data as any) ?? null;
  } catch {
    return null;
  }
}

/**
 * ── THE VERIFIED-MINOR CONTRADICTION RULE (IDF-25) ──────────────────────────
 *
 * Everything above this line derives age from `profiles.date_of_birth`, which
 * the user TYPES. `routes/profile.ts` validates it for format, for being in the
 * past, and for a CLAIMED age of 18 — and nothing else. It is a self-assertion.
 *
 * The product also holds, for some users, a provider's answer to the same
 * question. Both real adapters normalize a result whose failure reason is
 * `underage` to `isOver18 = false` — both adapters live under
 * `services/identityVerification/` and this module names neither vendor, because
 * the vendor is a config decision — and `routes/verification.ts`
 * writes that boolean to `identity_verifications.is_over_18` on EVERY result
 * state — the patch object is applied before the `status === "verified"` branch,
 * so a `failed` / `underage` result persists `is_over_18 = false`.
 *
 * Until this rule existed, NOTHING read that column as a gate. A user whose
 * government document proved they were a minor kept the adult birthday they had
 * typed and passed every 18+ gate that routes through this helper — including
 * the Rent-a-Buddy booking gate, which pairs strangers in person. The product
 * held proof of the contradiction and did nothing with it.
 *
 * ── WHY THIS DOES NOT WAIT ON THE OPEN SOURCE-OF-TRUTH QUESTION ─────────────
 * Whether `is_over_18` or the self-asserted date of birth is the AUTHORITY for
 * age is an open decision. This rule does not answer it, because it is a
 * CONTRADICTION rule and it holds under both answers: if the boolean becomes
 * the gate, a `false` refuses; if the typed date is ratified as the gate, a
 * provider-verified contradiction of a self-assertion must still win, or the
 * ratification means the product ignores evidence it paid a vendor for.
 *
 * What ELSE should follow — suspending the account, age-restricting it, clearing
 * the contradicted date of birth — is a separate owner decision and is
 * deliberately NOT done here. This rule refuses; it does not rewrite the record.
 * `dateOfBirth` is passed through untouched for exactly that reason.
 *
 * ── AND IT IS FAIL-CLOSED, IN BOTH DIRECTIONS ──────────────────────────────
 * `verifiedMinor` is asserted only from a row that actually says so, so an empty
 * or missing table never accuses anyone. An UNREADABLE table is a third answer
 * and is reported as itself: `verificationUnreadable`. A caller must not read
 * "could not check" as "checked, and clean" — which is what a bare
 * `catch { return notAMinor }` would have made it.
 */
export interface VerifiedAgeSignal {
  /** A provider result on file states this user is NOT over 18. */
  verifiedMinor: boolean;
  /** The check could not be performed. NOT the same as "no contradiction". */
  verificationUnreadable: boolean;
}

export interface TravelerIdentityChecked extends TravelerIdentity, VerifiedAgeSignal {}

/**
 * Columns a caller must SELECT for `verifiedAgeSignalFromRows` to work.
 * `is_over_18` is the whole signal; `created_at` orders it. NO provider payload,
 * no document field, and — as the migration's own header commits — no date of
 * birth exists on that table to select.
 */
export const VERIFIED_AGE_COLUMNS = "is_over_18, created_at";

/**
 * Newest DECIDED result wins.
 *
 * "Decided" means `is_over_18` is non-null: a `created` / `pending` session has
 * the column null and settles nothing, so starting a fresh attempt cannot clear
 * a standing minor result. And because the newest decided row wins rather than
 * "any false ever", a user who has since turned 18 and re-verified is no longer
 * held a minor — the rule tracks the evidence rather than punishing a history.
 */
export function verifiedAgeSignalFromRows(
  rows: Array<Record<string, any>> | null | undefined,
  error: unknown,
): VerifiedAgeSignal {
  if (error) return { verifiedMinor: false, verificationUnreadable: true };
  if (!Array.isArray(rows)) return { verifiedMinor: false, verificationUnreadable: true };

  let newest: Record<string, any> | null = null;
  for (const row of rows) {
    if (typeof row?.["is_over_18"] !== "boolean") continue;
    if (newest === null || String(row["created_at"] ?? "") > String(newest["created_at"] ?? "")) {
      newest = row;
    }
  }
  if (newest === null) return { verifiedMinor: false, verificationUnreadable: false };
  return { verifiedMinor: newest["is_over_18"] === false, verificationUnreadable: false };
}

/**
 * Fold the provider signal into the self-asserted identity.
 *
 * `age` becomes null — not a number — because there is no age derived from the
 * typed birthday that may satisfy an 18+ gate once a document has contradicted
 * it. Every existing consumer of this helper already treats `age === null` as a
 * refusal, so the four gates that read it fail closed without each having to
 * learn a new field; `verifiedMinor` is there so a caller that wants to say WHY
 * can, instead of telling a user their date of birth is missing when it is not.
 *
 * `idVerified` becomes false for the same reason: a document check whose answer
 * was "this holder is a minor" is a FAILED identity check, and treating it as a
 * passed one is the exact contradiction this rule exists to stop.
 */
export function applyVerifiedAgeSignal(
  identity: TravelerIdentity,
  signal: VerifiedAgeSignal,
): TravelerIdentityChecked {
  const blocked = signal.verifiedMinor || signal.verificationUnreadable;
  return {
    ...identity,
    age: blocked ? null : identity.age,
    idVerified: signal.verifiedMinor ? false : identity.idVerified,
    verifiedMinor: signal.verifiedMinor,
    verificationUnreadable: signal.verificationUnreadable,
  };
}

/**
 * Read the user's decided verification results.
 *
 * Deliberately a plain `select/eq/order/limit` list read: no `.not()` filter, so
 * the undecided rows arrive too and `verifiedAgeSignalFromRows` — which is pure
 * and directly testable — makes the whole decision. A thrown client (a table the
 * caller's Supabase client cannot address at all) is `verificationUnreadable`,
 * not "clean".
 */
export async function readVerifiedAgeSignal(db: any, userId: string): Promise<VerifiedAgeSignal> {
  try {
    const { data, error } = await db
      .from("identity_verifications")
      .select(VERIFIED_AGE_COLUMNS)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(VERIFIED_AGE_SCAN_LIMIT);
    return verifiedAgeSignalFromRows(data as any, error);
  } catch (err) {
    return verifiedAgeSignalFromRows(null, err ?? new Error("identity_verifications read threw"));
  }
}

/**
 * How many of a user's verification rows are read to find the newest decided
 * one. `routes/verification.ts` rate-limits session creation to 3 per user per
 * 24h, so 50 rows is well over two weeks of maximum-rate attempts and the
 * newest decided row is inside it in every realistic case.
 */
const VERIFIED_AGE_SCAN_LIMIT = 50;
