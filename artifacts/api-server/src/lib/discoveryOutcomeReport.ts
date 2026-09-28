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
 * sizes, and this report carries no verdict. What "improves" means was decided
 * at §82 (register D-W10-O-10) and is applied SEPARATELY, by
 * `judgeOutcomeImprovement` at the foot of this file, so the numbers never
 * depend on the rule. Nothing here changes what is served or its order.
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
 * NAMES ARE DECIDED, NOT UPGRADED (§82, D-W10-O-6 / D-W10-O-11)
 * ======================
 * `dismiss` is the card's "Not interested" control; on Discovery `hide` and
 * `not_interested` are one act, so it is the §12 HIDE rate. Regret and the
 * report rate are their own rates, read from the enrichment (foot of file).
 * Every §12 item with no possible input is listed as unmeasured with the
 * missing input named, and is never emitted as 0.
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

export type OutcomeMetricDef = MeasuredMetric | UnmeasuredMetric | EnrichedMetric;  // §82: EnrichedMetric is declared at the foot

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
    missingInput: "decided (D-W10-O-10): a trip action is SUCCESSFUL when the itinerary item a Discovery exposure added is carried out; no Trips plan-item projection reaches Discovery (E-7), so no row can say so",
  },
  // §82 (W10-O): low regret/hide/report is THREE rates (D-W10-O-11); creator diversity and new-creator discovery read the enrichment.
  { id: "dismiss_rate", spec: "low regret/hide/report rates — the hide rate: the card's 'Not interested' (`04` §4 hide ≡ not_interested on Discovery, D-W10-O-6)", status: "measured",
    lower: ["dismiss"], upper: ["dismiss"], note: "the card's 'Not interested' control, the one negative control Discovery offers; terminal, so exact." },
  { id: "low_regret", spec: "low regret/hide/report rates — the regret rate", status: "enriched", direction: "lower_is_better",
    note: "of the exposures with a positive outcome (tap or stronger), the share whose item the SAME viewer dismissed on a LATER exposure within REGRET_WINDOW_DAYS" },
  { id: "report_rate", spec: "low regret/hide/report rates — the report rate", status: "enriched", direction: "lower_is_better",
    note: "of the exposures of a reportable (community, db/<uuid>) place, the share the viewer reported (discovery_place_reports) within REPORT_ATTRIBUTION_WINDOW_DAYS after the exposure" },
  { id: "creator_diversity", spec: "creator diversity", status: "enriched", direction: "lower_is_better",
    note: "Herfindahl index of exposures across creators (discovery_places.submitted_by, hashed), over exposures whose creator resolved; coverage beside it. The same join 3391's creator_concentration uses" },
  { id: "new_creator_discovery", spec: "new-creator discovery", status: "enriched", direction: "higher_is_better",
    note: "new to the PLATFORM (D-W10-O-10; `01` §1 'new creators fair exploration', §10): of the exposures whose creator resolved, the share whose creator's first submission is within NEW_CREATOR_WINDOW_DAYS before the exposure" },
  //
  //
  //
  //
  //
  //
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
    n: 0, terminal: {}, rankedInRequest: { ranked: 0, unranked: 0, unrecorded: 0 }, metrics: {}, enriched: {},
  };
}

function add(cell: OutcomeCell, row: TraceRankEventRow): void {
  cell.n += 1;
  const o = String(row.outcome ?? "");
  cell.terminal[o] = (cell.terminal[o] ?? 0) + 1;
  const r = featuresOf(row)["rankedInRequest"];
  if (r === true) cell.rankedInRequest.ranked += 1;
  else if (r === false) cell.rankedInRequest.unranked += 1;
  else cell.rankedInRequest.unrecorded += 1; accumulateEnrichment(cell, row);  // §82
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
  return finishEnriched(cell);  // §82: the four enriched figures
}

const spOrder = (sp: ServePointKey | "all") => (typeof sp === "number" ? sp : sp === "unmarked" ? 1000 : sp === "unrecognised" ? 1001 : 1002);

