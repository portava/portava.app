/**
 * gateAge — the ONE place a route or service turns "who is this user" into
 * "how old may this product treat them as being".
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 * The verified-minor contradiction rule (IDF-25) was added to
 * `lib/travelerVerification.ts#loadTravelerIdentity`. That helper is called
 * from exactly four files, all Rent-a-Buddy. Measured at this tree:
 *
 *     lib/travelerVerification.ts   routes/admin.ts   routes/rentABuddy.ts
 *     routes/rentABuddyRollout.ts   routes/rentABuddySpec.ts
 *
 * Seven OTHER gate families read `profiles.date_of_birth` directly and called
 * that helper ZERO times — meetup RSVP and meetup invite, circle-invite accept,
 * event join and event waitlist, the media-feed viewer age (route and
 * projection service), the discovery caller age, and the `ageGateRequired` flag
 * the profile route sends the client. A user whose government document came
 * back `is_over_18: false` kept the adult birthday they typed and passed every
 * one of them.
 *
 * ── WHY A SEAM AND NOT SEVEN CALLS TO THE EXISTING HELPER ──────────────────
 * Handing each of the seven sites `loadTravelerIdentity` would fix the seven
 * sites and nothing else: the EIGHTH gate, added next month, would read
 * `date_of_birth` and `calculateUserAge` exactly as these seven did, because
 * that is what the surrounding code looks like, and it would be wrong in
 * exactly the same way with nobody the wiser. The fix has to change what the
 * next author's obvious move produces.
 *
 * Two mechanisms do that, and they are the whole design:
 *
 *   1. THE RETURN TYPE HAS NO `age` FIELD TO REACH FOR. `GateAge` is a
 *      discriminated union; `age` exists only inside the `ok` arm. `resolved.age`
 *      does not COMPILE until the author has narrowed on `state === "ok"`, which
 *      is to say until they have written something for `verified_minor` and for
 *      `unreadable`. The failure mode this replaces — reaching a plain number and
 *      comparing it to 18 — is no longer expressible. The one escape hatch,
 *      `ageForFailClosedFilter`, still collapses BOTH refusal states to `null`,
 *      so even the lazy path cannot hand a minor a number.
 *
 *   2. A DRIFT GUARD MAKES THE OLD SHAPE GO RED. `src/test/ageGateSeamCoverage.
 *      test.ts` scans every route and service for a `date_of_birth` read and
 *      requires the file to be routed through this module or to be on a named,
 *      reasoned allowlist. An eighth gate written the old way fails CI on the
 *      commit that introduces it, rather than shipping and being found later.
 *
 * ── THREE ANSWERS, AND WHY THE THIRD IS NOT THE SECOND ─────────────────────
 *   ok              — nothing contradicts the profile. `age` is derived from
 *                     the typed date of birth, and is `null` when there is no
 *                     date of birth on file. That last case is a FACT about the
 *                     record and callers may say so.
 *   verified_minor  — a provider result on file says this user is not over 18.
 *                     The gate refuses. It must NOT say "your date of birth is
 *                     missing": the date of birth is present and contradicted.
 *   unreadable      — `identity_verifications` could not be read. This is an
 *                     OUTAGE, not a finding about the user. Callers refuse (fail
 *                     closed) and say the check is unavailable — never that the
 *                     user is a minor, and never that their profile is missing
 *                     something. `routes/meetups.ts` already had to learn this
 *                     lesson once for the `profiles` read itself.
 *
 * The contradiction rule itself is NOT re-implemented here. It lives once, in
 * `verifiedAgeSignalFromRows`, and this module composes it.
 */

import { calculateUserAge } from "./ageEligibility.js";
import {
  readVerifiedAgeSignal,
  verifiedAgeSignalFromRows,
  VERIFIED_AGE_COLUMNS,
  type VerifiedAgeSignal,
} from "./travelerVerification.js";

