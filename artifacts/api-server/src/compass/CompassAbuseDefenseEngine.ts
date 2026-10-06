/**
 * CompassAbuseDefenseEngine — Phase 5 abuse pattern detection.
 *
 * Runs on a cron schedule (hourly) and on-demand when a report is confirmed.
 * Detected patterns are written to `compass_abuse_flags`, reach reduction is
 * applied via `compass_visibility_cooldowns`, and severe confirmed patterns
 * call CompassActiveUserRewardEngine to zero out rewards.
 *
 * Scans performed by runScan():
 *   1. mutual_review_ring    — ≥3 users all gave each other 5★ within 7 days
 *   2. booking_loop          — same user pair with >5 bookings in 30 days, all 5★
 *   3. referral_farm         — user referred >10 accounts with no subsequent bookings
 *   4. comment_pod           — groups of users always commenting on each other's posts
 *   5. hashtag_spam          — >20 identical hashtag uses from one account in 24 h
 *   6. geotag_farming        — >15 location stamps from one account in 1 hour
 *   7. available_now_abuse   — status toggled on/off >20 times in 24 h with no bookings
 *   8. refund_abuse          — >3 booking cancellations/refunds in 30 days
 *
 * Scans 5, 6 and 7 are NARROWER than the gap this process can go without
 * running, so they resume from a durable per-detector watermark rather than
 * from `now - lookback`. See NARROW_SCANS below for the whole argument: which
 * window each one scans, why the keys are separate, why the watermark only
 * ever WIDENS a window, and what bounds a catch-up pass after an outage.
 *
 * Severity levels:
 *   low     — flagged only; no immediate action
 *   medium  — reach reduced (compass_visibility_cooldowns extended)
 *   high    — reach reduced + flagged for admin review
 *   severe  — reach zeroed + active-user reward zeroed + suspension request
 *             (auto-confirmed because threshold evidence is strong)
 *
 * Never throws — all errors are swallowed so the scheduler stays healthy.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../lib/logger.js";
import { computeActiveUserScore } from "./CompassActiveUserRewardEngine.js";
import {
  scanWindow,
  readWatermark,
  commitWatermark,
  type ScanWindow,
} from "../lib/schedulerWatermark.js";

const logger = rootLogger.child({ service: "CompassAbuseDefenseEngine" });

// ── Types ─────────────────────────────────────────────────────────────────────

export type AbusePatternType =
  | "mutual_review_ring"
  | "booking_loop"
  | "referral_farm"
  | "comment_pod"
  | "hashtag_spam"
  | "geotag_farming"
  | "available_now_abuse"
  | "refund_abuse";

export type AbuseSeverity = "low" | "medium" | "high" | "severe";

export interface AbuseFlag {
  patternType:   AbusePatternType;
  involvedUsers: string[];
  severity:      AbuseSeverity;
  evidence:      Record<string, unknown>;
}

/**
 * What one detector actually managed to determine.
 *
 * `flags: []` alone was the whole problem. supabase-js RESOLVES `{ data, error }`,
 * and every detector bound only `data`, so an unreadable table — an RLS change, a
 * statement timeout, a 22P02 on an enum label — became `data === undefined`, then
 * `?? []`, then zero rows, then zero flags. The scan reported "ran, found no
 * abuse" in language identical to a scan that had read every row. Seven detectors
 * shared that shape, so a single broken table could turn the entire abuse defence
 * into a reassuring no-op that nobody would look at twice.
 *
 * `failed` is the distinction that was missing: no flags because there is no
 * abuse, versus no flags because nothing was read.
 */
export interface DetectorOutcome {
  detector: AbusePatternType;
  flags:    AbuseFlag[];
  /** True when a read this detector depends on did not complete. */
  failed:   boolean;
  /** Present only when `failed` — the first read error encountered. */
  error?:   string;
}

/** The result of a whole scan — never silently "clean" when a detector failed. */
export interface ScanResult {
  flagsWritten: number;
  /** "ok" only when every detector completed its reads. */
  status: "ok" | "incomplete";
  /** Detectors that could not complete, so the caller can say so out loud. */
  failedDetectors: Array<{ detector: AbusePatternType; error: string }>;
  /**
   * Watermark reads or commits that did not complete, per job key.
   *
   * These deliberately do NOT make the scan `incomplete`: every detector still
   * read its own table over at least its calibrated window, which is a real
   * measurement of that window. What they do mean is that the pass covered
   * less TIME than it could have (read failure) or that the time it covered
   * was not recorded as covered (commit failure) — and in both cases nothing
   * is advanced, so the next pass re-covers it instead of skipping it. Surfaced
   * so an operator can see a watermark store that is quietly broken, which
   * would otherwise look like a perfectly healthy hourly scan.
   */
  watermarkFailures: Array<{ job: string; phase: "read" | "commit"; error: string }>;
}

/**
 * The durable watermark store, as the two calls this engine needs. Injectable
 * so the scan can be tested over a simulated outage without a database, and so
 * a caller can pass `null` for "there is no store" — see RunScanOptions.
 */
export interface WatermarkPorts {
  read:   (db: SupabaseClient, job: string) => Promise<{ at: Date | null; ok: boolean }>;
  commit: (db: SupabaseClient, job: string, through: Date) => Promise<boolean>;
}

const DEFAULT_WATERMARK_PORTS: WatermarkPorts = {
  read:   readWatermark,
  commit: commitWatermark,
};

export interface RunScanOptions {
  /** The instant this pass is anchored on; defaults to now. */
  now?: Date;
  /**
   * The watermark store. Omitted means the real one. Explicit `null` means
   * there is none reachable, which is treated exactly like a failed read:
   * calibrated lookbacks only, and nothing committed.
   */
  watermarks?: WatermarkPorts | null;
}

function ok(detector: AbusePatternType, flags: AbuseFlag[]): DetectorOutcome {
  return { detector, flags, failed: false };
}

/**
 * A detector gave up. Any flags it DID find before the failure are kept — they
 * were really observed — but the outcome is still marked incomplete.
 */
function failed(detector: AbusePatternType, error: string, flags: AbuseFlag[] = []): DetectorOutcome {
  return { detector, flags, failed: true, error };
}

// ── Thresholds ────────────────────────────────────────────────────────────────

const RING_MIN_USERS            = 3;    // mutual review ring minimum size
const RING_WINDOW_DAYS          = 7;
const BOOKING_LOOP_MIN          = 5;    // >5 bookings between same pair in 30 days
const BOOKING_LOOP_WINDOW_DAYS  = 30;
const REFERRAL_FARM_MIN         = 10;   // referred >10 accounts that made no bookings
const COMMENT_POD_MIN_MUTUAL    = 6;    // ≥6 genuinely mutual pairs in 72 h signals a pod
const COMMENT_POD_MIN_DIRECTED  = 2;    // each side must comment on the other ≥2× (bidirectional check)
const HASHTAG_SPAM_MIN          = 20;   // same hashtag >20 times in 24 h
const GEOTAG_FARM_MIN           = 15;   // >15 stamps in 1 hour
const AVAILABLE_TOGGLE_MIN      = 20;   // >20 toggles in 24 h
const REFUND_ABUSE_MIN          = 3;    // >3 cancellations/refunds in 30 days

