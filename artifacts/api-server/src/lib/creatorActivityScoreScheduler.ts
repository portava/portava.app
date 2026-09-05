/**
 * Creator Activity Score Scheduler
 *
 * Background job that recalculates CreatorActivityScores for stale users on a
 * configurable schedule (default: every 4 hours).
 *
 * Strategy:
 *   - Gated on ACTIVITY_DISCOVERY_BOOST_ENABLED feature flag; when the flag
 *     is disabled the job is a no-op so operators can pause recalculation
 *     without a code deploy.
 *   - Processes users in batches of BATCH_SIZE ordered by calculated_at ASC
 *     NULLS FIRST so the stalest (or never-calculated) users come first.
 *   - Only recalculates users whose score is missing OR older than
 *     STALE_THRESHOLD_MS (default: 6 hours).
 *   - Guards against concurrent duplicate runs with an in-process flag.
 *   - Per-user errors are swallowed so a single failure never aborts the batch.
 *
 * Follows the compassSenseScheduler / compassAbuseScanScheduler pattern.
 *
 * COLD START: THIS JOB CANNOT SEED ITSELF
 * --------------------------------------
 * The candidate pool is (stale rows in `creator_activity_scores`) ∪ (actor_ids
 * seen in `activity_events` in the last 90 days). `creator_activity_scores`
 * has exactly one writer — persistActivityScore, called from this job — and
 * `activity_events` has no producer at all (see the header of
 * services/ranking/CreatorActivityScoreService.ts). So on an empty
 * creator_activity_scores the union is empty, the batch is empty, and the job
 * logs "no stale users" forever: no creator is ever scored a first time, and
 * DiscoveryRankingService's activity boost stays at its no-row default.
 *
 * The fix is a real never-scored pool, and the obvious source is the same set
 * of contribution tables the scorer itself already reads (posts, events,
 * trips, reviews, discovery_places — all of which do have producers). That
 * changes who gets ranked and how, so it is left as an owner decision rather
 * than slipped in here.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { calculateAndPersistScore } from "../services/ranking/CreatorActivityScoreService.js";
import { getConfigValue }           from "../services/ranking/rankingConfig.js";

const logger = rootLogger.child({ job: "CreatorActivityScoreScheduler" });

// ── Constants ─────────────────────────────────────────────────────────────────

const STARTUP_DELAY_MS    = 2 * 60_000;          // 2 min — let other init finish
const JOB_INTERVAL_MS     = 4 * 60 * 60_000;     // every 4 hours
const BATCH_SIZE          = 500;
const STALE_THRESHOLD_MS  = 6 * 60 * 60_000;     // 6 hours

// ── In-process concurrency guard ──────────────────────────────────────────────

let _running = false;

// ── Test hooks ────────────────────────────────────────────────────────────────

let _testClient: any | null = null;
/** Inject a fake Supabase client in tests; pass null to restore. */
export function _setTestClient(sc: any | null): void {
  _testClient = sc;
}

let _testCalculate: typeof calculateAndPersistScore | null = null;
/** Inject a fake calculateAndPersistScore in tests; pass null to restore. */
export function _setTestCalculateFn(fn: typeof calculateAndPersistScore | null): void {
  _testCalculate = fn;
}

// ── Job summary type ──────────────────────────────────────────────────────────

export interface ActivityScoreJobSummary {
  usersProcessed: number;
  usersSkipped:   number;
  errors:         number;
  alreadyRunning: boolean;
  flagDisabled:   boolean;
}

// ── Feature-flag gate ─────────────────────────────────────────────────────────

async function isJobEnabled(db: any): Promise<boolean> {
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "ACTIVITY_DISCOVERY_BOOST_ENABLED")
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    // Fail-safe: if we can't read the flag, skip the job rather than run
    // unexpectedly on a degraded connection.
    return false;
  }
}

// ── Core batch runner ─────────────────────────────────────────────────────────

/**
 * Run one batch of stale-user recalculations.
 * Returns a summary. Never throws.
 */
