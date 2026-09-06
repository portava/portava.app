/**
 * ReliabilityCounters — keeps the derived signal columns on rent_buddy_profiles
 * (completed_count, cancel_count, no_show_count, favorites_count, profile_views,
 * response_time_h) in sync with booking lifecycle, saved-buddy and view events.
 *
 * Counters feed buddy search ranking (see rentABuddy.ts ranking score) and
 * public profile display, so they must move as bookings complete/cancel and
 * as travelers save/unsave buddies.
 *
 * Updates are atomic: they go through the SQL functions created in migration
 * 0135 (`rb_adjust_buddy_counter`, `rb_sync_favorites_count`) and 2305
 * (`rb_record_buddy_response`, and profile_views added to the counter
 * allowlist), which perform
 * a single-statement UPDATE so concurrent events cannot lose increments.
 * If the RPC is unavailable (function not yet migrated, or a partial client),
 * a read-modify-write / recount fallback keeps behavior correct on the
 * single-request path.
 *
 * All helpers are best-effort: they never throw, so a counter update can
 * never fail the main request.
 */

/**
 * Columns rb_adjust_buddy_counter will accept. `profile_views` joins the three
 * reliability counters in migration 2305 — it is read by the buddy dashboard
 * (`profileViews`) and, before that migration, had no writer anywhere in src/,
 * so every buddy was shown a hard 0. Keep this union in step with the IN-list
 * in the SQL function; a column outside it raises there rather than writing.
 */
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "ReliabilityCounters" });

type CounterColumn = "completed_count" | "cancel_count" | "no_show_count" | "profile_views";

async function tryRpc(client: any, fn: string, args: Record<string, unknown>): Promise<boolean> {
  if (typeof client?.rpc !== "function") return false;
  // supabase-js never throws — failure surfaces as res.error
  const res: any = await client.rpc(fn, args);
  return !res?.error;
}

/**
 * Atomically increment/decrement a reliability counter, clamped at >= 0.
 */
export async function adjustBuddyCounter(
  client: any,
  buddyProfileId: string,
  column: CounterColumn,
  delta: number = 1,
): Promise<void> {
  if (!client || !buddyProfileId || !delta) return;
  try {
    // Preferred path: atomic single-statement update via SQL function.
    if (await tryRpc(client, "rb_adjust_buddy_counter", {
      p_buddy_id: buddyProfileId,
      p_column: column,
      p_delta: delta,
    })) return;

    // Fallback: read-modify-write (non-atomic; only used when the RPC is
    // unavailable, e.g. before migration 0135 is applied).
    const readRes: any = await client
      .from("rent_buddy_profiles")
      .select(column)
      .eq("id", buddyProfileId)
      .maybeSingle();
    if (readRes?.error) return; // don't write a bogus count on a failed read
    const current = Number((readRes?.data as any)?.[column] ?? 0);
    const next = Math.max(0, current + delta);
    await client
      .from("rent_buddy_profiles")
      .update({ [column]: next, updated_at: new Date().toISOString() })
      .eq("id", buddyProfileId);
  } catch { /* non-critical — partial/fake clients may throw on missing methods */ }
}

/**
 * Recomputes favorites_count from the rent_buddy_saved table.
 * A recount (rather than +/-1) makes save/unsave idempotent: re-saving an
 * already-saved buddy (upsert) or unsaving a non-saved one cannot drift the
 * counter.
 */
export async function syncFavoritesCount(
  client: any,
  buddyProfileId: string,
): Promise<void> {
  if (!client || !buddyProfileId) return;
  try {
    // Preferred path: atomic DB-side recount via SQL function.
    if (await tryRpc(client, "rb_sync_favorites_count", {
      p_buddy_id: buddyProfileId,
    })) return;

    // Fallback 1: server-side exact count (no row transfer, no row limits).
    // supabase-js reports failure via res.error; partial/fake clients may
    // throw on missing methods — the outer catch covers those.
    let count: number | null = null;
    const res: any = await client
      .from("rent_buddy_saved")
      .select("*", { count: "exact", head: true })
      .eq("buddy_id", buddyProfileId);
    if (!res?.error && typeof res?.count === "number") count = res.count;

    // Fallback 2 (partial/fake clients only): count returned rows.
    if (count === null) {
      const res: any = await client
        .from("rent_buddy_saved")
        .select("user_id")
        .eq("buddy_id", buddyProfileId);
      if (!Array.isArray(res?.data)) return; // leave counter untouched
      count = res.data.length;
    }

    await client
      .from("rent_buddy_profiles")
      .update({ favorites_count: count, updated_at: new Date().toISOString() })
      .eq("id", buddyProfileId);
  } catch { /* non-critical — never fail the main request */ }
}

