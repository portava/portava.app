/**
 * discoveryOutcomeReport — the outcome INSTRUMENT for DV-19 (census-discovery §55).
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/01_Portava_Discovery_Engine.md` §12:
 *
 *   "PDE is successful when it improves: useful saves, itinerary additions,
 *    place opens, completed visits, event attendance, successful trip actions,
 *    low regret/hide/report rates, creator diversity, new-creator discovery,
 *    Trail freshness, repeat traveler satisfaction."
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ================================
 * A PURE report over served exposures and the outcomes bound to them, split by
 * ARM — which ranker ordered the page, read from the serve row's own
 * `features.modelVersion` — and by serve point. It states numbers and sample
 * sizes. It carries NO threshold, NO "improved" / "better" / "worse" verdict and
 * no significance test: `01` §12 says what success is measured ON, not what
 * number counts as success, and no owner has said. Nothing here changes what is
 * served or its order.
 *
 * THE ARMS, FROM THE ROW
 * ======================
 *   pde         `features.modelVersion = DISCOVERY_PDE_MODEL_VERSION` — the page
 *               was ordered by the PDE ranker in that request (lib/rankLog.ts
 *               stamps it on exactly the rows it ranked).
 *   legacy      `features.modelVersion = DISCOVERY_MODEL_VERSION` — written by
 *               lib/discoveryServeLog.ts: every serve NOT ordered by the PDE
 *               ranker (Compass rank or replay, unranked cache A, feed, search,
 *               community, hidden gems, map search).
 *   unrecorded  no modelVersion (a row older than §13.3). Never folded into an arm.
 *   unknown     a modelVersion this build does not write. Never folded either.
 * The arms are OBSERVATIONAL: which rows landed in which arm was decided by the
 * engine mode, the cohort and the serve point, not by randomisation, and pages
 * from different serve points are not like for like. Every figure is therefore
 * also given per serve point.
 *
 * ONE MUTABLE OUTCOME PER EXPOSURE — WHY OPENS AND SAVES ARE BOUNDS
 * ================================================================
 * `rank_events` keeps ONE outcome per exposure, the furthest funnel rung reached
 * (impression → tap → save/join/rsvp → trip_add → attended; routes/rankEvents.ts
 * OUTCOME_RUNG), updated in place. A place that was opened and then saved reads
 * `save`; one saved from the card without opening also reads `save`. So:
 *   lower bound  exposures whose furthest outcome IS the metric's token;
 *   upper bound  exposures whose furthest outcome is that token or a rung that
 *                can have consumed it.
 * The truth lies between, and the report prints both rather than pick one.
 * `dismiss` is terminal (nothing overwrites it) and is exact.
 *
 * NAMES ARE NOT UPGRADED
 * ======================
 * `dismiss` is the card's "Not interested" control. No spec calls it regret, and
 * `04` §4 separates `hide` from `not_interested` without defining either, so it
 * is reported as "dismiss rate" and low regret is UNMEASURED. Every §12 item
 * with no input in the tree is listed as unmeasured with the missing input
 * named, and is never emitted as 0.
 *
 * ID SPACES
 * =========
 * Every figure is per EXPOSURE ROW, and no figure joins `item_id` to a content
 * table, so the `db/<uuid>` / bare-uuid split (§51.2) cannot double-count here.
 * Attention (dwell) rows are not exposures and never enter any figure.
 */
import { DISCOVERY_MODEL_VERSION, DISCOVERY_PDE_MODEL_VERSION } from "./discoveryRankProvenance.js";
import {
  featuresOf,
  isAnonymousServeRequest,
  modelVersionOf,
  servePointLabel,
  servePointOf,
  traceRowKind,
  type ServePointKey,
  type TraceRankEventRow,
  type TraceServeRequestRow,
} from "./discoveryTraceCoverage.js";

// ═════════════════════════════════════════════════════════════════════════════
// Arms
// ═════════════════════════════════════════════════════════════════════════════

export const OUTCOME_ARMS = ["pde", "legacy"] as const;
export type OutcomeArm = (typeof OUTCOME_ARMS)[number] | "unrecorded" | "unknown";

/** The arm a served exposure belongs to, from its own `features.modelVersion`. */
export function armOf(row: TraceRankEventRow): OutcomeArm {
  const mv = modelVersionOf(row);
  if (mv === DISCOVERY_PDE_MODEL_VERSION) return "pde";
  if (mv === DISCOVERY_MODEL_VERSION) return "legacy";
  if (mv === "unrecorded") return "unrecorded";
  return "unknown";
}

