/**
 * Location snapshot purge scheduler — deletes location_snapshots past expires_at.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * services/location/LocationSafetyService.ts writes raw lat/lng into
 * public.location_snapshots on every location update and geofence check-in. The
 * table carries `expires_at DEFAULT now() + 24 hours`, and the anti-spoof read
 * path correctly filters `.gt("expires_at", now)` — so the FEATURE behaves as
 * though the data expires after a day.
 *
 * It never did. purgeExpiredSnapshots() — whose own docstring says "call from
 * cleanup job" — had exactly one reference in the repository: its own
 * definition. No cleanup job existed. Twenty schedulers start in index.ts and
 * none of them was this one. The practical result was a permanent, per-user,
 * timestamped precise-coordinate trail that was invisible to the code that
 * created it (every reader filters it out) and invisible to account deletion
 * (location_snapshots is not in the deletion cascade).
 *
 * ── WHY PURGING IS BEHAVIOURALLY INVISIBLE ──────────────────────────────────
 * public.location_snapshots has exactly three touch points, all in
 * LocationSafetyService.ts: one SELECT that already excludes expired rows
 * (:80-83), one INSERT (:121), and this purge (:224). Because the only reader
 * filters on expires_at, deleting expired rows cannot change any result. This
 * removes data that is already unreachable by every read path.
 *
 * ── WHY IT IS STILL FLAG-GATED ──────────────────────────────────────────────
 * DELETE is irreversible, and this repository has a precedent for exactly that
 * shape: accountDeletionScheduler gates its irreversible work behind
 * `account_deletion_worker_enabled` and fails closed, so starting it in index.ts
 * is safe before the flag is ever turned on. This follows that pattern. The
 * scheduler can therefore be wired now and enabled deliberately, and the first
 * enable can be watched.
 *
 * The flag is read through the SHARED lib/featureFlags.ts isFlagEnabled(), which
 * already returns false on an absent row, an unreadable table or any error. A
 * purge that cannot confirm it is permitted does not run. Note this deliberately
 * does NOT define a local isFlagEnabled: check-flag-polarity rejects such shadow
 * readers, because a function wearing a shared helper's name while carrying its
 * own polarity is exactly what makes a call-site check worthless.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { purgeExpiredSnapshots } from "../services/location/LocationSafetyService.js";

/** Startup delay keeps boot cheap; the backlog is not urgent to the second. */
const STARTUP_DELAY_MS = 5 * 60 * 1000;
/** Hourly. expires_at is 24h, so hourly bounds overshoot to ~4% of the window. */
const INTERVAL_MS = 60 * 60 * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface PurgeResult {
  purged: number;
  skipped: boolean;
}

/**
 * Run one purge pass. Exported for tests and for a manual operator run.
 * `opts.client` is test-injectable, matching the house scheduler pattern.
 */
export async function runLocationSnapshotPurge(
  opts: { client?: any } = {},
): Promise<PurgeResult> {
  const db = opts.client ?? getServiceClient();
  if (!db) return { purged: 0, skipped: true };

  if (!(await isFlagEnabled(db, "location_snapshot_purge_enabled"))) {
    return { purged: 0, skipped: true };
  }

  const purged = await purgeExpiredSnapshots(db);
  if (purged > 0) {
    // Count only — never a user id, never a coordinate.
    logger.info({ purged }, "location snapshot purge removed expired rows");
  }
  return { purged, skipped: false };
}

export function startLocationSnapshotPurgeScheduler(): void {
  if (_timer !== null) return; // already started
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: "location_snapshot_purge_enabled" },
    "LocationSnapshotPurgeScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runLocationSnapshotPurge()
      .catch((err) => logger.warn({ err }, "location snapshot purge failed"))
      .finally(() => {
        _timer = setTimeout(tick, INTERVAL_MS);
      });
  }, STARTUP_DELAY_MS);
}

export function stopLocationSnapshotPurgeScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