/**
 * Build the report. `rankEvents` are Discovery `rank_events` rows; only the
 * exposures among them (the serve corpus, `event_type IS NULL`) are counted.
 * `serveRequests` is `null` when `public.recommendations` could not be read.
 */
export function buildOutcomeReport(
  rankEvents: readonly TraceRankEventRow[],
  serveRequests: readonly TraceServeRequestRow[] | null, enrichment: OutcomeEnrichment | null = null,  // §82: per-exposure enrichment; null ⇒ the four read UNOBSERVED
): OutcomeReport { _enrichment = enrichment;
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
    lines.push(`    furthest recorded outcome: ${JSON.stringify(c.terminal)}`); renderEnriched(c, lines);  // §82
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

// ═════════════════════════════════════════════════════════════════════════════
// census-discovery §82 (lane W10-O) — DV-19 / D-3: the enriched items, and what
// "improves" means.
//
// APPENDED: the census cites this file by line (:86, :127, :243, :263). Every
// edit above is on a line that already existed.
//
// THE ENRICHMENT. Four `01` §12 items have an input in the database that the
// exposure row does not carry: the place's creator (discovery_places.submitted_by,
// the join 3391's creator_concentration already makes), the creator's first
// submission, the viewer's place reports, and the viewer's later dismissals.
// OUTCOME_ENRICHMENT_SQL reads them per exposure, READ ONLY, and nothing about
// the viewer leaves the database: user_id is joined inside the statement and
// never projected, and the creator leaves only as md5(submitted_by).
//
// "IMPROVES" (register D-W10-O-10), decided because `01` §12 names what success
// is measured on and not the number:
//   1. Per serve point, never pooled: the arms are observational (engine mode,
//      cohort and serve point decide membership), so only like-for-like pages
//      are compared.
//   2. Both arms need OUTCOME_MIN_SAMPLE_PER_ARM on the metric's own
//      denominator, or that metric at that serve point is insufficient.
//   3. A rate differs only when a two-proportion z-test clears
//      OUTCOME_Z_CRITICAL (two-sided 95 %) AND the relative change is at least
//      OUTCOME_MIN_RELATIVE_CHANGE. For the funnel's bounded metrics BOTH the
//      lower and the upper bound must clear in the same direction: the truth
//      lies between them, and a difference that holds at only one end is not
//      shown.
//   4. Creator diversity is an HHI, not a proportion: it differs when one arm's
//      HHI is CREATOR_HHI_MIN_RELATIVE_CHANGE lower (or higher) than the other's.
//   5. The verdict: `improves` iff at least one serve point shows an INTENT
//      metric (useful saves or itinerary additions) improving, and NO measured
//      metric worsens at ANY serve point. Place opens alone never suffice:
//      "Raw engagement may rise or fall; it is not the sole acceptance
//      criterion" (`01` §12). `insufficient_sample` when no serve point can
//      judge an intent metric. Otherwise `does_not_improve`.
//   6. It covers 6 of §12's 11 items. The five with no possible input are
//      listed in `notCovered`, never counted as passing.
// The judgement is evidence only about the database it was read from: over the
// harness it is controlled evidence, and only a read of production is production
// evidence.
// ═════════════════════════════════════════════════════════════════════════════
import { runReadOnly } from "./discoveryTraceRead.js";

/** Per serve point and arm, the fewest units of a metric's own denominator a comparison may rest on. */
export const OUTCOME_MIN_SAMPLE_PER_ARM = 1000;
/** Two-sided 95 % critical value for the two-proportion z-test. */
export const OUTCOME_Z_CRITICAL = 1.96;
/** The smallest relative change in a rate that counts as a difference, once significant. */
export const OUTCOME_MIN_RELATIVE_CHANGE = 0.05;
/** The smallest relative change in creator HHI that counts as a difference. */
export const CREATOR_HHI_MIN_RELATIVE_CHANGE = 0.10;
/** A creator is NEW when their first Discovery submission is at most this many days before the exposure. */
export const NEW_CREATOR_WINDOW_DAYS = 30;
/** A report counts against an exposure when the viewer filed it within this many days after it. */
export const REPORT_ATTRIBUTION_WINDOW_DAYS = 7;
/** A later dismissal of the same item by the same viewer within this many days is regret. */
export const REGRET_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** An item read from the enrichment rather than from the exposure row. */
export interface EnrichedMetric {
  id: string;
  spec: string;
  status: "enriched";
  direction: "lower_is_better" | "higher_is_better";
  note: string;
}

/** What the enrichment read says about one exposure (keyed by the exposure row's id). */
export interface ExposureEnrichment {
  /** md5 of the creator (discovery_places.submitted_by); null when none resolved. */
  creator: string | null;
  /** The creator's first discovery_places submission; null when no creator. */
  creatorFirstAt: string | null;
  /** A community place (db/<uuid>) — the only kind a viewer can report. */
  reportable: boolean;
  /** The viewer reported it within REPORT_ATTRIBUTION_WINDOW_DAYS after this exposure. */
  reported: boolean;
  /** The viewer dismissed this item on a LATER exposure within REGRET_WINDOW_DAYS. */
  regretted: boolean;
}
export type OutcomeEnrichment = ReadonlyMap<string, ExposureEnrichment>;

export type EnrichedFigure =
  | { status: "unobserved"; reason: string }
  | { status: "insufficient_sample"; n: 0 }
  | { status: "measured"; n: number; count: number; share: number }
  | { status: "measured"; n: number; hhi: number; creators: number; coverage: number };

// Declaration merging: every cell carries the four enriched figures.
export interface OutcomeCell {
  /** §82: the enriched items, by metric id. UNOBSERVED when the enrichment was not read. */
  enriched: Record<string, EnrichedFigure>;
}

interface EnrichmentAcc { positive: number; regretted: number; reportable: number; reported: number; creators: Map<string, number>; newCreator: number; resolved: number }
const POSITIVE = new Set(["tap", "save", "join", "rsvp", "trip_add", "attended"]);
let _enrichment: OutcomeEnrichment | null = null;
const _acc = new WeakMap<OutcomeCell, EnrichmentAcc>();

function accumulateEnrichment(cell: OutcomeCell, row: TraceRankEventRow): void {
  if (!_enrichment) return;
  const e = _enrichment.get(String(row.id ?? ""));
  let a = _acc.get(cell);
  if (!a) { a = { positive: 0, regretted: 0, reportable: 0, reported: 0, creators: new Map(), newCreator: 0, resolved: 0 }; _acc.set(cell, a); }
  if (!e) return;
  if (POSITIVE.has(String(row.outcome ?? ""))) { a.positive += 1; if (e.regretted) a.regretted += 1; }
  if (e.reportable) { a.reportable += 1; if (e.reported) a.reported += 1; }
  if (e.creator) {
    a.resolved += 1;
    a.creators.set(e.creator, (a.creators.get(e.creator) ?? 0) + 1);
    const served = typeof row.served_at === "string" ? Date.parse(row.served_at) : NaN;
    const first = e.creatorFirstAt ? Date.parse(e.creatorFirstAt) : NaN;
    if (Number.isFinite(served) && Number.isFinite(first) && first <= served && served - first <= NEW_CREATOR_WINDOW_DAYS * DAY_MS) a.newCreator += 1;
  }
}

function rate(count: number, n: number): EnrichedFigure {
  return n === 0 ? { status: "insufficient_sample", n: 0 } : { status: "measured", n, count, share: count / n };
}

function finishEnriched(cell: OutcomeCell): OutcomeCell {
  cell.enriched = cell.enriched ?? {};
  if (!_enrichment) {
    for (const m of OUTCOME_METRICS) if (m.status === "enriched") cell.enriched[m.id] = { status: "unobserved", reason: "the enrichment (creator, reports, later dismissals) was not read" };
    return cell;
  }
  const a = _acc.get(cell) ?? { positive: 0, regretted: 0, reportable: 0, reported: 0, creators: new Map<string, number>(), newCreator: 0, resolved: 0 };
  cell.enriched["low_regret"] = rate(a.regretted, a.positive);
  cell.enriched["report_rate"] = rate(a.reported, a.reportable);
  if (a.resolved === 0) cell.enriched["creator_diversity"] = { status: "insufficient_sample", n: 0 };
  else {
    let hhi = 0;
    for (const k of a.creators.values()) hhi += (k / a.resolved) ** 2;
    cell.enriched["creator_diversity"] = { status: "measured", n: a.resolved, hhi, creators: a.creators.size, coverage: cell.n > 0 ? a.resolved / cell.n : 0 };
  }
  cell.enriched["new_creator_discovery"] = rate(a.newCreator, a.resolved);
  return cell;
}

function renderEnriched(c: OutcomeCell, lines: string[]): void {
  for (const [id, f] of Object.entries(c.enriched ?? {})) {
    if (f.status === "unobserved") lines.push(`    ${id}: unobserved (${f.reason}) — not 0`);
    else if (f.status === "insufficient_sample") lines.push(`    ${id}: insufficient sample (n = 0) — not 0%`);
    else if ("hhi" in f) lines.push(`    ${id}: HHI ${f.hhi.toFixed(3)} over ${f.n} resolved exposure(s), ${f.creators} creator(s), coverage ${(f.coverage * 100).toFixed(1)}%`);
    else lines.push(`    ${id}: ${f.count} (${(f.share * 100).toFixed(1)}%) of ${f.n}`);
  }
}

/**
 * The enrichment read. psql variables: :'since' and :'until', as the trace read.
 * One row per Discovery exposure served in the window. No user id and no raw
 * creator id is projected.
 */
export const OUTCOME_ENRICHMENT_SQL = `
WITH win AS (
  SELECT :'since'::timestamptz AS since, NULLIF(:'until', '')::timestamptz AS until
), ex AS (
  SELECT r.id, r.user_id, r.item_id, r.served_at,
         CASE WHEN r.item_id ~* '^db/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN (substring(r.item_id FROM 4))::uuid END AS place_id
    FROM public.rank_events r CROSS JOIN win
   WHERE r.surface = 'discovery' AND r.event_type IS NULL AND r.outcome <> 'analytics'
     AND r.served_at >= win.since AND (win.until IS NULL OR r.served_at <= win.until)
), p AS (
  SELECT ex.id, dp.submitted_by FROM ex JOIN public.discovery_places dp ON dp.id = ex.place_id
), firsts AS (
  SELECT dp.submitted_by, min(dp.created_at) AS first_at
    FROM public.discovery_places dp
   WHERE dp.submitted_by IN (SELECT submitted_by FROM p WHERE submitted_by IS NOT NULL)
   GROUP BY dp.submitted_by
), t AS (
  SELECT ex.id,
         md5(p.submitted_by::text) AS creator,
         f.first_at AS creator_first_at,
         (ex.place_id IS NOT NULL) AS reportable,
         EXISTS (SELECT 1 FROM public.discovery_place_reports pr
                  WHERE ex.place_id IS NOT NULL AND pr.place_id = ex.place_id AND pr.reporter_id = ex.user_id
                    AND pr.created_at >= ex.served_at AND pr.created_at < ex.served_at + interval '${REPORT_ATTRIBUTION_WINDOW_DAYS} days') AS reported,
         EXISTS (SELECT 1 FROM public.rank_events later
                  WHERE later.user_id = ex.user_id AND later.item_id = ex.item_id AND later.surface = 'discovery'
                    AND later.event_type IS NULL AND later.outcome = 'dismiss'
                    AND later.served_at > ex.served_at AND later.served_at < ex.served_at + interval '${REGRET_WINDOW_DAYS} days') AS regretted
    FROM ex LEFT JOIN p ON p.id = ex.id LEFT JOIN firsts f ON f.submitted_by = p.submitted_by
)
SELECT COALESCE(json_agg(json_build_object('id', t.id, 'creator', t.creator, 'creator_first_at', t.creator_first_at,
         'reportable', t.reportable, 'reported', t.reported, 'regretted', t.regretted)), '[]'::json)::text FROM t;
`;

/** Read the enrichment for a window, read-only. An error rather than a partial map. */
export function readOutcomeEnrichment(
  dbUrl: string, window: { since: string; until: string | null },
): { ok: true; enrichment: OutcomeEnrichment } | { ok: false; error: string } {
  const r = runReadOnly(dbUrl, OUTCOME_ENRICHMENT_SQL, { since: window.since, until: window.until ?? "" });
  if (!r.ok) return { ok: false, error: `outcome enrichment read failed: ${r.error}` };
  const rows = JSON.parse(r.stdout || "[]") as Array<{ id: string; creator: string | null; creator_first_at: string | null; reportable: boolean; reported: boolean; regretted: boolean }>;
  const m = new Map<string, ExposureEnrichment>();
  for (const x of rows) m.set(String(x.id), { creator: x.creator ?? null, creatorFirstAt: x.creator_first_at ?? null, reportable: x.reportable === true, reported: x.reported === true, regretted: x.regretted === true });
  return { ok: true, enrichment: m };
}

// ── The judgement ────────────────────────────────────────────────────────────

/** Two-proportion z (pooled). 0 when the pooled variance is 0. Positive ⇒ the first proportion is higher. */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 0;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se === 0 ? 0 : (x1 / n1 - x2 / n2) / se;
}

