/**
 * layoverContractMonitor — spec §20 `recommendation_contract_violation`
 * (census-layover L216): "Any generated recommendation that violates certified
 * return contract; target = 0".
 *
 * ── WHAT "THE CONTRACT" IS, ON THIS TREE ────────────────────────────────────
 * Spec §9 names a fifteen-member `LayoverRecommendationContract`; census L76
 * scores it W because a card carries only some of them. This monitor does not
 * invent the missing members. It checks every card the generator WROTE against
 * the one certified record the request rated it with (`generateRecommendations`
 * computes `certified` once and hands its deadline to `rankActivities`), on the
 * terms the card and the record actually share:
 *
 *   HARD_RETURN_DIVERGES        the card's `hard_return_time` is not the
 *                               record's `deadline.hardReturnTime`. Spec §2.1-4:
 *                               "no duplicate time-budget logic" — a second
 *                               derivation anywhere shows up here.
 *   RETURN_BUFFER_DIVERGES      the card's `return_buffer_min` is not the
 *                               record's `deadline.breakdown.totalBuffer`.
 *   CERTIFIED_ON_UNSTATED_TIME  the card is rated `safe` or `possible_but_risky`
 *                               (a certification) while a term it needs was
 *                               never stated: a landside leg or a dwell nobody
 *                               measured (census L293 — a lower bound may refuse,
 *                               it may never certify).
 *   EXCEEDS_CERTIFIED_WINDOW    a landside card certified as fitting whose own
 *                               stated out-and-back (2 × leg + dwell) is longer
 *                               than the record's certified usable minutes.
 *   LANDSIDE_PAST_CLOSED_GATE   a landside card was generated while the record's
 *                               landside gate is closed (`landsideStatusOf`:
 *                               verdict `no` / `stay_airside`, or a constraint
 *                               closure) — §9.1's HARD GATE, which the generator
 *                               applies before fetching a single landside place.
 *   ENVELOPE_BLOCKED_CANDIDATE  the §8 envelope BLOCKED this candidate (it cannot
 *                               fit at the straight-line lower bound) and it was
 *                               generated anyway.
 *   SNAPSHOT_CITATION_DIVERGES  migration 3623's half: a card cites a snapshot
 *                               other than the one this request certified
 *                               (`snapshotIdFor(session, record.inputHash)`), or
 *                               cites one when the stamp was refused, or fails to
 *                               cite one when it was stored.
 *
 * Each check reads values that were ALREADY decided — the record and the row —
 * and re-rates nothing. It is a comparison, not a second safety answer (census
 * L1/L2 score a second feasibility judgement as a defect wherever it appears).
 * Airside cards have no return leg, so only the deadline, buffer, unstated-dwell,
 * envelope and citation checks can apply to them.
 *
 * ── IT OBSERVES, IT DOES NOT GATE ───────────────────────────────────────────
 * A violating card is still written and served exactly as before. Withholding
 * it here would be a second eligibility gate, decided by a monitor; the fix for
 * a violation is in the generator, and the monitor's job is to make one
 * impossible to miss. Whether a violating card should ALSO be withheld is an
 * owner question, not decided here.
 *
 * ── WHERE THE COUNT GOES (owner question OQ-8: admin route + logs only) ─────
 *   1. In process: a counter by check, and ONE structured
 *      `layover_recommendation_contract_violation` line per violating
 *      generation (the `emitStaleFallback` pattern, census L215). The log line
 *      is the emission a log-based counter reads.
 *   2. Durably: the generator puts this request's TALLY (counts only, no card
 *      content) into the `recommendation_generated` audit event it already
 *      writes to `layover_events` (0127, on every database). That is what
 *      `GET /api/admin/layover/metrics` folds over its window, so the metric is
 *      per window and survives a deploy, rather than per process.
 * There is no bound exporter in this repository
 * (`lib/providers/metricsExporter.ts` exists and nothing calls it); the metric
 * row grades W for that reason (§59.3 precedent).
 */
