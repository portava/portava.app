/**
 * layoverLiveSignals — THE LIVE-SIGNAL PRODUCER. Lane B2-LIVE, Layover 165.
 *
 * Census L54, L55, L81, L180, L227, L228, L281, L285, L286, L287 all rested on
 * one fact: `LayoverAirportTruth.liveConditionsFrom` is the only emitter of
 * SECURITY_WAIT_HIGH / DATA_STALE / SOURCE_CONFLICT / TRAFFIC_DEGRADED and the
 * only live term in an Estimate, and NOTHING in production produced its input.
 * Every session ran `liveConditions = null`. This module is that producer.
 *
 * OWNER DECISION 2026-10-18 (verbatim): "Use a combination of: Official airport
 * information; Licensed or approved live feeds; Verified traveler observations;
 * Confidence calculations; Data provenance; Freshness checks; Conflict
 * resolution; Trust weighting; Outlier detection. Traveler reports are
 * supporting evidence, not authoritative proof of safety. Unknown or
 * conflicting critical safety information must fail closed."
 *
 * ── THE SOURCES ──────────────────────────────────────────────────────────────
 *   official / feed   `official` and `operator_feed` readings — stored in
 *                     `airport_fact_observations` (2860) or read live through
 *                     the feed adapter (layoverLiveFeed.ts; no feed is
 *                     connected, a named absence).
 *   traveller         `community` readings, i.e. the crowd reports
 *                     `POST /observations` stores (3513's channel). The
 *                     traveller vocabulary says WHICH queue no more precisely
 *                     than "the line you are standing in" / "how long did
 *                     security or immigration take", so both facts are filed
 *                     under the RETURN-SIDE SECURITY term — the one checkpoint
 *                     every landside return crosses (App A SECURITY_WAIT_HIGH:
 *                     "Return-side security time materially constrains plan").
 *                     Filing the same reading under immigration as well would
 *                     count one queue twice.
 *   official baseline `airport_profiles` and the declared baselines
 *                     (SECURITY_/IMMIGRATION_WAIT_BASELINE_MIN,
 *                     TAXI_QUEUE_BASELINE_MIN; the airport's traffic term) are
 *                     what the static buffer already covers. A live term is the
 *                     DEVIATION above them, never a discount below.
 *   traffic           the routing lane's measured return leg
 *                     (layoverLiveTraffic.ts).
 *
 * ── THE RULES, EACH ONE A TEST ───────────────────────────────────────────────
 *   VALIDATION (L180)  every stored or fed reading passes
 *                      `validateObservationWindow`: plausibility, freshness,
 *                      trust floor, one reading per reporter, MAD outliers,
 *                      independent reporters.
 *   MORE CONSERVATIVE ONLY  traveller evidence may raise a wait, contract an
 *                      envelope and move a deadline earlier; it can never
 *                      shorten a wait (every percentile is floored at the
 *                      longest authoritative reading) and never proves safety
 *                      (its confidence is never above LOW, and a traveller-only
 *                      term that would add nothing is not folded at all).
 *   DISTRIBUTION (L54) per term, p50 / p75 / p90 over the validated readings by
 *                      linear interpolation; with thin evidence (fewer than
 *                      MIN_DISTRIBUTION_READINGS independent readings) the p90
 *                      is the MAXIMUM — there is no population to take a 90th
 *                      percentile of, and the sample maximum is the bound that
 *                      cannot under-state it.
 *   PERCENTILE (L55)   the minutes a term adds are taken at
 *                      `LIVE_PERCENTILE_POLICY[consequence][maturity]`. Every
 *                      buffer term protects the flight, so the deadline reads
 *                      the `flight` row: p90 (the maximum, when thin).
 *   CONFLICT (L286)    distinct authoritative observers, and the crowd's median,
 *                      are SOURCES; when they disagree by more than the fact's
 *                      tolerance the term is flagged — SOURCE_CONFLICT — the
 *                      conservative value stands and confidence steps down.
 *   STALENESS (L285)   a term with no fresh evidence but evidence that expired
 *                      within STALE_HOLD_MIN is HELD at its conservative value,
 *                      flagged DATA_STALE, confidence at most LOW. A configured
 *                      feed or a store that cannot be read is DATA_STALE too.
 *                      Never fabricated freshness; never a silent widening.
 *   FAIL CLOSED        a severe disruption from an authoritative source (level
 *                      >= SEVERE_DISRUPTION_LEVEL), whose minutes no source
 *                      states, makes the live estimate INSUFFICIENT — the record
 *                      folds it, and an INSUFFICIENT window plans nothing
 *                      landside (LayoverEnvelope ENVELOPE_UNCERTAINTY_BUDGET).
 *
 * ── THE SWITCH ───────────────────────────────────────────────────────────────
 * `layover_live_signals_enabled` (migration 3885, seeded FALSE), read with
 * `isFlagEnabled` — off, absent and unreadable all answer null, and a null is
 * exactly today's computation. A null is also the answer when nothing live
 * exists, so with the flag ON a session at an airport nobody has reported on
 * certifies byte-for-byte as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import {
  CONFLICT_TOLERANCE_MIN,
  FACT_CLASS_TTL_MIN,
  IMMIGRATION_WAIT_BASELINE_MIN,
  SECURITY_WAIT_BASELINE_MIN,
  TAXI_QUEUE_BASELINE_MIN,
  MIN_INDEPENDENT_REPORTERS,
  factClassOf,
  liveConditionsFrom,
  medianOf,
  readStoredObservations,
  validateObservationWindow,
  type AirportFactType,
  type AirportObservation,
  type ObserverKind,
  type ScreenedObservation,
  type TruthValue,
} from "./LayoverAirportTruth.js";
import type { EstimateConfidence, EstimatePercentile } from "./LayoverFeasibility.js";
import type { LayoverReasonCode, LiveConditions, LiveConditionsEstimate } from "./LayoverSafetyEngine.js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { configuredLiveFeed, type LayoverLiveFeedAdapter, type LiveFeedRead } from "./layoverLiveFeed.js";
import { readReturnTrafficSignal, type TrafficSignal, type TrafficSignalRead } from "./layoverLiveTraffic.js";
import type { RouteCorridorProvider } from "./LayoverReturnCorridor.js";
import { observationAirportRefOf } from "../layover/LayoverObservationService.js";

const logger = rootLogger.child({ service: "layoverLiveSignals" });

/** Migration 3885, seeded FALSE. Read with `isFlagEnabled` beside its literal (check:flag-polarity). */
export const LAYOVER_LIVE_SIGNALS_FLAG = "layover_live_signals_enabled";
/** Version of THIS module's policy; bump on any threshold or rule change. */
export const LIVE_SIGNALS_VERSION = "2026.10.18-1";
/** How long past its TTL a reading is HELD (DATA_STALE) rather than dropped. */
export const STALE_HOLD_MIN = 60;
/** Independent readings before a term's distribution is "established" rather than "thin". */
export const MIN_DISTRIBUTION_READINGS = 5;
/** An authoritative disruption level at or above this, with no minutes stated, fails the live estimate closed. */
export const SEVERE_DISRUPTION_LEVEL = 3;