export type MetricResult = "improves" | "worsens" | "no_difference" | "insufficient_sample" | "unobserved";
export interface MetricJudgement { result: MetricResult; detail: string }
export interface OutcomeJudgement {
  verdict: "improves" | "does_not_improve" | "insufficient_sample";
  servePoints: Array<{ servePoint: ServePointKey; metrics: Record<string, MetricJudgement> }>;
  notCovered: Array<{ id: string; spec: string; missingInput: string }>;
  rule: string;
}

const INTENT_METRICS = ["useful_saves", "itinerary_additions"];
const LOWER_IS_BETTER_MEASURED = new Set(["dismiss_rate"]);

/** Compare one rate. `sign` +1 when higher is better, −1 when lower is. */
function compareRate(pX: number, pN: number, lX: number, lN: number, sign: 1 | -1): MetricResult {
  if (pN < OUTCOME_MIN_SAMPLE_PER_ARM || lN < OUTCOME_MIN_SAMPLE_PER_ARM) return "insufficient_sample";
  const z = twoProportionZ(pX, pN, lX, lN) * sign;
  const pr = pX / pN, lr = lX / lN;
  const base = Math.max(pr, lr);
  const rel = base === 0 ? 0 : Math.abs(pr - lr) / base;
  if (Math.abs(z) < OUTCOME_Z_CRITICAL || rel < OUTCOME_MIN_RELATIVE_CHANGE) return "no_difference";
  return z > 0 ? "improves" : "worsens";
}

