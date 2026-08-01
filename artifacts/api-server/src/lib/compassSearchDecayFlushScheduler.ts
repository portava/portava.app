/**
 * CompassSearchDecayFlushScheduler
 *
 * A daily background job that writes time-decayed search-signal weights back
 * to the DB so repeated profile reads don't each recompute the same decay.
 *
 * ## Why
 * `getDecayedWeights` (called on every Compass profile build) applies decay
 * on-read. This is correct and non-destructive, but means:
 *   (a) per-read computation is wasted — the stored weight is always the
 *       pre-decay value, so every read re-derives the same decay.
 *   (b) the stored `category_weights` in `compass_user_preferences` diverges
 *       from the effective value, breaking direct inspection in admin tooling
 *       or analytics.
 *
 * ## What the flush does (per user)
 *   1. Reads the user's `compass_search_signal_log` rows.
 *   2. Computes the post-decay effective `search_weight` for each row:
 *        effectiveSw = round(search_weight × 0.5 ^ (age_days / halfLifeDays))
 *   3. Applies `applySearchDecay` to get the updated `category_weights`.
 *   4. Upserts the decayed weights back to `compass_user_preferences`.
 *   5. For every log row whose weight changed: resets
 *        search_weight  = effectiveSw   (the new post-decay baseline)
 *        last_nudge_at  = now()          (so the next read-side decay starts
 *                                         from this baseline, not the old time)
 *
 * Resetting `last_nudge_at` is essential: without it the next read-side call
 * would compute age from the old timestamp against the already-decayed
 * `search_weight`, double-applying decay.
 *
 * ## Guarantees
 *   - No-ops when `SEARCH_SIGNAL_DECAY_DAYS` is disabled in feature_flags.
 *   - Overlap guard: a second daily tick is skipped if the previous is still
 *     in flight.
 *   - Per-user errors are logged and skipped; the job never crashes the server.
 *   - Fail-soft: any DB failure is caught; no-op is always safe (decay falls
 *     back to the read-side path).
 *
 * Follows the intelligenceGraphScheduler pattern.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import {
  getDecayConfig,
  applySearchDecay,
  type SearchSignalRow,
} from "../compass/CompassSearchDecayService.js";

const logger = rootLogger.child({ job: "CompassSearchDecayFlushScheduler" });

const STARTUP_DELAY_MS  = 60_000;           // 1 minute
const FLUSH_INTERVAL_MS = 24 * 60 * 60_000; // daily

/**
 * Rows fetched per pagination page when iterating distinct users.
 * We order by user_id and use a cursor, so this is rows-per-page, not a
 * total cap — all users in the table are eventually covered across pages.
 */
const PAGE_SIZE = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DecayFlushReport {
  usersProcessed:  number;
  usersSkipped:    number;
  weightsUpdated:  number;
  logRowsReset:    number;
  durationMs:      number;
}

export type FlushRunResult =
  | { status: "completed"; report: DecayFlushReport }
  | { status: "skipped";   reason: "disabled" | "overlap" | "no_service_client" }
  | { status: "failed" };

// ── Test hooks ────────────────────────────────────────────────────────────────

type FlushFn = (
  db:           SupabaseClient,
  halfLifeDays: number,
  nowMs?:       number,
) => Promise<DecayFlushReport>;

let _testFlushFn: FlushFn | null = null;
export function _setTestFlushFn(fn: FlushFn | null): void { _testFlushFn = fn; }

let _testGetClient: (() => SupabaseClient | null) | null = null;
export function _setTestGetClient(fn: (() => SupabaseClient | null) | null): void {
  _testGetClient = fn;
}

// ── Overlap guard ─────────────────────────────────────────────────────────────

let running = false;

// ── Core flush ────────────────────────────────────────────────────────────────

/**
 * Flush decayed weights for all users that have signal log rows.
 *
 * Iterates users via cursor-based pagination ordered by user_id so that ALL
 * users in the table are covered regardless of how many category rows each
 * has — a flat LIMIT on raw rows would under-count users when a few have many
 * categories.
 *
 * Exported so it can be tested directly and called from admin routes.
 */
