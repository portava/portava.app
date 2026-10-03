/**
 * TrustGamingDetectionService
 *
 * Scheduled / on-demand scan for gaming patterns.
 * Never auto-penalises — only creates trust_reviews of type 'gaming_suspected'.
 *
 * Detects:
 *  1. Same-location check-in cluster farming (daily limit exceeded)
 *  2. Mutual upvote rings (pair/group mutual engagement above threshold)
 *  3. Rapid score jumps inconsistent with event history
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { COUNTERPARTY_METADATA_KEY } from "./TrustEventService.js";
import { scanWindow, readWatermark, commitWatermark } from "../../lib/schedulerWatermark.js";

const logger = rootLogger.child({ service: "TrustGamingDetectionService" });

/**
 * Read the counterpart user id out of a trust_events.metadata value.
 *
 * jsonb comes back as an object from supabase-js, but a hand-written row or an
 * older client can deliver a JSON string, and metadata is nullable — so this
 * tolerates all three and returns null rather than throwing inside a scan whose
 * failure mode is "flag nobody".
 */
function readCounterparty(metadata: unknown): string | null {
  let m = metadata;
  if (typeof m === "string") {
    try { m = JSON.parse(m); } catch { return null; }
  }
  if (!m || typeof m !== "object") return null;
  const v = (m as Record<string, unknown>)[COUNTERPARTY_METADATA_KEY];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ── Scan watermarks: why two of the three detectors need one ─────────────────

/**
 * THE DEFECT. The maintenance pass that drives this scan runs every six hours
 * (trustMaintenanceScheduler.ts: TRUST_MAINTENANCE_INTERVAL_HOURS, default 6),
 * and two of the three detectors below selected their evidence with a bare
 * `created_at > now - 24h` window. A window forgets: once the gap between two
 * passes exceeds the window, every row inside the gap is older than the next
 * pass's `since` and is examined by NO later pass, ever. After a 54-hour outage
 * roughly 30 hours of check-in clusters and rapid score jumps were skipped
 * permanently, and a trust score gamed inside that gap simply stood.
 *
 * This is an abuse-detection path, so the fix may only ever make it see MORE.
 * The watermark does exactly that and nothing else: no threshold moves, no
 * pattern is dropped, and `createGamingReview` is untouched in how it creates
 * and dedupes. `defaultLookbackMs` stays at 24h, so a first run against a
 * database with no mark scans precisely the span it scanned before.
 *
 * `detectMutualRings` keeps its 7-day window and no watermark on purpose: 7
 * days already exceeds any gap this scheduler has produced, so it was never
 * losing evidence, and a ring is a RATIO over a population rather than a count
 * of rows — moving its span would move what the ratio means.
 */

/**
 * ONE JOB KEY PER DETECTOR, not one for the scan.
 *
 * The two detectors read different tables, fail independently (each has its own
 * `error` branch and its own try/catch, and they run concurrently under
 * `Promise.all`), and either can succeed while the other does not. A single
 * shared key would let the detector that succeeded advance the mark past the
 * span the detector that FAILED never examined — manufacturing exactly the
 * permanent skip this watermark exists to close, out of a transient error
 * instead of an outage. Separate keys make each detector's coverage its own.
 *
 * These and the two spans below are exported for the same reason
 * MAX_REVIEW_REPAIRS_PER_PASS is in the scheduler: so a test sizes its fixtures
 * and its watermark rows AGAINST these values rather than against retyped
 * copies that would quietly stop matching the moment one of them moved.
 */
export const CHECKIN_CLUSTER_WATERMARK_JOB = "trust_gaming_checkin_clusters";
export const RAPID_JUMP_WATERMARK_JOB = "trust_gaming_rapid_jumps";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Unchanged from the windows these two detectors have always used, so a
 * database with no stored mark — a first run, a fresh environment, the pass
 * immediately after this deploys — scans the same 24 hours it scanned before.
 */
export const DEFAULT_LOOKBACK_MS = 24 * HOUR_MS;

/**
 * How far back one catch-up pass may reach. SEVEN DAYS.
 *
 * ── THE HAZARD THIS BOUNDS ──────────────────────────────────────────────────
 * Every flag these detectors raise becomes a `trust_reviews` row for a human
 * admin. An uncapped catch-up after a long outage would hand one pass an
 * arbitrarily wide span and could dump a burst of reviews into that queue at
 * once — a self-inflicted denial of the review surface, which is worse than a
 * late flag because it buries the real ones.
 *
 * ── WHAT ACTUALLY BOUNDS THE BURST ──────────────────────────────────────────
 * Not this constant, mostly. `createGamingReview` refuses to insert when the
 * user already has an open or in_progress 'gaming_suspected' review, and that
 * check is per USER and ignores the pattern — so the ceiling on new rows from
 * any one pass is the number of DISTINCT USERS with evidence in the span, at
 * most one row each, no matter how much evidence each of them generated or how
 * many of the detectors fired on them. Widening the span multiplies the
 * evidence examined; it does not multiply the rows per user.
 *
 * ── WHAT THE WIDTH DOES COST, AND WHY SEVEN DAYS ────────────────────────────
 * Sensitivity, and this is the real reason for a cap at all. Both detectors
 * compare an aggregate over the span against a threshold the settings table
 * expresses PER 24 HOURS (`gaming_checkin_cluster_limit`,
 * `gaming_rapid_jump_points` — see the doc comments, "within 24 hours"). Over a
 * 7-day span the same threshold is met by about a seventh of the per-day rate,
 * so a capped catch-up flags more users than a normal pass would. In this
 * direction that is acceptable and deliberate: the output is a review for a
 * human, never an automatic penalty, and this path may err toward seeing more.
 * It is not acceptable unbounded, which is what fixes the number here.
 *
 * Seven days is chosen rather than invented: it is the window
 * `detectMutualRings` below has always run in production, so it introduces no
 * span width this scan has not already tolerated, and it covers
 * twelve consecutive missed passes — far beyond the 54-hour gap that exposed
 * this. Beyond a week the skip IS still permanent, by design: a gap that long
 * is an incident, and the right response is a deliberate backfill with
 * thresholds chosen for the span, not a routine pass quietly applying per-day
 * thresholds to a fortnight. When the cap bites, `capped` is true and the
 * detector logs it, so a catch-up that did not cover everything is never
 * reported as a clean pass.
 */
export const MAX_CATCHUP_MS = 7 * DAY_MS;

/**
 * The span one detector should scan, and whether it may commit afterwards.
 *
 * `commitThrough` is null for exactly one reason: the mark could not be READ.
 * `readWatermark` deliberately distinguishes "no row yet" (`ok:true, at:null`)
 * from "the read failed" (`ok:false`) because the two are indistinguishable in
 * the data and mean opposite things. On a failed read this keeps the old 24h
 * lookback AND withholds the commit, so a transient database error can neither
 * widen a scan nor move the mark — a blip must not be able to look like a fresh
 * install, nor to advance coverage it cannot account for.
 * (CONTRIBUTING.md:33-66: a check that cannot establish its result must fail
 * rather than assume.)
 */
interface DetectorWindow {
  sinceIso: string;
  /** Commit this on success; null means the watermark is unreadable — do not commit. */
  commitThrough: Date | null;
  capped: boolean;
}

async function detectorWindow(db: SupabaseClient, job: string): Promise<DetectorWindow> {
  const now = new Date();
  const mark = await readWatermark(db, job);
  if (!mark.ok) {
    logger.warn(
      { job },
      "gaming scan watermark unreadable — falling back to the 24h lookback and NOT committing",
    );
    return {
      sinceIso: new Date(now.getTime() - DEFAULT_LOOKBACK_MS).toISOString(),
      commitThrough: null,
      capped: false,
    };
  }
  const win = scanWindow({
    watermark: mark.at,
    now,
    defaultLookbackMs: DEFAULT_LOOKBACK_MS,
    maxCatchupMs: MAX_CATCHUP_MS,
  });
  if (win.capped) {
    logger.warn(
      { job, since: win.since.toISOString(), maxCatchupHours: MAX_CATCHUP_MS / HOUR_MS },
      "gaming scan catch-up hit the cap — evidence older than the cap is NOT covered by this pass",
    );
  }
  return { sinceIso: win.since.toISOString(), commitThrough: win.through, capped: win.capped };
}

/**
 * Advance a detector's mark, having established that its scan covered the span.
 *
 * Called only on the success path of the detector, after every review for the
 * span has been accounted for. A commit that does not land is not fatal — the
 * next pass re-scans the same span, and re-scanning is the safe direction — but
 * it is logged, because unproven coverage reported as a clean pass is the thing
 * the watermark is here to prevent.
 */
async function advanceDetectorWatermark(
  db: SupabaseClient,
  job: string,
  through: Date | null,
): Promise<void> {
  if (!through) return;
  const committed = await commitWatermark(db, job, through);
  if (!committed) {
    logger.warn({ job }, "gaming scan watermark did not advance — the span will be re-scanned next pass");
  }
}

interface GamingSettings {
  gaming_checkin_cluster_limit: number;
  gaming_mutual_rate_threshold: number;
  gaming_rapid_jump_points: number;
}

async function loadGamingSettings(db: SupabaseClient): Promise<GamingSettings> {
  const { data, error } = await db.from("trust_settings").select("*").eq("id", 1).maybeSingle();
  if (error) {
    logger.warn({ err: error }, "loadGamingSettings failed — using defaults");
    return { gaming_checkin_cluster_limit: 5, gaming_mutual_rate_threshold: 0.80, gaming_rapid_jump_points: 20 };
  }
  return {
    gaming_checkin_cluster_limit:  Number((data as any)?.gaming_checkin_cluster_limit)  || 5,
    gaming_mutual_rate_threshold:  Number((data as any)?.gaming_mutual_rate_threshold)  || 0.80,
    gaming_rapid_jump_points:      Number((data as any)?.gaming_rapid_jump_points)      || 20,
  };
}

async function isGamingDetectionEnabled(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db
    .from("feature_flags")
    .select("enabled")
    .eq("flag", "trust_gaming_detection_enabled")
    .maybeSingle();
  if (error) {
    logger.warn({ err: error }, "isGamingDetectionEnabled flag read failed — treating as disabled");
    return false;
  }
  return Boolean((data as any)?.enabled);
}

/**
 * Create a gaming review for a user, unless one is already open for them.
 *
 * The dedup and the insert are UNCHANGED. What changed is that the outcome is
 * now returned instead of discarded: `true` means the evidence is represented
 * in the review queue (a row was inserted, or one was already open), `false`
 * means this process could not establish that it is — the existing-check failed
 * or the insert was rejected. Both of those branches already logged and
 * continued, which was correct while the scan re-read the last 24h on every
 * pass and would simply try again. It is NOT correct once a watermark exists:
 * advancing the mark over a span whose flag never reached `trust_reviews` would
 * lose that flag permanently, which is the same defect the watermark closes,
 * reached from the other end. The callers use this to withhold the commit.
 */
async function createGamingReview(
  db: SupabaseClient,
  userId: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  // Only create if no open gaming review already exists for this user (non-fatal)
  const { data: existing, error: readError } = await db
    .from("trust_reviews")
    .select("id")
    .eq("user_id", userId)
    .eq("review_type", "gaming_suspected")
    .in("status", ["open", "in_progress"])
    .maybeSingle();
  if (readError) {
    logger.warn({ err: readError, userId }, "createGamingReview existing-check failed (non-fatal)");
    return false;
  }
  if (existing) return true;

  const { error: insError } = await db.from("trust_reviews").insert({
    user_id:     userId,
    review_type: "gaming_suspected",
    status:      "open",
    metadata,
  });
  if (insError) {
    logger.warn({ err: insError, userId }, "createGamingReview insert failed (non-fatal)");
    return false;
  }
  return true;
}

/**
 * The `plan_attendance_events.event_type` values that represent a member
 * ACTUALLY ARRIVING somewhere — the only rows a check-in farming cluster can be
 * built from.
 *
 * These are exactly the two strings `routes/geofence.ts` writes on a successful
 * check-in (see `upsertCheckin`, geofence.ts:610). They are NOT the whole
 * vocabulary of the table: 'suspicious_check_in' is a REJECTED check-in (the
 * route returns ok:false and writes no plan_checkins row), and
 * 'host_manual_override' is the host acting, not the member — counting either
 * as a check-in would let a host manufacture a cluster against a guest, or let
 * a user farm reviews by failing GPS repeatedly.
 *
 * This list previously read `'checked_in'`, a string no writer has ever
 * produced and the table's CHECK constraint has never admitted, so the scan
 * matched zero rows in every environment. Migration 2302 admits the real
 * vocabulary; this constant names the subset that means "arrived".
 */
export const CHECKIN_CLUSTER_EVENT_TYPES = ["checked_in_successfully", "late_check_in"] as const;

/**
 * Scan for same-location check-in clusters.
 * Flags users with more than gaming_checkin_cluster_limit check-ins
 * at the same geofence within 24 hours.
 *
 * The span is now watermarked (see "Scan watermarks" above): normally the last
 * 24 hours, but after a gap it reaches back to wherever the last SUCCEEDING
 * scan got to, bounded by MAX_CATCHUP_MS. Nothing else about the detector
 * moved — same event types, same strictly-greater-than comparison against the
 * same limit, same grouping by user+geofence.
 */
async function detectCheckinClusters(
  db: SupabaseClient,
  settings: GamingSettings,
): Promise<DetectorResult> {
  let flagged = 0;
  let inputRows = 0;
  try {
    const win = await detectorWindow(db, CHECKIN_CLUSTER_WATERMARK_JOB);
    // No upper bound on the query on purpose. `win.commitThrough` is the instant
    // the span is committed at, and leaving the read open-ended means a row
    // written between that instant and the query can only be scanned twice,
    // never zero times — the safe direction for an abuse detector.
    const { data, error } = await db
      .from("plan_attendance_events")
      .select("user_id, geofence_id")
      .gt("created_at", win.sinceIso)
      .in("event_type", CHECKIN_CLUSTER_EVENT_TYPES as unknown as string[]);

    if (error) {
      // The scan did not happen, so the mark must not move: returning here
      // (rather than falling through) is what leaves this span for the next
      // pass. Same for the `!data` case below.
      logger.warn({ err: error }, "detectCheckinClusters query failed");
      return { flagged: 0, inputRows: null };
    }
    if (!data) return { flagged: 0, inputRows: 0 };
    const rows = data as any[];
    inputRows = rows.length;

    // Group by user+geofence
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.user_id}:${row.geofence_id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let unrecorded = 0;
    for (const [key, count] of counts) {
      if (count > settings.gaming_checkin_cluster_limit) {
        const [userId] = key.split(":");
        const recorded = await createGamingReview(db, userId, {
          pattern: "checkin_cluster",
          checkinCount: count,
          limit: settings.gaming_checkin_cluster_limit,
        });
        if (!recorded) unrecorded++;
        flagged++;
      }
    }

    // Commit LAST, and only over a span that was both scanned and fully
    // accounted for. A flag that never reached `trust_reviews` means this span
    // still owes a review, so the mark stays put and the next pass re-raises
    // it; the per-user dedup is what makes that retry idempotent.
    if (unrecorded > 0) {
      logger.warn(
        { job: CHECKIN_CLUSTER_WATERMARK_JOB, unrecorded },
        "detectCheckinClusters could not record every flag — withholding the watermark commit",
      );
    } else {
      await advanceDetectorWatermark(db, CHECKIN_CLUSTER_WATERMARK_JOB, win.commitThrough);
    }
  } catch {
    // non-fatal — and the mark is untouched, so the span is re-scanned
  }
  return { flagged, inputRows };
}

/**
 * Detect mutual upvote rings.
 * Looks for pairs of users where > threshold% of each other's positive events
 * come from the same counterpart.
 *
 * ── WHAT THIS USED TO DO, AND WHY IT COULD NEVER FIRE ────────────────────────
 * The query filtered `source_type = 'user_action'`. `recordTrustEvent` defaults
 * `sourceType` to 'system', and not one of the ~30 production call sites has
 * ever passed 'user_action' — the emitted values are trips | events | booking |
 * hidden_gem | review | message_request | geofence_checkin | passport | gps |
 * moderation | admin | appeal | safe_return | local_guide | pulse_post.
 * `trust_events.source_type` carries no CHECK constraint, so the filter did not
 * error; it simply matched zero rows, in every environment, always.
 *
 * The pair analysis was dead a second time over: it keyed on `source_id`, which
 * is the OBJECT id (the dedup key), so `totalPerUser.get(sourceId)` was always
 * 0 and the reverse rate always 0. Removing only the source_type filter would
 * have left the detector just as incapable of flagging anyone.
 *
 * Both are fixed here: the scan reads every positive event, and pairs on the
 * counterpart recorded in `metadata[COUNTERPARTY_METADATA_KEY]` — a field that
 * means "the other user", written by the reciprocal surfaces a ring would
 * actually exploit (rent-a-buddy reviews, accepted connection requests).
 */
async function detectMutualRings(
  db: SupabaseClient,
  settings: GamingSettings,
): Promise<DetectorResult> {
  let flagged = 0;
  let inputRows = 0;
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db
      .from("trust_events")
      .select("user_id, source_type, source_id, metadata")
      .gt("created_at", since)
      .gt("delta", 0);

    if (error) {
      logger.warn({ err: error }, "detectMutualRings query failed");
      return { flagged: 0, inputRows: null };
    }
    if (!data) return { flagged: 0, inputRows: 0 };
    const rows = data as any[];
    inputRows = rows.length;

    // Count total positive events per user
    const totalPerUser = new Map<string, number>();
    // Count events sourced from a specific other user
    const pairCounts = new Map<string, number>();

    for (const row of rows) {
      totalPerUser.set(row.user_id, (totalPerUser.get(row.user_id) ?? 0) + 1);
      const counterparty = readCounterparty(row.metadata);
      // A self-referential counterpart is not a pair and must never be counted:
      // it would score a user's own activity as a 100% mutual rate with herself.
      if (counterparty && counterparty !== row.user_id) {
        const key = `${row.user_id}:${counterparty}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }

    for (const [key, count] of pairCounts) {
      const [userId, counterpartyId] = key.split(":");
      const total = totalPerUser.get(userId) ?? 0;
      if (total === 0) continue;
      const rate = count / total;
      // Check mutual: the counterpart also heavily depends on userId
      const reverseKey = `${counterpartyId}:${userId}`;
      const reverseCount = pairCounts.get(reverseKey) ?? 0;
      const reverseTotal = totalPerUser.get(counterpartyId) ?? 0;
      const reverseRate = reverseTotal > 0 ? reverseCount / reverseTotal : 0;

      if (rate > settings.gaming_mutual_rate_threshold && reverseRate > settings.gaming_mutual_rate_threshold) {
        await createGamingReview(db, userId, {
          pattern: "mutual_ring",
          withUserId: counterpartyId,
          rate,
          reverseRate,
        });
        flagged++;
      }
    }
  } catch {
    // non-fatal
  }
  return { flagged, inputRows };
}

/**
 * Detect rapid score jumps.
 * Flags users whose score increased by > gaming_rapid_jump_points
 * within a 24-hour window, inconsistent with normal event history.
 *
 * Watermarked for the same reason as the cluster scan (see "Scan watermarks"
 * above) and under its OWN job key, so this detector failing cannot advance
 * the cluster detector's coverage or the reverse. The threshold, the statuses
 * it accepts and the per-user delta sum are unchanged; only the span can now
 * reach back over a gap instead of forgetting it.
 */
async function detectRapidJumps(
  db: SupabaseClient,
  settings: GamingSettings,
): Promise<DetectorResult> {
  let flagged = 0;
  let inputRows = 0;
  try {
    const win = await detectorWindow(db, RAPID_JUMP_WATERMARK_JOB);
    // Open-ended upper bound, as in the cluster scan: a row landing after
    // `commitThrough` is re-scanned next pass rather than skipped.
    const { data, error } = await db
      .from("trust_events")
      .select("user_id, delta, created_at")
      .gt("created_at", win.sinceIso)
      .in("status", ["applied", "confirmed"]);

    if (error) {
      // Returning without committing is what leaves this span to the next pass.
      logger.warn({ err: error }, "detectRapidJumps query failed");
      return { flagged: 0, inputRows: null };
    }
    if (!data) return { flagged: 0, inputRows: 0 };
    const rows = data as any[];
    inputRows = rows.length;

    const deltaPerUser = new Map<string, number>();
    for (const row of rows) {
      deltaPerUser.set(row.user_id, (deltaPerUser.get(row.user_id) ?? 0) + (row.delta ?? 0));
    }

    let unrecorded = 0;
    for (const [userId, total] of deltaPerUser) {
      if (total > settings.gaming_rapid_jump_points) {
        const recorded = await createGamingReview(db, userId, {
          pattern: "rapid_jump",
          // Kept as `deltaIn24h` deliberately: admin views and any stored
          // review row already read this key, and renaming it would rewrite the
          // meaning of rows written before this change. The span is 24h in the
          // steady state and wider only on a catch-up pass.
          deltaIn24h: total,
          threshold: settings.gaming_rapid_jump_points,
        });
        if (!recorded) unrecorded++;
        flagged++;
      }
    }

    if (unrecorded > 0) {
      logger.warn(
        { job: RAPID_JUMP_WATERMARK_JOB, unrecorded },
        "detectRapidJumps could not record every flag — withholding the watermark commit",
      );
    } else {
      await advanceDetectorWatermark(db, RAPID_JUMP_WATERMARK_JOB, win.commitThrough);
    }
  } catch {
    // non-fatal — and the mark is untouched, so the span is re-scanned
  }
  return { flagged, inputRows };
}

/**
 * What one detector examined. `inputRows` is the number of rows its query
 * returned — `null` when the query FAILED (examined nothing because it could
 * not, as opposed to examined nothing because there was nothing).
 */
interface DetectorResult {
  flagged: number;
  inputRows: number | null;
}

/**
 * Row counts each detector examined this scan. Measured in production on
 * 2026-09-07: the flag has been ON since 2026-07-17 and every pass ran all
 * three detectors over ZERO check-ins, ZERO counterparty-bearing positive
 * events and five events total — "0 flagged" was the only answer they could
 * give. Without these numbers a starved scan and a clean population are the
 * same log line. `null` = the query failed.
 */
export interface GamingScanInputs {
  checkins: number | null;
  positiveEvents: number | null;
  scoredEvents: number | null;
}

/** Run all gaming detection scans */
export async function runGamingDetectionScan(db: SupabaseClient): Promise<{
  ok: boolean;
  flaggedUsers: number;
  skipped?: boolean;
  inputs?: GamingScanInputs;
  /** True when every detector that ran examined zero rows: the scan was vacuous. */
  vacuous?: boolean;
}> {
  if (!await isGamingDetectionEnabled(db)) {
    return { ok: true, flaggedUsers: 0, skipped: true };
  }

  const settings = await loadGamingSettings(db);
  const [clusters, rings, jumps] = await Promise.all([
    detectCheckinClusters(db, settings),
    detectMutualRings(db, settings),
    detectRapidJumps(db, settings),
  ]);

  const inputs: GamingScanInputs = {
    checkins:       clusters.inputRows,
    positiveEvents: rings.inputRows,
    scoredEvents:   jumps.inputRows,
  };
  const vacuous = [clusters, rings, jumps].every((d) => d.inputRows === 0 || d.inputRows === null);

  return {
    ok: true,
    flaggedUsers: clusters.flagged + rings.flagged + jumps.flagged,
    inputs,
    vacuous,
  };
}
