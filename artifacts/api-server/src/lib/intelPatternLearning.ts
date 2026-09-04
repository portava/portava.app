/**
 * Intelligence Gathering — §12 historical pattern learning (PURE core).
 *
 * No I/O. Turns FINALIZED intel observations (append-only firsthand reports —
 * NOT the mutable live projection, spec §21) into recurring cohort patterns,
 * enforcing the Table-19 minimums so a pattern is NEVER derived below its cohort
 * floor. lib/intelPatternScheduler.ts supplies the rows and persists the output.
 *
 * ELIGIBILITY (Table 18) is a hard gate here, mirrored by the DB CHECK on
 * intel_historical_patterns: "A live observation does not become a historical
 * pattern until multiple independent finalized outcomes satisfy minimum cohort,
 * time coverage and accuracy checks." A bucket below its minimum yields NOTHING —
 * absence of a pattern, never a thin one dressed up as typical.
 *
 * WHAT THIS PRODUCES (observation-derived kinds only):
 *   • typical_crowd_by_weekday_hour  ← crowd.level
 *   • typical_crowd_mix              ← crowd.mix
 *   • recurring_queue                ← queue.wait
 * peak_arrival_time and venue_to_venue_movement need arrival/direction OUTCOME
 * sequences (canonical_events), owned by the outcome/trail units — the table
 * supports them, but this core does not fabricate them from observations.
 */
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";

export const PATTERN_KINDS = [
  "typical_crowd_by_weekday_hour",
  "peak_arrival_time",
  "typical_crowd_mix",
  "recurring_queue",
  "venue_to_venue_movement",
] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

/**
 * Table 19 minimum cohorts + rolling windows. `cohortMetric` says WHICH count the
 * kind's minimum applies to (and which count becomes the row's cohort_size the DB
 * CHECK re-verifies): "independent qualifying visits" (distinct actor×date) vs raw
 * report count.
 */
export const PATTERN_MINIMUMS: Record<
  PatternKind,
  { cohortMetric: "independent_visits" | "reports"; minCohort: number; minDates: number; minContributors: number; windowDays: number }
> = {
  typical_crowd_by_weekday_hour: { cohortMetric: "independent_visits", minCohort: 8,  minDates: 4, minContributors: 0, windowDays: 120 },
  peak_arrival_time:             { cohortMetric: "independent_visits", minCohort: 12, minDates: 6, minContributors: 0, windowDays: 180 },
  typical_crowd_mix:             { cohortMetric: "reports",            minCohort: 15, minDates: 0, minContributors: 5, windowDays: 120 },
  recurring_queue:               { cohortMetric: "independent_visits", minCohort: 10, minDates: 5, minContributors: 0, windowDays: 90 },
  venue_to_venue_movement:       { cohortMetric: "independent_visits", minCohort: PRIVACY_THRESHOLD_V1.minUniqueActors, minDates: 4, minContributors: PRIVACY_THRESHOLD_V1.minUniqueActors, windowDays: 120 },
};

/** Which observation claim_type feeds which OBSERVATION-derived pattern kind. */
export const CLAIM_TYPE_PATTERN_KIND: Readonly<Record<string, PatternKind>> = {
  "crowd.level": "typical_crowd_by_weekday_hour",
  "crowd.mix": "typical_crowd_mix",
  "queue.wait": "recurring_queue",
};

export interface FinalizedObservation {
  subjectId: string;
  zoneId?: string | null;
  claimType: string;
  value: unknown;
  observedAt: string; // ISO
  actorId?: string | null;
  groupKey?: string | null;
}

export interface DerivedPattern {
  subjectId: string;
  zoneId: string | null;
  claimFamily: string; // stores the claim_type (e.g. 'crowd.level')
  patternKind: PatternKind;
  timeBand: string;    // 'hour_HH'
  dow: number;         // 0..6, UTC
  valueJson: unknown;  // the modal/typical value
  cohortSize: number;  // the kind's cohortMetric count (what the DB CHECK re-verifies)
  distinctContributors: number;
  distinctDates: number;
  windowDays: number;
  confidence: number;  // 0..1, conservative
}