export async function flushDecayForAllUsers(
  db:           SupabaseClient,
  halfLifeDays: number,
  nowMs:        number = Date.now(),
): Promise<DecayFlushReport> {
  const nowIso = new Date(nowMs).toISOString();

  let usersProcessed = 0;
  let usersSkipped   = 0;
  let weightsUpdated = 0;
  let logRowsReset   = 0;

  // Cursor-based pagination: advance through distinct user_ids ordered
  // ascending.  Each page returns PAGE_SIZE raw rows; within the page we
  // de-duplicate adjacent same-user rows, then advance the cursor past the
  // last user_id seen.  Stops when a page returns fewer than PAGE_SIZE rows.
  let cursor = ""; // empty string sorts before all UUIDs
  while (true) {
    const { data: pageRows, error: pageErr } = await (db as any)
      .from("compass_search_signal_log")
      .select("user_id")
      .gt("user_id", cursor)
      .order("user_id")
      .limit(PAGE_SIZE);

    if (pageErr) {
      logger.warn({ err: pageErr }, "CompassSearchDecayFlush: failed to fetch user IDs page");
      break;
    }

    const rows = (pageRows as any[]) ?? [];
    if (rows.length === 0) break;

    // Collect distinct user_ids from this page (rows are ordered by user_id,
    // so equal values are adjacent — a single pass suffices).
    const pageUserIds: string[] = [];
    let lastSeen = "";
    for (const row of rows) {
      const uid = row.user_id as string;
      if (uid !== lastSeen) {
        pageUserIds.push(uid);
        lastSeen = uid;
      }
    }

    for (const userId of pageUserIds) {
      try {
        const result = await flushDecayForUser(db, userId, halfLifeDays, nowMs, nowIso);
        usersProcessed++;
        if (result.weightUpdated) weightsUpdated++;
        logRowsReset += result.rowsReset;
      } catch (err) {
        logger.warn({ err, userId }, "CompassSearchDecayFlush: per-user flush failed — skipping");
        usersSkipped++;
      }
    }

    // Advance cursor to the last user_id seen in this page.
    cursor = lastSeen;

    // Fewer rows than PAGE_SIZE means we've exhausted the table.
    if (rows.length < PAGE_SIZE) break;
  }

  return { usersProcessed, usersSkipped, weightsUpdated, logRowsReset, durationMs: 0 };
}

interface UserFlushResult {
  weightUpdated: boolean;
  rowsReset:     number;
}

async function flushDecayForUser(
  db:           SupabaseClient,
  userId:       string,
  halfLifeDays: number,
  nowMs:        number,
  nowIso:       string,
): Promise<UserFlushResult> {
  // When half-life is zero or negative, applySearchDecay is a no-op (returns
  // the original weights unchanged).  computeEffectiveSw would compute
  // 0.5^(age/0) = 0 and incorrectly attempt to reset log rows, so bail early.
  if (halfLifeDays <= 0) return { weightUpdated: false, rowsReset: 0 };

  // 1. Fetch signal rows for this user.
  const { data: signalData, error: signalErr } = await db
    .from("compass_search_signal_log")
    .select("category, last_nudge_at, search_weight")
    .eq("user_id", userId);

  if (signalErr || !signalData) return { weightUpdated: false, rowsReset: 0 };

  const signalRows: SearchSignalRow[] = (signalData as any[]) ?? [];
  if (signalRows.length === 0) return { weightUpdated: false, rowsReset: 0 };

  // 2. Fetch stored category_weights.
  const { data: prefData } = await db
    .from("compass_user_preferences")
    .select("category_weights")
    .eq("user_id", userId)
    .maybeSingle();

  const storedWeights: Record<string, number> =
    ((prefData as any)?.category_weights as Record<string, number>) ?? {};

  // 3. Compute per-row effective search_weight values.
  const effectiveSwByCategory = computeEffectiveSw(signalRows, halfLifeDays, nowMs);

  // 4. Apply decay to get updated category_weights.
  const decayedWeights = applySearchDecay(storedWeights, signalRows, halfLifeDays, nowMs);

  // 5. Check if any weight actually changed.
  const weightsChanged = hasWeightsChanged(storedWeights, decayedWeights);

  if (weightsChanged) {
    const { error: upsertErr } = await db
      .from("compass_user_preferences")
      .upsert(
        {
          user_id:          userId,
          category_weights: decayedWeights,
          updated_at:       nowIso,
        },
        { onConflict: "user_id" },
      );
    if (upsertErr) {
      logger.warn({ err: upsertErr, userId }, "CompassSearchDecayFlush: weight upsert failed");
      // Do NOT advance log baselines when weights could not be persisted.
      // Leaving search_weight and last_nudge_at unchanged means the original
      // decay contribution is preserved — the read-side getDecayedWeights call
      // will still derive the correct effective weight on the next profile
      // build.  Resetting log rows here would lose that information and cause
      // the un-persisted decay to be silently dropped forever.
      return { weightUpdated: false, rowsReset: 0 };
    }
  }

  // 6. Reset log rows that actually decayed to the new baseline.
  //    We only reach here when either (a) no weight change was needed, or
  //    (b) the weight upsert succeeded — so the stored weights are now in sync
  //    and it is safe to advance the log baselines.
  let rowsReset = 0;
  for (const row of signalRows) {
    const effectiveSw = effectiveSwByCategory.get(row.category);
    if (effectiveSw === undefined) continue;
    if (effectiveSw >= row.search_weight) continue; // no decay happened

    const { error: updateErr } = await db
      .from("compass_search_signal_log")
      .update({ search_weight: effectiveSw, last_nudge_at: nowIso })
      .eq("user_id", userId)
      .eq("category", row.category);

    if (updateErr) {
      logger.warn(
        { err: updateErr, userId, category: row.category },
        "CompassSearchDecayFlush: log row reset failed",
      );
    } else {
      rowsReset++;
    }
  }

  return { weightUpdated: weightsChanged, rowsReset };
}

