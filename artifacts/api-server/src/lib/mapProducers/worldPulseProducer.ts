/**
 * worldPulseProducer — the `world_pulse` kind (Map spec §36 Phase 7).
 *
 * "A world/continent-zoom aggregate layer OVER the existing §31 aggregation,
 * showing where activity is concentrated, built from ALREADY-AGGREGATED sources
 * (crowd flow zones, event density, projected place activity), never from
 * individual presence."
 *
 * ── WHAT MAKES THIS SAFE IS WHAT IT IS ALLOWED TO READ ───────────────────────
 * This module is PURE and takes `MapObject[]` — the output of
 * `mapAggregation.aggregateForViewport`, i.e. objects that have ALREADY been
 * through §24 protection and §31 aggregation. It has no database access, so
 * there is no path by which it could reach a presence row even if someone later
 * wanted it to. `PULSE_PEOPLE_SOURCE_KINDS` is the whole list of kinds that may
 * contribute a body to a pulse cell, and both members are objects that already
 * cleared a k gate of their own:
 *
 *   activity_zone   emitted by summarizeCell, which returns NULL rather than a
 *                   smaller zone below the cohort floor. An activity_zone that
 *                   exists has ≥ k contributors, by construction.
 *   crowd_flow      emitted by deriveCrowdFlow, which runs §10's four gates
 *                   (privacyGate, freshness, signal families, cohort density).
 *
 * Everything person-shaped is excluded by omission and by an explicit refusal
 * list: `social_zone`, `crew_member`, `buddy_zone`, `memory`, `saved_place` and
 * `personal_city` can never contribute, and `PULSE_FORBIDDEN_SOURCE_KINDS`
 * states that as data so the test can assert it rather than infer it.
 *
 * ── THE WEIGHT IS NOT A HEADCOUNT, AND IS NOT PUBLISHED AS ONE ───────────────
 * Two already-published aggregates in one cell may describe overlapping people:
 * a crowd_flow A→B and an activity_zone at A can count the same travellers. So
 * summing their cohorts does NOT yield a distinct-person count, and this module
 * never claims that it does. The sum is a SIGNAL WEIGHT — "how much
 * already-published activity sits in this cell" — and the only thing derived
 * from it is a BUCKET on §7's activity ladder. No number reaches the wire:
 * `count` is deliberately absent from the emitted object, and the payload
 * carries `cohortBucket`, never `cohortSize`.
 *
 * That also removes the double-counting objection in the direction that
 * matters: overlap can only make the weight LARGER, and a larger weight can
 * only make the cell easier to publish and coarser to read. It cannot expose
 * anybody.
 *
 * ── SUPPRESSION MUST NOT BE A SIGNAL ─────────────────────────────────────────
 * `payload.people` is null in BOTH cases: no people-derived contributor at all,
 * and people-derived contributors whose weight did not clear k. A reader cannot
 * tell those apart, and the test asserts it by serializing a cell built over
 * k-1 contributors and one built over zero and comparing them byte for byte.
 * If the two were distinguishable, "people: withheld" would itself publish the
 * existence of a sub-k group in that cell — which is the leak the floor exists
 * to prevent, one level of indirection out.
 *
 * ── §37: A PULSE IS AN OBSERVATION, NEVER A FORECAST ─────────────────────────
 * `world_pulse` is deliberately NOT in `FORECAST_KINDS`, and it earns that by
 * refusing forecast input: `prediction` objects are in
 * `PULSE_FORBIDDEN_SOURCE_KINDS`, so a projected state can never be folded into
 * a cell that renders in the vocabulary of a measurement. `payload.basis` says
 * `observed_aggregates` on every object, so a renderer never has to infer it.
 */