/** UTC calendar-date key 'YYYY-MM-DD' — the unit of "distinct dates". */
function dateKey(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** UTC hour 0..23 and day-of-week 0..6, or null on a bad timestamp. */
function hourDow(iso: string): { hour: number; dow: number } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return { hour: d.getUTCHours(), dow: d.getUTCDay() };
}

/** Stable, order-independent key so equal values (objects included) tally together. */
function stableValueKey(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>).sort().reduce<Record<string, unknown>>(
          (acc, k) => { acc[k] = (val as Record<string, unknown>)[k]; return acc; }, {})
      : val,
  );
}

interface Bucket {
  subjectId: string;
  zoneId: string | null;
  claimType: string;
  hour: number;
  dow: number;
  reports: number;
  actorDatePairs: Set<string>;      // independent qualifying visits
  actors: Set<string>;
  dates: Set<string>;
  valueCounts: Map<string, { count: number; value: unknown }>;
}

const zk = (z: string | null | undefined): string => z ?? "";

/**
 * Derive recurring patterns from finalized observations. `now` bounds the rolling
 * window per kind; an observation older than the kind's window is excluded from
 * that kind. A bucket that fails its Table-19 minimum produces nothing.
 */
export function derivePatterns(
  observations: readonly FinalizedObservation[],
  opts: { now?: Date } = {},
): DerivedPattern[] {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const buckets = new Map<string, Bucket>();

  for (const o of observations) {
    const kind = CLAIM_TYPE_PATTERN_KIND[o.claimType];
    if (!kind) continue;                       // no observation-derived kind for this type
    if (!o.subjectId || o.value == null) continue;
    const min = PATTERN_MINIMUMS[kind];
    const t = Date.parse(o.observedAt);
    if (Number.isNaN(t)) continue;             // a bad timestamp is not a qualifying data point
    if (t < nowMs - min.windowDays * 24 * 60 * 60 * 1000) continue; // outside the rolling window
    const hd = hourDow(o.observedAt);
    const dk = dateKey(o.observedAt);
    if (!hd || !dk) continue;

    const key = JSON.stringify([o.subjectId, zk(o.zoneId), o.claimType, hd.hour, hd.dow]);
    let b = buckets.get(key);
    if (!b) {
      b = {
        subjectId: o.subjectId, zoneId: o.zoneId ?? null, claimType: o.claimType,
        hour: hd.hour, dow: hd.dow, reports: 0,
        actorDatePairs: new Set(), actors: new Set(), dates: new Set(), valueCounts: new Map(),
      };
      buckets.set(key, b);
    }
    b.reports += 1;
    if (o.actorId) { b.actors.add(o.actorId); b.actorDatePairs.add(`${o.actorId}|${dk}`); }
    b.dates.add(dk);
    const vk = stableValueKey(o.value);
    const vc = b.valueCounts.get(vk);
    if (vc) vc.count += 1; else b.valueCounts.set(vk, { count: 1, value: o.value });
  }

  const out: DerivedPattern[] = [];
  for (const b of buckets.values()) {
    const kind = CLAIM_TYPE_PATTERN_KIND[b.claimType];
    if (!kind) continue;
    const min = PATTERN_MINIMUMS[kind];
    const independentVisits = b.actorDatePairs.size;
    const distinctContributors = b.actors.size;
    const distinctDates = b.dates.size;
    const cohortSize = min.cohortMetric === "independent_visits" ? independentVisits : b.reports;

    // Table-19 / Table-18 eligibility — ALL floors must clear, else no pattern.
    if (cohortSize < min.minCohort) continue;
    if (min.minDates > 0 && distinctDates < min.minDates) continue;
    if (min.minContributors > 0 && distinctContributors < min.minContributors) continue;

    // Modal (typical) value — deterministic tie-break by value key for replayability.
    let best: { count: number; value: unknown; vk: string } | null = null;
    for (const [vk, { count, value }] of b.valueCounts) {
      if (!best || count > best.count || (count === best.count && vk < best.vk)) best = { count, value, vk };
    }
    if (!best) continue;

    // Conservative confidence: how dominant the modal value is, damped by how far
    // past the minimum the cohort reached. Bounded [0,1]; never overstated.
    const dominance = best.count / (cohortSize > 0 ? Math.max(cohortSize, b.reports) : 1);
    const depth = Math.min(1, cohortSize / (min.minCohort * 2));
    const confidence = Math.max(0, Math.min(1, dominance * depth));

    out.push({
      subjectId: b.subjectId,
      zoneId: b.zoneId,
      claimFamily: b.claimType,
      patternKind: kind,
      timeBand: `hour_${String(b.hour).padStart(2, "0")}`,
      dow: b.dow,
      valueJson: best.value,
      cohortSize,
      distinctContributors,
      distinctDates,
      windowDays: min.windowDays,
      confidence,
    });
  }

  // Deterministic order (replayability): subject, zone, family, kind, dow, hour.
  out.sort((a, z) =>
    a.subjectId < z.subjectId ? -1 : a.subjectId > z.subjectId ? 1 :
    zk(a.zoneId) < zk(z.zoneId) ? -1 : zk(a.zoneId) > zk(z.zoneId) ? 1 :
    a.claimFamily < z.claimFamily ? -1 : a.claimFamily > z.claimFamily ? 1 :
    a.patternKind < z.patternKind ? -1 : a.patternKind > z.patternKind ? 1 :
    a.dow - z.dow || (a.timeBand < z.timeBand ? -1 : a.timeBand > z.timeBand ? 1 : 0),
  );
  return out;
}