// ── Narrow scan windows, watermarks and catch-up caps ─────────────────────────

const HOUR_MS = 60 * 60 * 1_000;

/**
 * Three of the eight detectors scan a window NARROWER than the gap this
 * process can go without ticking, so abuse committed inside a missed tick was
 * never evaluated at all: no flag, no reach reduction, no
 * compass_suspension_requests row, and no trace that anything was skipped.
 * compassAbuseScanScheduler runs hourly on Replit autoscale, which suspends
 * after 15 idle minutes — so an hour with no tick is an ordinary quiet night,
 * not an incident. geotag_farming was the worst of the three: a ONE-HOUR
 * window scanned on a ONE-HOUR timer, i.e. every suspended hour was a
 * permanent blind spot with no overlap to recover it.
 *
 * Each of the three now resumes from its own durable watermark — the `through`
 * of the last pass that genuinely completed — instead of from `now - lookback`.
 *
 * ── WHY ONE JOB KEY PER DETECTOR, NOT ONE FOR THE SCAN ──────────────────────
 * The three have different calibrated windows and they fail INDEPENDENTLY:
 * runScan dispatches detectors under Promise.allSettled, so one unreadable
 * table does not stop the others. A single shared key would therefore advance
 * on a pass in which passport_stamps was unreadable — which is this very bug
 * relocated rather than fixed, with hashtag_spam's success burying
 * geotag_farming's failure. Separate keys mean a detector's coverage is only
 * ever advanced by its own completed read.
 *
 * ── WHY THE WATERMARK ONLY EVER WIDENS A WINDOW ─────────────────────────────
 * The watermark is passed to scanWindow only when it is OLDER than the
 * detector's own lookback. hashtag_spam is calibrated on 24 hours but runs
 * hourly, so a bare `since = watermark` would shrink its window to the last
 * hour and stop counting the other 23 — a detector that sees LESS, which is
 * never an acceptable trade on an abuse path. Handing over the watermark only
 * when it predates `now - lookbackMs` makes the scanned span the union of
 * "what this detector always looks at" and "what the last pass missed", so a
 * steady-state tick scans exactly what it scans today, and a first run (no
 * watermark stored) is byte-identical to the old behaviour.
 *
 * ── WHY THE CATCH-UP IS CAPPED, AND WHAT THE CAP PROTECTS ───────────────────
 * The hazard is not the width of the READ, it is what the scan DOES at the end
 * of it. An uncapped catch-up after a long outage (a dead deploy, a disabled
 * scheduler, a restored backup full of old rows) would evaluate weeks in a
 * single pass and hand the moderation queue a burst of flags at once, every
 * `severe` one of them carrying an auto-confirmed flag, a zeroed active-user
 * reward, a 365-day reach cooldown and a compass_suspension_requests row.
 * TWO things bound that burst, and both are load-bearing:
 *
 *   1. The per-detector cap below bounds how much TIME one pass may evaluate.
 *   2. The detectors' own shape bounds how many FLAGS that time can produce.
 *      All three aggregate per user (per user+hashtag for hashtag_spam) and
 *      emit at most one flag per offender per pass, and the count that feeds
 *      the threshold and the severity is the peak inside the detector's
 *      CALIBRATED window (see peakInWindow), not the catch-up total. So a
 *      wider window cannot escalate anyone's severity, and the burst is
 *      bounded by the number of distinct offenders in the covered time — the
 *      same bound the timely scans would have had, summed over the ticks that
 *      never ran.
 *
 * Capping is a real admission, not a formality: abuse older than the cap stays
 * unevaluated. That is deliberate. Every action the engine takes starts from
 * `now`, so acting on a week-old one-hour geotag burst reduces present reach
 * on stale evidence; and the wide detectors (7-day rings, 30-day booking loops
 * and refunds) already cover that horizon with thresholds calibrated for it.
 */
interface NarrowScanSpec {
  /** Durable watermark key — one per detector, see above. */
  job:          string;
  /** The detector's existing calibrated window; also its minimum window. */
  lookbackMs:   number;
  /** The most time a single catch-up pass may evaluate. */
  maxCatchupMs: number;
}

const NARROW_SCANS: Record<
  "hashtag_spam" | "geotag_farming" | "available_now_abuse",
  NarrowScanSpec
> = {
  // 24-hour window. 7 days = 7 calibrated windows, and it matches
  // RING_WINDOW_DAYS — the widest horizon this engine already treats as
  // "current". The wider cap is justified here and not for the other two
  // because spam posts stay PUBLISHED and keep earning reach for as long as
  // they are up, so late detection still removes a live harm rather than
  // punishing a finished one.
  hashtag_spam:        { job: "compass_abuse_hashtag_spam",        lookbackMs: 24 * HOUR_MS, maxCatchupMs: 168 * HOUR_MS },
  // 1-hour window on a 1-hour timer: every suspended hour was lost outright.
  // 72 h covers the realistic worst case for an idle-suspended autoscale host
  // — a quiet long weekend — which is 72 calibrated windows evaluated in one
  // pass but still at most one flag per farming account. Stamps older than
  // that are stale evidence for a `severe` action that starts now.
  geotag_farming:      { job: "compass_abuse_geotag_farming",      lookbackMs: 1 * HOUR_MS,  maxCatchupMs: 72 * HOUR_MS },
  // 24-hour window, capped at 72 h rather than hashtag_spam's 7 days because
  // the harm is TRANSIENT: the misleading "available now" impressions are long
  // gone days later, so a reach reduction applied now protects nobody. The
  // exonerating read (completed bookings) is also only meaningful against the
  // window the toggles actually happened in.
  available_now_abuse: { job: "compass_abuse_available_now_abuse", lookbackMs: 24 * HOUR_MS, maxCatchupMs: 72 * HOUR_MS },
};

type NarrowScan = keyof typeof NARROW_SCANS;

/**
 * The largest number of timestamps falling inside ANY window of `widthMs` —
 * peak density, not the total across the scanned span — plus that window's
 * start.
 *
 * This exists because all three narrow thresholds are RATES wearing the
 * clothes of counts: ">15 stamps" means ">15 stamps IN ONE HOUR", and `severe`
 * at >30 means 30 in one hour. Feeding a 72-hour catch-up total into a
 * threshold calibrated on one hour would flag a merely busy traveller as a
 * severe geotag farmer and open a suspension request against them — not the
 * bug being fixed here, but a new one pointed the other way, and the exact
 * "burst of flags" the cap is also there to bound.
 *
 * Callers consult it ONLY when the scanned span is wider than the calibrated
 * window. When the span IS the calibrated window — every steady-state tick and
 * every first run — the peak over that span is by definition the total, so the
 * existing count is used directly and this function is not called at all. That
 * keeps the no-watermark path bit-for-bit what it was, including for rows with
 * an unparseable `created_at`, which the peak path cannot place in time.
 *
 * The window start is returned so a caller can scope a follow-up read to the
 * same window: available_now_abuse's exonerating bookings read has to ask
 * about the 24 hours the toggles happened in, not about all 72.
 *
 * `unplaceable` is the number of rows the caller read and counted but could NOT
 * place in time — a `created_at` that would not parse. They are ADDED to the
 * peak rather than dropped from it. Dropping them would make the catch-up pass
 * count fewer rows than it actually read, which is the one direction this whole
 * change forbids: a detector may see more than the timely scan it stands in
 * for, never less. A row whose time cannot be established is therefore treated
 * as being inside the densest window, the same way the no-watermark path counts
 * it (CONTRIBUTING.md:33-66 — a check that cannot establish its result must not
 * quietly assume the convenient answer). In practice `created_at` is NOT NULL
 * timestamptz, so this is a floor under the arithmetic, not a live case.
 *
 * `placed` is the peak excluding those rows, which is what tells a caller
 * whether `startMs` means anything: with nothing placeable there is no window
 * to scope a follow-up read to.
 */
