/**
 * worldMomentProducer — Sensing §7's third Map tweak, verbatim: "Promote
 * world_pulse into meaningful transient world-change projections: heating up,
 * forming, moving, clearing, unexpected activity, event spillover, traveler
 * surge." Map spec §36 Phase 4 names the same family ("emerging zones, cooling
 * areas, movement anomalies, event spillover").
 *
 * ── PROMOTE, NOT REPLACE ─────────────────────────────────────────────────────
 * The spec says promote `world_pulse`, so this module does not mint a kind. A
 * pulse cell stays a `world_pulse` object; when the already-published
 * aggregates inside it evidence a CHANGE, the cell gains `payload.moment`, a
 * headline title naming the change, a §7 trend where the change implies one,
 * and a §5.1 truth class. A cell with no evidenced change keeps its level and
 * carries `payload.moment: null`. The app contract therefore does not move,
 * and a client that predates this reads the pulse exactly as before.
 *
 * ── WHAT IT MAY READ — THE SAME RULE AS THE PULSE ────────────────────────────
 * PURE, `MapObject[]` in, and every input has ALREADY been published by a
 * producer that cleared its own gate:
 *
 *   activity_zone   summarizeCell's output; its `trend` is aggregateTrend's,
 *                   which refuses below the k floor. Heating up / clearing come
 *                   from re-running aggregateTrend over the zones in the cell,
 *                   so a cell needs a publishable cohort of trend carriers.
 *   crowd_flow      deriveCrowdFlow's output (§10's four gates). Its observed
 *                   flow state is the evidence for forming / moving / clearing
 *                   / unexpected activity; its `inferred` cause block — which
 *                   only the event-context door may supply — is the evidence
 *                   for event spillover.
 *   traveler_flow   the Phase 7 edge (already k-gated, cohort as a BUCKET).
 *                   An inbound edge at or above TRAVELER_SURGE_MIN_BUCKET is
 *                   the evidence for a traveler surge.
 *
 * Nothing person-shaped is read, no headcount is summed, and the only numbers
 * published are COUNTS OF AGGREGATES (how many zones carried a trend, how many
 * flows point in). Sensing §4.4: "One person/device never becomes 'crowd'" —
 * structurally, because no person is an input.
 *
 * ── SUPPRESSION MUST NOT BE A SIGNAL ─────────────────────────────────────────
 * `moment` is null both for "nothing is changing" and for "the trend carriers
 * did not clear k" (aggregateTrend returns undefined for both), so a reader
 * cannot tell a quiet cell from a sub-floor one. The test serializes both and
 * compares them byte for byte, as worldPulseProducer's does for `people`.
 *
 * ── TRUTH CLASS: A CHANGE IS NOT ALWAYS AN OBSERVATION ───────────────────────
 * Sensing §2: "Inference ≠ observation", §5 World Dynamics "must not claim
 * cause when unknown". Each change carries the class its evidence earns
 * (WORLD_CHANGE_TRUTH): a trend or a flow state is a published observation;
 * an event spillover rests on a cause HYPOTHESIS and is `inferred`; a traveler
 * surge rests on accepted PLANS — declared intent, not a sighting — and is
 * `inferred` too. The pulse's `truthClass` is its headline change's class, or
 * `observed` for a cell that is only a level.
 *
 * Gated at the route by `map_world_moments_enabled` (migration 2350, seeded
 * OFF); with the flag off this module is never called and a pulse is exactly
 * what worldPulseProducer emitted.
 */
import { aggregateTrend, cellFor, type GridCell } from "../mapAggregation.js";
import {
  ACTIVITY_LEVELS,
  centroidOf,
  type ActivityLevel,
  type CoverageState,
  type MapObject,
  type TrendState,
  type TruthClass,
} from "../mapObjects.js";
import { pulseGridZoom, type WorldPulsePayload } from "./worldPulseProducer.js";