/**
 * The age a gate is allowed to act on.
 *
 * Deliberately a union with no common `age` member — see mechanism 1 in the
 * header. Adding an `age: number | null` to the refusal arms "for convenience"
 * would undo the entire point of this type.
 */
export type GateAge =
  | { state: "ok"; age: number | null; dateOfBirth: string | null }
  | { state: "verified_minor" }
  | { state: "unreadable" };

/** The only `profiles` column this seam needs. */
export const GATE_AGE_PROFILE_COLUMNS = "date_of_birth";

/**
 * What a gate tells a user it refused a verified minor. Neutral on purpose: it
 * states the requirement and the fact that the identity check did not meet it,
 * and it does not disclose the provider result, the document, or the date of
 * birth on file.
 */
export const AGE_NOT_VERIFIED_ADULT_MESSAGE =
  "Your identity check did not confirm that you are 18 or over, so this is not available to you.";

/**
 * What a gate tells a user when the check could not run. Retryable, and about
 * the SYSTEM. Every word of it is deliberately not about them.
 */
export const AGE_CHECK_UNAVAILABLE_MESSAGE =
  "Your age could not be checked right now. Please try again shortly.";

/**
 * Fold a provider signal into a self-asserted date of birth. Pure, so the whole
 * decision is testable without a client, and so a caller that ALREADY holds the
 * profile row (and has already checked that read's own error) does not read it
 * a second time.
 */
export function gateAgeFrom(dateOfBirth: string | null | undefined, signal: VerifiedAgeSignal): GateAge {
  if (signal.verificationUnreadable) return { state: "unreadable" };
  if (signal.verifiedMinor) return { state: "verified_minor" };
  const dob = dateOfBirth ?? null;
  return { state: "ok", age: calculateUserAge(dob), dateOfBirth: dob };
}

/**
 * Resolve one user's gate age. Both reads are issued in PARALLEL, so a gate
 * that previously did one `profiles` read now does two reads in the same round
 * trip rather than two round trips.
 *
 * Fail-closed on the `profiles` read too: supabase-js RESOLVES on a database
 * error, so a discarded `error` looks byte-identical to "this user has no date
 * of birth" — the defect `routes/meetups.ts:713-717` documents having already
 * fixed once for this exact table. An errored read is `unreadable`, not a
 * statement that the profile is empty.
 */
export async function resolveGateAge(db: any, userId: string): Promise<GateAge> {
  const [profile, signal] = await Promise.all([
    readGateProfileRow(db, userId),
    readVerifiedAgeSignal(db, userId),
  ]);
  if (profile.unreadable) return { state: "unreadable" };
  return gateAgeFrom(profile.dateOfBirth, signal);
}

async function readGateProfileRow(
  db: any,
  userId: string,
): Promise<{ dateOfBirth: string | null; unreadable: boolean }> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select(GATE_AGE_PROFILE_COLUMNS)
      .eq("id", userId)
      .maybeSingle();
    if (error) return { dateOfBirth: null, unreadable: true };
    return { dateOfBirth: ((data as any)?.date_of_birth as string | null) ?? null, unreadable: false };
  } catch {
    return { dateOfBirth: null, unreadable: true };
  }
}

/**
 * Resolve MANY users at once — TWO queries total, whatever the size of the
 * batch. The meetup invite pre-check filters a list of invitees; doing this
 * per-invitee would be the N+1 the batched `profiles` read there already
 * avoids, and there is no reason the verification read should be worse.
 *
 * Every requested id gets an entry, so a caller cannot silently skip a user
 * whose row did not come back.
 */
export async function resolveGateAges(db: any, userIds: string[]): Promise<Map<string, GateAge>> {
  const out = new Map<string, GateAge>();
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return out;

  const [profiles, signals] = await Promise.all([
    readGateProfileRows(db, ids),
    readVerifiedAgeSignals(db, ids),
  ]);

  for (const id of ids) {
    if (profiles.unreadable) { out.set(id, { state: "unreadable" }); continue; }
    out.set(id, gateAgeFrom(profiles.byUser.get(id) ?? null, signals.get(id) ?? UNREADABLE_SIGNAL));
  }
  return out;
}