// ── §6.2 L55: the configurable conservative percentile ──────────────────────

/** What a wrong figure costs. Every buffer term in the certified record is `flight`. */
export type LiveConsequence = "flight" | "activity" | "advisory";
/** How much evidence the distribution rests on. */
export type EvidenceMaturity = "thin" | "established";

/**
 * Spec §6.2: "Safety-critical calculations should use a configurable
 * conservative percentile based on data maturity and consequence."
 *
 * A table, not a branch, so changing the policy is one visible edit. The
 * `flight` row is the one the certified deadline reads; with thin evidence its
 * p90 is the sample maximum (see the header), so maturity moves the figure on
 * that row too. The other rows are the policy for consequences a missed
 * estimate costs less on; no production surface reads them yet.
 */
export const LIVE_PERCENTILE_POLICY: Readonly<Record<LiveConsequence, Readonly<Record<EvidenceMaturity, EstimatePercentile>>>> = Object.freeze({
  flight: Object.freeze({ thin: "p90", established: "p90" }),
  activity: Object.freeze({ thin: "p90", established: "p75" }),
  advisory: Object.freeze({ thin: "p75", established: "p50" }),
});

export function selectLivePercentile(
  consequence: LiveConsequence,
  maturity: EvidenceMaturity,
  policy: typeof LIVE_PERCENTILE_POLICY = LIVE_PERCENTILE_POLICY,
): EstimatePercentile {
  return policy[consequence][maturity];
}

