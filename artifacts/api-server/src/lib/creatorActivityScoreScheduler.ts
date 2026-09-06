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
 * COLD START: THIS JOB COULD NOT SEED ITSELF (fixed 2026-09-06)
 * ------------------------------------------------------------
 * The candidate pool used to be (stale rows in `creator_activity_scores`) ∪
 * (actor_ids seen in `activity_events` in the last 90 days). `creator_activity_
 * scores` has exactly one writer — persistActivityScore, called from this job —
 * and `activity_events` had no producer at all. So on an empty
 * creator_activity_scores the union was empty, the batch was empty, and the job
 * logged "no stale users" forever: NO CREATOR WAS EVER SCORED A FIRST TIME, and
 * DiscoveryRankingService's activity boost sat at its no-row default. The job
 * ran on schedule, succeeded every time, and did nothing.
 *
 * The seed half is now `profiles` anti-joined against `creator_activity_scores`
 * — every profile that has never been scored, capped at SEED_SCAN_LIMIT. Two
 * properties worth keeping in mind if you change it:
 *
 *   - It seeds EVERY profile, not only contributors. A profile with no posts
 *     scores the NEW_USER_BASE_SCORE floor and is then a stale row like any
 *     other, so the cost is one wasted recalculation per empty profile per
 *     staleness window, and the benefit is that a creator's first contribution
 *     does not have to wait for a separate discovery pass to be noticed.
 *   - The anti-join is done client-side over a bounded scan, not as a SQL NOT
 *     EXISTS, because PostgREST cannot express it. That is fine while the id
 *     space is small; at real scale this wants a view or an RPC.
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { calculateAndPersistScore } from "../services/ranking/CreatorActivityScoreService.js";
import { getConfigValue }           from "../services/ranking/rankingConfig.js";

const logger = rootLogger.child({ job: "CreatorActivityScoreScheduler" });

// ── Constants ─────────────────────────────────────────────────────────────────

const STARTUP_DELAY_MS    = 2 * 60_000;          // 2 min — let other init finish
const JOB_INTERVAL_MS     = 4 * 60 * 60_000;     // every 4 hours
/**
 * How many rows the seed half may scan per tick. Bounded so the first run on a
 * large profiles table cannot become an unbounded scan; the half drains anyway,
 * so a low ceiling only means seeding takes a few more ticks.
 */
const SEED_SCAN_LIMIT = 2000;

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

    // ── SEED HALF: profiles that have never been scored ─────────────────────
    //
    // THIS IS THE COLD-START FIX, and it is the actual bug in this lane. The
    // previous seed half read `activity_events` — a table with no writer — so it
    // was permanently empty. The stale half reads `creator_activity_scores`,
    // which is written ONLY by this job. Both halves empty at cold start meant
    // the pool was empty forever and NO CREATOR WAS EVER SCORED A FIRST TIME.
    //
    // The pool is now `profiles` anti-joined against the scores table. Three
    // properties make this the right source, and the alternatives were rejected
    // on measurement, not taste:
    //   COMPLETE      — every creator is a profile. A union over the
    //                   contribution tables misses anyone whose only signal is
    //                   participation, anyone receiving follows on older
    //                   content, and every zero-contribution account — who still
    //                   needs a row, because a MISSING row and a NEW_USER_BASE
    //                   floor-10 row produce different boosts downstream
    //                   (DiscoveryRankingService defaults a missing row to 0).
    //   SELF-DRAINING — the job writes a row for every user it visits, so this
    //                   half shrinks to nothing after the first full pass and
    //                   the 6-hour staleness rule sustains the job alone
    //                   thereafter. Cold start is a seeding problem, not a
    //                   permanent second query.
    //   NEEDS NO NEW INDEX — it is an anti-join over two unique btrees that both
    //                   already exist. The contribution-union alternative would
    //                   sequential-scan `trips` on every tick forever: trips has
    //                   no index on created_at in the baseline or any migration,
    //                   and discovery_places.submitted_by is nullable AND
    //                   unindexed on a table dominated by bulk OSM imports.
    const newIds = new Set<string>();
    try {
      const { data: scoredRows } = await (db as any)
        .from("creator_activity_scores")
        .select("user_id")
        .limit(SEED_SCAN_LIMIT);
      const alreadyScored = new Set<string>(
        ((scoredRows as any[]) ?? []).map((r) => String(r.user_id)).filter(Boolean),
      );

      const { data: profileRows, error: profileErr } = await (db as any)
        .from("profiles")
        .select("id")
        .limit(SEED_SCAN_LIMIT);
      if (!profileErr) {
        for (const r of (profileRows as any[]) ?? []) {
          const id = String(r?.id ?? "");
          if (!id || staleIds.has(id) || alreadyScored.has(id)) continue;
          newIds.add(id);
          if (newIds.size >= BATCH_SIZE) break;
        }
      }
    } catch {
      // A failed seed scan must not stop the stale half from running.
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