import { logger as rootLogger } from "../../lib/logger.js";
import { statedTravelMin, statedDurationMin } from "./LayoverPlanFit.js";
import { landsideStatusOf, type LandsideGate } from "./LayoverConstraints.js";
import { snapshotIdFor } from "./layoverLedger.js";
import type { LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import type { SafetyRating } from "./LayoverSafetyEngine.js";

const logger = rootLogger.child({ service: "layoverContractMonitor" });

/** Bump when a check is added, removed or changes meaning. Stored in every tally. */
export const LAYOVER_CONTRACT_MONITOR_VERSION = "2026.10.14-1";

export const CONTRACT_CHECKS = [
  "HARD_RETURN_DIVERGES",
  "RETURN_BUFFER_DIVERGES",
  "CERTIFIED_ON_UNSTATED_TIME",
  "EXCEEDS_CERTIFIED_WINDOW",
  "LANDSIDE_PAST_CLOSED_GATE",
  "ENVELOPE_BLOCKED_CANDIDATE",
  "SNAPSHOT_CITATION_DIVERGES",
] as const;
export type ContractCheck = (typeof CONTRACT_CHECKS)[number];

/**
 * Which ratings CERTIFY that a card fits. Exhaustive over the union, so a fifth
 * rating cannot be added without deciding here whether it certifies.
 * `not_recommended` is a refusal and `airport_only` is the traveller's own
 * preference — neither claims anything fits.
 */
export const RATING_CERTIFIES_FIT: Record<SafetyRating, boolean> = {
  safe: true,
  possible_but_risky: true,
  not_recommended: false,
  airport_only: false,
};

/**
 * One generated `layover_recommendations` row as the generator built it — the
 * stored payload, with `0` standing for an unstated term in the two NOT NULL
 * minute columns (the generator's own convention, read back through
 * `statedTravelMin` / `statedDurationMin` exactly as the read path does).
 */
export interface ContractRow {
  safety_rating: string;
  travel_time_min: number | null;
  activity_time_min: number | null;
  return_buffer_min: number;
  hard_return_time: string;
  inside_airport: boolean;
  snapshot_id?: string | null;
}

export interface ContractCheckInput {
  sessionId: string;
  /** The ONE record every card in this generation was rated against. */
  record: Pick<LayoverFeasibilityRecord, "deadline" | "envelope" | "inputHash" | "verdict"> & { landsideGate: LandsideGate };
  rows: readonly ContractRow[];
  /** `recommendationKey` per row, index-aligned with `rows`. */
  keys: readonly string[];
  /** The §8 envelope's verdict per candidate key, as `bandCandidates` returned it. */
  bands: ReadonlyMap<string, { band: string }>;
  /** `recommendationSnapshotStamp(...).snapshotId` — non-null only when the computation was stored. */
  stampSnapshotId: string | null;
}

export interface ContractViolation {
  check: ContractCheck;
  /** Index into `rows`. */
  row: number;
  /** The card's `recommendationKey` (a place id or a slug — never user data). */
  key: string;
}

export interface ContractCheckResult {
  checked: number;
  /** Cards with at least one violation. A card that breaks two checks is ONE card here. */
  violating: number;
  byCheck: Partial<Record<ContractCheck, number>>;
  violations: ContractViolation[];
}

const instant = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : Number.NaN);

/**
 * Check every generated card against the record it was rated with. PURE: no
 * clock, no I/O, and it does not mutate its input.
 */