// ── Invalidation (spec §12 "Pattern invalidation") ────────────────────────────

/** A claim whose retraction/supersession/correction invalidates dependent patterns. */
export interface InvalidatingClaim {
  subjectId: string;
  zoneId?: string | null;
  claimType: string;
  status: string;      // 'retracted' | 'superseded' | 'rejected' | ...
}

/** An existing current pattern row (what the read would serve today). */
export interface ExistingPattern {
  id: string;
  subjectId: string;
  zoneId: string | null;
  claimFamily: string;
  patternKind: PatternKind;
  timeBand: string;
  computedAt: string;
}

export interface InvalidationTombstone {
  subjectId: string;
  zoneId: string | null;
  claimFamily: string;
  patternKind: PatternKind;
  timeBand: string;
  supersedesId: string;
  reason: string;
}

const INVALIDATING_STATUSES = new Set(["retracted", "superseded", "rejected"]);

/**
 * Given the claims that were retracted/superseded/rejected and the patterns
 * currently served, produce a tombstone for each current pattern whose source
 * claim family was invalidated — its provenance is now in doubt (spec §12 "Data
 * provenance is later invalidated"). One tombstone per affected pattern;
 * append-only supersession, never an UPDATE.
 *
 * SELF-HEALING: a scope (subject|zone|family) for which THIS pass derived a fresh
 * qualifying pattern is NOT tombstoned — the family still has qualifying evidence,
 * so retiring it would only churn. `freshScopes` carries those scope keys (from
 * `scopeKeysOf(derivePatterns(...))`); pass an empty set to tombstone regardless.
 */
export function deriveInvalidations(
  invalidating: readonly InvalidatingClaim[],
  current: readonly ExistingPattern[],
  freshScopes: ReadonlySet<string> = new Set(),
): InvalidationTombstone[] {
  const invalidatedFamilies = new Set<string>();
  for (const c of invalidating) {
    if (!INVALIDATING_STATUSES.has(c.status)) continue;
    if (!c.subjectId || !c.claimType) continue;
    invalidatedFamilies.add(`${c.subjectId}|${zk(c.zoneId)}|${c.claimType}`);
  }

  const out: InvalidationTombstone[] = [];
  for (const p of current) {
    const key = `${p.subjectId}|${zk(p.zoneId)}|${p.claimFamily}`;
    if (!invalidatedFamilies.has(key)) continue;
    if (freshScopes.has(key)) continue; // a fresh qualifying pattern replaces it this pass
    out.push({
      subjectId: p.subjectId,
      zoneId: p.zoneId,
      claimFamily: p.claimFamily,
      patternKind: p.patternKind,
      timeBand: p.timeBand,
      supersedesId: p.id,
      reason: "source_provenance_invalidated",
    });
  }
  return out;
}

/** Scope keys (subject|zone|family) of derived patterns — for `deriveInvalidations`. */
export function scopeKeysOf(patterns: readonly DerivedPattern[]): Set<string> {
  const s = new Set<string>();
  for (const p of patterns) s.add(`${p.subjectId}|${zk(p.zoneId)}|${p.claimFamily}`);
  return s;
}
