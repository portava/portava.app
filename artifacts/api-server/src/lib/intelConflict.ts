/**
 * Material conflict state (IG unit I2 — spec §10 "Material conflict state",
 * AT-07). PURE: no client, no clock other than the timestamps it is handed.
 *
 *   material_conflict = top_two_state_weights >= conflict_min_weight
 *                       AND semantic_distance(top_two_values) >= claim_type.conflict_distance
 *                       AND observation_windows_overlap
 *
 * WHAT WAS THERE BEFORE. lib/intelProjectionAggregator flagged a cohort as
 * "conflicting" when its most-recent values TIED for the lead, and the only
 * effect was a 0.20 materialConflict penalty on the confidence score. That is
 * silent averaging by another name: a venue half-reported 'quiet' and half
 * 'packed' still served whichever value the tie-break picked, with a Live label,
 * and nothing told the reader that the reports disagreed. Invariant §1 says the
 * opposite — "Conflicting material claims produce a visible conflict state until
 * reconciled; they are not silently averaged."
 *
 * THE THREE CONDITIONS, AND WHY EACH ONE EXISTS
 *   1. SEMANTIC DISTANCE. 'busy' vs 'packed' is one step on the crowd ladder —
 *      two honest people at the same bar can disagree by that much. 'quiet' vs
 *      'packed' is three steps and cannot both be true of one zone at one time.
 *      Distances are derived from the spec's Table 6 value spaces: ordinal
 *      ladders for crowd level / trajectory / queue bands / access states,
 *      boolean for access.walk_in, opposite-pair for crowd direction. Values in
 *      a family this module has no ladder for can only ever reach 'minor' —
 *      it never invents a scale.
 *   2. INDEPENDENT WEIGHT. A side is worth the number of INDEPENDENCE CLUSTERS
 *      behind it, not the number of taps: one Trip Crew of eight is one cluster
 *      (lib/intelGroupKey) and a cluster with a verifiable independent identity
 *      weighs 1.0; an actor with NO verifiable group (null group_key) weighs 0.5
 *      — Table 14's "Independence 0.5 = unclear" — so two unattested strangers
 *      are worth one attested party. Both sides must clear CONFLICT_MIN_WEIGHT,
 *      and the minority must be at least CONFLICT_MIN_MINORITY_SHARE of the
 *      majority, so two accounts cannot pin "Reports differ" on a venue that
 *      forty independent parties agree about (Table 30: venue brigading).
 *   3. WINDOW OVERLAP. "Reports outside the same claim overlap window are
 *      sequence evidence, not contradiction" (§10). 'quiet' at 21:00 and
 *      'packed' at 22:30 is a venue filling up, not a dispute. Each side's
 *      window is the hull of its observation instants; the sides conflict only
 *      when the gap between the hulls is within overlapWindowSeconds(ttl).
 *
 * STATES. 'material' triggers everything §10 lists (Reports-differ label, strong
 * Live label suppressed, contradiction-resolution prompt, no high-confidence API
 * output). 'minor' records a real but sub-threshold disagreement (adjacent
 * values, or distant values that fail the weight test) — surfaced in the
 * conflict block, no suppression. 'none' is agreement, a single side, or
 * sequence evidence. The spec's Table 17 names the middle state
 * 'contextualized'; normalizeConflictState accepts that spelling as 'minor'.
 *
 * DIRECTION OF ERROR. Every ambiguity resolves toward the STRICTER outcome for
 * the Live label (an unknown stored state that is not 'none'/'minor' reads as
 * material; unparseable-but-different values read as at least minor). Nothing
 * here can raise confidence or widen what serves — see the read-path cap in
 * lib/liveClaimRead.
 */
import {
  CROWD_LEVELS,
  VIBE_STATES,
  EVENT_STATUS_STATES,
  CROWD_DIRECTIONS,
  CONFIDENCE_BAND_FLOOR,
  confidenceBand,
  type ConfidenceBand,
} from "./intelContracts.js";

// ── State vocabulary ─────────────────────────────────────────────────────────
export const CONFLICT_STATES = ["none", "minor", "material"] as const;
export type ConflictState = (typeof CONFLICT_STATES)[number];