export function checkRecommendationContract(input: ContractCheckInput): ContractCheckResult {
  const { record, rows, keys, bands } = input;
  const deadlineMs = record.deadline.hardReturnTime.getTime();
  const totalBuffer = record.deadline.breakdown.totalBuffer;
  const usable = record.envelope.usableMinutes;
  const gateClosed = landsideStatusOf(record) === "closed";
  // The snapshot this request certified, when (and only when) it was stored.
  const expectedCitation = input.stampSnapshotId !== null ? snapshotIdFor(input.sessionId, record.inputHash) : null;

  const violations: ContractViolation[] = [];
  rows.forEach((row, i) => {
    const key = keys[i] ?? `row:${i}`;
    const add = (check: ContractCheck) => violations.push({ check, row: i, key });
    const landside = row.inside_airport !== true;
    const certifies = RATING_CERTIFIES_FIT[row.safety_rating as SafetyRating] === true;

    // Equality of INSTANTS, not strings: a deadline is the same deadline in
    // any ISO spelling, and an unparseable one is a divergence (NaN never equals).
    if (instant(row.hard_return_time) !== deadlineMs) add("HARD_RETURN_DIVERGES");
    if (row.return_buffer_min !== totalBuffer) add("RETURN_BUFFER_DIVERGES");

    const leg = statedTravelMin({ travelMin: row.travel_time_min, insideAirport: !landside });
    const dwell = statedDurationMin({ durationMin: row.activity_time_min });
    if (certifies && (leg === null || dwell === null)) add("CERTIFIED_ON_UNSTATED_TIME");
    if (certifies && landside && leg !== null && dwell !== null && 2 * leg + dwell > usable) add("EXCEEDS_CERTIFIED_WINDOW");

    if (landside && gateClosed) add("LANDSIDE_PAST_CLOSED_GATE");
    if (bands.get(key)?.band === "BLOCKED") add("ENVELOPE_BLOCKED_CANDIDATE");

    const cited = row.snapshot_id ?? null;
    if (cited !== expectedCitation) add("SNAPSHOT_CITATION_DIVERGES");
  });

  const byCheck: Partial<Record<ContractCheck, number>> = {};
  for (const v of violations) byCheck[v.check] = (byCheck[v.check] ?? 0) + 1;
  return {
    checked: rows.length,
    violating: new Set(violations.map((v) => v.row)).size,
    byCheck,
    violations,
  };
}

// ── the tally the audit event carries ────────────────────────────────────────

/**
 * What one generation stores in its `recommendation_generated` event, under
 * `metadata.contract`. Counts only — never a card, a title or a place.
 * `failed: true` means the monitor itself threw, so this generation's cards are
 * UNCHECKED and the window cannot claim them clean.
 */
export type ContractTally =
  | { monitorVersion: string; checked: number; violating: number; byCheck: Partial<Record<ContractCheck, number>> }
  | { monitorVersion: string; failed: true };

// ── in-process emission (census L215 pattern) ────────────────────────────────

interface ContractCounters {
  generations: number;
  checked: number;
  violating: number;
  monitorFailures: number;
  byCheck: Partial<Record<ContractCheck, number>>;
}

const counters: ContractCounters = { generations: 0, checked: 0, violating: 0, monitorFailures: 0, byCheck: {} };

/** At most this many example violations go into one log line. */
const LOG_EXAMPLES = 5;

/**
 * Check, count and emit. Called ONCE per generation by
 * `generateRecommendations`, after the rows are built and before the audit
 * event is written; the returned tally goes into that event.
 *
 * NEVER THROWS. A monitor that could fail a traveller's recommendations would
 * be worse than no monitor: any internal error is logged, counted as a monitor
 * failure, and reported as `{ failed: true }` so the window says these cards
 * were not checked rather than that they were clean.
 */