const UNREADABLE_SIGNAL: VerifiedAgeSignal = { verifiedMinor: false, verificationUnreadable: true };

async function readGateProfileRows(
  db: any,
  ids: string[],
): Promise<{ byUser: Map<string, string | null>; unreadable: boolean }> {
  const byUser = new Map<string, string | null>();
  try {
    const { data, error } = await db.from("profiles").select("id, date_of_birth").in("id", ids);
    if (error) return { byUser, unreadable: true };
    for (const row of (data as any[]) ?? []) byUser.set((row as any).id as string, ((row as any).date_of_birth as string | null) ?? null);
    return { byUser, unreadable: false };
  } catch {
    return { byUser, unreadable: true };
  }
}

/**
 * How many verification rows one batched read may return before the result is
 * treated as truncated. A truncated page is indistinguishable from "these users
 * have no decided results", which is the PERMISSIVE answer — so truncation is
 * reported as `unreadable` for the whole batch rather than quietly admitting
 * whoever fell off the end. `routes/verification.ts` rate-limits session
 * creation to 3 per user per 24h, so this holds hundreds of users' complete
 * histories; a batch large enough to breach it is a caller that should be
 * paging, not a gate that should be opening.
 */
const BATCH_VERIFICATION_SCAN_LIMIT = 2000;

/**
 * Batched sibling of `readVerifiedAgeSignal`. Same plain select/in/order/limit
 * shape and the same reason for it: no `.not()` filter, so undecided rows
 * arrive too and the single pure function `verifiedAgeSignalFromRows` — already
 * the one implementation of "newest DECIDED result wins" — makes every
 * decision. This function groups; it does not re-decide.
 */
export async function readVerifiedAgeSignals(
  db: any,
  ids: string[],
): Promise<Map<string, VerifiedAgeSignal>> {
  const out = new Map<string, VerifiedAgeSignal>();
  let rows: any[] | null = null;
  let err: unknown = null;
  try {
    const res = await db
      .from("identity_verifications")
      .select(`user_id, ${VERIFIED_AGE_COLUMNS}`)
      .in("user_id", ids)
      .order("created_at", { ascending: false })
      .limit(BATCH_VERIFICATION_SCAN_LIMIT);
    rows = (res?.data as any[]) ?? null;
    err = res?.error ?? null;
  } catch (thrown) {
    err = thrown ?? new Error("identity_verifications batch read threw");
  }
  if (!err && Array.isArray(rows) && rows.length >= BATCH_VERIFICATION_SCAN_LIMIT) {
    err = new Error("identity_verifications batch read truncated");
  }

  const grouped = new Map<string, any[]>();
  for (const row of rows ?? []) {
    const uid = (row as any)?.user_id as string | undefined;
    if (!uid) continue;
    const list = grouped.get(uid);
    if (list) list.push(row);
    else grouped.set(uid, [row]);
  }
  for (const id of ids) {
    out.set(id, verifiedAgeSignalFromRows(err ? null : (grouped.get(id) ?? []), err));
  }
  return out;
}

/**
 * The ONE narrowing shortcut, for surfaces where the answer is "show it or
 * don't" and there is no user to tell anything to — the media feed's
 * `viewerAge`, which `lib/mediaEligibility.ts:447` already treats as
 * fail-closed when null.
 *
 * It collapses `verified_minor` and `unreadable` to the same `null` the
 * fail-closed path already handles, so it CANNOT be misused to admit a minor:
 * the worst a careless caller gets from it is a refusal. It must not be used
 * where the refusal is explained to the user, because it destroys the
 * distinction between "no date of birth on file" and "the check did not run",
 * and reporting one as the other is the fabrication this whole change is about.
 */
export function ageForFailClosedFilter(resolved: GateAge): number | null {
  return resolved.state === "ok" ? resolved.age : null;
}