function peakInWindow(
  timestampsMs: number[],
  widthMs: number,
  unplaceable = 0,
): { count: number; startMs: number; placed: number } {
  if (timestampsMs.length === 0) return { count: unplaceable, startMs: 0, placed: 0 };
  const t = [...timestampsMs].sort((a, b) => a - b);
  let best = 0;
  let bestStart = t[0]!;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    if (j < i) j = i; // j never walks backwards — the sweep stays O(n)
    // A densest window can always be slid until its left edge sits ON an
    // event, so testing every event as the left edge is exhaustive, not a
    // heuristic. The edges are inclusive, matching the `.gte(since)` read with
    // no upper bound that produced these rows.
    while (j + 1 < t.length && t[j + 1]! - t[i]! <= widthMs) j++;
    const count = j - i + 1;
    if (count > best) { best = count; bestStart = t[i]!; }
  }
  return { count: best + unplaceable, startMs: bestStart, placed: best };
}

/**
 * The window a narrow detector actually scans: the one runScan handed it from
 * a readable watermark, or its own calibrated lookback when there was none.
 *
 * A failed watermark READ is a refusal, not an absence (CONTRIBUTING.md:33-66
 * — a check that cannot establish its result must fail rather than assume).
 * `{ at: null, ok: true }` is "nothing stored yet"; `{ ok: false }` is "we do
 * not know". Both land here as the calibrated lookback — never wider — and on
 * `ok: false` runScan also commits nothing, so the uncovered time is still
 * uncovered at the next tick and is picked up then instead of being silently
 * declared scanned.
 */
function resolveWindow(win: ScanWindow | null, detector: NarrowScan): ScanWindow {
  if (win) return win;
  const nowMs = Date.now();
  return {
    since:   new Date(nowMs - NARROW_SCANS[detector].lookbackMs),
    through: new Date(nowMs),
    capped:  false,
  };
}

// ── Cooldown writer ───────────────────────────────────────────────────────────

async function applyReachReduction(
  db:       SupabaseClient,
  userId:   string,
  severity: AbuseSeverity,
): Promise<void> {
  const durationHours: Record<AbuseSeverity, number> = {
    low:    0,
    medium: 24,
    high:   72,
    severe: 8760, // 1 year ≈ effectively permanent until admin lifts
  };
  const hours = durationHours[severity];
  if (hours === 0) return;

  const nowMs = Date.now();
  const endsAt = new Date(nowMs + hours * 60 * 60 * 1_000).toISOString();
  // non-fatal
  const { error } = await db.from("compass_visibility_cooldowns").upsert(
    {
      author_id:    userId,
      cooldown_type: "reach_reduction",
      reason:       `abuse_defense:${severity}`,
      ends_at:      endsAt,
      // `updated_at` is NOT a column of compass_visibility_cooldowns — the
      // table is (id, author_id, cooldown_type, started_at, ends_at, reason).
      // PostgREST rejects an unknown column in a write body with 42703 and the
      // WHOLE upsert fails, so this reach reduction was NEVER recorded: every
      // confirmed medium/high/severe abuse pattern logged a warning and left
      // the offender's visibility untouched. `started_at` is the column that
      // carries "when this cooldown began"; writing it explicitly is what makes
      // an EXTENSION of an existing cooldown (the ON CONFLICT path) restate the
      // clock, and it matches the two sibling writers in
      // CompassFairExposureEngine.ts:112,218 exactly.
      started_at:   new Date(nowMs).toISOString(),
    },
    { onConflict: "author_id,cooldown_type" },
  );
  if (error) logger.warn({ err: error, userId }, "visibility cooldown upsert failed (non-fatal)");
}

// ── Suspension-request trigger for severe patterns ────────────────────────────

/**
 * Emit a suspension request for a user confirmed to have committed a severe
 * abuse pattern. Inserts a pending-review row into compass_suspension_requests
 * so that the moderation team can act on it — the system never auto-suspends;
 * it only queues the request. Fire-and-forget: errors are swallowed.
 */
async function requestSuspension(
  db:     SupabaseClient,
  userId: string,
  reason: string,
): Promise<void> {
  // non-fatal
  const { error } = await db.from("compass_suspension_requests").insert({
    user_id:    userId,
    reason:     `severe_abuse:${reason}`,
    status:     "pending_review",
    created_at: new Date().toISOString(),
  });
  if (error) logger.warn({ err: error, userId }, "suspension request insert failed (non-fatal)");
}

// ── Reward zeroing for severe patterns ────────────────────────────────────────

/**
 * Zero out the active-user reward for a confirmed severe abuse flag.
 * Uses hasSevereSafetyFlag=true override so the score is recomputed as 0.
 * Also directly upserts the score row for immediate effect.
 */