/** Compute post-decay effective search_weight for each category. */
function computeEffectiveSw(
  rows:         SearchSignalRow[],
  halfLifeDays: number,
  nowMs:        number,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (!row.category || row.search_weight <= 0) continue;
    const nudgeMs = new Date(row.last_nudge_at).getTime();
    if (isNaN(nudgeMs)) continue;
    const ageDays     = Math.max(0, (nowMs - nudgeMs) / 86_400_000);
    const decayFactor = Math.pow(0.5, ageDays / halfLifeDays);
    result.set(row.category, Math.round(row.search_weight * decayFactor));
  }
  return result;
}

function hasWeightsChanged(
  before: Record<string, number>,
  after:  Record<string, number>,
): boolean {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if ((before[k] ?? 0) !== (after[k] ?? 0)) return true;
  }
  return false;
}

// ── Scheduler tick ────────────────────────────────────────────────────────────

/**
 * Run one scheduled decay flush. Never throws:
 *   - no-ops when SEARCH_SIGNAL_DECAY_DAYS is disabled,
 *   - skips when a previous flush is still in flight,
 *   - skips when the service client is unavailable,
 *   - logs and swallows any flush failure.
 */
export async function runDecayFlushOnce(): Promise<FlushRunResult> {
  if (running) {
    logger.info("CompassSearchDecayFlush: previous flush still running — skipping this tick");
    return { status: "skipped", reason: "overlap" };
  }

  const sc = _testGetClient ? _testGetClient() : getServiceClient();
  if (!sc) {
    logger.warn("CompassSearchDecayFlush: service client unavailable — skipping flush");
    return { status: "skipped", reason: "no_service_client" };
  }

  // Check flag — if disabled, no-op.
  const config = await getDecayConfig(sc);
  if (!config.enabled) {
    logger.info("CompassSearchDecayFlush: SEARCH_SIGNAL_DECAY_DAYS disabled — skipping flush");
    return { status: "skipped", reason: "disabled" };
  }

  running = true;
  const startedAt = Date.now();
  try {
    const flush = _testFlushFn ?? flushDecayForAllUsers;
    const rawReport = await flush(sc, config.halfLifeDays);
    const report: DecayFlushReport = { ...rawReport, durationMs: Date.now() - startedAt };
    logger.info(report, "CompassSearchDecayFlush: daily flush completed");
    return { status: "completed", report };
  } catch (err) {
    logger.error(
      { err, durationMs: Date.now() - startedAt },
      "CompassSearchDecayFlush: daily flush failed",
    );
    return { status: "failed" };
  } finally {
    running = false;
  }
}

// ── Scheduler start ───────────────────────────────────────────────────────────

/**
 * Start the daily search-decay flush scheduler.
 * Returns the interval handle so callers can cancel it in tests.
 */
export function startCompassSearchDecayFlushScheduler(): ReturnType<typeof setInterval> {
  const startupTimer = setTimeout(() => {
    runDecayFlushOnce().catch(() => {});
  }, STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    runDecayFlushOnce().catch(() => {});
  }, FLUSH_INTERVAL_MS);

  interval.unref();
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  logger.info(
    { intervalHours: FLUSH_INTERVAL_MS / 3_600_000 },
    "CompassSearchDecayFlush: daily scheduler started",
  );

  return interval;
}
