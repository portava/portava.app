/**
 * Intel retention sweep — deletes intel_state_snapshots past expires_at.
 *
 * Ships with the tables it sweeps, deliberately. location_snapshots carried
 * expires_at for months with no cleanup job: the only purge function had a single
 * reference in the whole repository, its own definition. Readers filtered on
 * expiry so the feature looked correct while rows accumulated forever. 2130 gives
 * the intel tables the same shape, so the sweeper lands in the same band.
 *
 * Only DERIVED state is swept. Snapshots are recomputable from claims and an
 * expired one is already invisible (liveClaimRead filters it in the query), so
 * this is hygiene, not data loss. intel_observations is contributor content and
 * its retention window is an owner policy decision — see 2133's header.
 *
 * Flag-gated and fail-closed, following accountDeletionScheduler: DELETE is
 * irreversible, so starting this in index.ts is safe before the flag is on.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";

const STARTUP_DELAY_MS = 7 * 60 * 1000;
const INTERVAL_MS = 60 * 60 * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface SweepResult { purged: number; skipped: boolean }

export async function runIntelRetentionSweep(opts: { client?: any } = {}): Promise<SweepResult> {
  const db = opts.client ?? getServiceClient();
  if (!db) return { purged: 0, skipped: true };
  if (!(await isFlagEnabled(db, "intel_retention_sweep_enabled"))) return { purged: 0, skipped: true };

  try {
    const { data, error } = await db.rpc("purge_expired_intel_snapshots");
    if (error) {
      logger.warn({ err: error }, "intel retention sweep failed");
      return { purged: 0, skipped: true };
    }
    const purged = typeof data === "number" ? data : 0;
    if (purged > 0) logger.info({ purged }, "intel retention sweep removed expired snapshots");
    return { purged, skipped: false };
  } catch (err) {
    logger.warn({ err }, "intel retention sweep threw");
    return { purged: 0, skipped: true };
  }
}

export function startIntelRetentionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: "intel_retention_sweep_enabled" },
    "IntelRetentionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runIntelRetentionSweep()
      .catch((err) => logger.warn({ err }, "intel retention sweep failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelRetentionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