async function zeroActiveUserReward(
  db:     SupabaseClient,
  userId: string,
): Promise<void> {
  try {
    // Recompute with severe flag override (may throw — not a bare supabase call)
    await computeActiveUserScore(db, userId, { hasSevereSafetyFlag: true });
  } catch (err) {
    logger.warn({ err, userId }, "active user score recompute failed (non-fatal)");
  }

  // Direct upsert for immediate effect (in case recompute is slow) — non-fatal
  const { error } = await db.from("compass_active_user_scores").upsert(
    {
      user_id:           userId,
      active_user_score: 0,
      trust_multiplier:  0,
      boost_eligible:    false,
      last_computed_at:  new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) logger.warn({ err: error, userId }, "active user score zeroing upsert failed (non-fatal)");
}

// ── Flag writer ───────────────────────────────────────────────────────────────

/**
 * Returns whether the flag row was durably recorded. The insert stays
 * non-fatal, but the answer is no longer discarded: a detector whose flag
 * could not be written has NOT covered its window, so runScan must not advance
 * that detector's watermark past the abuse it just failed to record.
 */
async function writeFlag(
  db:   SupabaseClient,
  flag: AbuseFlag,
): Promise<boolean> {
  // non-fatal
  const { error } = await db.from("compass_abuse_flags").insert({
    pattern_type:   flag.patternType,
    involved_users: flag.involvedUsers,
    severity:       flag.severity,
    evidence:       flag.evidence,
    // severe patterns are auto-confirmed; others are pending admin review
    status:         flag.severity === "severe" ? "confirmed" : "pending",
  });
  if (error) logger.warn({ err: error, patternType: flag.patternType }, "abuse flag insert failed (non-fatal)");
  return !error;
}

// ── Post-detection action dispatcher ─────────────────────────────────────────

/** Returns whether the flag itself was durably recorded — see writeFlag. */
async function handleFlag(
  db:   SupabaseClient,
  flag: AbuseFlag,
): Promise<boolean> {
  const written = await writeFlag(db, flag);

  const applyReach       = flag.severity !== "low";
  const applyReward      = flag.severity === "severe";
  const applySuspension  = flag.severity === "severe";

  await Promise.allSettled(
    flag.involvedUsers.flatMap((uid) => {
      const ops: Promise<void>[] = [];
      if (applyReach)      ops.push(applyReachReduction(db, uid, flag.severity));
      if (applyReward)     ops.push(zeroActiveUserReward(db, uid));
      if (applySuspension) ops.push(requestSuspension(db, uid, flag.patternType));
      return ops;
    }),
  );

  return written;
}

// ── Individual pattern detectors ──────────────────────────────────────────────

/** 1. Mutual 5★ review ring — ≥3 users who all reviewed each other within 7 days */
async function detectMutualReviewRings(
  db:     SupabaseClient,
  userId: string | null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - RING_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    const q = db
      .from("rent_buddy_reviews")
      .select("reviewer_id, reviewee_id, rating, created_at")
      .eq("rating", 5)
      .gte("created_at", since);

    if (userId) q.or(`reviewer_id.eq.${userId},reviewee_id.eq.${userId}`);

    const { data, error } = await q;
    if (error) return failed("mutual_review_ring", error.message);
    const rows = (data as any[]) ?? [];

    // Build adjacency map: reviewer → set of reviewees (with 5★)
    const reviewedBy = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!reviewedBy.has(r.reviewer_id)) reviewedBy.set(r.reviewer_id, new Set());
      reviewedBy.get(r.reviewer_id)!.add(r.reviewee_id);
    }

    // Find the largest fully-connected clique (all members have reviewed each other
    // with 5★). A pair-based shortcut (checking only against the pivot user) is
    // insufficient — every pair in the ring must be mutually verified.
    function areMutual(a: string, b: string): boolean {
      return Boolean(reviewedBy.get(a)?.has(b) && reviewedBy.get(b)?.has(a));
    }

    const users = [...reviewedBy.keys()];
    for (let i = 0; i < users.length; i++) {
      // Start with just the pivot user and try to grow a clique
      const clique: string[] = [users[i]!];

      for (let j = i + 1; j < users.length; j++) {
        const candidate = users[j]!;
        // The candidate can join only if it mutually reviewed ALL existing members
        if (clique.every((member) => areMutual(candidate, member))) {
          clique.push(candidate);
        }
      }

      if (clique.length >= RING_MIN_USERS) {
        flags.push({
          patternType:   "mutual_review_ring",
          involvedUsers: clique,
          severity:      clique.length >= 5 ? "severe" : "high",
          evidence:      { ring_size: clique.length, window_days: RING_WINDOW_DAYS },
        });
        break; // one flag per scan — admin reviews then re-runs
      }
    }
  } catch (e) {
    return failed("mutual_review_ring", (e as Error).message, flags);
  }
  return ok("mutual_review_ring", flags);
}

/** 2. Booking loop — same user pair with >5 completed/confirmed 5★ bookings in 30 days */
async function detectBookingLoops(
  db:     SupabaseClient,
  userId: string | null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - BOOKING_LOOP_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString();
    // rent_buddy_bookings has no rating column — ratings live on
    // rent_buddy_reviews (keyed by booking_id). Fetch bookings and 5★
    // reviews separately, then count only bookings with a 5★ review.
    const q = db
      .from("rent_buddy_bookings")
      .select("id, traveler_id, buddy_id, status, created_at")
      .in("status", ["completed", "confirmed"])
      .gte("created_at", since);

    if (userId) q.or(`traveler_id.eq.${userId},buddy_id.eq.${userId}`);

    const { data, error } = await q;
    if (error) return failed("booking_loop", error.message);
    const rows = (data as any[]) ?? [];

    // An unreadable reviews table would leave `fiveStarBookingIds` empty, and
    // the `continue` below would then skip every booking — no pair could ever
    // reach the threshold. That is a silent all-clear, not a measurement.
    const { data: reviewRows, error: reviewErr } = await db
      .from("rent_buddy_reviews")
      .select("booking_id, rating")
      .eq("rating", 5)
      .gte("created_at", since);
    if (reviewErr) return failed("booking_loop", reviewErr.message);
    const fiveStarBookingIds = new Set(
      ((reviewRows as any[]) ?? []).map((r) => r.booking_id as string),
    );

    // Count 5★ bookings per pair
    const pairCounts = new Map<string, number>();
    for (const r of rows) {
      if (!fiveStarBookingIds.has(r.id as string)) continue; // ensure 5★
      const key = [r.traveler_id, r.buddy_id].sort().join("|");
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }

    for (const [pair, count] of pairCounts) {
      if (count > BOOKING_LOOP_MIN) {
        const [a, b] = pair.split("|");
        flags.push({
          patternType:   "booking_loop",
          involvedUsers: [a!, b!],
          severity:      count > 10 ? "severe" : "high",
          evidence:      { booking_count: count, window_days: BOOKING_LOOP_WINDOW_DAYS, all_five_star: true },
        });
      }
    }
  } catch (e) {
    return failed("booking_loop", (e as Error).message, flags);
  }
  return ok("booking_loop", flags);
}

/** 3. Referral farm — user whose referrals (>10) made no bookings */
async function detectReferralFarms(
  db:     SupabaseClient,
  userId: string | null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    // STUB: profiles has no referred_by column in the live schema, so referral
    // farms cannot be detected until a referral source is tracked. Return no
    // flags rather than silently failing the whole scan.
    const rows: any[] = [];

    // Count referrals per referrer
    const referralCounts = new Map<string, string[]>(); // referrerId → referred user IDs
    for (const r of rows) {
      if (!r.referred_by) continue;
      if (userId && r.referred_by !== userId) continue;
      if (!referralCounts.has(r.referred_by)) referralCounts.set(r.referred_by, []);
      referralCounts.get(r.referred_by)!.push(r.id);
    }

    for (const [referrerId, referredIds] of referralCounts) {
      if (referredIds.length <= REFERRAL_FARM_MIN) continue;

      // Check how many of ALL referred users have made any bookings.
      // Paginate in batches of 50 (PostgREST .in() limit) to avoid
      // under-counting active users in large referral networks, which would
      // artificially inflate inactiveCount and trigger punitive flags.
      const BATCH_SIZE   = 50;
      const activeIds    = new Set<string>();
      for (let batchStart = 0; batchStart < referredIds.length; batchStart += BATCH_SIZE) {
        const batch = referredIds.slice(batchStart, batchStart + BATCH_SIZE);
        const { data: batchBookings, error: batchErr } = await db
          .from("rent_buddy_bookings")
          .select("traveler_id")
          .in("traveler_id", batch);
        // Failing OPEN here would be punitive, not permissive: a missed batch
        // shrinks activeIds, which INFLATES inactiveCount and can manufacture a
        // referral_farm flag against a referrer whose referrals are all active.
        if (batchErr) return failed("referral_farm", batchErr.message, flags);
        for (const b of (batchBookings as any[] ?? [])) {
          activeIds.add(b.traveler_id as string);
        }
      }
      const inactiveCount = referredIds.length - activeIds.size;

      if (inactiveCount >= REFERRAL_FARM_MIN) {
        flags.push({
          patternType:   "referral_farm",
          involvedUsers: [referrerId],
          severity:      inactiveCount > 20 ? "severe" : "high",
          evidence:      {
            referral_count: referredIds.length,
            inactive_count: inactiveCount,
          },
        });
      }
    }
  } catch (e) {
    return failed("referral_farm", (e as Error).message, flags);
  }
  return ok("referral_farm", flags);
}

