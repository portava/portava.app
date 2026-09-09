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
 *   - RESTRICTION EXPIRY. `applyRestriction` accepts `expires_at` and every
 *     enforcement read already ignores an expired row, but nothing marked the
 *     row lifted, so admin views listed a lapsed restriction as active for ever.
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
import { expireOldCaps } from "../services/trust/TrustCapService.js";
import { expireOldRestrictions } from "../services/trust/TrustRestrictionService.js";
import { runGamingDetectionScan, type GamingScanInputs } from "../services/trust/TrustGamingDetectionService.js";
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
/** Per-pass ceiling on review re-queues, so one sick pass cannot become a storm. */
/**
 * Per-pass cap on the pending_review scan. Exported so a test can size a
 * backlog AGAINST the cap rather than against a hardcoded 200 — a hardcode
 * would quietly stop exercising the truncation path the moment the cap moved.
 */
export const MAX_REVIEW_REPAIRS_PER_PASS = 200;

const DAY_MS = 24 * 60 * 60 * 1_000;

// ── Status ────────────────────────────────────────────────────────────────────

export interface TrustMaintenanceStatus {
  lastRunAt: string | null;
  lastCapsExpired: number;
  lastRestrictionsExpired: number;
  lastProbationCleared: number;
  lastUsersRecalculated: number;
  lastGamingFlagged: number;
  /**
   * Scoreable events inside the dirty-user lookback window at the last pass.
   * THE STARVATION SIGNAL. Production read 2026-09-07: the engine has been ON
   * since 2026-07-17 and the ledger holds 5 events in 52 days — a pass that
   * recalculates 0 users because nobody is dirty is indistinguishable, in the
   * old log line, from a pass that recalculates 0 users because the emitters
   * are silent. This number is the difference. `null` = the read failed.
   */
  lastEventsSeen: number | null;
  /** What the gaming scan examined last pass — see GamingScanInputs. */
  lastGamingInputs: GamingScanInputs | null;
  lastSkippedReason: string | null;
  consecutiveFailures: number;
  /**
   * When a pass last GENUINELY succeeded — not merely "did not throw".
   *
   * `lastRunAt` says a pass was ATTEMPTED. These two diverging is the signal
   * that this job is running and failing, a state that used to be
   * indistinguishable from a healthy idle one because `consecutiveFailures`
   * was reset at the end of every pass that did not throw.
   */
  lastSuccessAt: string | null;
  /** Users whose recalculation threw last pass. Non-zero is a partial failure. */
  lastRecalcFailures: number;
  /** Events left unadjudicated last pass; null = the scan itself could not run. */
  lastReviewsStuck: number | null;
  /** Every reason the last pass was not a success. Empty on a clean pass. */
  lastFailures: string[];
}

const _status: TrustMaintenanceStatus = {
  lastRunAt: null,
  lastCapsExpired: 0,
  lastRestrictionsExpired: 0,
  lastProbationCleared: 0,
  lastUsersRecalculated: 0,
  lastGamingFlagged: 0,
  lastEventsSeen: null,
  lastGamingInputs: null,
  lastSkippedReason: null,
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastRecalcFailures: 0,
  lastReviewsStuck: null,
  lastFailures: [],
};

export function getTrustMaintenanceStatus(): Readonly<TrustMaintenanceStatus> {
  return { ..._status, lastFailures: [..._status.lastFailures] };
}

