/**
 * discoveryStopConditions — `12` "Stop conditions", made into something that
 * can actually stop a rollout.
 *
 * THE REQUIREMENT, QUOTED
 * =======================
 * `docs/specs/discovery-v1/12_Claude_Code_Implementation.md` §"Stop conditions"
 * (`:206`):
 *
 *   "Stop rollout if: event rejection rises, recommendation logging gaps
 *    appear, creator concentration spikes, reports/hides increase materially,
 *    cache bypass reappears, RLS leaks occur, attribution double-counts."
 *
 * census-discovery DV-82 measured **0 of 7 enforced**: *"Rejections are logged
 * (C25) but nothing thresholds them… and nothing halts a rollout."*
 *
 * WHAT A STOP CONDITION IS, AND WHAT IT IS NOT
 * ============================================
 * `disable_discovery_pde` (lib/discoveryEngineMode.ts) is a MANUAL stop: a human
 * notices and pulls a lever. A stop CONDITION is the system pulling it. Both are
 * needed and neither replaces the other — the manual stop works when the
 * instrument itself is what failed, and this one works when nobody is looking.
 *
 * IT CAN ONLY EVER MOVE TOWARD LEGACY
 * ===================================
 * The only effect a trip has is to resolve `DISCOVERY_ENGINE_MODE` to `legacy` —
 * what every user already receives. It cannot enable anything, widen a cohort,
 * or change a served result on a path that was already legacy. That one-way
 * property is why this is safe to wire into a live resolver at all, and it is
 * pinned by a test rather than left as an intention.
 *
 * ALL SEVEN HAVE A PRODUCER. TWO HAVE A THRESHOLD. FIVE ARE MEASURED, UNRULED.
 * ===========================================================================
 * Every condition has a measurement wired into this evaluator
 * (`STOP_CONDITION_PRODUCERS`, at the foot of this file); a condition with no
 * producer would have to carry a named reason there instead, and a test fails
 * when any of the seven has neither. A threshold is a separate question: `12`
 * gives none and the owner has ruled none, so the five below report their
 * measured value in `readings` with state `unruled` and NEVER trip. They are
 * listed in `unenforced` on every evaluation, so a clean result can never be
 * read as "all seven are fine". A default would be a guess dressed as a guard.
 *   creator_concentration      Herfindahl index of Discovery exposures across
 *                              creators, via the discovery_places.submitted_by
 *                              join (3391; lib/discoveryStopMeasurements.ts).
 *   reports_hides              dismisses + place/Trail reports per exposure (3391).
 *   cache_bypass               share of serves OWED a rank (pde path, viewer in
 *                              cohort) that were served unranked from Cache A —
 *                              `recordRankObligation`, fed by the serve path.
 *   rls_leak                   deviations of the live catalogue from 3390's
 *                              declared posture (3391).
 *   attribution_double_count   live attributions crediting one beneficiary
 *                              twice for one value event (3391; 2920's table).
 *
 *
 * THE TWO WITH A THRESHOLD (UNRATIFIED), AND HOW THEY DIFFER
 * ===========================================================
 *   event_rejection_rate       fraction of serve-log INSERT ATTEMPTS the database
 *                              refused or that threw. A constraint, a permission
 *                              or a type problem.
 *   recommendation_logging_gap fraction of SERVED ITEMS that never became an
 *                              event row. It catches everything the rejection
 *                              rate catches AND a writer that accepts the insert
 *                              while silently dropping items.
 *
 * They are CORRELATED, not independent: a rejected batch contributes to both.
 * Stated plainly because two correlated numbers read as two pieces of evidence
 * unless somebody says otherwise. They are reported separately because their
 * thresholds differ and because a gap with a zero rejection rate is a specific,
 * diagnosable fault.
 *
 * IN-PROCESS, BOUNDED, AND IT RECOVERS
 * ====================================
 * Three windows are bounded rings in this process (the two serve-log rates and
 * cache bypass): a stop that needs a healthy database is unavailable exactly
 * when it is needed. The four database measurements are refreshed OFF the
 * request path and age out after STOP_WINDOW_MS (state `stale`); an unreadable
 * one is reported as `unreadable`, never as clear. Each instance decides for
 * itself and a restart clears the evidence. Evidence ages out, so a stop
 * RECOVERS; a stop that never recovers is an outage wearing a guardrail's name.
 *
 * A MINIMUM-EVIDENCE FLOOR, for the same reason lib/discoveryLocalMomentum has
 * one: a 100 % rejection rate over three attempts is one bad minute, not a
 * rollout signal, and a stop that fires on noise is a stop that gets disabled.
 */