/** Sensing §7's seven change types, in the spec's own order. */
export const WORLD_CHANGES = [
  "heating_up",
  "forming",
  "moving",
  "clearing",
  "unexpected_activity",
  "event_spillover",
  "traveler_surge",
] as const;
export type WorldChange = (typeof WORLD_CHANGES)[number];

/**
 * Which change HEADLINES a cell that evidences several. Anomaly and cause
 * outrank the ordinary dynamics because they are the ones a reader would act
 * on; heating/clearing outrank flow shape because a trend is a statement about
 * the cell itself and a flow is a statement about its edges.
 */
export const WORLD_CHANGE_PRECEDENCE: readonly WorldChange[] = [
  "unexpected_activity",
  "event_spillover",
  "traveler_surge",
  "heating_up",
  "clearing",
  "moving",
  "forming",
];

export const WORLD_CHANGE_TITLES: Record<WorldChange, string> = {
  heating_up: "Heating up",
  forming: "Forming",
  moving: "Moving",
  clearing: "Clearing",
  unexpected_activity: "Unexpected activity",
  event_spillover: "Event spillover",
  traveler_surge: "Traveler surge",
};

/** The §5.1 class each change's EVIDENCE earns. See the header. */
export const WORLD_CHANGE_TRUTH: Record<WorldChange, TruthClass> = {
  heating_up: "observed",
  forming: "observed",
  moving: "observed",
  clearing: "observed",
  unexpected_activity: "observed",
  event_spillover: "inferred",
  traveler_surge: "inferred",
};

/** The §7 trend a change implies for the cell, where it implies one. */
export const WORLD_CHANGE_TREND: Partial<Record<WorldChange, TrendState>> = {
  heating_up: "getting_busier",
  clearing: "getting_quieter",
};

/**
 * The lowest inbound traveler-flow bucket that counts as a surge. `busy` is
 * four times the k floor on §7's ladder (mapAggregation.ACTIVITY_COHORT_MULTIPLES):
 * a merely publishable edge is movement, not a surge. Tunable; declared as data.
 */
export const TRAVELER_SURGE_MIN_BUCKET: ActivityLevel = "busy";

/**
 * Coverage for a pulse: how many INDEPENDENTLY PUBLISHED aggregates fed its
 * people component. Density-only cells (no people evidence) are `unknown` —
 * Sensing §2 "No coverage ≠ quiet". Tunable; declared as data.
 */
export const PULSE_COVERAGE_BY_AGGREGATES: readonly { atLeast: number; coverage: CoverageState }[] = [
  { atLeast: 4, coverage: "many" },
  { atLeast: 2, coverage: "several" },
  { atLeast: 1, coverage: "few" },
];

export interface WorldMomentEvidence {
  /** Activity zones in the cell that carried a §7 trend. */
  zonesWithTrend: number;
  /** Crowd flows whose destination is the cell. */
  flowsIn: number;
  /** Crowd flows whose origin is the cell. */
  flowsOut: number;
  /** Traveler-flow edges whose destination is the cell. */
  travelerFlowsIn: number;
  /** Inbound crowd flows carrying an inferred event cause. */
  inferredCauses: number;
}

export interface WorldMomentPayload {
  /** Always the literal below. A moment is derived, never sensed directly. */
  basis: "derived_from_published_aggregates";
  change: WorldChange;
  /** Secondary changes the same cell evidences, in precedence order. */
  also: WorldChange[];
  truthClass: TruthClass;
  evidence: WorldMomentEvidence;
}

/** The pulse payload after promotion. `moment` is null when nothing changed. */
export type PromotedPulsePayload = WorldPulsePayload & { moment: WorldMomentPayload | null };

export interface WorldMomentReport {
  /** Pulses offered. */
  considered: number;
  /** Pulses that gained a moment. */
  attached: number;
  /** Pulses left as a level (`moment: null`). */
  unchanged: number;
  byChange: Record<WorldChange, number>;
}

