/**
 * Compass Sense Scheduler — Phase 11 background evaluator.
 *
 * Sense signals used to be evaluated ONLY when the client called
 * POST /api/compass/sense/check (e.g. on app open). But a "leave earlier" or
 * "saved event starting" alert is most valuable when the user is NOT looking
 * at the app. This scheduler periodically runs the exact same
 * CompassSenseEngine.runSense pipeline server-side so nudges reach users
 * through push even when the app is closed.
 *
 * Guarantees:
 *   - Only opted-in users are evaluated: the sweep selects users whose
 *     compass_sense_settings.presence_level is 'aware' or 'active'.
 *     Passive users (including everyone without a settings row — passive is
 *     the default) are never touched.
 *   - Every existing gate holds unchanged, because delivery goes through
 *     runSense itself: presence level → per-category permission → quiet
 *     hours → dedupe → daily cap. Dedupe and caps are durable via the
 *     compass_sense_nudges table, so they hold ACROSS job ticks and across
 *     job/app-open interleavings.
 *   - Push delivery uses the existing NotificationRouter pathway inside
 *     runSense — no separate send path.
 *   - Gated on COMPASS_ENABLED like every Compass surface; flag off → the
 *     sweep is a no-op.
 *
 * Follows the compassAbuseScanScheduler pattern: initial run shortly after
 * server start, fixed interval thereafter, per-user errors swallowed so the
 * sweep never crashes the server.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { isCompassEnabled } from "../compass/flags.js";
import { runSense } from "../compass/CompassSenseEngine.js";

const logger = rootLogger.child({ job: "CompassSenseScheduler" });

const STARTUP_DELAY_MS = 60_000;        // 1 minute — let Supabase client init
const SWEEP_INTERVAL_MS = 15 * 60_000;  // every 15 minutes
/** Upper bound on users evaluated per tick — keeps a single sweep cheap. */
const MAX_USERS_PER_SWEEP = 500;

// ── test hooks ────────────────────────────────────────────────────────────────

let _testClient: SupabaseClient | null = null;
/** Inject a fake Supabase client in tests; pass null to restore. */
export function _setTestClient(sc: SupabaseClient | null): void {
  _testClient = sc;
}

export interface SenseSweepSummary {
  usersEvaluated: number;
  nudgesDelivered: number;
  errors: number;
}

/**
 * One sweep: find opted-in (aware/active) users and run the full Sense
 * pipeline for each. Passive users are excluded at the query level and —
 * belt-and-suspenders — runSense re-checks presence per user, so a user who
 * flips to passive mid-sweep still gets nothing.
 */
export async function runSenseSweep(
  opts: { hourUtc?: number; nowMinutes?: number; nowMs?: number } = {},
): Promise<SenseSweepSummary> {
  const summary: SenseSweepSummary = { usersEvaluated: 0, nudgesDelivered: 0, errors: 0 };

  const sc = _testClient ?? (isServiceClientReady ? getServiceClient() : null);
  if (!sc) return summary;

  const enabled = await isCompassEnabled(sc).catch(() => false);
  if (!enabled) return summary;

  // Opted-in users only. Passive is the default (no row = passive), so
  // selecting aware/active rows is the complete opt-in set.
  const { data, error } = await (sc as any)
    .from("compass_sense_settings")
    .select("user_id, presence_level")
    .in("presence_level", ["aware", "active"])
    .limit(MAX_USERS_PER_SWEEP);

  if (error) {
    logger.warn({ err: error }, "CompassSenseScheduler: opted-in user query failed");
    summary.errors += 1;
    return summary;
  }

  const userIds = Array.from(
    new Set(((data ?? []) as any[]).map((r) => String(r.user_id)).filter(Boolean)),
  );

  for (const userId of userIds) {
    try {
      const result = await runSense(sc, userId, opts);
      summary.usersEvaluated += 1;
      summary.nudgesDelivered += result.delivered.length;
    } catch (err) {
      summary.errors += 1;
      logger.warn({ err, userId }, "CompassSenseScheduler: runSense failed for user");
    }
  }

  if (summary.usersEvaluated > 0 || summary.errors > 0) {
    logger.info(summary, "CompassSenseScheduler: sweep completed");
  }
  return summary;
}

/**
 * Start the periodic background Sense evaluator.
 * Returns the interval handle so callers can cancel it in tests.
 */
export function startCompassSenseScheduler(): ReturnType<typeof setInterval> {
  const startupTimer = setTimeout(() => {
    runSenseSweep().catch((err) =>
      logger.warn({ err }, "CompassSenseScheduler: initial sweep error"),
    );
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    runSenseSweep().catch((err) =>
      logger.warn({ err }, "CompassSenseScheduler: sweep error"),
    );
  }, SWEEP_INTERVAL_MS);

  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  logger.info(
    { intervalMinutes: SWEEP_INTERVAL_MS / 60_000 },
    "CompassSenseScheduler: periodic Sense evaluator started",
  );
  return interval;
}