/** Reset status between test runs — not for production use. */
export function _resetStatus(): void {
  _status.lastRunAt = null;
  _status.lastCapsExpired = 0;
  _status.lastRestrictionsExpired = 0;
  _status.lastProbationCleared = 0;
  _status.lastUsersRecalculated = 0;
  _status.lastGamingFlagged = 0;
  _status.lastEventsSeen = null;
  _status.lastGamingInputs = null;
  _status.lastSkippedReason = null;
  _status.consecutiveFailures = 0;
  _status.lastSuccessAt = null;
  _status.lastRecalcFailures = 0;
  _status.lastReviewsStuck = null;
  _status.lastFailures = [];
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
async function findDirtyUsers(db: any, now: number): Promise<{ dirty: Set<string>; eventsSeen: number | null }> {
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
      return { dirty, eventsSeen: null };
    }
    events = (data as any[]) ?? [];
  } catch (err) {
    logger.warn({ err }, "findDirtyUsers: trust_events fetch threw (non-fatal)");
    return { dirty, eventsSeen: null };
  }
  const eventsSeen = events.length;

  // Newest event timestamp per user.
  const newestByUser = new Map<string, string>();
  for (const e of events) {
    const uid = e?.user_id;
    if (!uid) continue;
    const prev = newestByUser.get(uid);
    if (!prev || String(e.created_at) > prev) newestByUser.set(uid, String(e.created_at));
  }
  if (newestByUser.size === 0) return { dirty, eventsSeen };

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

  return { dirty, eventsSeen };
}

/**
 * Users who have trust events but have NEVER had a score computed — regardless
 * of how old those events are.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 * The two passes above between them leave a hole that closes over a user
 * permanently:
 *
 *   findDirtyUsers  starts from `trust_events` but only looks back
 *                   EVENT_LOOKBACK_DAYS (30). It is how a user with NO
 *                   `trust_profiles` row gets their first score.
 *   findStaleUsers  starts from `trust_profiles`, so it can only refresh a
 *                   score that already exists.
 *
 * So a user whose only trust event ages past 30 days BEFORE a pass ever runs
 * falls out of the first query and was never eligible for the second. Their
 * score is then never computed — not late, never. Nothing reports it, because
 * every reader substitutes a default for a missing profile
 * (`TRUST_SCORE_WHEN_NO_PROFILE = 50` in routes/events.ts), so the user simply
 * gets the substitute forever while their real evidence sits in the table.
 *
 * This is not hypothetical. Measured on production 2026-09-08: 5 applied trust
 * events across 3 users, newest 23 days old, and ONE user with an event and no
 * `trust_profiles` row. At 30 days that user became permanently uncomputable —
 * the scheduler has not yet run in production because the branch carrying it is
 * unmerged, so the window was going to expire before the first pass.
 *
 * Deliberately age-independent: the whole point is that these users are missed
 * BECAUSE their evidence is old. Bounded by the pass budget like every other
 * query here, and it looks only for events that can actually move a score
 * (`applied` / `confirmed`), matching findDirtyUsers.
 *
 * A NULL `last_recalculated_at` counts as never-computed too: the row exists but
 * no score was ever written into it, which is the same user-visible state.
 */