/** 4. Comment pod — group of users who always comment on each other's posts */
async function detectCommentPods(
  db:     SupabaseClient,
  userId: string | null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    const since72h = new Date(Date.now() - 72 * 60 * 60 * 1_000).toISOString();

    // Get recent comments with the post author joined
    const q = db
      .from("posts_comments")
      .select("user_id, post_id, created_at")
      .gte("created_at", since72h)
      .is("deleted_at", null);

    if (userId) q.eq("user_id", userId);

    const { data: comments, error: commentsErr } = await q;
    if (commentsErr) return failed("comment_pod", commentsErr.message);
    const commentRows = (comments as any[]) ?? [];
    // Now a real measurement: the table was read and there were no comments.
    if (commentRows.length === 0) return ok("comment_pod", flags);

    // Get post authors for these post_ids
    const postIds = [...new Set(commentRows.map((c: any) => c.post_id as string))].slice(0, 100);
    const { data: posts, error: postsErr } = await db
      .from("posts")
      .select("id, author_id")
      .in("id", postIds);
    // Without authors every comment is unattributable and the pod count is 0 —
    // a guaranteed all-clear from a table that was never read.
    if (postsErr) return failed("comment_pod", postsErr.message);

    const postAuthorMap = new Map<string, string>();
    for (const p of (posts as any[] ?? [])) {
      postAuthorMap.set(p.id as string, p.author_id as string);
    }

    // Build DIRECTED commenter → post_author pairs.
    // Using directed keys (not sorted) lets us verify true bidirectionality:
    // A one-way heavy commenter does not constitute a mutual pod.
    const directedCounts = new Map<string, number>();
    for (const c of commentRows) {
      const postAuthor = postAuthorMap.get(c.post_id);
      if (!postAuthor || postAuthor === c.user_id) continue; // skip self-comment
      const directedKey = `${c.user_id as string}→${postAuthor}`;
      directedCounts.set(directedKey, (directedCounts.get(directedKey) ?? 0) + 1);
    }

    // A pair (A,B) is mutual only when BOTH A→B ≥ MIN_DIRECTED AND B→A ≥ MIN_DIRECTED.
    // This prevents one-way heavy engagement from triggering punitive reach reduction.
    const mutualPairs = new Set<string>();
    for (const [key, aToB] of directedCounts) {
      if (aToB < COMMENT_POD_MIN_DIRECTED) continue;
      const [commenter, author] = key.split("→") as [string, string];
      const bToA = directedCounts.get(`${author}→${commenter}`) ?? 0;
      if (bToA >= COMMENT_POD_MIN_DIRECTED) {
        // Canonical sorted key so each pair is only counted once
        mutualPairs.add([commenter, author].sort().join("|"));
      }
    }

    if (mutualPairs.size >= COMMENT_POD_MIN_MUTUAL) {
      const involved = [
        ...new Set(
          [...mutualPairs].flatMap((p) => p.split("|")),
        ),
      ].slice(0, 20);

      flags.push({
        patternType:   "comment_pod",
        involvedUsers: involved,
        severity:      mutualPairs.size > 12 ? "high" : "medium",
        evidence:      { mutual_pairs: mutualPairs.size, window_hours: 72 },
      });
    }
  } catch (e) {
    return failed("comment_pod", (e as Error).message, flags);
  }
  return ok("comment_pod", flags);
}