export async function runActivityScoreJob(): Promise<ActivityScoreJobSummary> {
  const summary: ActivityScoreJobSummary = {
    usersProcessed: 0,
    usersSkipped:   0,
    errors:         0,
    alreadyRunning: false,
    flagDisabled:   false,
  };

  if (_running) {
    logger.info("CreatorActivityScoreScheduler: previous run still in-flight — skipping tick");
    summary.alreadyRunning = true;
    return summary;
  }

  const db = _testClient ?? (isServiceClientReady ? getServiceClient() : null);
  if (!db) return summary;

  // Feature-flag gate — if disabled, skip silently.
  const enabled = await isJobEnabled(db);
  if (!enabled) {
    summary.flagDisabled = true;
    return summary;
  }

  _running = true;
  try {
    // Read half-life from ranking_config (falls back to 14 days)
    const halfLifeDays = await getConfigValue(db, "ranking.activity.decayHalfLifeDays", 14);

    // Find stale rows (calculated_at older than STALE_THRESHOLD_MS)
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    const { data: staleRows, error: staleErr } = await (db as any)
      .from("creator_activity_scores")
      .select("user_id")
      .lt("calculated_at", staleThreshold)
      .order("calculated_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (staleErr) {
      logger.warn({ err: staleErr }, "CreatorActivityScoreScheduler: stale-user query failed");
      summary.errors += 1;
      return summary;
    }

    const staleIds = new Set<string>(
      ((staleRows as any[]) ?? []).map((r) => String(r.user_id)).filter(Boolean),
    );

    // Also pick up users with recent activity who have never been scored.
    // Use activity_events (actor_id) from the last 90 days as the candidate pool.
    const { data: activeRows, error: activeErr } = await (db as any)
      .from("activity_events")
      .select("actor_id")
      .gte("created_at", new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString())
      .limit(BATCH_SIZE);

    const newIds = new Set<string>();
    if (!activeErr) {
      for (const r of (activeRows as any[]) ?? []) {
        const id = String(r.actor_id ?? "");
        if (id && !staleIds.has(id)) newIds.add(id);
      }
    }

    // Merge: stale first, then new, up to BATCH_SIZE
    const userIds = [...staleIds, ...newIds].slice(0, BATCH_SIZE);

    if (userIds.length === 0) {
      logger.info("CreatorActivityScoreScheduler: no stale users — skipping batch");
      return summary;
    }

    logger.info(
      { count: userIds.length, halfLifeDays },
      "CreatorActivityScoreScheduler: processing batch",
    );

    const calculateFn = _testCalculate ?? calculateAndPersistScore;

    for (const userId of userIds) {
      try {
        const result = await calculateFn(db, userId, halfLifeDays);
        if (result !== null) {
          summary.usersProcessed += 1;
        } else {
          summary.errors += 1;
        }
      } catch (err) {
        summary.errors += 1;
        logger.warn({ err, userId }, "CreatorActivityScoreScheduler: per-user error");
      }
    }

    logger.info(summary, "CreatorActivityScoreScheduler: batch complete");
    return summary;
  } catch (err) {
    logger.warn({ err }, "CreatorActivityScoreScheduler: unexpected job error");
    summary.errors += 1;
    return summary;
  } finally {
    _running = false;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the periodic CreatorActivityScore recalculation job.
 * Returns the interval handle so tests can cancel it.
 */
export function startCreatorActivityScoreScheduler(): ReturnType<typeof setInterval> {
  const startupTimer = setTimeout(() => {
    runActivityScoreJob().catch((err) =>
      logger.warn({ err }, "CreatorActivityScoreScheduler: initial run error"),
    );
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    runActivityScoreJob().catch((err) =>
      logger.warn({ err }, "CreatorActivityScoreScheduler: tick error"),
    );
  }, JOB_INTERVAL_MS);

  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  logger.info(
    { intervalHours: JOB_INTERVAL_MS / 3_600_000, batchSize: BATCH_SIZE },
    "CreatorActivityScoreScheduler: started",
  );

  return interval;
}