/**
 * The PERSISTED spelling of a conflict state — the spec's Table 17 vocabulary,
 * and the exact set both CHECK constraints admit:
 *
 *   2273 intel_state_snapshots_conflict_state_check
 *   2273 intel_state_snapshot_versions_conflict_state_check
 *     CHECK (conflict_state IS NULL OR conflict_state IN ('none','contextualized','material'))
 *
 * The in-memory vocabulary above names the middle state 'minor'; the schema (and
 * the spec's Table 17) names the SAME state 'contextualized'. Writing 'minor'
 * violates both CHECKs, and because lib/intelProjection appends the version row
 * FIRST and skips the current-state upsert when that append fails, a single
 * cohort in mild disagreement stopped projecting entirely — silently, as a
 * warn-log. `toStoredConflictState` is the one translation at the write
 * boundary; `normalizeConflictState` already reads 'contextualized' back as
 * 'minor', so the READ path is unchanged in every respect (only 'material' has
 * serving consequences — see capForConflict).
 */
export const STORED_CONFLICT_STATES = ["none", "contextualized", "material"] as const;
export type StoredConflictState = (typeof STORED_CONFLICT_STATES)[number];

/** Translate an in-memory conflict state into the spelling the CHECKs admit. */
export function toStoredConflictState(state: ConflictState): StoredConflictState {
  return state === "minor" ? "contextualized" : state;
}

/**
 * Normalise a stored/served conflict state. NULL, '' and 'none' are 'none'
 * (the pre-2275 rows and every non-conflicting snapshot). The spec's
 * 'contextualized' is the same middle state as 'minor'. ANY other non-empty
 * string is read as 'material' — an unrecognised conflict marker must suppress
 * the strong label rather than be ignored (fail-closed for the Live label).
 */
export function normalizeConflictState(raw: unknown): ConflictState {
  if (raw == null) return "none";
  if (typeof raw !== "string") return "material";
  const s = raw.trim().toLowerCase();
  if (s === "" || s === "none") return "none";
  if (s === "minor" || s === "contextualized") return "minor";
  return "material";
}

// ── Calibration constants (v1; §8 "thresholds launch in shadow mode") ────────
/** Weight of one independence cluster that carries a verifiable group identity. */
export const INDEPENDENT_CLUSTER_WEIGHT = 1;
/** Weight of a cluster with NO verifiable independent identity (Table 14: unclear = 0.5). */
export const UNCLEAR_CLUSTER_WEIGHT = 0.5;
/** Both of the top two sides must carry at least this much independent weight. */
export const CONFLICT_MIN_WEIGHT = 2;
/** The minority side must be at least this share of the majority's weight. */
export const CONFLICT_MIN_MINORITY_SHARE = 0.2;
/** Floor on the overlap window so a 20-minute queue TTL still tolerates a 15-minute spread. */
export const MIN_OVERLAP_WINDOW_SECONDS = 15 * 60;

/**
 * How far apart two sides' observation windows may be and still be "the same
 * claim window". Half the family TTL, floored at 15 minutes: a crowd level
 * (45 min TTL) contradicts within 22.5 min; a cover price (7-day TTL) within
 * 3.5 days — because a price is a policy fact and two receipts on different
 * days genuinely disagree, while a crowd is a moment.
 */
export function overlapWindowSeconds(ttlSeconds: number): number {
  const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 0;
  return Math.max(MIN_OVERLAP_WINDOW_SECONDS, ttl / 2);
}

// ── Semantic distance per claim family (spec Table 6 value spaces) ───────────
/** A comparison outcome: ordinal steps apart, and the family's material threshold. */
export interface SemanticDistance {
  distance: number;
  threshold: number;
}

/** Default material threshold for ordinal ladders: two steps. */
const ORDINAL_THRESHOLD = 2;

/** Ordinal position on a ladder, or null when the value is not on it. */
function ordinal(ladder: readonly string[], v: string | null): number | null {
  if (v === null) return null;
  const i = ladder.indexOf(v);
  return i >= 0 ? i : null;
}

/**
 * crowd.trajectory is not a strict ladder: 'stable' sits with 'peaking', and
 * the lateral values (fragmenting/relocating) sit with 'declining'. This map
 * says how far apart two phases are for conflict purposes only.
 */
