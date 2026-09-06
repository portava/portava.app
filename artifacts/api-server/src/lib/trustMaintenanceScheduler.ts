/**
 * TrustMaintenanceScheduler
 *
 * The missing driver for the Trust engine.
 *
 * The engine was fully built — TrustEventService records events, TrustScoreService
 * computes decayed weighted scores, TrustCapService imposes and expires ceilings,
 * TrustGamingDetectionService looks for farming — but nothing ever *drove* it.
 * `recalculateTrustScore` was called only from the admin routes, so on production
 * `trust_events` accumulated rows while `trust_profiles` stayed empty and
 * `last_recalculated_at` was NULL for every user. Scores were never computed.
 *
 * Three of the engine's properties only exist if something runs on a schedule:
 *
 *   - DECAY. Category scores are a decay-weighted mean over a 365-day event
 *     window (TrustScoreService.computeCategoryScore). The weight of every past
 *     event falls continuously, so a score is stale the moment it is written —
 *     even when the user does nothing. Without a periodic pass, a penalty never
 *     fades and good standing never rebuilds.
 *   - CAP EXPIRY. `applyEventCaps` writes ceilings with `expires_at` (7/14/30/60
 *     days). Nothing lifted them, so a time-limited ceiling was permanent — the
 *     opposite of the intended "recovers slowly".
 *   - PROBATION. `trust_profiles.probation_ends_at` had no reader, so probation
 *     never ended.
 *
 * Ordering within a pass is deliberate: caps are lifted and probation cleared
 * BEFORE recalculation, so the recalculated score reflects the ceilings that
 * apply now rather than the ones that applied last pass.
 *
 * Fail-soft by construction: every step is independently guarded, and one
 * failing step never prevents the others from running. A pass that throws is
 * counted and the scheduler continues.
 *
 * Gated behind the `trust_engine_enabled` feature flag and FAILS CLOSED — the
 * same gate `recordTrustEvent` uses, so events and scoring can never disagree
 * about whether the engine is on. Safe to start before the flag is enabled.
 *
 * Configuration (env vars)
 * ────────────────────────
 *   TRUST_MAINTENANCE_INTERVAL_HOURS    — pass interval          (default: 6)
 *   TRUST_MAINTENANCE_STARTUP_DELAY_MS  — delay before first run (default: 120 000)
 *   TRUST_MAINTENANCE_MAX_USERS         — max recalcs per pass   (default: 500)
 *   TRUST_MAINTENANCE_STALE_DAYS        — decay refresh age      (default: 7)
 */

import { getServiceClient } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";
import { recalculateTrustScore } from "../services/trust/TrustScoreService.js";
import { expireOldRestrictions } from "../services/trust/TrustRestrictionService.js";
import { expireOldCaps } from "../services/trust/TrustCapService.js";
import { runGamingDetectionScan } from "../services/trust/TrustGamingDetectionService.js";
import { isTrustEnabled } from "../services/trust/TrustEventService.js";

const logger = rootLogger.child({ service: "TrustMaintenanceScheduler" });

// ── Configuration ─────────────────────────────────────────────────────────────

function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

