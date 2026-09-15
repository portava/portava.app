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
 * TWO OF THE SEVEN ARE ENFORCED. THE OTHER FIVE ARE NAMED, NOT FAKED.
 * ==================================================================
 * `STOP_CONDITIONS_WITHOUT_PRODUCER` lists the five whose input does not exist
 * inside Discovery's own instruments today, and every evaluation carries that
 * list in `unenforced` so a clean result can never be read as "all seven are
 * fine". A stop condition wired to an input that does not exist is worse than no
 * stop condition: it can never trip, and it looks exactly like one that works.
 *
 *   creator_concentration      A served `DiscoveryPlace` carries no author, so a
 *                              served page cannot be measured for creator
 *                              concentration at all (census-discovery DV-79).
 *   reports_hides              Reports and hides are written on other surfaces'
 *                              routes; Discovery has no counter to threshold.
 *   cache_bypass               The regression test exists (§11.8 / §12.2) and is
 *                              a BUILD-time guard. A RUNTIME detector needs a
 *                              per-serve record of "a ranker should have run and
 *                              did not", which the serve log's `rankedInRequest`
 *                              could feed once the ranked path actually executes
 *                              in a deployment — today it never does (DV-47).
 *   rls_leak                   Detecting a leak needs a catalogue read, not a
 *                              request-path counter.
 *   attribution_double_count   No attribution subsystem exists (DV-56…DV-69).
 *
 * THE TWO THAT ARE ENFORCED, AND HOW THEY DIFFER
 * ==============================================
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
 * The window is a bounded ring in this process. It is deliberately NOT a durable
 * store: a stop condition that needs a healthy database to read is unavailable
 * exactly when it is needed. The consequences are stated rather than hidden —
 * each instance decides for itself, a restart clears the evidence, and an
 * instance serving no Discovery traffic never trips. Evidence ages out of the
 * window, so a stop RECOVERS; a stop that never recovers is an outage wearing a
 * guardrail's name.
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

/** The five with no producer in Discovery's own instruments. Never trip; named so the absence is checkable. */
export const STOP_CONDITIONS_WITHOUT_PRODUCER: readonly DiscoveryStopCondition[] = [
  "creator_concentration",
  "reports_hides",
  "cache_bypass",
  "rls_leak",
  "attribution_double_count",
];

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
 * it is the number an owner should argue with first.
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
  _next = 0;
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
  /** Conditions that fired. Only ever a subset of the two with producers. */
  tripped: DiscoveryStopCondition[];
  /** Conditions this evaluation did NOT check, by name. Always present. */
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
export function evaluateStopConditions(nowMs: number = Date.now()): StopConditionVerdict {
  const base: StopConditionVerdict = {
    tripped: [],
    unenforced: STOP_CONDITIONS_WITHOUT_PRODUCER,
    attempts: 0,
    eventRejectionRate: 0,
    loggingGapRate: 0,
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
    if (attempts === 0) return base;

    const eventRejectionRate = bad / attempts;
    const loggingGapRate = served === 0 ? 0 : Math.max(0, (served - landed) / served);
    const tripped: DiscoveryStopCondition[] = [];
    if (attempts >= STOP_MIN_SAMPLE) {
      if (eventRejectionRate > EVENT_REJECTION_RATE_THRESHOLD) tripped.push("event_rejection_rate");
      if (loggingGapRate > LOGGING_GAP_THRESHOLD) tripped.push("recommendation_logging_gap");
    }
    return { ...base, tripped, attempts, eventRejectionRate, loggingGapRate };
  } catch (err) {
    logger.warn({ err }, "discoveryStopConditions: evaluation threw — reporting all-clear rather than halting on our own bug");
    return base;
  }
}