const TRAJECTORY_ORDINAL: Record<string, number> = {
  emerging: 0, building: 1, peaking: 2, stable: 2, fragmenting: 3, relocating: 3, declining: 3, ending: 4,
};
const WALK_IN_ORDINAL = ["accepted", "limited", "paused", "denied"] as const;
const RESERVATION_ORDINAL = ["not_needed", "recommended", "required"] as const;
const INVENTORY_ORDINAL = ["available", "limited", "sold_out"] as const;
const TRANSIT_ORDINAL = ["normal", "delayed", "disrupted", "closed"] as const;
/** Crowd DIRECTION opposites — the only pair that cannot both be true. */
const DIRECTION_OPPOSITES: ReadonlyArray<readonly [string, string]> = [["arriving", "dispersing"]];

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The scalar a claim value carries: a bare string, or the first known key. */
function scalar(v: unknown, keys: readonly string[]): string | null {
  if (typeof v === "string") return v.trim().toLowerCase();
  const r = asRecord(v);
  if (!r) return null;
  for (const k of keys) {
    const x = r[k];
    if (typeof x === "string") return x.trim().toLowerCase();
  }
  return null;
}

/**
 * Stable, order-independent key for a claim value so equal values (including
 * equal objects serialised with keys in a different order) compare equal.
 * Mirrors the aggregator's tally key.
 */
export function stableValueKey(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>).sort().reduce<Record<string, unknown>>(
          (acc, k) => { acc[k] = (val as Record<string, unknown>)[k]; return acc; }, {})
      : val,
  );
}

/**
 * Queue / service wait → band index on the §6 entrance ladder
 * (none, <10, 10–20, 20–40, 40+), by the interval midpoint. An open-ended
 * "40+" (maxMinutes null) is its own top band.
 */
function waitBand(v: unknown): number | null {
  const r = asRecord(v);
  if (!r) return null;
  const min = typeof r.minMinutes === "number" && Number.isFinite(r.minMinutes) ? r.minMinutes : null;
  if (min === null || min < 0) return null;
  const max = typeof r.maxMinutes === "number" && Number.isFinite(r.maxMinutes) ? r.maxMinutes : null;
  if (max === null) return min >= 40 ? 4 : min === 0 ? 0 : min < 10 ? 1 : min < 20 ? 2 : min < 40 ? 3 : 4;
  const mid = (min + max) / 2;
  if (max === 0) return 0;
  if (mid < 10) return 1;
  if (mid < 20) return 2;
  if (mid < 40) return 3;
  return 4;
}

/** Fallback: unequal values are ONE step apart and can only reach 'minor'. */
function fallbackDistance(a: unknown, b: unknown): SemanticDistance {
  return { distance: stableValueKey(a) === stableValueKey(b) ? 0 : 1, threshold: ORDINAL_THRESHOLD };
}

function ladderDistance(ladder: readonly string[], a: string | null, b: string | null, raw: [unknown, unknown]): SemanticDistance {
  const ia = ordinal(ladder, a);
  const ib = ordinal(ladder, b);
  if (ia === null || ib === null) return fallbackDistance(raw[0], raw[1]);
  return { distance: Math.abs(ia - ib), threshold: ORDINAL_THRESHOLD };
}

/**
 * Semantic distance between two values of one claim family, with the family's
 * material threshold. Deterministic and symmetric. A family without a ladder
 * here degrades to the fallback (unequal ⇒ 1 < threshold ⇒ at most 'minor').
 */