import {
  CELL_SIZE_DEGREES_BY_ZOOM,
  bboxContains,
  cellFor,
  cellPolygon,
  cohortWeightOf,
  oldestFreshness,
  weakestConfidence,
  zoomBandFor,
  type BBox,
  type GridCell,
  type ZoomBand,
} from "../mapAggregation.js";
import {
  CONFIDENCE_STATES,
  KIND_DEFAULT_PRIORITY,
  centroidOf,
  isServable,
  type ActivityLevel,
  type ConfidenceState,
  type FreshnessState,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from "../mapObjects.js";
import {
  bandCarriesWorldIntelligence,
  bucketCohort,
  resolveWorldIntelligenceK,
} from "./worldIntelligence.js";

/** A pulse cell is aggregate-only, always. It describes nobody in particular. */
export const WORLD_PULSE_PRIVACY_CLASS: PrivacyClass = "aggregate_only";

/**
 * Kinds that may contribute a PEOPLE cohort. Both are already-k-gated
 * aggregates; see the header. This list is the whole permission.
 */
export const PULSE_PEOPLE_SOURCE_KINDS: readonly MapObjectKind[] = ["activity_zone", "crowd_flow"];

/**
 * Kinds that may contribute PUBLIC DENSITY. A venue and a scheduled event are
 * public facts about geography, not people — they carry no cohort, they are
 * COUNTED (not weighted), and they can never satisfy the k floor because
 * satisfying it is not something a building can do.
 */
export const PULSE_DENSITY_SOURCE_KINDS: readonly MapObjectKind[] = ["place", "event"];

/**
 * Kinds that may NEVER contribute, recorded as data so the guard can assert the
 * refusal instead of inferring it from the two allow-lists.
 *
 *   social_zone / crew_member / buddy_zone   people, at person granularity.
 *   memory / saved_place / personal_city     the VIEWER'S own rows. Folding
 *                                            them in would make the pulse read
 *                                            differently for the one person who
 *                                            saved a place there — a per-viewer
 *                                            world map that leaks its viewer.
 *   prediction                               §37: a forecast must never be
 *                                            folded into an observation.
 *   safety_notice / meeting_point / trip_stop not activity, and §5 puts safety
 *                                            above activity ranking anyway.
 *   world_pulse / traveler_flow / city_model Phase 7's own output. A pulse of
 *                                            pulses would double-publish.
 */
export const PULSE_FORBIDDEN_SOURCE_KINDS: readonly MapObjectKind[] = [
  "social_zone",
  "crew_member",
  "buddy_zone",
  "memory",
  "saved_place",
  "personal_city",
  "prediction",
  "safety_notice",
  "meeting_point",
  "trip_stop",
  "hidden_gem",
  "world_pulse",
  "traveler_flow",
  "city_model",
];

/**
 * How much COARSER a pulse cell is than the aggregation cell at the same zoom.
 * Two zoom steps = four times as wide. A pulse drawn on the SAME grid as the
 * activity zones it summarizes would be a redraw, not a summary; this is what
 * makes it a genuinely wider view.
 */
export const WORLD_PULSE_ZOOM_OFFSET = 2;

/**
 * Public venues/events needed before a cell may publish on density ALONE (no
 * publishable people component). Not a privacy threshold — no person is in this
 * count — but a noise floor: three restaurants is not a concentration of
 * activity at continental scale.
 */
export const MIN_PULSE_DENSITY_SOURCES = 8;

/**
 * The density ladder, in multiples of `MIN_PULSE_DENSITY_SOURCES`, mirroring
 * `ACTIVITY_COHORT_MULTIPLES`'s shape so the two read the same way. Used ONLY
 * when a cell has no publishable people component.
 */
export const PULSE_DENSITY_MULTIPLES: readonly { atLeast: number; level: ActivityLevel }[] = [
  { atLeast: 16, level: "peak" },
  { atLeast: 8, level: "very_busy" },
  { atLeast: 4, level: "busy" },
  { atLeast: 2, level: "moderate" },
  { atLeast: 1, level: "quiet" },
];

function densityIntensity(sources: number): ActivityLevel {
  const ratio = sources / MIN_PULSE_DENSITY_SOURCES;
  for (const step of PULSE_DENSITY_MULTIPLES) if (ratio >= step.atLeast) return step.level;
  return "very_quiet";
}

/**
 * What a pulse cell publishes.
 *
 * `people` is null for a cell with no people-derived contributors AND for one
 * whose contributors did not clear k — see the header. `density` is null when
 * no public venue or event sits in the cell. `intensitySource` says which
 * component set the headline band, which carries no information `people: null`
 * does not already carry.
 */
export interface WorldPulsePayload {
  /** §37: always the literal below. A pulse is measured, never projected. */
  basis: "observed_aggregates";
  intensity: ActivityLevel;
  intensitySource: "people" | "public_density";
  people: {
    /** §7's activity ladder, banded on multiples of k. NEVER a headcount. */
    cohortBucket: ActivityLevel;
    /** How many ALREADY-PUBLISHED aggregates fed it. Not a person count. */
    contributingAggregates: number;
  } | null;
  density: {
    venues: number;
    events: number;
  } | null;
}

export interface WorldPulseReport {
  /** The §17 band the request sat in. */
  band: ZoomBand;
  /** Edge of the (coarser) pulse grid, in degrees. Null when none applies. */
  cellSizeDegrees: number | null;
  /** Objects offered to the producer. */
  considered: number;
  /** Objects a forbidden or unknown kind excluded. */
  ineligible: number;
  /**
   * People-derived contributors dropped for carrying an unusable or sub-k
   * cohort. Should be zero — both source kinds guarantee ≥ k — so a non-zero
   * value means something upstream published below its own floor.
   */
  rejectedContributors: number;
  cells: number;
  published: number;
  /** Cells that produced nothing. Count only; naming them would re-leak. */
  suppressed: number;
}

export interface DeriveWorldPulseOptions {
  bbox: BBox;
  zoom: number;
  /** Cohort floor override. May only TIGHTEN. */
  k?: number;
}

export interface DeriveWorldPulseResult {
  pulses: MapObject<WorldPulsePayload>[];
  report: WorldPulseReport;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The zoom the pulse grid is drawn on: coarser than the request's own. */
export function pulseGridZoom(zoom: number | null | undefined): number {
  const z = finite(zoom) ? Math.floor(zoom) : 0;
  return Math.max(0, z - WORLD_PULSE_ZOOM_OFFSET);
}

interface PulseBin {
  cell: GridCell;
  peopleWeight: number;
  peopleContributors: MapObject[];
  venues: number;
  events: number;
  all: MapObject[];
}

/**
 * Derive the world/continent pulse from the §31 aggregation's own output.
 *
 * PURE. Fail-closed at every step: a band that does not carry Phase 7 produces
 * nothing, an unresolvable cell drops the contributor, an unusable cohort drops
 * the contributor (and is COUNTED, because it should be impossible), and a cell
 * that clears neither the k floor nor the density floor is suppressed rather
 * than drawn small.
 */
export function deriveWorldPulse(
  objects: readonly MapObject[],
  opts: DeriveWorldPulseOptions,
): DeriveWorldPulseResult {
  const band = zoomBandFor(opts?.zoom);
  const gridZoom = pulseGridZoom(opts?.zoom);
  const cellSizeDegrees = CELL_SIZE_DEGREES_BY_ZOOM[gridZoom] ?? null;
  const report: WorldPulseReport = {
    band,
    cellSizeDegrees,
    considered: Array.isArray(objects) ? objects.length : 0,
    ineligible: 0,
    rejectedContributors: 0,
    cells: 0,
    published: 0,
    suppressed: 0,
  };

  if (!bandCarriesWorldIntelligence(band)) return { pulses: [], report };
  if (!Array.isArray(objects) || objects.length === 0) return { pulses: [], report };

  const k = resolveWorldIntelligenceK(opts?.k);
  const bins = new Map<string, PulseBin>();

  for (const obj of objects) {
    if (!isServable(obj)) {
      report.ineligible += 1;
      continue;
    }
    const isPeople = PULSE_PEOPLE_SOURCE_KINDS.includes(obj.kind);
    const isDensity = PULSE_DENSITY_SOURCE_KINDS.includes(obj.kind);
    if (!isPeople && !isDensity) {
      report.ineligible += 1;
      continue;
    }
    const c = centroidOf(obj.geometry);
    if (!c || !bboxContains(opts?.bbox, c.lat, c.lng)) {
      report.ineligible += 1;
      continue;
    }
    const cell = cellFor(c.lat, c.lng, gridZoom);
    if (!cell) {
      report.ineligible += 1;
      continue;
    }

    let bin = bins.get(cell.key);
    if (!bin) {
      bin = { cell, peopleWeight: 0, peopleContributors: [], venues: 0, events: 0, all: [] };
      bins.set(cell.key, bin);
    }

    if (isPeople) {
      // An already-published aggregate carries its own cohort in `count`. It is
      // read, never trusted: a contributor whose count is unusable or below the
      // floor is DROPPED and counted, because a source kind that guarantees ≥ k
      // producing less than k means the guarantee broke.
      const weight = cohortWeightOf(obj);
      if (weight == null || !(weight >= k)) {
        report.rejectedContributors += 1;
        continue;
      }
      bin.peopleWeight += weight;
      bin.peopleContributors.push(obj);
      bin.all.push(obj);
      continue;
    }

    if (obj.kind === "event") bin.events += 1;
    else bin.venues += 1;
    bin.all.push(obj);
  }

  report.cells = bins.size;
  const pulses: MapObject<WorldPulsePayload>[] = [];

  // Sorted so ids and ordering are independent of input order (paging stays
  // stable across identical requests).
  for (const key of [...bins.keys()].sort()) {
    const bin = bins.get(key) as PulseBin;
    const densitySources = bin.venues + bin.events;

    // `bucketCohort` refuses below k, so this is null for BOTH "nobody" and
    // "not enough" — the indistinguishability the header describes.
    const cohortBucket =
      bin.peopleContributors.length > 0 ? bucketCohort(bin.peopleWeight, k) : null;

    const peopleComponent: WorldPulsePayload["people"] =
      cohortBucket === null
        ? null
        : { cohortBucket, contributingAggregates: bin.peopleContributors.length };

    const densityComponent: WorldPulsePayload["density"] =
      densitySources > 0 ? { venues: bin.venues, events: bin.events } : null;

    if (peopleComponent === null && !(densitySources >= MIN_PULSE_DENSITY_SOURCES)) {
      report.suppressed += 1;
      continue;
    }

    const intensity: ActivityLevel =
      peopleComponent !== null ? peopleComponent.cohortBucket : densityIntensity(densitySources);
    const intensitySource: WorldPulsePayload["intensitySource"] =
      peopleComponent !== null ? "people" : "public_density";

    // Weakest-wins, exactly as summarizeCell folds: an aggregate is never more
    // certain or fresher than the weakest thing inside it.
    const confidence: ConfidenceState | undefined = weakestConfidence(bin.all);
    const freshness: FreshnessState = oldestFreshness(bin.all);

    const pulse: MapObject<WorldPulsePayload> = {
      id: `pulse:${bin.cell.key}`,
      kind: "world_pulse",
      geometry: cellPolygon(bin.cell),
      title: `${humanize(intensity)} activity`,
      subtitle: "Aggregated from already-published activity",
      freshness,
      activity: intensity,
      privacyClass: WORLD_PULSE_PRIVACY_CLASS,
      renderingPriority: KIND_DEFAULT_PRIORITY.world_pulse,
      // NO `count`. The weight is not a headcount and must not be published as
      // one; NEVER_AGGREGATED_KINDS keeps anything downstream from wanting it.
      interaction: { actions: ["ask_compass", "view"], opensSheet: true },
      // Deliberately NO sourceRefs: a reference list on an aggregate is a
      // re-identification handle back onto its contributors (summarizeCell's
      // rule, and the same reason applies one level out).
      provenance: {
        lines: [{ text: "Summarized from activity that was already aggregated and published" }],
        confidence: confidence ?? (CONFIDENCE_STATES[0] as ConfidenceState),
      },
      payload: {
        basis: "observed_aggregates",
        intensity,
        intensitySource,
        people: peopleComponent,
        density: densityComponent,
      },
    };
    if (confidence !== undefined) pulse.confidence = confidence;
    pulses.push(pulse);
    report.published += 1;
  }

  return { pulses, report };
}

function humanize(a: ActivityLevel): string {
  return a
    .split("_")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}
