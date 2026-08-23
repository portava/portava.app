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

export interface SweepResult {
  purged: number;
  skipped: boolean;
  /**
   * WHY this run did nothing. An error and a disabled flag both used to return
   * `{purged:0, skipped:true}`, which made a persistently failing sweep
   * indistinguishable from one nobody had switched on — the same shape as the
   * original defect (a documented expiry that nothing enforced).
   */
  reason: "disabled" | "no_client" | "error" | null;
}

export async function runIntelRetentionSweep(opts: { client?: any } = {}): Promise<SweepResult> {
  // Explicit null means "no client"; undefined means "use the service client if
  // available" — the house pattern (dailyBriefCleanup, inviteSlotSweeper).
  //
  // This was `opts.client ?? getServiceClient()`, and `??` does NOT short-circuit
  // on an explicit null: `null ?? f()` calls f(). CI runs the suite with the
  // Supabase URL env var pointed at a closed port (127.0.0.1:9), so a test
  // passing `client: null` got a REAL client, spent ~7s failing to connect, and
  // reported reason
  // "error" instead of "no_client". It passed locally only because a dev machine
  // has that variable unset, so getServiceClient() returned null there. A unit test
  // must not depend on the absence of an env var — or open a socket at all.
  const db =
    "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { purged: 0, skipped: true, reason: "no_client" };
  if (!(await isFlagEnabled(db, "intel_retention_sweep_enabled"))) {
    return { purged: 0, skipped: true, reason: "disabled" };
  }

  try {
    const { data, error } = await db.rpc("purge_expired_intel_snapshots");
    if (error) {
      logger.warn({ err: error }, "intel retention sweep failed");
      return { purged: 0, skipped: true, reason: "error" };
    }
    // The function returns bigint, which can arrive as a STRING over PostgREST
    // (int8 exceeds JS safe-integer range, so it is not always emitted as a JSON
    // number). A `typeof data === "number"` guard silently reported 0 for every
    // successful purge. Coerce instead.
    const purged = Number(data) || 0;
    if (purged > 0) logger.info({ purged }, "intel retention sweep removed expired snapshots");
    return { purged, skipped: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "intel retention sweep threw");
    return { purged: 0, skipped: true, reason: "error" };
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