import { logger } from "./logger.js";

/** `12`'s seven, in the specification's own order. */
export const STOP_CONDITIONS = [
  "event_rejection_rate",
  "recommendation_logging_gap",
  "creator_concentration",
  "reports_hides",
  "cache_bypass",
  "rls_leak",
  "attribution_double_count",
] as const;

export type DiscoveryStopCondition = (typeof STOP_CONDITIONS)[number];

/** Conditions with no producer, derived from STOP_CONDITION_PRODUCERS (foot of file). Each would need a named reason there. */
export const STOP_CONDITIONS_WITHOUT_PRODUCER: readonly DiscoveryStopCondition[] = STOP_CONDITIONS.filter(
  // A hoisted function declaration: the registry lives at the foot of the file
  // with the producers it names, and a `const` there would still be in its
  // temporal dead zone when this line runs at module load.
  (c) => !("producer" in stopConditionProducers()[c]),
);


/** How far back evidence counts. Long enough to be a rate, short enough to recover from. */
export const STOP_WINDOW_MS = 10 * 60_000;
/** Attempts below which no rate is trusted. */
export const STOP_MIN_SAMPLE = 20;
/**
 * Rejection rate that halts a rollout.
 *
 * 5 %: the healthy value is 0 — a serve-log insert is a plain insert against a
 * table whose constraints the writer already satisfies, so any sustained
 * rejection is a real fault. The threshold is a noise margin, not a budget, and
 * it is UNRATIFIED: a lane's proposal (§12.5), not an owner ruling (§54).
 */
export const EVENT_REJECTION_RATE_THRESHOLD = 0.05;
/**
 * Fraction of served items that may fail to become an event row.
 *
 * 10 %, looser than the rejection threshold on purpose: this number also absorbs
 * legitimate partial states (a batch whose flag flipped mid-window), and a
 * logging gap is a measurement problem rather than a user-facing one.
 */
export const LOGGING_GAP_THRESHOLD = 0.10;

/** Bound on remembered attempts. A ring, so memory is flat under any traffic. */
const RING_SIZE = 512;

export type ServeLogOutcome = "landed" | "rejected" | "threw";

interface Attempt {
  at: number;
  outcome: ServeLogOutcome;
  servedItems: number;
  landedRows: number;
}

const _ring: Attempt[] = [];
let _next = 0;

/** Test hook: forget every recorded attempt. */
export function _resetStopConditionsForTest(): void {
  _ring.length = 0;
  _next = 0; _resetExtendedStopState();  // the obligation ring and the database measurements (foot of file)
}

/**
 * Record one serve-log insert attempt.
 *
 * Called ONLY when the writer actually attempted an insert. A serve that wrote
 * nothing because the flag was off is not a gap — it is the flag doing its job —
 * and counting it would make the stop trip hardest precisely when the feature is
 * disabled.
 *
 * Never throws: this sits on a fire-and-forget path and must not be able to
 * damage a response that has already been sent.
 */
export function recordServeLogOutcome(
  a: { outcome: ServeLogOutcome; servedItems: number; landedRows?: number },
  nowMs: number = Date.now(),
): void {
  try {
    const entry: Attempt = {
      at: nowMs,
      outcome: a.outcome,
      servedItems: Math.max(0, a.servedItems | 0),
      landedRows: Math.max(0, (a.landedRows ?? (a.outcome === "landed" ? a.servedItems : 0)) | 0),
    };
    if (_ring.length < RING_SIZE) _ring.push(entry);
    else { _ring[_next] = entry; _next = (_next + 1) % RING_SIZE; }
  } catch {
    /* an instrument must never break the thing it instruments */
  }
}

export interface StopConditionVerdict {
  /** Conditions that fired. Only a condition with a ruling in effect can appear here. */
  tripped: DiscoveryStopCondition[];
  /** Conditions this evaluation could NOT trip — no ruling in effect — by name. Always present. */
  unenforced: readonly DiscoveryStopCondition[];
  /** Attempts inside the window. Below STOP_MIN_SAMPLE nothing can trip. */
  attempts: number;
  eventRejectionRate: number;
  loggingGapRate: number;
}