async function findNeverComputedUsers(db: any, budget: number): Promise<string[]> {
  if (budget <= 0) return [];
  let events: any[] = [];
  try {
    const { data, error } = await db
      .from("trust_events")
      .select("user_id")
      .in("status", ["applied", "confirmed"])
      .order("created_at", { ascending: true })
      .limit(budget * 20);
    if (error) {
      logger.warn({ err: error }, "findNeverComputedUsers: trust_events fetch failed (non-fatal)");
      return [];
    }
    events = (data as any[]) ?? [];
  } catch (err) {
    logger.warn({ err }, "findNeverComputedUsers: trust_events fetch threw (non-fatal)");
    return [];
  }

  const candidates = [...new Set(events.map((e) => e?.user_id).filter(Boolean).map(String))];
  if (candidates.length === 0) return [];

  // Anyone with a computed score is not our business; anyone without one is.
  const computed = new Set<string>();
  for (let i = 0; i < candidates.length; i += ID_CHUNK) {
    const chunk = candidates.slice(i, i + ID_CHUNK);
    try {
      const { data, error } = await db
        .from("trust_profiles")
        .select("user_id, last_recalculated_at")
        .in("user_id", chunk);
      if (error) {
        // FAIL CLOSED toward doing nothing rather than toward recomputing
        // everybody: an unreadable trust_profiles would otherwise make every
        // candidate look never-computed and schedule a full recalculation
        // storm. Skipping the chunk costs one pass; the next pass retries.
        logger.warn({ err: error }, "findNeverComputedUsers: trust_profiles fetch failed — skipping chunk (non-fatal)");
        for (const id of chunk) computed.add(id);
        continue;
      }
      for (const p of ((data as any[]) ?? [])) {
        if (p?.user_id && p.last_recalculated_at) computed.add(String(p.user_id));
      }
    } catch (err) {
      logger.warn({ err }, "findNeverComputedUsers: trust_profiles fetch threw — skipping chunk (non-fatal)");
      for (const id of chunk) computed.add(id);
    }
  }

  return candidates.filter((id) => !computed.has(id)).slice(0, budget);
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
  probationCleared: number;
  usersRecalculated: number;
  recalcFailures: number;
  gamingFlagged: number;
  /** Scoreable events in the lookback window this pass; null = read failed. */
  eventsSeen: number | null;
  /** What the gaming scan examined; null = scan skipped (flag off) or threw. */
  gamingInputs: GamingScanInputs | null;
  /** True when the gaming scan ran and every detector examined zero rows. */
  gamingVacuous: boolean;
  truncated: boolean;
  /**
   * pending_review events that reached an admin queue only because this pass
   * repaired them. Non-zero means the original queue insert was lost.
   */
  reviewsRepaired: number;
  /**
   * pending_review events STILL not on the queue after the repair ran — the
   * stuck set. Null when the scan could not be performed, which is not zero:
   * "we could not look" must never be reported as "there is nothing there".
   *
   * When `reviewsScanTruncated` is true this is a FLOOR over the events the
   * pass examined, not a total.
   */
  reviewsStuck: number | null;
  /**
   * True when the pending_review scan hit its per-pass cap
   * (MAX_REVIEW_REPAIRS_PER_PASS), so there were events it never looked at.
   *
   * Without this, "we could not look" hides inside a BOUND rather than inside
   * an error: a backlog of 500 lost queue rows is examined 200 at a time and
   * reports `reviewsStuck: 0` — which reads as "nothing is stuck" while 300
   * serious findings sit unadjudicated and unmentioned. `truncated` above is
   * about DIRTY USERS and says nothing about this scan, so a caller had no
   * signal at all. Same failure class as reporting null as zero, one level down.
   */
  reviewsScanTruncated: boolean;
}

/**
 * Re-queue serious/severe trust events whose admin review row was lost.
 *
 * ── THE DURABILITY GAP ───────────────────────────────────────────────────────
 * `recordTrustEvent` writes the event, then inserts a `trust_reviews` row so an
 * admin can adjudicate it. That second insert is deliberately NON-FATAL: the
 * event is the record of the finding and is already committed, so a failed queue
 * insert should delay adjudication rather than lose evidence.
 *
 * Non-fatal with no retry is AT-MOST-ONCE. The event then sits in
 * `pending_review` — excluded from the score by design (`loadEvents` counts only
 * applied/confirmed) and absent from the queue an admin can actually list. An
 * unattended serious finding is then invisible in both directions at once, and
 * the only trace is a log line from whenever it happened.
 *
 * This sweep makes the delivery AT-LEAST-ONCE. Migration 2650 is what stops
 * at-least-once from becoming a MORE-THAN-ONCE EFFECT: a partial unique index on
 * `trust_reviews (source_event_id) WHERE source_event_id IS NOT NULL` means a
 * re-queue of an event that is already queued is refused with 23505, which is
 * read here as "already delivered" rather than as a failure. Retry plus a
 * uniqueness backstop is exactly-once effect; retry alone would be a second
 * review of the same finding, adjudicated twice, and closed by
 * TrustAdminService.confirmEvent / dismissEvent — which close
 * `trust_reviews WHERE source_event_id = :id` and so already assume at most one.
 *
 * ── WHY IT REPORTS A STUCK COUNT, AND WHY THAT CAN BE NULL ──────────────────
 * Anything it could not repair stays visible in the pass result. `null` is not
 * zero: it means the scan itself could not be performed, and "we could not look"
 * reported as "there is nothing there" is the defect class this whole file
 * exists to refuse.
 */