/** 5. Hashtag spam — >20 uses of the same hashtag from one account in 24 h */
async function detectHashtagSpam(
  db:     SupabaseClient,
  userId: string | null,
  win:    ScanWindow | null = null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    const w       = resolveWindow(win, "hashtag_spam");
    const widthMs = NARROW_SCANS.hashtag_spam.lookbackMs;
    const spanMs  = w.through.getTime() - w.since.getTime();
    // A catch-up pass covers more than one calibrated 24 h, so the count that
    // meets HASHTAG_SPAM_MIN must be the peak 24 h, not the span total.
    const catchingUp = spanMs > widthMs;
    const since = w.since.toISOString();

    // No upper bound, deliberately: `through` is taken at the start of the
    // pass, so rows written DURING it are counted here and again next tick
    // (the watermark commits `through`, not the real now). Evaluating a row
    // twice costs a duplicate flag; an upper bound could drop one between the
    // two passes, and this scan is already overlapping today.
    const { data: usageRows, error: usageErr } = await db
      .from("hashtag_usage")
      .select("hashtag_id, source_id, source_type, created_at")
      .gte("created_at", since);
    if (usageErr) return failed("hashtag_spam", usageErr.message);

    const rows = (usageRows as any[]) ?? [];
    if (rows.length === 0) return ok("hashtag_spam", flags);

    // Attribution pre-filter. No single account can exceed HASHTAG_SPAM_MIN
    // uses of a hashtag that was used at most HASHTAG_SPAM_MIN times IN TOTAL
    // across all accounts, so dropping those hashtags cannot drop a flag — it
    // is a necessary condition, not a heuristic. (It counts non-post-sourced
    // rows too, which only over-counts, i.e. keeps MORE hashtags.) It exists
    // because the attribution read below now has to cover a window up to 7×
    // wider, and most hashtags in any window are used a handful of times.
    const usageByHashtag = new Map<string, number>();
    for (const r of rows) {
      const h = r.hashtag_id as string;
      usageByHashtag.set(h, (usageByHashtag.get(h) ?? 0) + 1);
    }
    const candidateRows = rows.filter(
      (r: any) => (usageByHashtag.get(r.hashtag_id as string) ?? 0) > HASHTAG_SPAM_MIN,
    );
    if (candidateRows.length === 0) return ok("hashtag_spam", flags);

    // Resolve source_id → user_id via the posts table (most usage is post-sourced)
    const postSourceIds = [
      ...new Set(
        candidateRows
          .filter((r: any) => !r.source_type || r.source_type === "post")
          .map((r: any) => r.source_id as string),
      ),
    ];

    const postAuthorMap = new Map<string, string>(); // source_id → user_id
    // Batched, and no longer truncated at 200. The old `.slice(0, 200)` was a
    // silent ceiling on how much of the window could be attributed at all, and
    // widening the window would have made it bite HARDER while looking
    // unchanged: the surviving 200 ids come out of an unordered read, so a
    // wider window could have displaced the very rows the old 24 h scan
    // attributed — a detector seeing LESS as a side effect of seeing further.
    // Batch size 50 is the PostgREST `.in()` list limit, as in detectReferralFarms.
    const ATTRIBUTION_BATCH = 50;
    for (let batchStart = 0; batchStart < postSourceIds.length; batchStart += ATTRIBUTION_BATCH) {
      const batch = postSourceIds.slice(batchStart, batchStart + ATTRIBUTION_BATCH);
      const { data: posts, error: postsErr } = await db
        .from("posts")
        .select("id, author_id")
        .in("id", batch);
      // Every usage row is skipped as unattributable when this map is empty,
      // so a failure here is indistinguishable from "nobody spammed".
      if (postsErr) return failed("hashtag_spam", postsErr.message);

      for (const p of (posts as any[] ?? [])) {
        postAuthorMap.set(p.id as string, p.author_id as string);
      }
    }

    // Count (user_id, hashtag_id) pairs.
    // Always resolve the actual post author from postAuthorMap — never assume
    // that all rows belong to the scoped userId.  For scoped on-demand scans
    // we filter to rows whose resolved author matches userId; unattributable
    // rows are skipped in both modes.
    const userHashtagCount = new Map<string, number>(); // `${uid}:${hashtagId}` → count
    const userHashtagId    = new Map<string, string>();  // key → hashtagId
    const userHashtagTimes = new Map<string, number[]>(); // key → row timestamps (ms)

    for (const r of candidateRows) {
      const resolvedUid = postAuthorMap.get(r.source_id as string) ?? null;
      // Scoped scan: skip rows that don't belong to the target user
      if (userId !== null && resolvedUid !== userId) continue;
      if (!resolvedUid) continue; // can't attribute — skip in global scan too
      const key = `${resolvedUid}:${r.hashtag_id}`;
      userHashtagCount.set(key, (userHashtagCount.get(key) ?? 0) + 1);
      userHashtagId.set(key, r.hashtag_id as string);
      const ts = Date.parse(r.created_at as string);
      if (!Number.isNaN(ts)) {
        if (!userHashtagTimes.has(key)) userHashtagTimes.set(key, []);
        userHashtagTimes.get(key)!.push(ts);
      }
    }

    for (const [key, total] of userHashtagCount) {
      // On a catch-up pass the threshold is applied to the peak 24 h, so the
      // same 21-uses-a-day account is caught and an ordinary account that used
      // one hashtag 21 times over a week is not. On a normal pass the span IS
      // 24 h and the total is used unchanged.
      const times = userHashtagTimes.get(key) ?? [];
      const count = catchingUp
        ? peakInWindow(times, widthMs, total - times.length).count
        : total;
      if (count > HASHTAG_SPAM_MIN) {
        const uid = key.split(":")[0]!;
        const hashtagId = userHashtagId.get(key)!;
        flags.push({
          patternType:   "hashtag_spam",
          involvedUsers: [uid],
          severity:      count > 50 ? "severe" : count > 30 ? "high" : "medium",
          evidence:      {
            hashtag_id:   hashtagId,
            usage_count:  count,
            window_hours: widthMs / HOUR_MS,
            // Stated so a reviewer can tell a catch-up flag from a timely one
            // and see exactly what span produced it.
            scanned_from:    since,
            scanned_through: w.through.toISOString(),
            ...(catchingUp ? { catchup_scan: true, scanned_hours: Math.round(spanMs / HOUR_MS) } : {}),
            ...(w.capped ? { catchup_capped: true } : {}),
          },
        });
      }
    }
  } catch (e) {
    return failed("hashtag_spam", (e as Error).message, flags);
  }
  return ok("hashtag_spam", flags);
}

/** 6. Geotag farming — >15 location stamps from one account in 1 hour */
async function detectGeotagFarming(
  db:     SupabaseClient,
  userId: string | null,
  win:    ScanWindow | null = null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    // The 1-hour window on a 1-hour timer: without a watermark this detector
    // had no overlap at all, so a single suspended tick lost an hour for good.
    const w       = resolveWindow(win, "geotag_farming");
    const widthMs = NARROW_SCANS.geotag_farming.lookbackMs;
    const spanMs  = w.through.getTime() - w.since.getTime();
    const catchingUp = spanMs > widthMs;
    const since = w.since.toISOString();
    // Upper bound omitted on purpose — see detectHashtagSpam.
    const q = db
      .from("passport_stamps")
      .select("user_id, created_at")
      .gte("created_at", since);

    if (userId) q.eq("user_id", userId);

    const { data, error } = await q;
    if (error) return failed("geotag_farming", error.message);
    const rows = (data as any[]) ?? [];

    const countByUser  = new Map<string, number>();
    const stampsByUser = new Map<string, number[]>();
    for (const r of rows) {
      countByUser.set(r.user_id, (countByUser.get(r.user_id) ?? 0) + 1);
      const ts = Date.parse(r.created_at as string);
      if (!Number.isNaN(ts)) {
        if (!stampsByUser.has(r.user_id)) stampsByUser.set(r.user_id, []);
        stampsByUser.get(r.user_id)!.push(ts);
      }
    }

    for (const [uid, total] of countByUser) {
      // GEOTAG_FARM_MIN and the >30 severe line are per-HOUR rates. On a
      // catch-up pass the hour with the most stamps decides, so a farming
      // burst inside a suspended hour is still caught at the severity it
      // earned, and 16 stamps spread over a quiet weekend is not a severe
      // farmer. On a normal pass the span is the hour and the total is used.
      const stampTimes = stampsByUser.get(uid) ?? [];
      const count = catchingUp
        ? peakInWindow(stampTimes, widthMs, total - stampTimes.length).count
        : total;
      if (count > GEOTAG_FARM_MIN) {
        flags.push({
          patternType:   "geotag_farming",
          involvedUsers: [uid],
          severity:      count > 30 ? "severe" : "high",
          evidence:      {
            stamp_count:  count,
            window_hours: widthMs / HOUR_MS,
            scanned_from:    since,
            scanned_through: w.through.toISOString(),
            ...(catchingUp ? { catchup_scan: true, scanned_hours: Math.round(spanMs / HOUR_MS) } : {}),
            ...(w.capped ? { catchup_capped: true } : {}),
          },
        });
      }
    }
  } catch (e) {
    return failed("geotag_farming", (e as Error).message, flags);
  }
  return ok("geotag_farming", flags);
}