/**
 * Evaluate the window. Pure with respect to everything but the ring and the
 * clock; never throws; returns an all-clear rather than a trip on any internal
 * problem, because a stop that fires on its own bug takes the surface down.
 */
export function evaluateStopConditions(nowMs: number = Date.now(), opts: StopEvaluationOptions = {}): StopConditionVerdict {
  const rulings = effectiveRulings(opts.rulings);
  const base: StopConditionVerdict = {
    tripped: [],
    unenforced: unenforcedUnder(rulings),
    attempts: 0,
    eventRejectionRate: 0,
    loggingGapRate: 0,
    readings: silentReadings(rulings),
  };
  try {
    const since = nowMs - STOP_WINDOW_MS;
    let attempts = 0, bad = 0, served = 0, landed = 0;
    for (const e of _ring) {
      if (!e || e.at < since || e.at > nowMs) continue;
      attempts += 1;
      if (e.outcome !== "landed") bad += 1;
      served += e.servedItems;
      landed += Math.min(e.landedRows, e.servedItems);
    }
    const eventRejectionRate = attempts === 0 ? 0 : bad / attempts;
    const loggingGapRate = attempts === 0 || served === 0 ? 0 : Math.max(0, (served - landed) / served);

    const readings = { ...base.readings } as Record<DiscoveryStopCondition, StopConditionReading>;
    readings.event_rejection_rate = judge("event_rejection_rate", attempts === 0 ? null : eventRejectionRate, attempts, rulings);
    readings.recommendation_logging_gap = judge("recommendation_logging_gap", attempts === 0 ? null : loggingGapRate, attempts, rulings);
    readings.cache_bypass = judgeObligations(since, nowMs, rulings);
    for (const c of DATABASE_MEASURED) readings[c] = judgeMeasurement(c, nowMs, rulings);

    const tripped = STOP_CONDITIONS.filter((c) => readings[c].state === "tripped" || haltsOnUnreadable(readings[c], rulings[c]));  // §82 D-W10-O-2: armed, "cannot read" halts
    return { ...base, tripped, attempts, eventRejectionRate, loggingGapRate, readings };
  } catch (err) {
    logger.warn({ err }, "discoveryStopConditions: evaluation threw — reporting all-clear rather than halting on our own bug");
    return base;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// census-discovery DV-82 / §54 — producers for all seven, rulings for none new.
//
// Everything below was APPENDED rather than edited into the body above, because
// census-discovery cites this file by line (`:101`, `:121`, `:197`) and a line
// inserted above a cited one silently repoints the citation.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Who decided a threshold. `unratified_proposal` is the honest label for the two
 * values above: a lane proposed them (§12.5) and no owner has ruled on them. It
 * does not stop them tripping — they were enforced before §54 and removing an
 * enforced stop is not this section's call — but it travels with every reading
 * so nobody quotes 5 % as policy.
 */
export type StopRulingStatus = "owner_ruled" | "unratified_proposal" | "delegated_decision";  // §82: `delegated_decision` = decided under the owner's 2026-09-28 delegation (register D-W10-O-1), armed only by 3470

export interface StopRuling {
  /** The measured value ABOVE which the condition trips. Every measure here is higher-is-worse. */
  threshold: number;
  /** Sample below which no value is trusted. */
  minSample: number;
  status: StopRulingStatus;
  /** Where the number came from, in words a reviewer can check. */
  source: string;
}

/**
 * The rulings in effect. `null` means NO RULING: the condition is measured and
 * reported, and it cannot trip. There is deliberately no fallback value — `12`
 * says "spikes", "increase materially", "reappears", "occur" and "double-counts",
 * and turning any of those words into a number is the owner's decision (§54).
 */
export const STOP_CONDITION_RULINGS: Readonly<Record<DiscoveryStopCondition, StopRuling | null>> = {
  event_rejection_rate: {
    threshold: EVENT_REJECTION_RATE_THRESHOLD, minSample: STOP_MIN_SAMPLE, status: "unratified_proposal",
    source: "census-discovery §12.5: a lane's proposal (5 %), enforced since; not an owner ruling",
  },
  recommendation_logging_gap: {
    threshold: LOGGING_GAP_THRESHOLD, minSample: STOP_MIN_SAMPLE, status: "unratified_proposal",
    source: "census-discovery §12.5: a lane's proposal (10 %), enforced since; not an owner ruling",
  },
  creator_concentration: null,
  reports_hides: null,
  cache_bypass: null,
  rls_leak: null,
  attribution_double_count: null,
};

/**
 * A producer: the function that records a condition's evidence, the file that
 * must CALL it for the evidence to exist, and whether that call is still a
 * pending hunk. `src/test/discoveryStopSevenConditions.test.ts` reads each
 * `feeds.file` and fails when a producer claims a call that is not there, or
 * denies one that is — so "has a producer" cannot drift from the code.
 */
export interface StopProducer {
  producer: { module: string; fn: string; measures: string };
  feeds: { file: string; call: string; hookPending: boolean };
}
export type StopProducerEntry = StopProducer | { reason: string };

function stopConditionProducers(): Readonly<Record<DiscoveryStopCondition, StopProducerEntry>> {
  return {
    event_rejection_rate: {
      producer: { module: "lib/discoveryStopConditions.ts", fn: "recordServeLogOutcome", measures: "serve-log insert attempts refused or thrown / attempts" },
      feeds: { file: "lib/discoveryServeLog.ts", call: "recordServeLogOutcome(", hookPending: false },
    },
    recommendation_logging_gap: {
      producer: { module: "lib/discoveryStopConditions.ts", fn: "recordServeLogOutcome", measures: "served items that never became a rank_events row / served items" },
      feeds: { file: "lib/discoveryServeLog.ts", call: "recordServeLogOutcome(", hookPending: false },
    },
    creator_concentration: {
      producer: { module: "lib/discoveryStopMeasurements.ts", fn: "refreshDiscoveryStopMeasurements", measures: "HHI of Discovery exposures across creators (discovery_places.submitted_by), coverage beside it" },
      feeds: { file: "lib/discoveryEngineMode.ts", call: "refreshDiscoveryStopMeasurements(", hookPending: false },
    },
    reports_hides: {
      producer: { module: "lib/discoveryStopMeasurements.ts", fn: "refreshDiscoveryStopMeasurements", measures: "(dismisses + place reports + Trail reports) / exposures in the window" },
      feeds: { file: "lib/discoveryEngineMode.ts", call: "refreshDiscoveryStopMeasurements(", hookPending: false },
    },
    cache_bypass: {
      producer: { module: "lib/discoveryStopConditions.ts", fn: "recordRankObligation", measures: "serves owed a rank (pde path, in cohort) served unranked from Cache A / serves owed a rank" },
      feeds: { file: "routes/discovery.ts", call: "recordRankObligation(", hookPending: false },
    },
    rls_leak: {
      producer: { module: "lib/discoveryStopMeasurements.ts", fn: "refreshDiscoveryStopMeasurements", measures: "catalogue deviations from 3390's declared posture on the sixteen Discovery tables" },
      feeds: { file: "lib/discoveryEngineMode.ts", call: "refreshDiscoveryStopMeasurements(", hookPending: false },
    },
    attribution_double_count: {
      producer: { module: "lib/discoveryStopMeasurements.ts", fn: "refreshDiscoveryStopMeasurements", measures: "groups of live attributions crediting one beneficiary twice for one value event" },
      feeds: { file: "lib/discoveryEngineMode.ts", call: "refreshDiscoveryStopMeasurements(", hookPending: false },
    },
  };
}

/** `12`'s seven, each with its producer or the named reason it has none. */
export const STOP_CONDITION_PRODUCERS: Readonly<Record<DiscoveryStopCondition, StopProducerEntry>> = stopConditionProducers();

/** What one evaluation says about one condition. */
export type StopReadingState =
  | "tripped"                // a ruling is in effect and the measured value is above it
  | "clear"                  // a ruling is in effect and the value is at or below it
  | "unruled"                // measured, and NO ruling exists — reported, never tripped
  | "insufficient_evidence"  // a ruling exists but the sample is below its floor
  | "no_evidence"            // nothing measured in the window (or never measured)
  | "stale"                  // the last measurement is older than the window
  | "unreadable"             // the measurement's read failed — NOT clear
  | "input_absent";          // the input relation does not exist on this database

export interface StopConditionReading {
  state: StopReadingState;
  /** The measured value, whether or not anything can trip on it. */
  measured: number | null;
  sample: number | null;
  threshold: number | null;
  ruling: StopRulingStatus | null;
  detail?: Readonly<Record<string, unknown>>;
}

export interface StopConditionVerdict {
  /** Every condition's reading, including the ones that cannot trip. */
  readings: Readonly<Record<DiscoveryStopCondition, StopConditionReading>>;
}

export interface StopEvaluationOptions {
  /**
   * Rulings to evaluate under, merged over STOP_CONDITION_RULINGS. The resolver
   * never passes this; tests do, to show a condition trips once a ruling exists.
   */
  rulings?: Partial<Record<DiscoveryStopCondition, StopRuling | null>>;
}

/** The four conditions whose evidence is read from the database (3391). */
export const DATABASE_MEASURED = ["creator_concentration", "reports_hides", "rls_leak", "attribution_double_count"] as const;
export type DatabaseMeasuredCondition = (typeof DATABASE_MEASURED)[number];

/** One database measurement, as recorded by lib/discoveryStopMeasurements.ts. */
export interface StopMeasurement {
  state: "measured" | "unreadable" | "input_absent";
  /** The value a ruling would be compared with; null when there was nothing to measure. */
  value: number | null;
  /** How much evidence the value rests on (exposures, attributions, 1 for a catalogue read). */
  sample: number;
  /** Epoch ms the measurement was taken. */
  at: number;
  detail?: Readonly<Record<string, unknown>>;
}

const _measurements = new Map<DatabaseMeasuredCondition, StopMeasurement>();

/**
 * Record a database measurement. Never throws. An unknown condition is ignored
 * rather than stored, so a caller cannot invent an eighth.
 */
export function recordStopMeasurement(condition: DatabaseMeasuredCondition, m: StopMeasurement): void {
  try {
    if (!(DATABASE_MEASURED as readonly string[]).includes(condition)) return;
    _measurements.set(condition, { ...m });
  } catch {
    /* an instrument must never break the thing it instruments */
  }
}

interface Obligation { at: number; bypassed: boolean }
const _obligations: Obligation[] = [];
let _obligationNext = 0;

/**
 * Record one serve's ranking obligation — `12`'s "cache bypass reappears".
 *
 * `owed` is true exactly when the resolved path was `pde` AND the viewer was in
 * the cohort, i.e. when routes/discovery.ts is obliged to rank the Cache A
 * candidates for this viewer (`01` §7: a user-independent candidate cache "must
 * never bypass personalization/ranking"). `ranked` is whether it did. A serve
 * that owed nothing is not recorded: an out-of-cohort viewer served the legacy
 * order is the cohort working, not a bypass.
 *
 * Cache B hits are NOT obligations: serve point 4 replays a ranker's stored
 * order, and its `row_revoked` refusal (census-discovery §47) re-ranks — that
 * refusal is the guard working, and counting it would trip on moderation.
 */
export function recordRankObligation(o: { owed: boolean; ranked: boolean }, nowMs: number = Date.now()): void {
  try {
    if (!o || o.owed !== true) return;
    const entry: Obligation = { at: nowMs, bypassed: o.ranked !== true };
    if (_obligations.length < RING_SIZE) _obligations.push(entry);
    else { _obligations[_obligationNext] = entry; _obligationNext = (_obligationNext + 1) % RING_SIZE; }
  } catch {
    /* an instrument must never break the thing it instruments */
  }
}

/** A snapshot of the database measurements, for tests and diagnostics. */
export function stopMeasurementsSnapshot(): ReadonlyMap<DatabaseMeasuredCondition, StopMeasurement> {
  return new Map(_measurements);
}

function _resetExtendedStopState(): void {
  _measurements.clear(); _stopEnforcement = "disarmed";  // §82: a reset disarms
  _obligations.length = 0;
  _obligationNext = 0;
}

function effectiveRulings(
  over: Partial<Record<DiscoveryStopCondition, StopRuling | null>> | undefined,
): Record<DiscoveryStopCondition, StopRuling | null> {
  const out = { ...(stopEnforcementArmed() ? ARMED_STOP_CONDITION_RULINGS : STOP_CONDITION_RULINGS) } as Record<DiscoveryStopCondition, StopRuling | null>;  // §82: flag OFF ⇒ exactly the table above
  if (over) for (const c of STOP_CONDITIONS) if (c in over) out[c] = over[c] ?? null;
  return out;
}

function unenforcedUnder(rulings: Record<DiscoveryStopCondition, StopRuling | null>): readonly DiscoveryStopCondition[] {
  return STOP_CONDITIONS.filter((c) => rulings[c] === null);
}

function silentReadings(rulings: Record<DiscoveryStopCondition, StopRuling | null>): Record<DiscoveryStopCondition, StopConditionReading> {
  const out = {} as Record<DiscoveryStopCondition, StopConditionReading>;
  for (const c of STOP_CONDITIONS) {
    out[c] = { state: "no_evidence", measured: null, sample: null, threshold: rulings[c]?.threshold ?? null, ruling: rulings[c]?.status ?? null };
  }
  return out;
}

/**
 * The one rule every condition is judged by. No evidence is not clear; no
 * ruling is not a default; a thin sample is not a verdict.
 */
function judge(
  c: DiscoveryStopCondition,
  value: number | null,
  sample: number,
  rulings: Record<DiscoveryStopCondition, StopRuling | null>,
  detail?: Readonly<Record<string, unknown>>,
): StopConditionReading {
  const r = rulings[c];
  const common = { measured: value, sample, threshold: r?.threshold ?? null, ruling: r?.status ?? null, ...(detail ? { detail } : {}) };
  if (value === null || !Number.isFinite(value)) return { ...common, measured: null, state: "no_evidence" };
  if (r === null) return { ...common, state: "unruled" };
  if (sample < r.minSample) return { ...common, state: "insufficient_evidence" };
  return { ...common, state: value > r.threshold ? "tripped" : "clear" };
}

function judgeObligations(
  since: number, nowMs: number, rulings: Record<DiscoveryStopCondition, StopRuling | null>,
): StopConditionReading {
  let owed = 0, bypassed = 0;
  for (const o of _obligations) {
    if (!o || o.at < since || o.at > nowMs) continue;
    owed += 1;
    if (o.bypassed) bypassed += 1;
  }
  return judge("cache_bypass", owed === 0 ? null : bypassed / owed, owed, rulings, { owed, bypassed });
}

function judgeMeasurement(
  c: DatabaseMeasuredCondition, nowMs: number, rulings: Record<DiscoveryStopCondition, StopRuling | null>,
): StopConditionReading {
  const m = _measurements.get(c);
  const r = rulings[c];
  const idle = { measured: null, sample: null, threshold: r?.threshold ?? null, ruling: r?.status ?? null };
  if (!m) return { ...idle, state: "no_evidence" };
  const withDetail = m.detail ? { detail: m.detail } : {};
  if (nowMs - m.at > STOP_WINDOW_MS || m.at > nowMs) return { ...idle, measured: m.value, state: "stale", ...withDetail };
  if (m.state === "unreadable") return { ...idle, state: "unreadable", ...withDetail };
  if (m.state === "input_absent") return { ...idle, state: "input_absent", ...withDetail };
  return judge(c, m.value, m.sample, rulings, m.detail);
}

// ═════════════════════════════════════════════════════════════════════════════
// census-discovery §82 (lane W10-O) — DV-82 / DC-32: the seven halt values,
// DECIDED, and ARMED only by a flag seeded FALSE.
//
// APPENDED, for the same reason as the block above: the census cites this file
// by line (:101, :121, :197, :276, :296, :415). Four existing lines were edited
// IN PLACE (the tripped filter, the status union, effectiveRulings and the
// reset); no line above moved.
//
// WHAT WAS DECIDED (docs/architecture/discovery-decision-register.md, D-W10-O-1
// and D-W10-O-2, under the owner's 2026-09-28 delegation of routine product
// decisions). `12` gives words, not numbers: "rises", "appear", "spikes",
// "increase materially", "reappears", "occur", "double-counts". No spec, and no
// ROADMAP step, gives a number for any of them. So each value below is a
// CONSERVATIVE choice, and "conservative" has one meaning here: a trip can only
// ever move a request to `legacy` — what production already serves — so the
// cost of a false halt is a paused rollout, and the cost of a missed halt is a
// user-facing defect. When in doubt, halt.
//
//   event_rejection_rate       > 5 % of ≥ 20 serve-log insert attempts. The
//                              healthy value is 0; kept (§12.5's value).
//   recommendation_logging_gap > 10 % of served items over ≥ 20 attempts. Kept.
//   creator_concentration      HHI > 0.25 over ≥ 100 resolved exposures: more
//                              concentrated than four creators sharing the page
//                              equally. 0.25 is the classic "highly
//                              concentrated" line for an HHI on the 0–1 scale.
//   reports_hides              (dismisses + reports) / exposures > 5 % over
//                              ≥ 100 exposures.
//   cache_bypass               ANY bypass: "reappears" names an event, not a
//                              rate. One owed rank served unranked halts.
//   rls_leak                   ANY deviation from 3390's posture: "occur".
//   attribution_double_count   ANY live double count: "double-counts".
//   unreadable                 armed, a database measurement that cannot be
//                              read halts too (D-W10-O-2). Arming is only
//                              recommended with 3391 applied (APPROVAL REQUIRED,
//                              D-W10-O-3), so "unreadable" then means a real
//                              failure, not a missing function.
//
// One window for all seven: STOP_WINDOW_MS (10 min). Evidence ages out, so a
// halt recovers on its own once the cause is gone.
//
// ARMING IS PRODUCTION ACTIVATION, SO IT IS A FLAG. `discovery_stop_enforcement_enabled`
// (migration 3470) is seeded FALSE and never turned on by this lane. OFF,
// absent or unreadable, the evaluator uses STOP_CONDITION_RULINGS exactly as
// before (src/test/discoveryStopEnforcement.test.ts G2 pins two goldens
// captured before this edit). ON, it uses ARMED_STOP_CONDITION_RULINGS.
//
// THE CALLER. The flag is read by `refreshStopEnforcement`, called from
// `refreshDiscoveryStopMeasurements` — the refresh the engine-mode resolver
// already runs (not awaited) on every uncached non-legacy resolution. So the
// arming state follows the flag within one resolver cache period, and a
// legacy deployment never reads it (legacy has nothing to halt).
// ═════════════════════════════════════════════════════════════════════════════
import { getFlagRow } from "./featureFlags.js";

/** The arming flag (3470), seeded FALSE. `*_enabled` ⇒ CAPABILITY: read fail-closed via getFlagRow. */
export const STOP_ENFORCEMENT_FLAG = "discovery_stop_enforcement_enabled";

/**
 * The version of the decided table below. Arming requires the flag row to be
 * TRUE **and** its `metadata.values_version` to name exactly this string, so an
 * approval arms the values it approved and nothing else: change any value and
 * bump this, and a flag armed for the old values reads DISARMED until someone
 * approves the new ones (register D-W10-O-3). It also means a row that merely
 * reads `enabled: true` — a stub, a copy-pasted row — never arms anything.
 */
export const STOP_ENFORCEMENT_VALUES_VERSION = "stop-values-2026-09-28.1";

/** Creator concentration: HHI of Discovery exposures across creators above which the rollout halts. */
export const CREATOR_CONCENTRATION_HHI_THRESHOLD = 0.25;
/** …over at least this many exposures whose creator resolved. */
export const CREATOR_CONCENTRATION_MIN_RESOLVED = 100;
/** Reports and hides: (dismisses + place reports + Trail reports) / exposures above which the rollout halts. */
export const REPORTS_HIDES_RATE_THRESHOLD = 0.05;
/** …over at least this many exposures. */
export const REPORTS_HIDES_MIN_EXPOSURES = 100;
/** Cache bypass: the share of owed ranks served unranked above which the rollout halts. 0 ⇒ any bypass. */
export const CACHE_BYPASS_SHARE_THRESHOLD = 0;
/** …over at least this many owed ranks (one is enough: a bypass is an event). */
export const CACHE_BYPASS_MIN_OBLIGATIONS = 1;
/** RLS: posture deviations above which the rollout halts. 0 ⇒ any deviation. */
export const RLS_LEAK_DEVIATION_THRESHOLD = 0;
/** …from one catalogue read. */
export const RLS_LEAK_MIN_SAMPLE = 1;
/** Attribution: live double-count groups above which the rollout halts. 0 ⇒ any. */
export const ATTRIBUTION_DOUBLE_COUNT_THRESHOLD = 0;
/** …over at least one attribution in the window. */
export const ATTRIBUTION_DOUBLE_COUNT_MIN_SAMPLE = 1;
/** Armed, does an `unreadable` database measurement halt? (D-W10-O-2) */
export const STOP_UNREADABLE_HALTS_WHEN_ARMED = true;

const DECIDED = "census-discovery §82, register D-W10-O-1 (decided under the owner's 2026-09-28 delegation; armed only by 3470)";

/** The rulings in effect when `discovery_stop_enforcement_enabled` is ON. All seven. */
export const ARMED_STOP_CONDITION_RULINGS: Readonly<Record<DiscoveryStopCondition, StopRuling>> = {
  event_rejection_rate:       { threshold: EVENT_REJECTION_RATE_THRESHOLD, minSample: STOP_MIN_SAMPLE, status: "delegated_decision", source: `${DECIDED}: §12.5's 5 % kept`, haltOnUnreadable: false },
  recommendation_logging_gap: { threshold: LOGGING_GAP_THRESHOLD, minSample: STOP_MIN_SAMPLE, status: "delegated_decision", source: `${DECIDED}: §12.5's 10 % kept`, haltOnUnreadable: false },
  creator_concentration:      { threshold: CREATOR_CONCENTRATION_HHI_THRESHOLD, minSample: CREATOR_CONCENTRATION_MIN_RESOLVED, status: "delegated_decision", source: `${DECIDED}: HHI > 0.25 over >= 100 resolved exposures`, haltOnUnreadable: STOP_UNREADABLE_HALTS_WHEN_ARMED },
  reports_hides:              { threshold: REPORTS_HIDES_RATE_THRESHOLD, minSample: REPORTS_HIDES_MIN_EXPOSURES, status: "delegated_decision", source: `${DECIDED}: > 5 % of >= 100 exposures`, haltOnUnreadable: STOP_UNREADABLE_HALTS_WHEN_ARMED },
  cache_bypass:               { threshold: CACHE_BYPASS_SHARE_THRESHOLD, minSample: CACHE_BYPASS_MIN_OBLIGATIONS, status: "delegated_decision", source: `${DECIDED}: any bypass`, haltOnUnreadable: false },
  rls_leak:                   { threshold: RLS_LEAK_DEVIATION_THRESHOLD, minSample: RLS_LEAK_MIN_SAMPLE, status: "delegated_decision", source: `${DECIDED}: any deviation`, haltOnUnreadable: STOP_UNREADABLE_HALTS_WHEN_ARMED },
  attribution_double_count:   { threshold: ATTRIBUTION_DOUBLE_COUNT_THRESHOLD, minSample: ATTRIBUTION_DOUBLE_COUNT_MIN_SAMPLE, status: "delegated_decision", source: `${DECIDED}: any live double count`, haltOnUnreadable: STOP_UNREADABLE_HALTS_WHEN_ARMED },
};

// Declaration merging (same module): a ruling may say that "cannot read" halts.
// Absent — as on every flag-off ruling — it does not, exactly as before.
export interface StopRuling {
  /** When true, an `unreadable` reading of this condition trips (D-W10-O-2). */
  haltOnUnreadable?: boolean;
}

/** Where this process believes the arming flag stands. Unknown and failed reads are DISARMED. */
let _stopEnforcement: "armed" | "disarmed" = "disarmed";

/** Is the decided table in force in this process? */
export function stopEnforcementArmed(): boolean {
  return _stopEnforcement === "armed";
}

/**
 * Read `discovery_stop_enforcement_enabled` and arm or disarm. Armed only when
 * the row is TRUE and names STOP_ENFORCEMENT_VALUES_VERSION. Fail-closed:
 * FALSE, absent, another values version, an error, a throw and no client all
 * DISARM, which is the pre-§82 behaviour. Never throws.
 */
export async function refreshStopEnforcement(sc: unknown): Promise<void> {
  try {
    const row = sc ? await getFlagRow(sc, STOP_ENFORCEMENT_FLAG) : null;
    const armed = row?.enabled === true && row.metadata?.["values_version"] === STOP_ENFORCEMENT_VALUES_VERSION;
    _stopEnforcement = armed ? "armed" : "disarmed";
  } catch {
    _stopEnforcement = "disarmed";
  }
}

function haltsOnUnreadable(reading: StopConditionReading, ruling: StopRuling | null): boolean {
  return reading.state === "unreadable" && ruling?.haltOnUnreadable === true;
}