function parseEnvInt(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

const INTERVAL_HOURS = parseEnvFloat(process.env["TRUST_MAINTENANCE_INTERVAL_HOURS"], 6);

export const MAINTENANCE_INTERVAL_MS = INTERVAL_HOURS * 60 * 60 * 1_000;
export const STARTUP_DELAY_MS = parseEnvFloat(process.env["TRUST_MAINTENANCE_STARTUP_DELAY_MS"], 120_000);
export const MAX_USERS_PER_PASS = parseEnvInt(process.env["TRUST_MAINTENANCE_MAX_USERS"], 500);
export const STALE_DAYS = parseEnvFloat(process.env["TRUST_MAINTENANCE_STALE_DAYS"], 7);

/**
 * How far back to look for events when deciding who is dirty. Events older than
 * this can only matter via the decay refresh path, which is driven by
 * `last_recalculated_at` rather than by event age.
 */
const EVENT_LOOKBACK_DAYS = 30;

/** PostgREST `.in()` lists are URL-encoded — chunk so the query string stays sane. */
const ID_CHUNK = 100;

const DAY_MS = 24 * 60 * 60 * 1_000;

// ── Status ────────────────────────────────────────────────────────────────────

export interface TrustMaintenanceStatus {
  lastRunAt: string | null;
  lastCapsExpired: number;
  lastProbationCleared: number;
  lastUsersRecalculated: number;
  lastGamingFlagged: number;
  lastSkippedReason: string | null;
  consecutiveFailures: number;
}

const _status: TrustMaintenanceStatus = {
  lastRunAt: null,
  lastCapsExpired: 0,
  lastProbationCleared: 0,
  lastUsersRecalculated: 0,
  lastGamingFlagged: 0,
  lastSkippedReason: null,
  consecutiveFailures: 0,
};

export function getTrustMaintenanceStatus(): Readonly<TrustMaintenanceStatus> {
  return { ..._status };
}

/** Reset status between test runs — not for production use. */
export function _resetStatus(): void {
  _status.lastRunAt = null;
  _status.lastCapsExpired = 0;
  _status.lastProbationCleared = 0;
  _status.lastUsersRecalculated = 0;
  _status.lastGamingFlagged = 0;
  _status.lastSkippedReason = null;
  _status.consecutiveFailures = 0;
}

// ── Probation ─────────────────────────────────────────────────────────────────

/**
 * Clear probation whose end date has passed.
 *
 * `setProbation` (TrustRecoveryService) writes `on_probation` + `probation_ends_at`
 * but nothing ever read the end date, so probation never lifted.
 */
async function clearExpiredProbation(db: any): Promise<number> {
  try {
    const { data, error } = await db
      .from("trust_profiles")
      .update({ on_probation: false, updated_at: new Date().toISOString() })
      .eq("on_probation", true)
      .lt("probation_ends_at", new Date().toISOString())
      .select("user_id");
    if (error) {
      logger.warn({ err: error }, "clearExpiredProbation failed (non-fatal)");
      return 0;
    }
    return (data as any[])?.length ?? 0;
  } catch (err) {
    logger.warn({ err }, "clearExpiredProbation threw (non-fatal)");
    return 0;
  }
}

// ── Selecting who needs recalculation ─────────────────────────────────────────

/**
 * A user is "dirty" when they have a scoreable event newer than their last
 * recalculation — including the case where they have events but no
 * `trust_profiles` row at all, which is every user on production today.
 *
 * Only `applied` and `confirmed` events count, matching TrustScoreService.loadEvents.
 * Counting `pending_review` here would schedule recalculations that cannot change
 * the score, and would let an unconfirmed (possibly malicious) report generate load.
 */
async function findDirtyUsers(db: any, now: number): Promise<Set<string>> {
  const dirty = new Set<string>();
  const since = new Date(now - EVENT_LOOKBACK_DAYS * DAY_MS).toISOString();

  let events: any[] = [];
  try {
    const { data, error } = await db
      .from("trust_events")
      .select("user_id, created_at")
      .in("status", ["applied", "confirmed"])
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_USERS_PER_PASS * 20);
    if (error) {
      logger.warn({ err: error }, "findDirtyUsers: trust_events fetch failed (non-fatal)");
      return dirty;
    }
    events = (data as any[]) ?? [];
  } catch (err) {
    logger.warn({ err }, "findDirtyUsers: trust_events fetch threw (non-fatal)");
    return dirty;
  }

  // Newest event timestamp per user.
  const newestByUser = new Map<string, string>();
  for (const e of events) {
    const uid = e?.user_id;
    if (!uid) continue;
    const prev = newestByUser.get(uid);
    if (!prev || String(e.created_at) > prev) newestByUser.set(uid, String(e.created_at));
  }
  if (newestByUser.size === 0) return dirty;

  // Compare against each user's last recalculation.
  const ids = [...newestByUser.keys()];
  const lastRecalcByUser = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    try {
      const { data, error } = await db
        .from("trust_profiles")
        .select("user_id, last_recalculated_at")
        .in("user_id", chunk);
      if (error) {
        logger.warn({ err: error }, "findDirtyUsers: trust_profiles fetch failed (non-fatal)");
        continue;
      }
      for (const p of ((data as any[]) ?? [])) {
        lastRecalcByUser.set(p.user_id, p.last_recalculated_at ?? null);
      }
    } catch (err) {
      logger.warn({ err }, "findDirtyUsers: trust_profiles fetch threw (non-fatal)");
    }
  }

  for (const [uid, newestEventAt] of newestByUser) {
    if (!lastRecalcByUser.has(uid)) {
      dirty.add(uid); // no profile row yet
      continue;
    }
    const lastRecalc = lastRecalcByUser.get(uid);
    if (!lastRecalc || lastRecalc < newestEventAt) dirty.add(uid);
  }

  return dirty;
}