async function repairMissingEventReviews(
  db: any,
): Promise<{ repaired: number; stuck: number | null; scanTruncated: boolean }> {
  let pending: any[] = [];
  try {
    const { data, error } = await db
      .from("trust_events")
      .select("id, user_id, event_type, category, severity, source_type")
      .eq("status", "pending_review")
      .order("created_at", { ascending: true })
      .limit(MAX_REVIEW_REPAIRS_PER_PASS);
    if (error) {
      logger.warn({ err: error }, "trust review repair: pending_review scan failed — stuck count unknown this pass");
      return { repaired: 0, stuck: null, scanTruncated: false };
    }
    pending = (data as any[]) ?? [];
  } catch (err) {
    logger.warn({ err }, "trust review repair: pending_review scan threw — stuck count unknown this pass");
    return { repaired: 0, stuck: null, scanTruncated: false };
  }
  // The scan is bounded. A FULL page means there may be more pending events we
  // never looked at, so the stuck count below is a floor and must say so.
  const scanTruncated = pending.length >= MAX_REVIEW_REPAIRS_PER_PASS;
  if (scanTruncated) {
    logger.warn(
      { examined: pending.length, cap: MAX_REVIEW_REPAIRS_PER_PASS },
      "trust review repair: pending_review scan hit its per-pass cap — the stuck count is a FLOOR, not a total; remainder rolls to the next pass",
    );
  }
  if (pending.length === 0) return { repaired: 0, stuck: 0, scanTruncated: false };

  // Which of them already have a review row. An unreadable trust_reviews must
  // NOT be read as "none of them are queued" — that would re-queue every
  // pending event on every pass. Without the answer there is nothing safe to
  // do, and the stuck count is unknown rather than large.
  const ids = pending.map((e) => String(e.id));
  const queued = new Set<string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    try {
      const { data, error } = await db
        .from("trust_reviews")
        .select("source_event_id")
        .in("source_event_id", chunk);
      if (error) {
        logger.warn({ err: error }, "trust review repair: trust_reviews read failed — no repair attempted this pass");
        return { repaired: 0, stuck: null, scanTruncated };
      }
      for (const r of ((data as any[]) ?? [])) {
        if (r?.source_event_id) queued.add(String(r.source_event_id));
      }
    } catch (err) {
      logger.warn({ err }, "trust review repair: trust_reviews read threw — no repair attempted this pass");
      return { repaired: 0, stuck: null, scanTruncated };
    }
  }

  const missing = pending.filter((e) => !queued.has(String(e.id)));
  let repaired = 0;
  let stuck = 0;
  for (const e of missing) {
    try {
      const { error } = await db.from("trust_reviews").insert({
        user_id:         e.user_id,
        review_type:     "event_review",
        source_event_id: e.id,
        status:          "open",
        metadata: {
          event_type:  e.event_type,
          category:    e.category,
          severity:    e.severity,
          source_type: e.source_type,
          requeued_by: "trust_maintenance_repair",
        },
      });
      if (!error) { repaired += 1; continue; }
      // 23505 — migration 2650's unique index. Another emitter queued it between
      // our read and our write; that is delivery, not failure.
      if ((error as any).code === "23505") continue;
      stuck += 1;
      logger.warn({ err: error, eventId: e.id, userId: e.user_id }, "trust review repair: re-queue failed — event stays unadjudicated");
    } catch (err) {
      stuck += 1;
      logger.warn({ err, eventId: e.id }, "trust review repair: re-queue threw — event stays unadjudicated");
    }
  }
  if (repaired > 0) {
    logger.warn(
      { repaired },
      "trust review repair: pending_review event(s) were NOT on the admin queue and have been re-queued — the original queue insert was lost",
    );
  }
  return { repaired, stuck, scanTruncated };
}

/**
 * Run one maintenance pass.
 *
 * Accepts an optional `client` override so unit tests can inject a fake Supabase
 * client without a live connection. Production always uses the service client.
 */