export function semanticDistance(claimType: string, a: unknown, b: unknown): SemanticDistance {
  switch (claimType) {
    case "crowd.level":
      return ladderDistance(CROWD_LEVELS, scalar(a, ["level"]), scalar(b, ["level"]), [a, b]);
    case "crowd.trajectory": {
      const sa = scalar(a, ["trajectory"]); const sb = scalar(b, ["trajectory"]);
      const ia = sa !== null ? TRAJECTORY_ORDINAL[sa] : undefined;
      const ib = sb !== null ? TRAJECTORY_ORDINAL[sb] : undefined;
      if (ia === undefined || ib === undefined) return fallbackDistance(a, b);
      return { distance: Math.abs(ia - ib), threshold: ORDINAL_THRESHOLD };
    }
    case "vibe.state":
      return ladderDistance(VIBE_STATES, scalar(a, ["state"]), scalar(b, ["state"]), [a, b]);
    case "event.status": {
      const sa = scalar(a, ["status", "state"]); const sb = scalar(b, ["status", "state"]);
      if (sa === null || sb === null) return fallbackDistance(a, b);
      if (sa === sb) return { distance: 0, threshold: ORDINAL_THRESHOLD };
      // 'cancelled' contradicts every live phase outright.
      if (sa === "cancelled" || sb === "cancelled") return { distance: ORDINAL_THRESHOLD, threshold: ORDINAL_THRESHOLD };
      return ladderDistance(EVENT_STATUS_STATES, sa, sb, [a, b]);
    }
    case "closure.state": {
      const sa = scalar(a, ["state"]); const sb = scalar(b, ["state"]);
      if (sa === null || sb === null) return fallbackDistance(a, b);
      if (sa === sb) return { distance: 0, threshold: ORDINAL_THRESHOLD };
      // open vs any closed variant is the material disagreement; closed variants
      // among themselves are a nuance, not a contradiction.
      const openA = sa === "open"; const openB = sb === "open";
      return { distance: openA !== openB ? ORDINAL_THRESHOLD : 1, threshold: ORDINAL_THRESHOLD };
    }
    case "crowd.direction": {
      const sa = scalar(a, ["direction"]); const sb = scalar(b, ["direction"]);
      if (sa === null || sb === null || !CROWD_DIRECTIONS.includes(sa as any) || !CROWD_DIRECTIONS.includes(sb as any)) {
        return fallbackDistance(a, b);
      }
      if (sa === sb) return { distance: 0, threshold: ORDINAL_THRESHOLD };
      const opposite = DIRECTION_OPPOSITES.some(([x, y]) => (sa === x && sb === y) || (sa === y && sb === x));
      return { distance: opposite ? ORDINAL_THRESHOLD : 1, threshold: ORDINAL_THRESHOLD };
    }
    case "access.walk_in": {
      // Phase-1 capture stores { accepted: boolean } (lib/quickSignal); the spec
      // registry also allows the four-state ladder. A boolean is a yes/no fact —
      // disagreeing IS the material distance.
      const ra = asRecord(a); const rb = asRecord(b);
      if (typeof ra?.accepted === "boolean" && typeof rb?.accepted === "boolean") {
        return { distance: ra.accepted === rb.accepted ? 0 : 1, threshold: 1 };
      }
      const sa = scalar(a, ["state", "status"]); const sb = scalar(b, ["state", "status"]);
      if (sa === "unknown" || sb === "unknown") return { distance: 0, threshold: ORDINAL_THRESHOLD };
      return ladderDistance(WALK_IN_ORDINAL, sa, sb, [a, b]);
    }
    case "access.reservation": {
      const sa = scalar(a, ["policy", "state", "status"]); const sb = scalar(b, ["policy", "state", "status"]);
      if (sa === "unknown" || sb === "unknown") return { distance: 0, threshold: ORDINAL_THRESHOLD };
      return ladderDistance(RESERVATION_ORDINAL, sa, sb, [a, b]);
    }
    case "inventory.status":
      return ladderDistance(INVENTORY_ORDINAL, scalar(a, ["status", "state"]), scalar(b, ["status", "state"]), [a, b]);
    case "transit.condition":
      return ladderDistance(TRANSIT_ORDINAL, scalar(a, ["condition", "status", "state"]), scalar(b, ["condition", "status", "state"]), [a, b]);
    case "queue.wait":
    case "service.wait": {
      const ba = waitBand(a); const bb = waitBand(b);
      if (ba === null || bb === null) return fallbackDistance(a, b);
      return { distance: Math.abs(ba - bb), threshold: ORDINAL_THRESHOLD };
    }
    case "price.cover": {
      const ra = asRecord(a); const rb = asRecord(b);
      const pa = typeof ra?.amount === "number" && Number.isFinite(ra.amount) ? ra.amount : null;
      const pb = typeof rb?.amount === "number" && Number.isFinite(rb.amount) ? rb.amount : null;
      if (pa === null || pb === null) return fallbackDistance(a, b);
      // Different currencies are incomparable, not contradictory.
      if (typeof ra?.currency === "string" && typeof rb?.currency === "string" && ra.currency !== rb.currency) {
        return { distance: 0, threshold: ORDINAL_THRESHOLD };
      }
      if (pa === pb) return { distance: 0, threshold: ORDINAL_THRESHOLD };
      const ratio = Math.abs(pa - pb) / Math.max(Math.abs(pa), Math.abs(pb));
      return { distance: ratio >= 0.5 ? ORDINAL_THRESHOLD : 1, threshold: ORDINAL_THRESHOLD };
    }
    default:
      return fallbackDistance(a, b);
  }
}

