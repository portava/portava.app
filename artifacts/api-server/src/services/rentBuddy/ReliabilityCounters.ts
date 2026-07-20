/**
 * ReliabilityCounters — keeps the reliability counter columns on
 * rent_buddy_profiles (completed_count, cancel_count, no_show_count,
 * favorites_count) in sync with booking lifecycle and saved-buddy events.
 *
 * Counters feed buddy search ranking (see rentABuddy.ts ranking score) and
 * public profile display, so they must move as bookings complete/cancel and
 * as travelers save/unsave buddies.
 *
 * Updates are atomic: they go through the SQL functions created in migration
 * 0135 (`rb_adjust_buddy_counter`, `rb_sync_favorites_count`), which perform
 * a single-statement UPDATE so concurrent events cannot lose increments.
 * If the RPC is unavailable (function not yet migrated, or a partial client),
 * a read-modify-write / recount fallback keeps behavior correct on the
 * single-request path.
 *
 * All helpers are best-effort: they never throw, so a counter update can
 * never fail the main request.
 */

type CounterColumn = "completed_count" | "cancel_count" | "no_show_count";

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