function judgeMeasured(id: string, p: MetricFigure | undefined, l: MetricFigure | undefined): MetricJudgement {
  if (!p || !l || p.status !== "measured" || l.status !== "measured") return { result: "insufficient_sample", detail: "an arm has no exposures here" };
  const sign: 1 | -1 = LOWER_IS_BETTER_MEASURED.has(id) ? -1 : 1;
  const lo = compareRate(p.lower.count, p.n, l.lower.count, l.n, sign);
  const hi = compareRate(p.upper.count, p.n, l.upper.count, l.n, sign);
  const detail = `pde ${p.lower.count}–${p.upper.count}/${p.n}, legacy ${l.lower.count}–${l.upper.count}/${l.n}`;
  if (lo === "insufficient_sample" || hi === "insufficient_sample") return { result: "insufficient_sample", detail };
  return { result: lo === hi ? lo : "no_difference", detail };
}

function judgeEnriched(m: EnrichedMetric, p: EnrichedFigure | undefined, l: EnrichedFigure | undefined): MetricJudgement {
  if (!p || !l || p.status === "unobserved" || l.status === "unobserved") return { result: "unobserved", detail: "the enrichment was not read" };
  if (p.status !== "measured" || l.status !== "measured") return { result: "insufficient_sample", detail: "an arm has no units here" };
  if ("hhi" in p && "hhi" in l) {
    if (p.n < OUTCOME_MIN_SAMPLE_PER_ARM || l.n < OUTCOME_MIN_SAMPLE_PER_ARM) return { result: "insufficient_sample", detail: `resolved pde ${p.n}, legacy ${l.n}` };
    const detail = `HHI pde ${p.hhi.toFixed(3)}, legacy ${l.hhi.toFixed(3)}`;
    if (p.hhi <= l.hhi * (1 - CREATOR_HHI_MIN_RELATIVE_CHANGE)) return { result: "improves", detail };
    if (p.hhi >= l.hhi * (1 + CREATOR_HHI_MIN_RELATIVE_CHANGE)) return { result: "worsens", detail };
    return { result: "no_difference", detail };
  }
  if ("count" in p && "count" in l) {
    const result = compareRate(p.count, p.n, l.count, l.n, m.direction === "higher_is_better" ? 1 : -1);
    return { result, detail: `pde ${p.count}/${p.n}, legacy ${l.count}/${l.n}` };
  }
  return { result: "insufficient_sample", detail: "incomparable figures" };
}