// ── Conflict assessment ──────────────────────────────────────────────────────
/** One actor's CURRENT vote (their most recent value), already clustered. */
export interface ConflictVote {
  actorId: string;
  /** Independence cluster id (lib/intelIndependence / group_key). */
  clusterId: string;
  /** True when the cluster carries a verifiable independent identity (a group_key). */
  independent: boolean;
  value: unknown;
  /** ISO timestamp of the observation this vote comes from. */
  observedAt: string;
}

/** A side of the disagreement — counts only, plus the value it asserts. */
export interface ConflictSide {
  valueKey: string;
  value: unknown;
  /** Independent weight (clusters × their weight). */
  weight: number;
  actors: number;
  clusters: number;
  windowStart: string;
  windowEnd: string;
}

export interface ConflictAssessment {
  state: ConflictState;
  /** Number of sides in the disagreement (0 or 1 ⇒ none; the predicate uses the top two). */
  sidesCount: number;
  /** The top two sides by weight (fewer when the cohort has fewer values). */
  sides: ConflictSide[];
  distance: number;
  threshold: number;
  windowsOverlap: boolean;
  weightsQualify: boolean;
  reason:
    | "agreement"
    | "single_side"
    | "sequence_not_contradiction"
    | "below_conflict_weight"
    | "adjacent_values"
    | "material";
}

export interface ConflictInput {
  claimType: string;
  ttlSeconds: number;
  votes: readonly ConflictVote[];
}

const NONE: ConflictAssessment = {
  state: "none", sidesCount: 0, sides: [], distance: 0, threshold: ORDINAL_THRESHOLD,
  windowsOverlap: false, weightsQualify: false, reason: "single_side",
};

/**
 * Assess the conflict state of a cohort. Deterministic: ties in weight break on
 * actor count, then on the value key, so the same cohort always yields the same
 * sides in the same order.
 */
export function assessConflict(input: ConflictInput): ConflictAssessment {
  const votes = (input.votes ?? []).filter((v) => v && typeof v.actorId === "string" && v.actorId.length > 0);
  if (votes.length === 0) return { ...NONE, sides: [] };

  // Tally sides: per value, the set of actors, the set of clusters (with their
  // weight — a cluster counts ONCE per side, at its own weight), and the window.
  const sides = new Map<string, {
    value: unknown; actors: Set<string>; clusters: Map<string, number>; start: number; end: number;
  }>();
  for (const v of votes) {
    const key = stableValueKey(v.value);
    let s = sides.get(key);
    const at = Date.parse(v.observedAt);
    if (!s) {
      s = { value: v.value, actors: new Set(), clusters: new Map(), start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY };
      sides.set(key, s);
    }
    s.actors.add(v.actorId);
    const w = v.independent ? INDEPENDENT_CLUSTER_WEIGHT : UNCLEAR_CLUSTER_WEIGHT;
    // A cluster that appears with mixed independence keeps the HIGHER weight only
    // if it is genuinely independent somewhere; never sum members.
    s.clusters.set(v.clusterId, Math.max(s.clusters.get(v.clusterId) ?? 0, w));
    if (Number.isFinite(at)) { s.start = Math.min(s.start, at); s.end = Math.max(s.end, at); }
  }

  const ranked: ConflictSide[] = [...sides.entries()].map(([valueKey, s]) => ({
    valueKey,
    value: s.value,
    weight: [...s.clusters.values()].reduce((a, b) => a + b, 0),
    actors: s.actors.size,
    clusters: s.clusters.size,
    windowStart: Number.isFinite(s.start) ? new Date(s.start).toISOString() : "",
    windowEnd: Number.isFinite(s.end) ? new Date(s.end).toISOString() : "",
  })).sort((a, b) =>
    b.weight - a.weight || b.actors - a.actors || (a.valueKey < b.valueKey ? -1 : a.valueKey > b.valueKey ? 1 : 0),
  );

  if (ranked.length < 2) {
    return { ...NONE, sidesCount: ranked.length, sides: ranked, reason: "single_side" };
  }
  const [top, second] = ranked;
  const { distance, threshold } = semanticDistance(input.claimType, top.value, second.value);
  if (distance === 0) {
    return { state: "none", sidesCount: ranked.length, sides: [top, second], distance, threshold, windowsOverlap: false, weightsQualify: false, reason: "agreement" };
  }

  // Window overlap: gap between the two hulls, tolerated up to the family window.
  const startA = Date.parse(top.windowStart), endA = Date.parse(top.windowEnd);
  const startB = Date.parse(second.windowStart), endB = Date.parse(second.windowEnd);
  let windowsOverlap = false;
  if ([startA, endA, startB, endB].every(Number.isFinite)) {
    const gapMs = Math.max(0, Math.max(startA, startB) - Math.min(endA, endB));
    windowsOverlap = gapMs <= overlapWindowSeconds(input.ttlSeconds) * 1000;
  }
  if (!windowsOverlap) {
    return { state: "none", sidesCount: ranked.length, sides: [top, second], distance, threshold, windowsOverlap, weightsQualify: false, reason: "sequence_not_contradiction" };
  }

  const weightsQualify =
    top.weight >= CONFLICT_MIN_WEIGHT &&
    second.weight >= CONFLICT_MIN_WEIGHT &&
    second.weight >= CONFLICT_MIN_MINORITY_SHARE * top.weight;

  if (distance >= threshold && weightsQualify) {
    return { state: "material", sidesCount: ranked.length, sides: [top, second], distance, threshold, windowsOverlap, weightsQualify, reason: "material" };
  }
  return {
    state: "minor", sidesCount: ranked.length, sides: [top, second], distance, threshold, windowsOverlap, weightsQualify,
    reason: distance >= threshold ? "below_conflict_weight" : "adjacent_values",
  };
}