export interface AttachWorldMomentsOptions {
  zoom: number;
  /** Cohort floor override for the trend fold. May only tighten. */
  k?: number;
}

export interface AttachWorldMomentsResult {
  pulses: MapObject<PromotedPulsePayload>[];
  report: WorldMomentReport;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function bucketRank(level: unknown): number {
  const i = ACTIVITY_LEVELS.indexOf(level as ActivityLevel);
  return i;
}

interface CellEvidence {
  zones: MapObject[];
  flowsIn: MapObject[];
  flowsOut: MapObject[];
  travelerIn: MapObject[];
}

function emptyEvidence(): CellEvidence {
  return { zones: [], flowsIn: [], flowsOut: [], travelerIn: [] };
}

function flowState(obj: MapObject): string | null {
  const observed = (obj.payload as { observed?: { flowState?: unknown } } | undefined)?.observed;
  const s = observed?.flowState;
  return typeof s === "string" ? s : null;
}

function hasInferredCause(obj: MapObject): boolean {
  const inferred = (obj.payload as { inferred?: unknown } | undefined)?.inferred;
  return inferred !== null && inferred !== undefined && typeof inferred === "object";
}

function coverageForPulse(payload: WorldPulsePayload | undefined): CoverageState {
  const n = payload?.people?.contributingAggregates;
  if (!finite(n) || n < 1) return "unknown";
  for (const step of PULSE_COVERAGE_BY_AGGREGATES) if (n >= step.atLeast) return step.coverage;
  return "unknown";
}

/**
 * Attach world moments to the pulses that evidence a change.
 *
 * `context` is the set of ALREADY-PUBLISHED objects the route has in hand —
 * the aggregation output (zones, crowd flows) plus the Phase 7 objects that
 * survived §24. Only `activity_zone`, `crowd_flow` and `traveler_flow` are
 * read; everything else is ignored by kind.
 */
export function attachWorldMoments(
  pulses: readonly MapObject[],
  context: readonly MapObject[],
  opts: AttachWorldMomentsOptions,
): AttachWorldMomentsResult {
  const report: WorldMomentReport = {
    considered: 0,
    attached: 0,
    unchanged: 0,
    byChange: {
      heating_up: 0, forming: 0, moving: 0, clearing: 0,
      unexpected_activity: 0, event_spillover: 0, traveler_surge: 0,
    },
  };
  const gridZoom = pulseGridZoom(opts?.zoom);

  const cellKeyOf = (lat: number, lng: number): string | null => {
    const cell: GridCell | null = cellFor(lat, lng, gridZoom);
    return cell ? cell.key : null;
  };

  // Bin the evidence by pulse cell. A LineString contributes at BOTH ends,
  // as an outbound flow for its origin cell and an inbound one for its
  // destination cell; a point or polygon contributes where its centroid sits.
  const evidence = new Map<string, CellEvidence>();
  const bin = (key: string | null): CellEvidence | null => {
    if (!key) return null;
    let e = evidence.get(key);
    if (!e) { e = emptyEvidence(); evidence.set(key, e); }
    return e;
  };
  for (const obj of Array.isArray(context) ? context : []) {
    if (!obj || !obj.geometry) continue;
    if (obj.kind === "activity_zone") {
      const c = centroidOf(obj.geometry);
      if (!c) continue;
      bin(cellKeyOf(c.lat, c.lng))?.zones.push(obj);
      continue;
    }
    if (obj.kind !== "crowd_flow" && obj.kind !== "traveler_flow") continue;
    if (obj.geometry.type !== "LineString") continue;
    const coords = obj.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [oLng, oLat] = coords[0];
    const [dLng, dLat] = coords[coords.length - 1];
    if (!finite(oLat) || !finite(oLng) || !finite(dLat) || !finite(dLng)) continue;
    const originKey = cellKeyOf(oLat, oLng);
    const destKey = cellKeyOf(dLat, dLng);
    if (obj.kind === "crowd_flow") {
      bin(originKey)?.flowsOut.push(obj);
      bin(destKey)?.flowsIn.push(obj);
    } else {
      bin(destKey)?.travelerIn.push(obj);
    }
  }

  const out: MapObject<PromotedPulsePayload>[] = [];
  for (const pulse of Array.isArray(pulses) ? pulses : []) {
    if (!pulse || pulse.kind !== "world_pulse") continue;
    report.considered += 1;
    const basePayload = (pulse.payload ?? {}) as WorldPulsePayload;

    // The pulse's own cell: recomputed from its geometry rather than parsed
    // from its id, so a caller that re-ids pulses still lands in the right bin.
    const c = centroidOf(pulse.geometry);
    const key = c ? cellKeyOf(c.lat, c.lng) : null;
    const ev = (key && evidence.get(key)) || emptyEvidence();

    const changes = new Set<WorldChange>();

    // Trend over the cell's zones — k-gated by aggregateTrend itself.
    const trend = aggregateTrend(ev.zones, opts?.k);
    if (trend === "getting_busier" || trend === "increasing_quickly") changes.add("heating_up");
    if (trend === "cooling" || trend === "getting_quieter" || trend === "rapidly_dispersing") changes.add("clearing");

    let inferredCauses = 0;
    for (const f of ev.flowsIn) {
      const s = flowState(f);
      if (s === "emerging_movement") changes.add("forming");
      else if (s === "strong_movement" || s === "moderate_movement") changes.add("moving");
      else if (s === "unusual_movement") changes.add("unexpected_activity");
      if (hasInferredCause(f)) { inferredCauses += 1; changes.add("event_spillover"); }
    }
    for (const f of ev.flowsOut) {
      const s = flowState(f);
      if (s === "dispersing") changes.add("clearing");
      else if (s === "strong_movement" || s === "moderate_movement") changes.add("moving");
      else if (s === "unusual_movement") changes.add("unexpected_activity");
    }
    const surgeFloor = bucketRank(TRAVELER_SURGE_MIN_BUCKET);
    for (const t of ev.travelerIn) {
      const bucket = (t.payload as { cohortBucket?: unknown } | undefined)?.cohortBucket;
      if (bucketRank(bucket) >= surgeFloor) changes.add("traveler_surge");
    }

    const ordered = WORLD_CHANGE_PRECEDENCE.filter((ch) => changes.has(ch));
    const coverage = coverageForPulse(basePayload);

    if (ordered.length === 0) {
      report.unchanged += 1;
      out.push({
        ...pulse,
        truthClass: "observed",
        coverage,
        payload: { ...basePayload, moment: null },
      });
      continue;
    }

    const change = ordered[0];
    const truthClass = WORLD_CHANGE_TRUTH[change];
    const moment: WorldMomentPayload = {
      basis: "derived_from_published_aggregates",
      change,
      also: ordered.slice(1),
      truthClass,
      evidence: {
        zonesWithTrend: ev.zones.filter((z) => z.trend !== undefined).length,
        flowsIn: ev.flowsIn.length,
        flowsOut: ev.flowsOut.length,
        travelerFlowsIn: ev.travelerIn.length,
        inferredCauses,
      },
    };
    const promoted: MapObject<PromotedPulsePayload> = {
      ...pulse,
      title: WORLD_CHANGE_TITLES[change],
      // The level is not lost: it moves to the subtitle.
      subtitle: pulse.title,
      truthClass,
      coverage,
      payload: { ...basePayload, moment },
    };
    const impliedTrend = WORLD_CHANGE_TREND[change];
    if (impliedTrend !== undefined) promoted.trend = impliedTrend;
    out.push(promoted);
    report.attached += 1;
    report.byChange[change] += 1;
  }

  return { pulses: out, report };
}