/**
 * Users whose score is simply old. Decay means a score drifts with no new
 * events, so scores must be refreshed periodically or they silently misrepresent
 * the user — in both directions.
 */
async function findStaleUsers(db: any, now: number, budget: number): Promise<string[]> {
  if (budget <= 0) return [];
  const cutoff = new Date(now - STALE_DAYS * DAY_MS).toISOString();
  try {
    const { data, error } = await db
      .from("trust_profiles")
      .select("user_id")
      .lt("last_recalculated_at", cutoff)
      .order("last_recalculated_at", { ascending: true })
      .limit(budget);
    if (error) {
      logger.warn({ err: error }, "findStaleUsers failed (non-fatal)");
      return [];
    }
    return ((data as any[]) ?? []).map((r) => r.user_id).filter(Boolean);
  } catch (err) {
    logger.warn({ err }, "findStaleUsers threw (non-fatal)");
    return [];
  }
}

// ── Core pass ─────────────────────────────────────────────────────────────────

export interface TrustMaintenanceResult {
  ok: boolean;
  skipped?: boolean;
  skipReason?: string;
  capsExpired: number;
  restrictionsExpired: number;
  /** True when the restriction sweep could not tell — DISTINCT from 0 expired. */
  restrictionSweepFailed: boolean;
  probationCleared: number;
  usersRecalculated: number;
  recalcFailures: number;
  gamingFlagged: number;
  truncated: boolean;
}

/**
 * Run one maintenance pass.
 *
 * Accepts an optional `client` override so unit tests can inject a fake Supabase
 * client without a live connection. Production always uses the service client.
 */
