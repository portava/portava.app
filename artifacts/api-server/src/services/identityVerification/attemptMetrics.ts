/**
 * TV-6c — attempts per verified user.
 *
 * `docs/trust/verified-foundation-plan.md` phase V-6, "Cost checkpoints":
 *
 *     Rate limiting from V-1 is the cost-control mechanism; monitor attempts
 *     per verified user (>2.0 average means UX friction worth fixing).
 *
 * Two obligations sit in that sentence and only one of them was built. Rate
 * limiting is the CONTROL and it exists (`routes/verification.ts`, 3 sessions
 * per 24 h). This file is the MEASUREMENT, which did not: before it, no metric,
 * counter, report or query anywhere in the repository read
 * `identity_verifications` to answer the question, so nobody could tell whether
 * the 2.0 threshold had been crossed — including the person paying
 * ~$1.50–3.00 per attempt at the vendor.
 *
 * ── WHAT "ATTEMPTS PER VERIFIED USER" MEANS HERE, AND WHY ───────────────────
 * Numerator: every `identity_verifications` row belonging to a user who has at
 * least one `verified` row. Denominator: the number of those users.
 *
 * Both halves are scoped to users who eventually SUCCEEDED, and that is the
 * reading the threshold requires. The plan calls >2.0 "UX friction worth
 * fixing" — friction is what a user pushes through on the way to a result, so
 * the ratio has to be "how many tries did it take someone who got there". Were
 * users who never verified included, the number would move with abandonment
 * (people who opened one session and walked away pull it DOWN toward 1.0) and a
 * genuinely painful flow could read as healthy. That is the wrong direction for
 * a threshold that is supposed to raise an alarm.
 *
 * Consequences of the definition, stated so they are not surprises:
 *   * The floor is 1.0, because the successful attempt is itself an attempt.
 *     "2.0" therefore means one failure before success, on average.
 *   * Live rows (`created` / `pending` / `processing`) COUNT. Each one is a
 *     session opened at the vendor and billed as such.
 *   * A user who verified, later had that row purged, and re-verified is one
 *     user with the rows that remain. This measures what the table holds — it
 *     is a monitoring figure, not an accounting record.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * Two distinct non-answers, and neither of them is zero.
 *
 *   * A read that FAILS throws. supabase-js resolves on a database error, so an
 *     unbound `error` would turn an unreadable table into "0 attempts, 0 users"
 *     — which renders as a healthy flow with no friction, forever, and is
 *     exactly the shape of silence this subsystem's other fail-closed work
 *     exists to prevent.
 *   * No verified users yet is `state: "no_verified_users"` with `average:
 *     null` and `exceedsThreshold: null`. It is NOT 0.0 and NOT `false`. There
 *     is no ratio when the denominator is zero, and today production holds no
 *     verification rows at all, so this is the state the endpoint will actually
 *     be in on the day it is first looked at. A `0.0 — healthy` answer then
 *     would be a false negative on its first and most important reading.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The plan's figure. Exported so a test asserts the number, not a re-typed copy. */
export const ATTEMPT_FRICTION_THRESHOLD = 2.0;

/** The status that makes a user part of the denominator. */
export const VERIFIED_STATUS = "verified";

/**
 * Page size for the scan. PostgREST caps an unbounded select (1000 by default),
 * and a silently truncated scan under-reports the numerator — the fail-open
 * direction — so the read is paged explicitly and refuses to stop early.
 */
const PAGE_SIZE = 1000;

/** Guard against an unbounded loop; throws rather than truncating. See scanRows. */
const MAX_PAGES = 1000;

export interface AttemptMetrics {
  /** `measured` when a ratio exists; `no_verified_users` when the denominator is 0. */
  state: "measured" | "no_verified_users";
  /** Attempts per verified user, or null when there is no denominator. */
  average: number | null;
  /** Users with at least one `verified` row. */
  verifiedUsers: number;
  /** Rows belonging to those users — the numerator. */
  attemptsByVerifiedUsers: number;
  /** Every row scanned, verified users or not. Context, not the ratio. */
  totalRows: number;
  /** The plan's 2.0. Echoed so a caller renders the comparison it was measured against. */
  threshold: number;
  /** `average > threshold`, or null when nothing was measured. NEVER false-by-default. */
  exceedsThreshold: boolean | null;
  /** Lower bound applied to `created_at`, or null for all time. */
  since: string | null;
}

interface AttemptRow {
  user_id?: string | null;
  status?: string | null;
}

/**
 * Page through `identity_verifications`, throwing on any read failure.
 *
 * Returns every row rather than aggregating in the database: PostgREST offers
 * no GROUP BY, and the alternative — an RPC — would be a migration this lane is
 * not permitted to write. At production's current volume (the table holds no
 * rows) and at any plausible near-term volume this is a small scan; the paging
 * and the `since` bound are what keep it from silently becoming a large one.
 */
async function scanRows(db: SupabaseClient, since: string | null): Promise<AttemptRow[]> {
  const out: AttemptRow[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let q = db
      .from("identity_verifications")
      .select("user_id, status")
      .order("id", { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (since) q = q.gte("created_at", since);

    const { data, error } = await q;

    if (error) {
      // Never "0 attempts". A monitoring figure that reports health out of a
      // failed read is worse than no figure: it is believed.
      throw new Error(
        `read identity_verifications for attempt metrics (page ${page}): ${error.message} — ` +
          `REFUSING to report an attempts-per-verified-user figure from a table that could not be read`,
      );
    }

    const rows = (data ?? []) as AttemptRow[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return out;
  }

  throw new Error(
    `identity_verifications scan exceeded ${MAX_PAGES} pages of ${PAGE_SIZE} — ` +
      `refusing to report a figure computed from a truncated scan`,
  );
}

/**
 * Compute attempts per verified user.
 *
 * @param opts.since ISO timestamp; only rows created at or after it are counted.
 *   Omit for all time.
 */
export async function computeAttemptsPerVerifiedUser(
  db: SupabaseClient,
  opts: { since?: string | null } = {},
): Promise<AttemptMetrics> {
  const since = opts.since ?? null;
  const rows = await scanRows(db, since);

  const attemptsByUser = new Map<string, number>();
  const verified = new Set<string>();

  for (const r of rows) {
    const uid = typeof r.user_id === "string" && r.user_id.length > 0 ? r.user_id : null;
    if (!uid) continue;
    attemptsByUser.set(uid, (attemptsByUser.get(uid) ?? 0) + 1);
    if (r.status === VERIFIED_STATUS) verified.add(uid);
  }

  let attemptsByVerifiedUsers = 0;
  for (const uid of verified) attemptsByVerifiedUsers += attemptsByUser.get(uid) ?? 0;

  if (verified.size === 0) {
    return {
      state: "no_verified_users",
      average: null,
      verifiedUsers: 0,
      attemptsByVerifiedUsers: 0,
      totalRows: rows.length,
      threshold: ATTEMPT_FRICTION_THRESHOLD,
      exceedsThreshold: null,
      since,
    };
  }

  const average = attemptsByVerifiedUsers / verified.size;

  return {
    state: "measured",
    average,
    verifiedUsers: verified.size,
    attemptsByVerifiedUsers,
    totalRows: rows.length,
    threshold: ATTEMPT_FRICTION_THRESHOLD,
    exceedsThreshold: average > ATTEMPT_FRICTION_THRESHOLD,
    since,
  };
}