/** Apply D-W10-O-10 to a report. Pure. */
export function judgeOutcomeImprovement(r: OutcomeReport): OutcomeJudgement {
  const points = [...new Set(r.byServePoint.map((c) => c.servePoint))].filter((sp): sp is ServePointKey => sp !== "all");
  const servePoints = points.map((sp) => {
    const p = r.byServePoint.find((c) => c.servePoint === sp && c.arm === "pde");
    const l = r.byServePoint.find((c) => c.servePoint === sp && c.arm === "legacy");
    const metrics: Record<string, MetricJudgement> = {};
    for (const m of OUTCOME_METRICS) {
      if (m.status === "measured") metrics[m.id] = judgeMeasured(m.id, p?.metrics[m.id], l?.metrics[m.id]);
      else if (m.status === "enriched") metrics[m.id] = judgeEnriched(m, p?.enriched?.[m.id], l?.enriched?.[m.id]);
    }
    return { servePoint: sp, metrics };
  });
  const anyWorse = servePoints.some((s) => Object.values(s.metrics).some((j) => j.result === "worsens"));
  const intentJudged = servePoints.some((s) => INTENT_METRICS.some((id) => s.metrics[id] && s.metrics[id]!.result !== "insufficient_sample"));
  const intentImproves = servePoints.some((s) => INTENT_METRICS.some((id) => s.metrics[id]?.result === "improves"));
  const verdict: OutcomeJudgement["verdict"] = !intentJudged && !anyWorse ? "insufficient_sample" : intentImproves && !anyWorse ? "improves" : "does_not_improve";
  return {
    verdict,
    servePoints,
    notCovered: r.unmeasured.map((u) => ({ id: u.id, spec: u.spec, missingInput: u.missingInput })),
    rule: "D-W10-O-10: per serve point; both arms >= OUTCOME_MIN_SAMPLE_PER_ARM; |z| >= OUTCOME_Z_CRITICAL and relative change >= OUTCOME_MIN_RELATIVE_CHANGE on both funnel bounds; creator HHI by CREATOR_HHI_MIN_RELATIVE_CHANGE; improves iff an intent metric improves somewhere and nothing worsens anywhere",
  };
}

/** Plain text for the judgement. */
export function renderOutcomeJudgement(j: OutcomeJudgement): string {
  const covered = 11 - j.notCovered.length;
  const lines = [
    `judgement: ${j.verdict} — over ${covered} of \`01\` §12's 11 items. This is evidence only about the database it was read from: over the harness it is controlled evidence, never production evidence.`,
    `rule: ${j.rule}`,
  ];
  for (const s of j.servePoints) {
    lines.push(`  serve point ${String(s.servePoint)}:`);
    for (const [id, m] of Object.entries(s.metrics)) lines.push(`    ${id}: ${m.result} (${m.detail})`);
  }
  lines.push("  not covered (no possible input):");
  for (const u of j.notCovered) lines.push(`    ${u.id}: ${u.missingInput}`);
  return lines.join("\n");
}