/** 7. Available-now abuse — status toggled >20 times in 24 h with no completed bookings */
async function detectAvailableNowAbuse(
  db:     SupabaseClient,
  userId: string | null,
  win:    ScanWindow | null = null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    const w       = resolveWindow(win, "available_now_abuse");
    const widthMs = NARROW_SCANS.available_now_abuse.lookbackMs;
    const spanMs  = w.through.getTime() - w.since.getTime();
    const catchingUp = spanMs > widthMs;
    const since = w.since.toISOString();
    // Upper bound omitted on purpose — see detectHashtagSpam.
    const q = db
      .from("compass_active_user_events")
      .select("user_id, event_type, created_at")
      .eq("event_type", "availability_toggle")
      .gte("created_at", since);

    if (userId) q.eq("user_id", userId);

    const { data, error } = await q;
    if (error) return failed("available_now_abuse", error.message);
    const rows = (data as any[]) ?? [];

    const countByUser   = new Map<string, number>();
    const togglesByUser = new Map<string, number[]>();
    for (const r of rows) {
      countByUser.set(r.user_id, (countByUser.get(r.user_id) ?? 0) + 1);
      const ts = Date.parse(r.created_at as string);
      if (!Number.isNaN(ts)) {
        if (!togglesByUser.has(r.user_id)) togglesByUser.set(r.user_id, []);
        togglesByUser.get(r.user_id)!.push(ts);
      }
    }

    for (const [uid, total] of countByUser) {
      // AVAILABLE_TOGGLE_MIN and the >40 line are per-24 h rates; on a
      // catch-up pass the densest 24 h decides. On a normal pass the span IS
      // 24 h, so `peak` is skipped and the total is used unchanged.
      const toggleTimes = togglesByUser.get(uid) ?? [];
      const peak = catchingUp
        ? peakInWindow(toggleTimes, widthMs, total - toggleTimes.length)
        : null;
      const toggleCount = peak ? peak.count : total;
      // `startMs` only means something when at least one toggle could be
      // placed in time. With none placeable there is no densest window to
      // scope the exonerating read to, so it keeps the whole span — wider, so
      // more likely to find a booking, which is the direction that favours the
      // buddy rather than the flag.
      const window24 = peak && peak.placed > 0 ? peak : null;
      if (toggleCount <= AVAILABLE_TOGGLE_MIN) continue;

      // Check if this user has any completed bookings in the same window.
      // On a catch-up pass "the same window" is the 24 h the toggles were
      // counted in, NOT the whole catch-up span: exonerating a buddy who
      // toggled 30 times on Friday because they completed a booking on Monday
      // would make this detector weaker than the timely scan it is standing in
      // for, and the claim the flag makes is specifically "no bookings in the
      // 24 h they were toggling".
      const bq = db
        .from("rent_buddy_bookings")
        .select("id")
        .eq("buddy_id", uid)
        .eq("status", "completed")
        .gte("created_at", window24 ? new Date(window24.startMs).toISOString() : since);
      if (window24) bq.lte("created_at", new Date(window24.startMs + widthMs).toISOString());
      const { data: bookings, error: bookingsErr } = await bq;
      // This read EXONERATES. Coalescing a failure to `[]` reads as "no
      // bookings", which is the flagging branch — so an unreadable table would
      // punish a busy buddy for toggling their availability.
      if (bookingsErr) return failed("available_now_abuse", bookingsErr.message, flags);

      const hasBookings = ((bookings as any[]) ?? []).length > 0;
      if (!hasBookings) {
        flags.push({
          patternType:   "available_now_abuse",
          involvedUsers: [uid],
          severity:      toggleCount > 40 ? "high" : "medium",
          evidence:      {
            toggle_count:       toggleCount,
            window_hours:       widthMs / HOUR_MS,
            bookings_completed: 0,
            scanned_from:    since,
            scanned_through: w.through.toISOString(),
            ...(catchingUp ? { catchup_scan: true, scanned_hours: Math.round(spanMs / HOUR_MS) } : {}),
            ...(w.capped ? { catchup_capped: true } : {}),
          },
        });
      }
    }
  } catch (e) {
    return failed("available_now_abuse", (e as Error).message, flags);
  }
  return ok("available_now_abuse", flags);
}

/** 8. Refund abuse — >3 booking cancellations/refunds in 30 days */
async function detectRefundAbuse(
  db:     SupabaseClient,
  userId: string | null,
): Promise<DetectorOutcome> {
  const flags: AbuseFlag[] = [];
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const q = db
      .from("rent_buddy_bookings")
      .select("traveler_id, status, created_at")
      // `refunded` is not a label of the `rent_buddy_booking_status` enum, and
      // Postgres rejects an unknown enum literal outright (22P02) rather than
      // matching nothing — so this read failed WHOLE, `{ data }` was undefined,
      // and detector 8 of 8 has never flagged anyone. There is no refund status
      // in the enum at all; the expressible half of the intent is the
      // traveller's own cancellations, and `cancelled_by_traveler` is the label
      // rentABuddy.ts:1636 writes for exactly that. Buddy-initiated
      // cancellations are deliberately NOT counted here: the rows are grouped
      // by traveler_id, so including them would flag travellers for something
      // they did not do.
      .in("status", ["cancelled", "cancelled_by_traveler"])
      .gte("created_at", since);

    if (userId) q.eq("traveler_id", userId);

    const { data, error } = await q;
    // The 22P02 that silenced this detector for its whole life produced exactly
    // this error object. It is now reported instead of being read as innocence.
    if (error) return failed("refund_abuse", error.message);
    const rows = (data as any[]) ?? [];

    const countByUser = new Map<string, number>();
    for (const r of rows) {
      countByUser.set(r.traveler_id, (countByUser.get(r.traveler_id) ?? 0) + 1);
    }

    for (const [uid, count] of countByUser) {
      if (count > REFUND_ABUSE_MIN) {
        flags.push({
          patternType:   "refund_abuse",
          involvedUsers: [uid],
          severity:      count > 6 ? "high" : "medium",
          evidence:      { cancellation_count: count, window_days: 30 },
        });
      }
    }
  } catch (e) {
    return failed("refund_abuse", (e as Error).message, flags);
  }
  return ok("refund_abuse", flags);
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run all abuse pattern scans.
 *
 * @param db      Supabase service-role client.
 * @param userId  If provided, scope scans to this user only (on-demand mode).
 *                If null, run globally (scheduled mode).
 * @returns       The number of new flags written.
 */