// ── Serving cap (§10: "suppress strong Live label") ──────────────────────────
/** The highest band a materially-conflicted claim may serve at. */
export const MATERIAL_CONFLICT_BAND_CEILING: ConfidenceBand = "likely_current";

/**
 * Cap a served (confidence, band) pair under material conflict so it can never
 * read as Live/strong: the band is clamped to the ceiling and the numeric score
 * to just under the live floor, so a client that re-derives the band from the
 * number (travel-buddy display.confidenceBand) lands on the same answer. Any
 * other conflict state passes through unchanged. Only ever LOWERS.
 */
export function capForConflict(
  state: ConflictState,
  confidence: number | null,
  band: ConfidenceBand,
): { confidence: number | null; band: ConfidenceBand } {
  if (state !== "material") return { confidence, band };
  const ceilingFloor = CONFIDENCE_BAND_FLOOR[MATERIAL_CONFLICT_BAND_CEILING];
  const liveFloor = CONFIDENCE_BAND_FLOOR.live;
  const maxScore = Math.max(ceilingFloor, liveFloor - 0.01);
  const cappedConfidence = typeof confidence === "number" && Number.isFinite(confidence)
    ? Math.min(confidence, maxScore)
    : confidence;
  const cappedBand = CONFIDENCE_BAND_FLOOR[band] >= liveFloor ? MATERIAL_CONFLICT_BAND_CEILING : band;
  // Keep the pair consistent: never a band the number would not support.
  const consistentBand = cappedConfidence !== null && CONFIDENCE_BAND_FLOOR[confidenceBand(cappedConfidence)] < CONFIDENCE_BAND_FLOOR[cappedBand]
    ? confidenceBand(cappedConfidence)
    : cappedBand;
  return { confidence: cappedConfidence, band: consistentBand };
}

/** The client-facing conflict block (counts only — never sides' identities). */
export interface ConflictBlock {
  state: ConflictState;
  sidesCount: number;
  /** ISO — when the conflict state was last recomputed. */
  lastUpdated: string;
}

/** Build the conflict block for an envelope / API row. Null when there is no conflict. */
export function conflictBlock(state: ConflictState, lastUpdated: string): ConflictBlock | null {
  if (state === "none") return null;
  // The predicate is defined over the top two sides, so a recorded conflict is
  // always two-sided. The exact side sizes are k-anonymity internals and are
  // deliberately NOT carried.
  return { state, sidesCount: 2, lastUpdated };
}
