/**
 * postPlaceBackfillWorker — background sweep that resolves existing posts to
 * the venue-level `places` table.
 *
 * Runs every 10 minutes, processes up to 200 rows per tick. Selects posts
 * where canonical_place_id IS NULL AND canonical_location_id IS NOT NULL,
 * attempts resolvePostPlace using the post's own location_name +
 * location_lat/location_lng, and updates canonical_place_id on success.
 *
 * Stops automatically when the backlog reaches 0 (timer cleared).
 *
 * Exported for tests:
 *   runBackfillTick(scOverride?) — one synchronous processing pass.
 */

import { getServiceClient } from "../supabase.js";
import { resolvePostPlace } from "./placeResolve.js";

const TICK_INTERVAL_MS = 10 * 60 * 1_000; // 10 minutes
const BATCH_SIZE = 200;

// Persistent run counter (survives across ticks in the same process).
let _runCount = 0;
let _timer: ReturnType<typeof setInterval> | null = null;

/**
 * One processing tick. Exported so tests can inject a fake client and assert
 * the select-and-update logic without a running timer.
 *
 * Returns { processed, updated, stopped } — `stopped` is true when the backlog
 * was empty (timer has been cleared if it was running).
 */
export async function runBackfillTick(scOverride?: any): Promise<{
  processed: number;
  updated: number;
  stopped: boolean;
}> {
  const sc = scOverride ?? getServiceClient();
  if (!sc) return { processed: 0, updated: 0, stopped: false };

  _runCount++;

  // Select posts that have a city-level canonical location but no venue-level place.
  // We only need the post's own stored coordinates and name — no join required.
  const { data: rows, error } = await sc
    .from("posts")
    .select("id, location_name, location_lat, location_lng, location_city, location_country")
    .is("canonical_place_id", null)
    .not("canonical_location_id", "is", null)
    .limit(BATCH_SIZE);

  if (error) {
    console.error(JSON.stringify({
      event: "post_place_backfill.select_error",
      error: error.message,
      run: _runCount,
    }));
    return { processed: 0, updated: 0, stopped: false };
  }

  const batch = (rows ?? []) as Array<{
    id: string;
    location_name: string | null;
    location_lat: number | null;
    location_lng: number | null;
    location_city: string | null;
    location_country: string | null;
  }>;

  if (batch.length === 0) {
    // Backlog empty — log and return; keep the interval alive so posts
    // re-queued by admin "accept" actions are picked up on the next tick
    // without requiring a process restart.
    console.log(JSON.stringify({
      event: "post_place_backfill.backlog_empty",
      run: _runCount,
    }));
    return { processed: 0, updated: 0, stopped: true };
  }

  let updated = 0;

  for (const row of batch) {
    // Skip posts with no location data — can't resolve without name + coords.
    if (!row.location_name || row.location_lat == null || row.location_lng == null) {
      continue;
    }

    try {
      const result = await resolvePostPlace(sc, {
        postId: row.id,
        locationName: row.location_name,
        latitude: row.location_lat,
        longitude: row.location_lng,
        city: row.location_city ?? null,
        countryCode: row.location_country ?? null,
      });

      if (result?.placeId) {
        const { error: updateErr } = await sc
          .from("posts")
          .update({ canonical_place_id: result.placeId })
          .eq("id", row.id)
          .is("canonical_place_id", null); // guard against races

        if (!updateErr) {
          updated++;
        } else {
          console.warn(JSON.stringify({
            event: "post_place_backfill.update_error",
            post_id: row.id,
            error: updateErr.message,
          }));
        }
      }
    } catch (err) {
      // Fail-soft: one bad resolution must not abort the whole batch.
      console.warn(JSON.stringify({
        event: "post_place_backfill.resolve_error",
        post_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  console.log(JSON.stringify({
    event: "post_place_backfill.tick_complete",
    processed: batch.length,
    updated,
    run: _runCount,
  }));

  return { processed: batch.length, updated, stopped: false };
}

/**
 * Start the periodic backfill sweep. Safe to call multiple times — a second
 * call while a timer is already running is a no-op.
 */
export function startPostPlaceBackfillWorker(): void {
  if (_timer !== null) return; // already running

  // Run an initial tick immediately, then every TICK_INTERVAL_MS.
  void runBackfillTick().catch(() => {});

  _timer = setInterval(() => {
    void runBackfillTick().catch(() => {});
  }, TICK_INTERVAL_MS);

  console.log(JSON.stringify({
    event: "post_place_backfill.started",
    interval_ms: TICK_INTERVAL_MS,
    batch_size: BATCH_SIZE,
  }));
}