/** Linear-interpolation percentile (Hyndman–Fan type 7) of a non-empty list. */
export function interpolatedPercentile(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const h = (s.length - 1) * (p / 100);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

export interface WaitDistribution {
  p50: number;
  p75: number;
  p90: number;
  maturity: EvidenceMaturity;
  /** The longest authoritative reading, which every percentile is floored at; null with none. */
  authoritativeFloor: number | null;
}

/**
 * p50 / p75 / p90 of a term's readings. Thin evidence's p90 is its maximum.
 * Every percentile is floored at the longest AUTHORITATIVE reading, so a crowd
 * of short traveller readings can never take a term below an official figure.
 */
export function waitDistribution(
  readings: ReadonlyArray<{ value: number; kind: ObserverKind }>,
): WaitDistribution | null {
  if (readings.length === 0) return null;
  const values = readings.map((r) => r.value);
  const authoritative = readings.filter((r) => r.kind !== "community").map((r) => r.value);
  const floor = authoritative.length ? Math.max(...authoritative) : null;
  const maturity: EvidenceMaturity = readings.length >= MIN_DISTRIBUTION_READINGS ? "established" : "thin";
  const at = (n: number) => (floor === null ? n : Math.max(floor, n));
  const p50 = at(interpolatedPercentile(values, 50));
  const p75 = at(interpolatedPercentile(values, 75));
  const p90 = at(maturity === "thin" ? Math.max(...values) : interpolatedPercentile(values, 90));
  return { p50, p75: Math.max(p50, p75), p90: Math.max(p50, p75, p90), maturity, authoritativeFloor: floor };
}

// ── the terms ────────────────────────────────────────────────────────────────

export type LiveTermKey = "securityWait" | "immigrationWait" | "taxiQueue";

/** Which stored/fed facts feed which buffer term. See "THE SOURCES". */
export const LIVE_TERM_FACTS: Readonly<Record<LiveTermKey, readonly AirportFactType[]>> = Object.freeze({
  securityWait: ["security_wait_minutes", "checkpoint_timing_minutes", "queue_report_minutes"],
  immigrationWait: ["immigration_wait_minutes"],
  taxiQueue: ["taxi_queue_minutes"],
});

/** The fact whose conflict tolerance a merged term is judged by. */
const TERM_FACT: Record<LiveTermKey, AirportFactType> = {
  securityWait: "security_wait_minutes",
  immigrationWait: "immigration_wait_minutes",
  taxiQueue: "taxi_queue_minutes",
};

/** The baseline the static buffer already covers, per term (LayoverAirportTruth's declared constants). */
export const LIVE_TERM_BASELINE_MIN: Readonly<Record<LiveTermKey, number>> = Object.freeze({
  securityWait: SECURITY_WAIT_BASELINE_MIN,
  immigrationWait: IMMIGRATION_WAIT_BASELINE_MIN,
  taxiQueue: TAXI_QUEUE_BASELINE_MIN,
});

const DISRUPTION_FACTS: readonly AirportFactType[] = ["disruption_level", "closure_reported"];

/** Every fact the producer reads from the store in its ONE query. */
export const LIVE_SIGNAL_FACT_TYPES: readonly AirportFactType[] = [
  ...new Set([...LIVE_TERM_FACTS.securityWait, ...LIVE_TERM_FACTS.immigrationWait, ...LIVE_TERM_FACTS.taxiQueue, ...DISRUPTION_FACTS]),
];

interface UsedReading {
  value: number;
  kind: ObserverKind;
  observerId: string;
  sourceRef: string;
  observedAt: string;
  expiresAt: string;
  weight: number;
  stale: boolean;
}

export interface LiveTermResult {
  term: LiveTermKey;
  /** The reconciled truth handed to `liveConditionsFrom` — its value is the SELECTED percentile of the wait. */
  truth: TruthValue<number>;
  distribution: WaitDistribution;
  percentile: EstimatePercentile;
  /** EXTRA minutes over the term's baseline at each percentile. */
  extra: { p50: number; p75: number; p90: number };
  readings: UsedReading[];
  stale: boolean;
  communityOnly: boolean;
  rulesApplied: string[];
}

const CONF = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"] as const satisfies readonly EstimateConfidence[];
function confIndex(c: EstimateConfidence): number { return CONF.indexOf(c); }
function stepDown(c: EstimateConfidence, steps = 1): EstimateConfidence { return CONF[Math.max(0, confIndex(c) - steps)]!; }
function capAt(c: EstimateConfidence, cap: EstimateConfidence): EstimateConfidence { return confIndex(c) > confIndex(cap) ? cap : c; }
function worst(cs: EstimateConfidence[]): EstimateConfidence { return cs.reduce((a, b) => (confIndex(b) < confIndex(a) ? b : a), "HIGH" as EstimateConfidence); }

function used(s: ScreenedObservation, stale: boolean): UsedReading {
  return {
    value: s.observation.value,
    kind: s.observation.observerKind,
    observerId: s.observation.observerId,
    sourceRef: s.observation.sourceRef,
    observedAt: s.observation.observedAt,
    expiresAt: s.expiresAt,
    weight: s.weight,
    stale,
  };
}

/**
 * The validated FRESH readings of one fact, and the validated picture of its
 * readings that went stale within the hold (validated as of the newest of
 * them, i.e. the last moment that picture was current).
 */
function freshAndStale(corpus: AirportObservation[], factType: AirportFactType, airportRef: string, nowMs: number) {
  const fresh = validateObservationWindow(corpus, { nowMs, factType, airportRef });
  const ttlMs = FACT_CLASS_TTL_MIN[factClassOf(factType)] * 60_000;
  const lapsed = corpus.filter((o) => {
    if (o.airportRef !== airportRef || o.factType !== factType) return false;
    const at = Date.parse(o.observedAt);
    return Number.isFinite(at) && at + ttlMs <= nowMs && at + ttlMs > nowMs - STALE_HOLD_MIN * 60_000;
  });
  const asOf = lapsed.length ? Math.max(...lapsed.map((o) => Date.parse(o.observedAt))) : null;
  const stale = asOf === null ? null : validateObservationWindow(lapsed, { nowMs: asOf, factType, airportRef });
  return { fresh: fresh.accepted, stale: stale ? stale.accepted : [], rules: [...fresh.rulesApplied, ...(stale ? stale.rulesApplied.map((r) => `stale picture: ${r}`) : [])] };
}

/** One reading per reporter across a term's facts: the newest, the longer on a tie. */
function onePerReporter(readings: UsedReading[]): UsedReading[] {
  const by = new Map<string, UsedReading>();
  for (const r of readings) {
    const prev = by.get(r.observerId);
    const t = Date.parse(r.observedAt);
    const pt = prev ? Date.parse(prev.observedAt) : -Infinity;
    if (!prev || t > pt || (t === pt && r.value > prev.value)) by.set(r.observerId, r);
  }
  return [...by.values()];
}

/**
 * One buffer term from the corpus. Pure. `null` when nothing credible exists
 * for it, or when the only evidence is traveller evidence that would add
 * nothing (it may only make the answer MORE conservative; a traveller-only
 * reading at or under the baseline is not folded, so it cannot read as
 * "a live source says the queue is fine").
 */
export function evaluateLiveTerm(
  corpus: AirportObservation[],
  term: LiveTermKey,
  opts: { nowMs: number; airportRef: string; consequence?: LiveConsequence; policy?: typeof LIVE_PERCENTILE_POLICY },
): LiveTermResult | null {
  const rulesApplied: string[] = [];
  const freshNC: UsedReading[] = []; const freshC: UsedReading[] = [];
  const staleNC: UsedReading[] = []; const staleC: UsedReading[] = [];
  for (const factType of LIVE_TERM_FACTS[term]) {
    const fs = freshAndStale(corpus, factType, opts.airportRef, opts.nowMs);
    rulesApplied.push(...fs.rules.map((r) => `${factType}: ${r}`));
    for (const s of fs.fresh) (s.observation.observerKind === "community" ? freshC : freshNC).push(used(s, false));
    for (const s of fs.stale) (s.observation.observerKind === "community" ? staleC : staleNC).push(used(s, true));
  }

  // Which evidence stands. Fresh evidence supersedes stale evidence — except
  // that a stale AUTHORITATIVE reading is still held under fresh TRAVELLER
  // readings: a crowd may raise an official figure, never retire it.
  let readings: UsedReading[];
  if (freshNC.length + freshC.length > 0) {
    readings = [...freshNC, ...freshC, ...(freshNC.length === 0 ? staleNC : [])];
  } else {
    readings = [...staleNC, ...staleC];
  }
  readings = onePerReporter(readings);
  // NO SECOND independent-reporter check here, deliberately: every fact a term
  // reads is SAFETY_CRITICAL (pinned by test), so `validateObservationWindow`'s
  // rule 5 has already required MIN_INDEPENDENT_REPORTERS distinct travellers
  // PER FACT, and a merge of facts that each have two can never have fewer. A
  // term-level copy was written and a mutation proved it unreachable.
  if (readings.length === 0) return null;

  const distribution = waitDistribution(readings)!;
  const percentile = selectLivePercentile(opts.consequence ?? "flight", distribution.maturity, opts.policy);
  const selected = distribution[percentile];
  const baseline = LIVE_TERM_BASELINE_MIN[term];
  const extraOf = (v: number) => Math.max(0, v - baseline);
  const extra = { p50: extraOf(distribution.p50), p75: extraOf(distribution.p75), p90: extraOf(distribution.p90) };
  const communityOnly = readings.every((r) => r.kind === "community");
  const stale = readings.some((r) => r.stale);

  // Sources: each authoritative observer, and the crowd as one source (its median).
  const sources = readings.filter((r) => r.kind !== "community").map((r) => r.value);
  const crowdNow = readings.filter((r) => r.kind === "community").map((r) => r.value);
  if (crowdNow.length) sources.push(medianOf(crowdNow)!);
  const tolerance = CONFLICT_TOLERANCE_MIN[TERM_FACT[term]];
  const conflict = sources.length >= 2 && Math.max(...sources) - Math.min(...sources) > tolerance;

  const bestWeight = Math.max(...readings.map((r) => r.weight));
  let confidence: EstimateConfidence = bestWeight >= 0.75 ? "HIGH" : bestWeight >= 0.45 ? "MEDIUM" : bestWeight > 0 ? "LOW" : "INSUFFICIENT";
  if (stale) confidence = capAt(confidence, "LOW"); // a reading held past its TTL is LOW at best, never better
  // Traveller-only evidence is never above LOW: not by a cap here (a mutation
  // proved one dead) but because a community reading weighs at most
  // OBSERVER_KIND_TRUST.community = 0.3, below MEDIUM's 0.45 — pinned by T2.
  if (conflict) confidence = stepDown(confidence);
  rulesApplied.push(`${term}: ${readings.length} reading(s), ${distribution.maturity}, ${percentile} = ${selected} min (baseline ${baseline})${conflict ? `, CONFLICT beyond ${tolerance} min` : ""}${stale ? ", HELD past TTL" : ""}`);

  if (communityOnly && extra[percentile] === 0) {
    rulesApplied.push(`${term}: traveller-only evidence adds nothing over the baseline — not folded`);
    return null;
  }

  const observedAts = readings.map((r) => r.observedAt).sort();
  const expiries = readings.map((r) => r.expiresAt).sort();
  const truth: TruthValue<number> = {
    value: selected,
    confidence,
    conflict,
    sourceClass: "LIVE",
    sourceRefs: readings.map((r) => r.sourceRef),
    observedAt: observedAts[0] ?? null,
    // The SOONEST expiry: a held reading's expiry is in the past, which is
    // exactly what makes `liveConditionsFrom` emit DATA_STALE.
    expiresAt: expiries[0] ?? null,
    fallbackLevel: stale ? 1 : 0,
  };
  return { term, truth, distribution, percentile, extra, readings, stale, communityOnly, rulesApplied };
}

export interface DisruptionResult {
  /** An authoritative disruption at or above SEVERE_DISRUPTION_LEVEL: minutes unknown, fail closed. */
  severe: boolean;
  /** Corroborated traveller closure reports (>= MIN_INDEPENDENT_REPORTERS distinct reporters). */
  closureCorroborated: boolean;
  sourceRefs: string[];
}

/** §10 "disruption": no source states its minutes, so it moves CONFIDENCE, never a fabricated figure. */
export function evaluateDisruption(corpus: AirportObservation[], opts: { nowMs: number; airportRef: string }): DisruptionResult | null {
  const levels = validateObservationWindow(corpus, { nowMs: opts.nowMs, factType: "disruption_level", airportRef: opts.airportRef }).accepted
    .filter((s) => s.observation.observerKind !== "community" && s.observation.value >= SEVERE_DISRUPTION_LEVEL);
  const closures = validateObservationWindow(corpus, { nowMs: opts.nowMs, factType: "closure_reported", airportRef: opts.airportRef }).accepted
    .filter((s) => s.observation.value >= 1);
  const closureReporters = new Set(closures.map((s) => s.observation.observerId)).size;
  const severe = levels.length > 0;
  const closureCorroborated = closureReporters >= MIN_INDEPENDENT_REPORTERS;
  if (!severe && !closureCorroborated) return null;
  return {
    severe,
    closureCorroborated,
    sourceRefs: [...levels.map((s) => s.observation.sourceRef), ...(closureCorroborated ? closures.map((s) => s.observation.sourceRef) : [])],
  };
}

export type LiveDegradation = "store_unreadable" | "feed_unavailable" | "plan_unreadable";

/**
 * Fold the terms into the ONE shape the engine accepts. Pure.
 *
 * The minutes and codes come from `liveConditionsFrom` (the only builder of a
 * `LiveConditions`); traffic adds its excess to the ground-transport term and
 * TRAFFIC_DEGRADED; a degraded read adds DATA_STALE; the estimate carries the
 * distribution, confidence and provenance. `null` when there is nothing live
 * at all — exactly today's computation.
 */
export function assembleLiveConditions(input: {
  nowMs: number;
  terms: Partial<Record<LiveTermKey, LiveTermResult | null>>;
  traffic?: TrafficSignal | null;
  disruption?: DisruptionResult | null;
  degraded?: readonly LiveDegradation[];
}): LiveConditions | null {
  const terms = (Object.values(input.terms) as Array<LiveTermResult | null | undefined>).filter((t): t is LiveTermResult => !!t);
  const traffic = input.traffic && input.traffic.excessMin >= 0 ? input.traffic : null;
  const degraded = [...new Set(input.degraded ?? [])];
  if (terms.length === 0 && !traffic && !input.disruption && degraded.length === 0) return null;

  const base = liveConditionsFrom(
    {
      securityWait: input.terms.securityWait?.truth ?? null,
      immigrationWait: input.terms.immigrationWait?.truth ?? null,
      taxiQueue: input.terms.taxiQueue?.truth ?? null,
    },
    { nowMs: input.nowMs },
  );
  const codes: LayoverReasonCode[] = [...base.reasonCodes];
  const add = (c: LayoverReasonCode) => { if (!codes.includes(c)) codes.push(c); };
  if (traffic && traffic.excessMin > 0) add("TRAFFIC_DEGRADED");
  if (degraded.length > 0) add("DATA_STALE");

  const trafficExtra = traffic ? traffic.excessMin : 0;
  const sumAt = (k: "p50" | "p75" | "p90") => terms.reduce((n, t) => n + t.extra[k], 0) + trafficExtra;
  const percentiles = [...new Set(terms.map((t) => t.percentile))];
  const percentile: EstimatePercentile = percentiles.length === 1 ? percentiles[0]! : "p90";

  let confidence = worst([
    ...terms.map((t) => t.truth.confidence),
    ...(traffic ? [traffic.confidence as EstimateConfidence] : []),
    ...(terms.length === 0 && !traffic ? ["LOW" as EstimateConfidence] : []),
  ]);
  if (degraded.length > 0) confidence = capAt(confidence, "LOW");
  if (input.disruption?.closureCorroborated) confidence = stepDown(confidence);
  if (input.disruption?.severe) confidence = "INSUFFICIENT";

  const observedAts = [base.observedAt, traffic?.observedAt ?? null].filter((s): s is string => !!s).sort();
  const expiries = [base.expiresAt, traffic?.expiresAt ?? null].filter((s): s is string => !!s).sort();
  const estimate: LiveConditionsEstimate = {
    p50ExtraMin: sumAt("p50"),
    p75ExtraMin: sumAt("p75"),
    p90ExtraMin: sumAt("p90"),
    percentile,
    confidence,
    fallbackLevel: terms.some((t) => t.stale) || degraded.length > 0 ? 1 : 0,
    sourceRefs: [
      `layoverLiveSignals@${LIVE_SIGNALS_VERSION}`,
      ...terms.flatMap((t) => t.truth.sourceRefs),
      ...(traffic ? traffic.sourceRefs.map((r) => `traffic:${r}`) : []),
      ...(input.disruption ? input.disruption.sourceRefs : []),
      ...degraded.map((d) => `degraded:${d}`),
    ],
  };
  return {
    securityWaitExtraMin: base.securityWaitExtraMin,
    immigrationWaitExtraMin: base.immigrationWaitExtraMin,
    groundTransportExtraMin: base.groundTransportExtraMin + trafficExtra,
    reasonCodes: codes,
    observedAt: observedAts[0] ?? null,
    expiresAt: expiries[0] ?? null,
    estimate, ...screenedAuthoritativeEvidence(terms, codes, confidence, input.nowMs),
  };
}

// ── the I/O producer ─────────────────────────────────────────────────────────

export interface LiveSignalDeps {
  /** The licensed/official feed. Default: the deployment's (`configuredLiveFeed`), i.e. the named absence today. */
  feed?: LayoverLiveFeedAdapter;
  /** The routing provider for the traffic term. Default: the routing lane's production corridor provider. */
  corridorProvider?: RouteCorridorProvider;
  policy?: typeof LIVE_PERCENTILE_POLICY;
}

/** Is the producer switched on? Fail-closed: off, absent and unreadable are all false. */
export async function liveSignalsEnabled(db: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(db, "layover_live_signals_enabled");
}

/**
 * The live conditions for one session at one instant, or null — the producer
 * `liveConditionsFrom` never had. Never throws on a read failure: a failed
 * read is a named degradation (DATA_STALE, structured log), never an empty
 * world that looks like "no queue".
 */
export async function resolveLayoverLiveConditions(
  db: SupabaseClient,
  airport: AirportProfile,
  session: LayoverSession,
  nowMs: number,
  deps: LiveSignalDeps = {},
): Promise<LiveConditions | null> {
  if (!(await liveSignalsEnabled(db))) return null;
  const airportRef = observationAirportRefOf(airport);
  if (!airportRef) return null; // the generic fallback profile is not an airport anyone reports on

  const feed = deps.feed ?? configuredLiveFeed();
  const [stored, fed, traffic] = await Promise.all([
    readStoredObservations(db, airportRef, LIVE_SIGNAL_FACT_TYPES, nowMs, STALE_HOLD_MIN).catch((): { ok: false; reason: "read_failed" } => ({ ok: false, reason: "read_failed" })),
    feed.read(airportRef, nowMs).catch((e): LiveFeedRead => ({ ok: false, configured: true, reason: "feed_unavailable", detail: String(e) })),
    readReturnTrafficSignal(db, airport, session, nowMs, { provider: deps.corridorProvider }).catch((e): TrafficSignalRead => ({ ok: false, reason: "stops_unreadable", detail: String(e) })),
  ]);

  const degraded: LiveDegradation[] = [];
  if (!stored.ok) {
    degraded.push("store_unreadable");
    logger.warn({ airportRef, sessionId: session.id, reason: stored.reason }, "live signals: airport_fact_observations unreadable — DATA_STALE, no stored evidence folded");
  }
  if (!fed.ok && fed.configured) {
    degraded.push("feed_unavailable");
    logger.warn({ airportRef, sessionId: session.id, reason: fed.reason, detail: fed.detail }, "live signals: the configured live feed could not be read — DATA_STALE");
  }
  if (!traffic.ok) {
    degraded.push("plan_unreadable");
    logger.warn({ airportRef, sessionId: session.id, detail: traffic.detail }, "live signals: the plan could not be read, so return traffic was not forecast — DATA_STALE");
  }

  const corpus: AirportObservation[] = [...(stored.ok ? stored.corpus : []), ...(fed.ok ? fed.observations : [])];
  const opts = { nowMs, airportRef, consequence: "flight" as const, policy: deps.policy };
  return assembleLiveConditions({
    nowMs,
    terms: {
      securityWait: evaluateLiveTerm(corpus, "securityWait", opts),
      immigrationWait: evaluateLiveTerm(corpus, "immigrationWait", opts),
      taxiQueue: evaluateLiveTerm(corpus, "taxiQueue", opts),
    },
    traffic: traffic.ok ? traffic.signal : null,
    disruption: evaluateDisruption(corpus, { nowMs, airportRef }),
    degraded,
  });
}

/** Only screened official/licensed readings can advance maturity. Crowd and route evidence cannot. */
function screenedAuthoritativeEvidence(terms: LiveTermResult[], codes: LayoverReasonCode[], confidence: EstimateConfidence, nowMs: number): Pick<LiveConditions, "authoritativeEvidence"> {
  if (codes.includes("DATA_STALE") || codes.includes("SOURCE_CONFLICT") || confidence === "LOW" || confidence === "INSUFFICIENT") return {};
  const readings = terms.flatMap((t) => t.readings).filter((r) =>
    (r.kind === "official" || r.kind === "operator_feed") && !r.stale
    && Number.isFinite(Date.parse(r.observedAt)) && Date.parse(r.observedAt) <= nowMs && Date.parse(r.expiresAt) > nowMs);
  if (readings.length === 0) return {};
  return { authoritativeEvidence: {
    policy: "authoritative-live-v1",
    observedAt: readings.map((r) => r.observedAt).sort()[0]!,
    expiresAt: readings.map((r) => r.expiresAt).sort()[0]!,
    sourceKinds: [...new Set(readings.map((r) => r.kind as "official" | "operator_feed"))].sort(),
  } };
}