/**
 * Record one buddy response latency into `rent_buddy_profiles.response_time_h`.
 *
 * WHY THIS EXISTS. The buddy-search ranker scores responsiveness off that column
 * (+15 / +10 / +5 at 0.5h / 1h / 4h — routes/rentABuddy.ts scoreProfile), and
 * NOTHING in src/ ever wrote it. Only src/scripts/seed-demo-buddies.ts did, and
 * that does not run in production, so the column was NULL for every real buddy
 * and every candidate scored 0 on it: a ranking term that is constant across the
 * whole candidate set, i.e. no term at all.
 *
 * `hoursSince` is the elapsed time between the traveller's request and the
 * buddy's accept/decline. The stored value is an exponentially-weighted mean
 * (alpha = 0.3) computed DB-side by rb_record_buddy_response (migration 2305) so
 * concurrent responses cannot lose an update.
 *
 * Best-effort, exactly like the counters above: it never throws and never fails
 * the accept/decline it hangs off.
 */
export async function recordBuddyResponseTime(
  client: any,
  buddyProfileId: string,
  elapsedHours: number,
): Promise<void> {
  if (!client || !buddyProfileId) return;
  if (typeof elapsedHours !== "number" || !Number.isFinite(elapsedHours) || elapsedHours < 0) return;
  // Clamp to what numeric(4,1) can hold, so a stale request answered a year
  // late saturates instead of raising a numeric overflow on a fire-and-forget
  // write. The SQL function clamps too; this keeps the fallback path honest.
  const sample = Math.min(999.9, Math.round(elapsedHours * 10) / 10);
  try {
    if (await tryRpc(client, "rb_record_buddy_response", {
      p_buddy_id: buddyProfileId,
      p_hours: sample,
    })) return;

    // Fallback: read-modify-write with the SAME weighting, for clients/databases
    // where the function is not present yet (non-atomic; single-request path).
    const readRes: any = await client
      .from("rent_buddy_profiles")
      .select("response_time_h")
      .eq("id", buddyProfileId)
      .maybeSingle();
    if (readRes?.error) return; // don't write a bogus value on a failed read
    const prevRaw = (readRes?.data as any)?.response_time_h;
    const prev = prevRaw === null || prevRaw === undefined ? null : Number(prevRaw);
    const next = prev === null || !Number.isFinite(prev)
      ? sample
      : Math.round((prev * 0.7 + sample * 0.3) * 10) / 10;
    // supabase-js RESOLVES on a DB error, so the failure only exists in `error`.
    // The write is fire-and-forget, but a silently dropped one would leave the
    // ranker's responsiveness term stuck exactly as it was before this writer
    // existed — the failure mode this function was added to end.
    const { error } = await client
      .from("rent_buddy_profiles")
      .update({ response_time_h: Math.min(999.9, next), updated_at: new Date().toISOString() })
      .eq("id", buddyProfileId);
    if (error) logger.error({ err: error, buddyProfileId }, "response_time_h update failed (best-effort)");
  } catch (err) {
    // Never fail the main request — partial/fake clients may throw on missing methods.
    logger.debug({ err, buddyProfileId }, "response-time write threw (non-critical)");
  }
}

/** Elapsed hours between a request's creation and now, or null if unusable. */
export function hoursSince(createdAt: unknown, now: number = Date.now()): number | null {
  if (typeof createdAt !== "string" && !(createdAt instanceof Date)) return null;
  const t = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (!Number.isFinite(t)) return null;
  const h = (now - t) / 3_600_000;
  return h >= 0 ? h : null;
}