export async function runScan(
  db:     SupabaseClient | null,
  userId: string | null = null,
  opts:   RunScanOptions = {},
): Promise<ScanResult> {
  // No client is not a clean scan either — nothing was looked at.
  if (!db) {
    return {
      flagsWritten: 0,
      status: "incomplete",
      failedDetectors: [{ detector: "mutual_review_ring", error: "no service client available" }],
      watermarkFailures: [],
    };
  }

  const now   = opts.now ?? new Date();
  const nowMs = now.getTime();
  // `in`, not `??`: `??` does not short-circuit on an explicit null, so a
  // caller saying "there is no watermark store" would silently get the real
  // one. Same trap as telegraph/lifecycleScheduler.ts's client option.
  const ports = "watermarks" in opts && opts.watermarks !== undefined
    ? opts.watermarks
    : DEFAULT_WATERMARK_PORTS;

  let flagsWritten = 0;
  const failedDetectors: Array<{ detector: AbusePatternType; error: string }> = [];
  const watermarkFailures: Array<{ job: string; phase: "read" | "commit"; error: string }> = [];
  /** The window handed to each narrow detector, when one could be established. */
  const windows     = new Map<AbusePatternType, ScanWindow>();
  /** Jobs whose watermark was READ successfully, so advancing it is meaningful. */
  const committable = new Set<NarrowScan>();
  /** Detectors whose flags were found but could not be durably recorded. */
  const unrecorded  = new Set<AbusePatternType>();
  let scanAborted = false;

  for (const key of Object.keys(NARROW_SCANS) as NarrowScan[]) {
    const spec = NARROW_SCANS[key];
    // No watermark is the calibrated lookback, which is also the FLOOR: a
    // watermark can only ever move `since` earlier than this, never later.
    let watermark: Date | null = null;

    // Watermarks are read for the SCHEDULED GLOBAL pass only. An on-demand
    // scoped scan (userId set) reads ONE user's rows, so committing its
    // `through` would declare that window covered for every OTHER user and
    // recreate exactly the permanent skip this is fixing — just aimed at
    // everyone who was not the subject of the report. Scoped scans keep their
    // calibrated lookbacks and commit nothing.
    if (userId === null && ports) {
      let at: Date | null = null;
      let readOk = false;
      try {
        const r = await ports.read(db, spec.job);
        at = r.at;
        readOk = r.ok;
      } catch (e) {
        watermarkFailures.push({ job: spec.job, phase: "read", error: (e as Error)?.message ?? "threw" });
      }
      if (readOk) {
        // Union, never replacement: a watermark NEWER than the calibrated
        // lookback is not used, because it would NARROW the window (see
        // NARROW_SCANS). The job is committable either way, so the mark keeps
        // moving forward on every clean pass.
        watermark = at !== null && at.getTime() < nowMs - spec.lookbackMs ? at : null;
        committable.add(key);
      } else if (!watermarkFailures.some((f) => f.job === spec.job)) {
        // `ok: false` is a REFUSAL, not an absence — `{ at: null, ok: true }`
        // is the absence. Treating it as absence would quietly reset coverage
        // to `now - lookback` on every transient DB error, which is the very
        // "a check that cannot establish its result assumes instead of
        // failing" shape CONTRIBUTING.md:33-66 forbids. The detector falls
        // back to its calibrated lookback and the job stays OUT of
        // `committable`, so nothing is advanced and the uncovered time is
        // still there to be covered by the next tick.
        watermarkFailures.push({ job: spec.job, phase: "read", error: "watermark read did not establish a result" });
      }
    }

    windows.set(key, scanWindow({
      watermark,
      now,
      defaultLookbackMs: spec.lookbackMs,
      maxCatchupMs:      spec.maxCatchupMs,
    }));
  }

  {
    const cappedJobs = [...committable].filter((k) => windows.get(k)?.capped);
    if (cappedJobs.length > 0) {
      // Said out loud because it is a real gap, not a tidy success: everything
      // older than the cap in these windows will never be evaluated by this
      // detector. See NARROW_SCANS for why that trade is taken.
      logger.warn(
        {
          cappedJobs: cappedJobs.map((k) => ({
            job:   NARROW_SCANS[k].job,
            since: windows.get(k)!.since.toISOString(),
            maxCatchupHours: NARROW_SCANS[k].maxCatchupMs / HOUR_MS,
          })),
        },
        "abuse scan catch-up CAPPED — abuse older than the cap in these windows was not evaluated",
      );
    }
  }

  const DETECTORS: Array<[AbusePatternType, (db: SupabaseClient, u: string | null, w: ScanWindow | null) => Promise<DetectorOutcome>]> = [
    ["mutual_review_ring",  detectMutualReviewRings],
    ["booking_loop",        detectBookingLoops],
    ["referral_farm",       detectReferralFarms],
    ["comment_pod",         detectCommentPods],
    ["hashtag_spam",        detectHashtagSpam],
    ["geotag_farming",      detectGeotagFarming],
    ["available_now_abuse", detectAvailableNowAbuse],
    ["refund_abuse",        detectRefundAbuse],
  ];

  try {
    const settled = await Promise.allSettled(
      DETECTORS.map(([name, fn]) => fn(db, userId, windows.get(name) ?? null)),
    );

    // Flags carry their detector from here on: a watermark may only be
    // advanced for a detector whose OWN flags were all recorded.
    const allFlags: Array<{ detector: AbusePatternType; flag: AbuseFlag }> = [];
    settled.forEach((s, i) => {
      const name = DETECTORS[i]![0];
      if (s.status === "rejected") {
        // A detector that threw past its own guard measured nothing either.
        failedDetectors.push({ detector: name, error: String((s.reason as Error)?.message ?? s.reason) });
        return;
      }
      const outcome = s.value;
      for (const flag of outcome.flags) allFlags.push({ detector: outcome.detector, flag });
      if (outcome.failed) {
        failedDetectors.push({ detector: outcome.detector, error: outcome.error ?? "unknown read failure" });
      }
    });

    const writes = await Promise.allSettled(
      allFlags.map(async ({ flag }) => handleFlag(db, flag)),
    );
    writes.forEach((wr, i) => {
      const { detector } = allFlags[i]!;
      // `flagsWritten` now counts rows that actually landed. It used to count
      // handleFlag CALLS, so a rejected insert still reported a flag written —
      // the "a successful call is not evidence of the side effect" shape from
      // CONTRIBUTING.md, in the number the scheduler logs hourly.
      if (wr.status === "fulfilled" && wr.value) flagsWritten++;
      else unrecorded.add(detector);
    });
  } catch (e) {
    // The scheduler must not crash — but it must also not be told this scan
    // was clean. A blanket failure marks every detector unmeasured.
    scanAborted = true;
    failedDetectors.push({ detector: "mutual_review_ring", error: `scan aborted: ${(e as Error).message}` });
  }

  // ── Commit, and only now ────────────────────────────────────────────────────
  // A watermark is advanced strictly AFTER the pass, and only for a detector
  // whose own pass actually completed: it read its table, it did not throw, and
  // every flag it produced was durably inserted. Advancing past a window whose
  // abuse was never read — or was read and then dropped on the floor by a
  // failed insert — would discard it permanently and invisibly, which is the
  // defect being fixed rather than a smaller version of it. Re-scanning a
  // window costs at most a duplicate flag, and this scan already overlaps
  // itself hourly today.
  if (ports) {
    for (const key of committable) {
      const w    = windows.get(key)!;
      const spec = NARROW_SCANS[key];
      if (scanAborted) continue;
      if (failedDetectors.some((f) => f.detector === key)) continue;
      if (unrecorded.has(key)) continue;
      try {
        // `w.through`, never a fresh `now`: committing a later instant would
        // skip the time between the start of this pass and this line.
        const advanced = await ports.commit(db, spec.job, w.through);
        if (!advanced) {
          watermarkFailures.push({ job: spec.job, phase: "commit", error: "commit did not confirm the row was advanced" });
        }
      } catch (e) {
        watermarkFailures.push({ job: spec.job, phase: "commit", error: (e as Error)?.message ?? "threw" });
      }
    }
  }

  if (watermarkFailures.length > 0) {
    logger.warn(
      { watermarkFailures, userId },
      "abuse scan watermarks: a read or commit did not complete — this pass covered or recorded less time than it could have; the next pass re-covers it",
    );
  }

  if (failedDetectors.length > 0) {
    logger.warn(
      { failedDetectors, flagsWritten, userId },
      "abuse scan INCOMPLETE — one or more detectors could not read; this is not a clean result",
    );
  }

  return {
    flagsWritten,
    status: failedDetectors.length > 0 ? "incomplete" : "ok",
    failedDetectors,
    watermarkFailures,
  };
}
