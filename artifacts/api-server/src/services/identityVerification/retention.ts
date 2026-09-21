/**
 * Retention for identity-verification records.
 *
 * verified-foundation-plan.md V-7: "Retention job: purge failed/expired
 * verification rows older than 90 days."
 *
 * ── WHAT IS PURGED, AND WHAT IS DELIBERATELY NOT ────────────────────────────
 * Exactly the two statuses the plan names: `failed` and `expired`. Not
 * `canceled`, which the plan does not mention and which this file will not
 * decide for it; not `created` / `pending` / `processing`, which are live
 * attempts; and above all **not `verified`**.
 *
 * A `verified` row is not stale data — it is the standing evidence that a
 * government-ID check happened. `lib/travelerVerification.ts` and
 * `routes/rentABuddyRollout.ts` gate real-world introductions on the state it
 * produced, and the plan's own re-verification horizon lives in `expires_at`,
 * not in a purge. Deleting one would silently revoke a user's standing 90 days
 * after they earned it. `purgeExpiredVerificationRecords` therefore names its
 * statuses positively and never filters by "not verified" — a negative filter
 * would sweep in any status added later, including one that means verified.
 *
 * ── WHICH CLOCK ─────────────────────────────────────────────────────────────
 * `updated_at`, not `created_at`. The row's age for retention purposes starts
 * when it reached its terminal state, which is when it stopped being a live
 * attempt and became a record of a failure. A session created 100 days ago and
 * failed yesterday is one day of retained failure data, not 100.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The statuses the plan names. Positive list — see the header. */
export const PURGEABLE_STATUSES: readonly string[] = ["failed", "expired"];

/** The plan's figure. Exported so a test asserts the number, not a re-typed copy. */
export const VERIFICATION_RETENTION_DAYS = 90;

export interface RetentionResult {
  /** Rows deleted, or null when the delete could not be counted. */
  purged: number | null;
  /** The cutoff actually used, for the log line and for tests. */
  cutoff: string;
}

/**
 * Delete `failed` / `expired` verification rows whose terminal state is older
 * than the retention window.
 *
 * Throws on a database error rather than reporting zero: supabase-js RESOLVES
 * on failure, so an unbound error would make a purge that never ran look
 * identical to one that found nothing to do — and a retention job that silently
 * stops running is indistinguishable from one that is working, forever.
 */
export async function purgeExpiredVerificationRecords(
  db: SupabaseClient,
  opts: { now?: number; retentionDays?: number } = {},
): Promise<RetentionResult> {
  const retentionDays = opts.retentionDays ?? VERIFICATION_RETENTION_DAYS;
  const nowMs = opts.now ?? Date.now();
  const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("identity_verifications")
    .delete()
    .in("status", PURGEABLE_STATUSES as string[])
    .lt("updated_at", cutoff)
    // A delete with no chained select returns `data: null`, so the affected
    // count is UNKNOWABLE without one. Asking for the ids is what makes the
    // number in the log a measurement rather than an assumption.
    .select("id");

  if (error) {
    throw new Error(`purge identity_verifications (cutoff ${cutoff}): ${error.message}`);
  }

  return { purged: Array.isArray(data) ? data.length : null, cutoff };
}