export async function runTrustMaintenance(client?: any): Promise<TrustMaintenanceResult> {
  const empty: TrustMaintenanceResult = {
    ok: true, capsExpired: 0, restrictionsExpired: 0, restrictionSweepFailed: false, probationCleared: 0,
    usersRecalculated: 0, recalcFailures: 0, gamingFlagged: 0, truncated: false,
  };

  const db = client ?? getServiceClient();
  if (!db) {
    return { ...empty, ok: false, skipped: true, skipReason: "no_service_client" };
  }

  // Fail closed, exactly as recordTrustEvent does.
  if (!await isTrustEnabled(db)) {
    return { ...empty, skipped: true, skipReason: "flag_off" };
  }

  const now = Date.now();

  // 1. Lift expired ceilings FIRST so the recalculation below sees current caps.
  let capsExpired = 0;
  try {
    capsExpired = await expireOldCaps(db);
  } catch (err) {
    logger.warn({ err }, "expireOldCaps threw (non-fatal)");
  }

  // 1b. Lift restrictions whose term has run. This sits beside expireOldCaps and
  //     clearExpiredProbation because it is the third member of exactly the same
  //     family — a time-based lift — and it was the one the cleanup job missed.
  //     Until this call existed, expireOldRestrictions had NO caller anywhere in
  //     the repo, so an expired restriction stayed active permanently.
  let restrictionsExpired = 0;
  let restrictionSweepFailed = false;
  try {
    const sweep = await expireOldRestrictions(db);
    restrictionsExpired = sweep.expired;
    restrictionSweepFailed = sweep.failed;
    if (sweep.truncated) {
      logger.warn(
        { expired: sweep.expired },
        "restriction expiry truncated — more due than the per-pass cap; remainder rolls to the next pass",
      );
    }
    if (sweep.failed) {
      logger.warn({}, "restriction expiry FAILED — restrictions may still be active past their term");
    }
  } catch (err) {
    restrictionSweepFailed = true;
    logger.warn({ err }, "expireOldRestrictions threw (non-fatal)");
  }

  // 2. End probation whose term has run.
  const probationCleared = await clearExpiredProbation(db);

  // 3. Recalculate. Dirty users first — they have new information; stale users
  //    only need a decay refresh and can wait for a later pass.
  const dirty = await findDirtyUsers(db, now);
  let targets = [...dirty].slice(0, MAX_USERS_PER_PASS);
  const truncated = dirty.size > MAX_USERS_PER_PASS;

  const stale = await findStaleUsers(db, now, MAX_USERS_PER_PASS - targets.length);
  for (const uid of stale) {
    if (targets.length >= MAX_USERS_PER_PASS) break;
    if (!dirty.has(uid)) targets.push(uid);
  }

  let usersRecalculated = 0;
  let recalcFailures = 0;
  for (const userId of targets) {
    try {
      await recalculateTrustScore(db, userId);
      usersRecalculated += 1;
    } catch (err) {
      recalcFailures += 1;
      logger.warn({ err, userId }, "recalculateTrustScore failed for user (non-fatal)");
    }
  }

  if (truncated) {
    // Never let a bounded pass read as full coverage.
    logger.warn(
      { dirtyUsers: dirty.size, cap: MAX_USERS_PER_PASS },
      "trust maintenance truncated — more dirty users than the per-pass cap; remainder rolls to the next pass",
    );
  }

  // 4. Gaming detection. Runs last: it reads the scores this pass just wrote,
  //    and it self-skips when `trust_gaming_detection_enabled` is off.
  let gamingFlagged = 0;
  try {
    const scan = await runGamingDetectionScan(db);
    gamingFlagged = scan?.flaggedUsers ?? 0;
  } catch (err) {
    logger.warn({ err }, "runGamingDetectionScan threw (non-fatal)");
  }

  return {
    ok: true,
    capsExpired,
    restrictionsExpired,
    restrictionSweepFailed,
    probationCleared,
    usersRecalculated,
    recalcFailures,
    gamingFlagged,
    truncated,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

async function tickOnce(): Promise<void> {
  try {
    const r = await runTrustMaintenance();
    _status.lastRunAt = new Date().toISOString();
    _status.lastSkippedReason = r.skipped ? (r.skipReason ?? "skipped") : null;
    if (!r.skipped) {
      _status.lastCapsExpired = r.capsExpired;
      _status.lastProbationCleared = r.probationCleared;
      _status.lastUsersRecalculated = r.usersRecalculated;
      _status.lastGamingFlagged = r.gamingFlagged;
      logger.info(
        {
          capsExpired: r.capsExpired,
          probationCleared: r.probationCleared,
          usersRecalculated: r.usersRecalculated,
          recalcFailures: r.recalcFailures,
          gamingFlagged: r.gamingFlagged,
          truncated: r.truncated,
        },
        "trust maintenance pass complete",
      );
    }
    _status.consecutiveFailures = 0;
  } catch (err) {
    _status.consecutiveFailures += 1;
    logger.error(
      { err, consecutiveFailures: _status.consecutiveFailures },
      "trust maintenance pass failed",
    );
  }
}

export function startTrustMaintenanceScheduler(): void {
  if (_timer !== null) return; // already started

  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: MAINTENANCE_INTERVAL_MS,
      maxUsersPerPass: MAX_USERS_PER_PASS,
      staleDays: STALE_DAYS,
    },
    "TrustMaintenanceScheduler scheduled",
  );

  _timer = setTimeout(function tick() {
    void tickOnce().finally(() => {
      _timer = setTimeout(tick, MAINTENANCE_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopTrustMaintenanceScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
