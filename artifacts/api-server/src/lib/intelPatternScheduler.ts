/**
 * Intelligence Gathering — §12 pattern-learning PRODUCER scheduler.
 *
 * The nightly autonomous pass (spec §21 "Pattern learning nightly from finalized
 * outcomes; never from mutable live projection alone"). Each run:
 *   1. reads FINALIZED intel_observations inside the widest Table-19 window,
 *   2. derives recurring cohort patterns (lib/intelPatternLearning.derivePatterns),
 *      Table-19 minimums enforced there and re-verified by the DB CHECK,
 *   3. writes invalidation tombstones for patterns whose source claim family was
 *      retracted/superseded/corrected (spec §12 "Pattern invalidation") — one per
 *      CURRENTLY SERVED pattern, carrying the full read key (time_band AND dow)
 *      so liveClaimRead.readTypicalPatterns can actually match it, and skipping
 *      scopes already retired so the pass is idempotent night over night,
 *   4. INSERTs the derived patterns (append-only — supersession is a new row).
 *
 * Gated on `intel_pattern_learning`, fail-closed, self-rescheduling — the house
 * scheduler shape (see intelCoverageScheduler). Off ⇒ an inert no-op that writes
 * nothing. Never writes outcomes; reads observations + claims only.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import {
  derivePatterns,
  deriveInvalidations,
  currentlyServedPatterns,
  scopeKeysOf,
  PATTERN_MINIMUMS,
  CLAIM_TYPE_PATTERN_KIND,
  type FinalizedObservation,
  type InvalidatingClaim,
  type ExistingPattern,
  type StoredPatternRow,
  type PatternKind,
} from "./intelPatternLearning.js";

const PATTERN_FLAG = "intel_pattern_learning";
const STARTUP_DELAY_MS = 6 * 60 * 1000;          // after projection/coverage settle
const INTERVAL_MS = 24 * 60 * 60 * 1000;         // nightly
const MAX_OBS = 50000;
const MAX_CLAIMS = 20000;
const MAX_CURRENT_PATTERNS = 50000;

// Widest Table-19 window across all produced kinds, so one observation read
// covers every kind (each kind then applies its own narrower window internally).
const MAX_WINDOW_DAYS = Math.max(...Object.values(PATTERN_MINIMUMS).map((m) => m.windowDays));
const PRODUCED_CLAIM_TYPES = Object.keys(CLAIM_TYPE_PATTERN_KIND);

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface PatternPassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  observations: number;
  patternsWritten: number;
  invalidationsWritten: number;
}

export async function runPatternLearningPass(opts: { client?: any; now?: Date } = {}): Promise<PatternPassResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const empty: PatternPassResult = { skipped: true, reason: null, observations: 0, patternsWritten: 0, invalidationsWritten: 0 };
  if (!db) return { ...empty, reason: "no_client" };
  if (!(await isFlagEnabled(db, PATTERN_FLAG))) return { ...empty, reason: "disabled" };

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const windowIso = new Date(nowMs - MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. finalized observations for the produced families, inside the widest window.
    const { data: obsData, error: obsErr } = await db
      .from("intel_observations")
      .select("subject_id, zone_id, claim_type, value, observed_at, actor_id, group_key, moderation_state")
      .in("claim_type", PRODUCED_CLAIM_TYPES)
      .gte("observed_at", windowIso)
      .limit(MAX_OBS);
    if (obsErr) { logger.warn({ err: obsErr }, "pattern pass: observation read failed"); return { ...empty, reason: "error" }; }

    // Only moderation-eligible content backs a pattern (invalidated content excluded).
    const observations: FinalizedObservation[] = ((obsData ?? []) as any[])
      .filter((r) => r.moderation_state == null || r.moderation_state === "allowed" || r.moderation_state === "pending")
      .map((r) => ({
        subjectId: String(r.subject_id),
        zoneId: r.zone_id ?? null,
        claimType: String(r.claim_type),
        value: r.value,
        observedAt: String(r.observed_at),
        actorId: r.actor_id ?? null,
        groupKey: r.group_key ?? null,
      }));

    const patterns = derivePatterns(observations, { now });

    // 3. invalidations — retracted/superseded/rejected claims vs currently-served patterns.
    const { data: claimData, error: claimErr } = await db
      .from("intel_claims")
      .select("subject_id, zone_id, claim_type, status")
      .in("status", ["retracted", "superseded", "rejected"])
      .limit(MAX_CLAIMS);
    if (claimErr) logger.warn({ err: claimErr }, "pattern pass: invalidating-claim read failed (non-fatal; skipping invalidation)");
    const invalidating: InvalidatingClaim[] = ((claimData ?? []) as any[]).map((r) => ({
      subjectId: String(r.subject_id),
      zoneId: r.zone_id ?? null,
      claimType: String(r.claim_type),
      status: String(r.status),
    }));

    let currentPatterns: ExistingPattern[] = [];
    if (invalidating.length > 0) {
      // Read tombstones TOO (no is_invalidation filter): a scope whose newest row
      // is already a tombstone is not served, so it must not be tombstoned again.
      // Filtering them out here is what made the pass re-insert the same tombstone
      // every night. currentlyServedPatterns applies the reader's own rule —
      // newest row per (subject, zone, family, kind, time_band, dow) — so the
      // invalidation pass is idempotent.
      const { data: curData, error: curErr } = await db
        .from("intel_historical_patterns")
        .select("id, subject_id, zone_id, claim_family, pattern_kind, time_band, dow, computed_at, is_invalidation")
        .limit(MAX_CURRENT_PATTERNS);
      if (curErr) logger.warn({ err: curErr }, "pattern pass: current-pattern read failed (non-fatal)");
      const stored: StoredPatternRow[] = ((curData ?? []) as any[]).map((r) => ({
        id: String(r.id),
        subjectId: String(r.subject_id),
        zoneId: r.zone_id ?? null,
        claimFamily: String(r.claim_family),
        patternKind: String(r.pattern_kind) as PatternKind,
        timeBand: String(r.time_band),
        dow: typeof r.dow === "number" ? r.dow : r.dow == null ? null : Number(r.dow),
        computedAt: String(r.computed_at),
        isInvalidation: r.is_invalidation === true,
      }));
      currentPatterns = currentlyServedPatterns(stored);
    }
    const tombstones = deriveInvalidations(invalidating, currentPatterns, scopeKeysOf(patterns));

    // 4. persist — tombstones first, then fresh patterns. Both append-only INSERTs.
    let invalidationsWritten = 0;
    if (tombstones.length > 0) {
      const rows = tombstones.map((t) => ({
        subject_id: t.subjectId,
        zone_id: t.zoneId,
        claim_family: t.claimFamily,
        pattern_kind: t.patternKind,
        time_band: t.timeBand,
        // THE READER MATCHES ON dow. liveClaimRead.readTypicalPatterns filters
        // `.eq("time_band", …).eq("dow", …)` before it takes the newest row per
        // scope, so a tombstone written without dow lands as NULL, matches
        // nothing, and the retracted pattern keeps serving indefinitely. The
        // tombstone carries the full key of the row it supersedes.
        dow: t.dow,
        value_json: {},
        is_invalidation: true,
        invalidation_reason: t.reason,
        supersedes_id: t.supersedesId,
        source_label: "historical_pattern",
        computed_at: now.toISOString(),
      }));
      const { error: invErr } = await db.from("intel_historical_patterns").insert(rows);
      if (invErr) logger.warn({ err: invErr }, "pattern pass: invalidation write failed (non-fatal)");
      else invalidationsWritten = rows.length;
    }

    let patternsWritten = 0;
    if (patterns.length > 0) {
      const rows = patterns.map((p) => ({
        subject_id: p.subjectId,
        zone_id: p.zoneId,
        claim_family: p.claimFamily,
        pattern_kind: p.patternKind,
        time_band: p.timeBand,
        dow: p.dow,
        value_json: p.valueJson,
        cohort_size: p.cohortSize,
        distinct_contributors: p.distinctContributors,
        distinct_dates: p.distinctDates,
        window_days: p.windowDays,
        confidence: p.confidence,
        source_label: "historical_pattern",
        computed_at: now.toISOString(),
      }));
      const { error: insErr } = await db.from("intel_historical_patterns").insert(rows);
      if (insErr) { logger.warn({ err: insErr }, "pattern pass: pattern write failed"); return { ...empty, reason: "error" }; }
      patternsWritten = rows.length;
    }

    if (patternsWritten > 0 || invalidationsWritten > 0) {
      logger.info({ observations: observations.length, patternsWritten, invalidationsWritten }, "pattern learning pass complete");
    }
    return { skipped: false, reason: null, observations: observations.length, patternsWritten, invalidationsWritten };
  } catch (err) {
    logger.warn({ err }, "pattern learning pass threw");
    return { ...empty, reason: "error" };
  }
}

export function startIntelPatternScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: PATTERN_FLAG },
    "IntelPatternScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runPatternLearningPass()
      .catch((err) => logger.warn({ err }, "pattern learning pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelPatternScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