export async function runTrustMaintenance(client?: any): Promise<TrustMaintenanceResult> {
  const empty: TrustMaintenanceResult = {
    ok: true, capsExpired: 0, restrictionsExpired: 0, probationCleared: 0,
    usersRecalculated: 0, recalcFailures: 0, gamingFlagged: 0,
    eventsSeen: null, gamingInputs: null, gamingVacuous: false, truncated: false,
    reviewsRepaired: 0, reviewsStuck: null, reviewsScanTruncated: false,
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

  // 1b. Mark time-limited restrictions that have run out as lifted. Enforcement
  //     already ignores them past `expires_at` (getRestrictionState filters on
  //     it); this keeps the row — and the admin views that list it — honest.
  //     TrustRestrictionService.expireOldRestrictions had no caller before.
  let restrictionsExpired = 0;
  try {
    restrictionsExpired = await expireOldRestrictions(db);
  } catch (err) {
    logger.warn({ err }, "expireOldRestrictions threw (non-fatal)");
  }

  // 2. End probation whose term has run.
  const probationCleared = await clearExpiredProbation(db);

  // 3. Recalculate. Dirty users first — they have new information; stale users
  //    only need a decay refresh and can wait for a later pass.
  const { dirty, eventsSeen } = await findDirtyUsers(db, now);
  let targets = [...dirty].slice(0, MAX_USERS_PER_PASS);
  const truncated = dirty.size > MAX_USERS_PER_PASS;

  // Users who have evidence but have never had a score computed. Ranked ABOVE
  // stale refreshes: a stale score is merely out of date, whereas a
  // never-computed one means every reader is substituting a default for a user
  // whose real evidence is sitting in the table. Age-independent by design —
  // these users are missed precisely because their events are old.
  const neverComputed = await findNeverComputedUsers(db, MAX_USERS_PER_PASS - targets.length);
  for (const uid of neverComputed) {
    if (targets.length >= MAX_USERS_PER_PASS) break;
    if (!dirty.has(uid)) targets.push(uid);
  }

  const alreadyTargeted = new Set(targets);
  const stale = await findStaleUsers(db, now, MAX_USERS_PER_PASS - targets.length);
  for (const uid of stale) {
    if (targets.length >= MAX_USERS_PER_PASS) break;
    if (!alreadyTargeted.has(uid)) targets.push(uid);
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

  // 3b. Re-queue any serious/severe event whose admin review row was lost. See
  //     repairMissingEventReviews: at-least-once delivery, made exactly-once in
  //     EFFECT by migration 2650's unique index on trust_reviews.source_event_id.
  let reviewsRepaired = 0;
  let reviewsStuck: number | null = null;
  let reviewsScanTruncated = false;
  try {
    const r = await repairMissingEventReviews(db);
    reviewsRepaired = r.repaired;
    reviewsStuck = r.stuck;
    reviewsScanTruncated = r.scanTruncated;
  } catch (err) {
    logger.warn({ err }, "repairMissingEventReviews threw (non-fatal) — stuck count unknown this pass");
  }

  // 4. Gaming detection. Runs last: it reads the scores this pass just wrote,
  //    and it self-skips when `trust_gaming_detection_enabled` is off.
  let gamingFlagged = 0;
  let gamingInputs: GamingScanInputs | null = null;
  let gamingVacuous = false;
  try {
    const scan = await runGamingDetectionScan(db);
    gamingFlagged = scan?.flaggedUsers ?? 0;
    gamingInputs = scan?.inputs ?? null;
    gamingVacuous = Boolean(scan?.vacuous) && !scan?.skipped;
  } catch (err) {
    logger.warn({ err }, "runGamingDetectionScan threw (non-fatal)");
  }

  return {
    ok: true,
    capsExpired,
    restrictionsExpired,
    probationCleared,
    usersRecalculated,
    recalcFailures,
    gamingFlagged,
    eventsSeen,
    reviewsRepaired,
    reviewsStuck,
    reviewsScanTruncated,
    gamingInputs,
    gamingVacuous,
    truncated,
  };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;

/**
 * One scheduled tick. Exported so a test can drive a pass and assert on the
 * health counters directly — `startTrustMaintenanceScheduler` only installs the
 * timer, and asserting on a timer handle proves nothing about what a pass does
 * to `consecutiveFailures`.
 */
export async function tickOnce(): Promise<void> {
  try {
    const r = await runTrustMaintenance();
    _status.lastRunAt = new Date().toISOString();
    _status.lastSkippedReason = r.skipped ? (r.skipReason ?? "skipped") : null;
    if (!r.skipped) {
      _status.lastCapsExpired = r.capsExpired;
      _status.lastRestrictionsExpired = r.restrictionsExpired;
      _status.lastProbationCleared = r.probationCleared;
      _status.lastUsersRecalculated = r.usersRecalculated;
      _status.lastGamingFlagged = r.gamingFlagged;
      _status.lastEventsSeen = r.eventsSeen;
      _status.lastGamingInputs = r.gamingInputs;
      logger.info(
        {
          capsExpired: r.capsExpired,
          restrictionsExpired: r.restrictionsExpired,
          probationCleared: r.probationCleared,
          usersRecalculated: r.usersRecalculated,
          recalcFailures: r.recalcFailures,
          gamingFlagged: r.gamingFlagged,
          eventsSeen: r.eventsSeen,
          gamingInputs: r.gamingInputs,
          gamingVacuous: r.gamingVacuous,
          truncated: r.truncated,
        },
        "trust maintenance pass complete",
      );
      // The engine being ON and the ledger being empty is the production
      // state this line exists to make visible: 0 users recalculated is only
      // "everyone is current" when there were events to be current with.
      if (r.eventsSeen === 0) {
        logger.warn(
          { lookbackDays: EVENT_LOOKBACK_DAYS },
          "trust maintenance: engine ON but ZERO scoreable events in the lookback window — the emitters are silent, not the scheduler",
        );
      }
    }

    // ── consecutiveFailures RESETS ONLY ON A PASS THAT GENUINELY SUCCEEDED ──
    // It used to be set to 0 here unconditionally, i.e. at the end of every
    // pass that did not THROW. `runTrustMaintenance` is fail-soft by
    // construction: every step is individually try/caught and the function
    // returns `ok: true` regardless, so the top-level catch below fired almost
    // never. The counter therefore read 0 through a pass with no service
    // client, a pass where `trust_events` was unreadable, a pass in which
    // EVERY recalculation threw, and a pass whose review scan could not run —
    // the exact states a health reader exists to see. Same defect the event
    // waitlist sweeper carried and fixed.
    //
    // A SKIP is not a failure of the work when it is `flag_off`: the engine is
    // deliberately off and there is nothing to do. `no_service_client` IS a
    // failure — this process cannot do the job at all.
    const failures: string[] = [];
    if (r.skipped) {
      if ((r.skipReason ?? "") === "no_service_client") failures.push("no_service_client");
    } else {
      // "Could not look" — an unreadable trust_events makes every subsequent
      // count in this pass a floor of unknown depth, not a measurement.
      if (r.eventsSeen === null) failures.push("events_unreadable");
      // A partial failure is still a failure: users whose score this pass was
      // supposed to refresh still carry a stale one.
      if (r.recalcFailures > 0) failures.push(`recalc_failures:${r.recalcFailures}`);
      // null = the pending_review scan itself could not be performed.
      if (r.reviewsStuck === null) failures.push("review_scan_unreadable");
      else if (r.reviewsStuck > 0) failures.push(`reviews_stuck:${r.reviewsStuck}`);
      _status.lastRecalcFailures = r.recalcFailures;
      _status.lastReviewsStuck = r.reviewsStuck;
    }

    _status.lastFailures = failures;
    if (failures.length === 0) {
      _status.consecutiveFailures = 0;
      if (!r.skipped) _status.lastSuccessAt = _status.lastRunAt;
    } else {
      _status.consecutiveFailures += 1;
      logger.error(
        { failures, consecutiveFailures: _status.consecutiveFailures },
        "trust maintenance pass did NOT fully succeed",
      );
    }
  } catch (err) {
    _status.consecutiveFailures += 1;
    _status.lastFailures = ["threw"];
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