// ═════════════════════════════════════════════════════════════════════════════
// The `01` §12 metrics — every one, measured or named as unmeasured
// ═════════════════════════════════════════════════════════════════════════════

export interface MeasuredMetric {
  id: string;
  /** The §12 wording this figure stands for. */
  spec: string;
  status: "measured";
  /** Terminal outcomes counted by the lower bound. */
  lower: readonly string[];
  /** Terminal outcomes counted by the upper bound (equal to `lower` ⇒ exact). */
  upper: readonly string[];
  note: string;
}

export interface UnmeasuredMetric {
  id: string;
  spec: string;
  status: "unmeasured";
  /** The input that does not exist in the tree. */
  missingInput: string;
  /** Terminal outcomes that, if found on Discovery exposures, mean the registry is stale. */
  strayOutcomes?: readonly string[];
}

export type OutcomeMetricDef = MeasuredMetric | UnmeasuredMetric;

/**
 * `01` §12, item by item, in the specification's order. The mapping is the
 * funnel's own vocabulary (OUTCOME_VALUES in routes/rankEvents.ts); nothing here
 * is a new signal.
 */
export const OUTCOME_METRICS: readonly OutcomeMetricDef[] = [
  {
    id: "useful_saves", spec: "useful saves", status: "measured",
    lower: ["save"], upper: ["save", "trip_add", "attended"],
    note: "a save; 'useful' is not distinguishable from any save. trip_add and attended can consume a save.",
  },
  {
    id: "itinerary_additions", spec: "itinerary additions", status: "measured",
    lower: ["trip_add"], upper: ["trip_add", "attended"],
    note: "trip_add, reported by the plan picker on a successful add (2894). attended can consume it.",
  },
  {
    id: "place_opens", spec: "place opens", status: "measured",
    lower: ["tap"], upper: ["tap", "save", "join", "rsvp", "trip_add", "attended"],
    note: "tap: the card opening its detail sheet, Directions, the full place page. Every stronger rung can have consumed one.",
  },
  {
    id: "completed_visits", spec: "completed visits", status: "unmeasured",
    missingInput: "no visit-confirmation signal exists on rank_events: `attended` is event attendance, and no client emits it",
  },
  {
    id: "event_attendance", spec: "event attendance", status: "unmeasured",
    missingInput: "no client emits `attended` at all, and `rsvp` is emitted only against 'events' and 'live_pulse' (useEventRsvp, LivePulseCard) — never against a Discovery exposure",
    strayOutcomes: ["rsvp", "attended"],
  },
  {
    id: "successful_trip_actions", spec: "successful trip actions", status: "unmeasured",
    missingInput: "no definition beyond trip_add (reported as itinerary_additions); the spec does not say what else counts",
  },
  {
    id: "dismiss_rate", spec: "low regret/hide/report rates — ONLY the dismiss rate, under its own name", status: "measured",
    lower: ["dismiss"], upper: ["dismiss"],
    note: "the card's 'Not interested' control. No spec calls it regret; low regret and the report rate are unmeasured (no Discovery `report` outcome), and `04` §4 does not define hide vs not_interested.",
  },
  {
    id: "low_regret", spec: "low regret", status: "unmeasured",
    missingInput: "no regret signal: nothing records that a viewer regretted acting on a recommendation; `dismiss` is reported as dismiss_rate, not as regret",
  },
  {
    id: "creator_diversity", spec: "creator diversity", status: "unmeasured",
    missingInput: "no Discovery writer puts the item's creator on the rank_events row, and cannot: the storage screen (screenFeaturesForStorage) refuses every unclassified features key and no creator key is classified",
  },
  {
    id: "new_creator_discovery", spec: "new-creator discovery", status: "unmeasured",
    missingInput: "the creator is not on the row (see creator_diversity), and the spec does not define 'new' (new to the viewer, or new to the platform)",
  },
  {
    id: "trail_freshness", spec: "Trail freshness", status: "unmeasured",
    missingInput: "not an outcome of a served exposure: Trail health computes freshness over Trail content (lib/discoveryTrailHealth.ts), which no served-recommendation row carries",
  },
  {
    id: "repeat_traveler_satisfaction", spec: "repeat traveler satisfaction", status: "unmeasured",
    missingInput: "no satisfaction or return-visit signal exists in the tree",
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// The report
// ═════════════════════════════════════════════════════════════════════════════

export type Share = { count: number; share: number };

export type MetricFigure =
  | { status: "measured"; n: number; lower: Share; upper: Share }
  /** n = 0: there is nothing to divide. NOT 0 %. */
  | { status: "insufficient_sample"; n: 0; lower: null; upper: null };

export interface OutcomeCell {
  arm: OutcomeArm;
  servePoint: ServePointKey | "all";
  label: string;
  /** Served exposures in this cell — the denominator of every figure. */
  n: number;
  /** Furthest recorded outcome per exposure, as stored. */
  terminal: Record<string, number>;
  rankedInRequest: { ranked: number; unranked: number; unrecorded: number };
  metrics: Record<string, MetricFigure>;
}

export interface OutcomeReport {
  arms: OutcomeCell[];                 // one per arm, all serve points
  byServePoint: OutcomeCell[];         // arm × serve point, both arms for every serve point seen
  outsideArms: OutcomeCell[];          // unrecorded / unknown model versions, never folded in
  unknownModelVersions: string[];
  unmeasured: Array<{ id: string; spec: string; missingInput: string; strayRows?: number }>;
  anonymous:
    | { observed: true; requests: number; items: number; outcomes: "unobservable by design — an anonymous serve has no exposure row and binds no outcome" }
    | { observed: false; reason: string };
  verdict: "none — numbers and sample sizes only";
}

function emptyCell(arm: OutcomeArm, sp: ServePointKey | "all"): OutcomeCell {
  return {
    arm, servePoint: sp, label: sp === "all" ? "all serve points" : servePointLabel(sp),
    n: 0, terminal: {}, rankedInRequest: { ranked: 0, unranked: 0, unrecorded: 0 }, metrics: {},
  };
}

function add(cell: OutcomeCell, row: TraceRankEventRow): void {
  cell.n += 1;
  const o = String(row.outcome ?? "");
  cell.terminal[o] = (cell.terminal[o] ?? 0) + 1;
  const r = featuresOf(row)["rankedInRequest"];
  if (r === true) cell.rankedInRequest.ranked += 1;
  else if (r === false) cell.rankedInRequest.unranked += 1;
  else cell.rankedInRequest.unrecorded += 1;
}

function sumOf(terminal: Record<string, number>, outcomes: readonly string[]): number {
  return outcomes.reduce((acc, o) => acc + (terminal[o] ?? 0), 0);
}

function finish(cell: OutcomeCell): OutcomeCell {
  for (const m of OUTCOME_METRICS) {
    if (m.status !== "measured") continue;
    if (cell.n === 0) {
      cell.metrics[m.id] = { status: "insufficient_sample", n: 0, lower: null, upper: null };
      continue;
    }
    const lo = sumOf(cell.terminal, m.lower), hi = sumOf(cell.terminal, m.upper);
    cell.metrics[m.id] = {
      status: "measured", n: cell.n,
      lower: { count: lo, share: lo / cell.n },
      upper: { count: hi, share: hi / cell.n },
    };
  }
  return cell;
}

const spOrder = (sp: ServePointKey | "all") => (typeof sp === "number" ? sp : sp === "unmarked" ? 1000 : sp === "unrecognised" ? 1001 : 1002);

/**
 * Build the report. `rankEvents` are Discovery `rank_events` rows; only the
 * exposures among them (the serve corpus, `event_type IS NULL`) are counted.
 * `serveRequests` is `null` when `public.recommendations` could not be read.
 */
export function buildOutcomeReport(
  rankEvents: readonly TraceRankEventRow[],
  serveRequests: readonly TraceServeRequestRow[] | null,
): OutcomeReport {
  const totals = new Map<OutcomeArm, OutcomeCell>(OUTCOME_ARMS.map((a) => [a, emptyCell(a, "all")]));
  const cells = new Map<string, OutcomeCell>();
  const outside = new Map<string, OutcomeCell>();
  const unknownVersions = new Set<string>();
  const seenPoints = new Set<ServePointKey>();

  for (const row of rankEvents) {
    if (traceRowKind(row) !== "exposure") continue;
    const arm = armOf(row);
    const sp = servePointOf(featuresOf(row));
    if (arm === "unrecorded" || arm === "unknown") {
      if (arm === "unknown") unknownVersions.add(modelVersionOf(row));
      const k = `${arm}|${sp}`;
      const c = outside.get(k) ?? emptyCell(arm, sp);
      add(c, row);
      outside.set(k, c);
      continue;
    }
    seenPoints.add(sp);
    add(totals.get(arm)!, row);
    const k = `${arm}|${sp}`;
    const c = cells.get(k) ?? emptyCell(arm, sp);
    add(c, row);
    cells.set(k, c);
  }
  // Every serve point either arm reached is shown for BOTH arms: an arm with no
  // exposures there is `insufficient_sample`, never silently absent and never 0 %.
  for (const sp of seenPoints) {
    for (const arm of OUTCOME_ARMS) {
      const k = `${arm}|${sp}`;
      if (!cells.has(k)) cells.set(k, emptyCell(arm, sp));
    }
  }

  const unmeasured = OUTCOME_METRICS
    .filter((m): m is UnmeasuredMetric => m.status === "unmeasured")
    .map((m) => {
      const stray = m.strayOutcomes
        ? [...totals.values(), ...outside.values()].reduce((acc, c) => acc + sumOf(c.terminal, m.strayOutcomes!), 0)
        : 0;
      return stray > 0
        ? { id: m.id, spec: m.spec, missingInput: m.missingInput, strayRows: stray }
        : { id: m.id, spec: m.spec, missingInput: m.missingInput };
    });

  let anonymous: OutcomeReport["anonymous"];
  if (serveRequests === null) {
    anonymous = { observed: false, reason: "public.recommendations was not read (3376 absent, or not given): anonymous serves are unobservable, not zero" };
  } else {
    let requests = 0, items = 0;
    for (const r of serveRequests) {
      if (!isAnonymousServeRequest(r)) continue;
      requests += 1;
      const c = typeof r.served_count === "number" ? r.served_count : Number(r.served_count);
      items += Number.isFinite(c) && c > 0 ? c : 0;
    }
    anonymous = { observed: true, requests, items, outcomes: "unobservable by design — an anonymous serve has no exposure row and binds no outcome" };
  }

  const sortCells = (xs: OutcomeCell[]) => xs.sort((a, b) =>
    spOrder(a.servePoint) - spOrder(b.servePoint) || String(a.arm).localeCompare(String(b.arm)));

  return {
    arms: OUTCOME_ARMS.map((a) => finish(totals.get(a)!)),
    byServePoint: sortCells([...cells.values()].map(finish)),
    outsideArms: sortCells([...outside.values()].map(finish)),
    unknownModelVersions: [...unknownVersions].sort(),
    unmeasured,
    anonymous,
    verdict: "none — numbers and sample sizes only",
  };
}

/** Plain-text rendering for the report script. */
export function renderOutcomeReport(r: OutcomeReport): string {
  const lines: string[] = [];
  const pct = (s: Share) => `${s.count} (${(s.share * 100).toFixed(1)}%)`;
  const cellLines = (c: OutcomeCell) => {
    lines.push(`  [${c.arm}] ${c.label} — n = ${c.n} exposure(s); ranked in request ${c.rankedInRequest.ranked}, unranked ${c.rankedInRequest.unranked}, unrecorded ${c.rankedInRequest.unrecorded}`);
    lines.push(`    furthest recorded outcome: ${JSON.stringify(c.terminal)}`);
    for (const m of OUTCOME_METRICS) {
      if (m.status !== "measured") continue;
      const f = c.metrics[m.id];
      if (!f) continue;
      if (f.status === "insufficient_sample") { lines.push(`    ${m.id}: insufficient sample (n = 0) — not 0%`); continue; }
      const exact = m.lower.length === m.upper.length && m.lower.every((o, i) => o === m.upper[i]);
      lines.push(exact
        ? `    ${m.id}: ${pct(f.lower)} of ${f.n}`
        : `    ${m.id}: between ${pct(f.lower)} and ${pct(f.upper)} of ${f.n}`);
    }
  };
  lines.push(`verdict: ${r.verdict}. Arms are observational (engine mode, cohort and serve point decide membership), not randomised.`);
  lines.push("", "── arms, all serve points ──");
  r.arms.forEach(cellLines);
  lines.push("", "── arm × serve point ──");
  r.byServePoint.forEach(cellLines);
  if (r.outsideArms.length > 0) {
    lines.push("", "── exposures in NO arm (never folded in) ──");
    r.outsideArms.forEach(cellLines);
  }
  if (r.unknownModelVersions.length > 0) lines.push(`UNKNOWN modelVersion: ${r.unknownModelVersions.join(", ")}`);
  lines.push("", "── `01` §12 items NOT measured (no input in the tree) ──");
  for (const u of r.unmeasured) lines.push(`  ${u.id} (${u.spec}): ${u.missingInput}${u.strayRows ? ` — BUT ${u.strayRows} exposure(s) carry one of its outcomes: the registry is stale` : ""}`);
  lines.push("", r.anonymous.observed
    ? `anonymous: ${r.anonymous.requests} request(s), ${r.anonymous.items} item(s); outcomes ${r.anonymous.outcomes}`
    : `anonymous: unobserved (${r.anonymous.reason})`);
  return lines.join("\n");
}