export function monitorRecommendationContract(input: ContractCheckInput): ContractTally {
  try {
    const r = checkRecommendationContract(input);
    counters.generations += 1;
    counters.checked += r.checked;
    counters.violating += r.violating;
    for (const [check, n] of Object.entries(r.byCheck) as Array<[ContractCheck, number]>) {
      counters.byCheck[check] = (counters.byCheck[check] ?? 0) + n;
    }
    if (r.violating > 0) {
      logger.warn(
        {
          metric: "layover_recommendation_contract_violation",
          monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION,
          sessionId: input.sessionId,
          checked: r.checked,
          violating: r.violating,
          byCheck: r.byCheck,
          examples: r.violations.slice(0, LOG_EXAMPLES).map((v) => ({ check: v.check, key: v.key })),
        },
        "layover_recommendation_contract_violation",
      );
    }
    return { monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION, checked: r.checked, violating: r.violating, byCheck: r.byCheck };
  } catch (err) {
    counters.monitorFailures += 1;
    logger.warn(
      { metric: "layover_recommendation_contract_monitor_failed", sessionId: input.sessionId, err: err instanceof Error ? err.message : String(err) },
      "layover recommendation contract monitor failed — this generation's cards are unchecked",
    );
    return { monitorVersion: LAYOVER_CONTRACT_MONITOR_VERSION, failed: true };
  }
}

/** Since this process started. A snapshot; never the live object. */
export function recommendationContractCounters(): ContractCounters {
  return { ...counters, byCheck: { ...counters.byCheck } };
}

/** Tests only. */
export function _resetRecommendationContractCounters(): void {
  counters.generations = 0;
  counters.checked = 0;
  counters.violating = 0;
  counters.monitorFailures = 0;
  counters.byCheck = {};
}

// ── the window the admin route reports ───────────────────────────────────────

export interface RecommendationContractWindow {
  /** `recommendation_generated` events read in the window. */
  generations: number;
  /** Of those, how many carried a readable tally. */
  checkedGenerations: number;
  /** No `contract` key at all: written before this monitor existed. Excluded, and reported. */
  unchecked: number;
  /** A tally that does not parse, or a generation whose monitor failed. */
  malformed: number;
  /** Cards checked across the checked generations. */
  checked: number;
  /** Cards with at least one violation. */
  violating: number;
  byCheck: Record<ContractCheck, number>;
  truncated: boolean;
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Fold the `metadata` of a window's `recommendation_generated` events.
 *
 * A tally is accepted only when every count is a non-negative integer,
 * `violating <= checked`, and every `byCheck` key is a known check. Anything
 * else — and a `failed` tally — is MALFORMED, never skipped silently: a
 * generation whose result cannot be read could be hiding a violation, and the
 * metric refuses to report a count that left it out (`computeLayoverMetrics`).
 */
export function recommendationContractWindow(
  metadatas: readonly unknown[],
  truncated: boolean,
): RecommendationContractWindow {
  const byCheck = Object.fromEntries(CONTRACT_CHECKS.map((c) => [c, 0])) as Record<ContractCheck, number>;
  const w: RecommendationContractWindow = {
    generations: metadatas.length, checkedGenerations: 0, unchecked: 0, malformed: 0,
    checked: 0, violating: 0, byCheck, truncated,
  };
  for (const m of metadatas) {
    const tally = m !== null && typeof m === "object" ? (m as Record<string, unknown>).contract : undefined;
    if (tally === undefined) { w.unchecked += 1; continue; }
    if (tally === null || typeof tally !== "object") { w.malformed += 1; continue; }
    const t = tally as Record<string, unknown>;
    const bc = t.byCheck;
    const wellFormed =
      t.failed === undefined &&
      isCount(t.checked) && isCount(t.violating) && t.violating <= t.checked &&
      bc !== null && typeof bc === "object" && !Array.isArray(bc) &&
      Object.entries(bc as Record<string, unknown>).every(([k, n]) => (CONTRACT_CHECKS as readonly string[]).includes(k) && isCount(n));
    if (!wellFormed) { w.malformed += 1; continue; }
    w.checkedGenerations += 1;
    w.checked += t.checked as number;
    w.violating += t.violating as number;
    for (const [k, n] of Object.entries(bc as Record<string, number>)) byCheck[k as ContractCheck] += n;
  }
  return w;
}
