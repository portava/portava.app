/**
 * layoverCalibration — APPLY calibration, not only measure it (census-layover
 * L83 "Historical model — time-of-day distributions, recalibrated", L247 "L4
 * Calibrated — prediction errors measured, model calibrated by airport/time
 * band"). LAYOVER 165, lane B2-CURATE.
 *
 * `LayoverAirportTruth.measureCalibration` MEASURES error and adjusts nothing.
 * This module closes the loop, per airport and per airport-local hour band:
 *
 *   PRIOR      the band currently in force: the last calibrated p90 when there
 *              is one, otherwise what the ENGINE already budgets for the
 *              re-entry checkpoint at that hour (the security-queue baseline
 *              the buffer assumes, `SECURITY_WAIT_BASELINE_MIN`, plus the
 *              engine's own time-of-day band).
 *   EVIDENCE   (a) traveller OBSERVATIONS of checkpoint timing (the 3513 crowd
 *                  channel, airport_fact_observations): screened by §10.1's
 *                  rules, and a band counts only with >= MIN_CALIBRATION_
 *                  OBSERVATIONS readings from >= MIN_CALIBRATION_OBSERVERS
 *                  distinct observers (the aggregate's anonymity floor);
 *              (b) stored OUTCOMES (2992's layover_outcomes, with 2700's
 *                  certified hard-return time): returns at or before the
 *                  certified deadline whose boarding was MISSED are the
 *                  model under-predicting at that hour; a band counts only
 *                  with >= MIN_OUTCOME_RETURNS such compliant returns.
 *   ERROR      prior − observed p90 (positive = pessimistic), and the outcome
 *              coverage (share of compliant returns that boarded).
 *   STEP       toward the evidence, BOUNDED: at most +STEP_UP_MINUTES and
 *              -STEP_DOWN_MINUTES per recalibration — up faster than down,
 *              because under-predicting a queue costs a flight.
 *   PERSISTED  through `airport_calibration_apply()` (3880) with its provenance:
 *              counts, measured error, the rule in force, versions, the
 *              evidence window, and a 90-day TTL. NO identifier of a traveller,
 *              an observer, an observation or a session is stored.
 *   READ       by the engine: the airport row's projection becomes
 *              `AirportProfile.calibratedCheckpointExtra`, folded into the
 *              time-of-day term (LayoverSafetyEngine `calibratedTimeOfDayExtra`)
 *              and named in the certified record's inputs. It can only make a
 *              deadline earlier.
 *
 * Without evidence nothing is written: a band with too few samples keeps its
 * prior, and an airport with no band meeting the rule gets no calibration.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { localHour } from "./AirportTime.js";
import {
  LAYOVER_TRUTH_VERSION,
  OBSERVATION_RATE_LIMIT,
  SECURITY_WAIT_BASELINE_MIN,
  isImplausible,
  type AirportObservation,
  type ObserverKind,
} from "./LayoverAirportTruth.js";
import { engineTimeOfDayBandMinutes } from "./LayoverSafetyEngine.js";
import { MIN_DISTINCT_OBSERVERS_PER_BAND } from "../layover/LayoverObservationAggregate.js";

const logger = rootLogger.child({ service: "layoverCalibration" });

export const CALIBRATION_POLICY_VERSION = "2026.10.18-1";
/** The calibrated quantity: minutes to clear the re-entry checkpoint (a traveller-submittable §10 fact). */
export const CALIBRATED_FACT_TYPE = "checkpoint_timing_minutes" as const;
export const MIN_CALIBRATION_OBSERVATIONS = 10;
export const MIN_CALIBRATION_OBSERVERS = MIN_DISTINCT_OBSERVERS_PER_BAND;
export const MIN_OUTCOME_RETURNS = 5;
export const STEP_UP_MINUTES = 10;
export const STEP_DOWN_MINUTES = 5;
/** Share of compliant returns that must board for the band to be "covering" (p90). */
export const OUTCOME_COVERAGE_TARGET = 0.9;
/** §10 "longer-lived but recalibrated" — LayoverAirportTruth's HISTORICAL_MODEL TTL. */
export const CALIBRATION_TTL_MS = 90 * 86_400_000;
export const EVIDENCE_WINDOW_MS = 90 * 86_400_000;

/** What the engine already budgets for the re-entry checkpoint at an airport-local hour. */
export function engineCheckpointBudget(hour: number): number {
  return SECURITY_WAIT_BASELINE_MIN + engineTimeOfDayBandMinutes(hour);
}

export interface BandEvidence {
  hour: number;
  /** De-identified: counts and a percentile only. Null when the band has no reading at all. */
  observation: { samples: number; distinctObservers: number; p90: number } | null;
  outcomes: { compliantReturns: number; missed: number };
}

/** One recalibrated band, in exactly the shape `airport_calibration_apply` stores (3880's CHECKs hold by construction). */
export interface CalibrationStep {
  factType: typeof CALIBRATED_FACT_TYPE;
  localHour: number;
  priorP90: number;
  targetP90: number;
  stepApplied: number;
  stepBoundUp: number;
  stepBoundDown: number;
  calibratedP90: number;
  engineBudget: number;
  extraMinutes: number;
  observationSamples: number;
  observationDistinctObservers: number;
  observedP90: number | null;
  outcomeCompliantReturns: number;
  outcomeMissed: number;
  meanSignedError: number | null;
  outcomeCoverageRate: number | null;
  evidence: "observations" | "outcomes" | "observations_and_outcomes";
  minObservationSamples: number;
  minDistinctObservers: number;
  minOutcomeReturns: number;
  policyVersion: string;
  truthVersion: string;
  windowStart: string;
  windowEnd: string;
  expiresAt: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Recalibrate ONE hour band. Pure. `null` when the minimum-sample rule is not
 * met by either kind of evidence — the band then keeps its prior and nothing is
 * written for it.
 */
export function recalibrateBand(
  previousP90: number | null,
  ev: BandEvidence,
  window: { startMs: number; endMs: number },
  nowMs: number,
): CalibrationStep | null {
  const budget = engineCheckpointBudget(ev.hour);
  const prior = clamp(Math.round(previousP90 ?? budget), 0, 240);
  const obsOk = ev.observation !== null
    && ev.observation.samples >= MIN_CALIBRATION_OBSERVATIONS
    && ev.observation.distinctObservers >= MIN_CALIBRATION_OBSERVERS;
  const outOk = ev.outcomes.compliantReturns >= MIN_OUTCOME_RETURNS;
  if (!obsOk && !outOk) return null;

  const coverage = outOk ? (ev.outcomes.compliantReturns - ev.outcomes.missed) / ev.outcomes.compliantReturns : null;
  // Observations say WHERE the band should be; outcomes say whether the band in
  // force let compliant travellers board. A coverage below target is the model
  // under-predicting: the band must rise, by the full bound.
  const targets: number[] = [];
  if (obsOk) targets.push(Math.round(ev.observation!.p90));
  if (coverage !== null) targets.push(coverage < OUTCOME_COVERAGE_TARGET ? prior + STEP_UP_MINUTES : prior);
  const target = clamp(Math.max(...targets), 0, 240);
  let step = clamp(target - prior, -STEP_DOWN_MINUTES, STEP_UP_MINUTES);
  step = clamp(prior + step, 0, 240) - prior;
  const calibrated = prior + step;
  return {
    factType: CALIBRATED_FACT_TYPE,
    localHour: ev.hour,
    priorP90: prior,
    targetP90: target,
    stepApplied: step,
    stepBoundUp: STEP_UP_MINUTES,
    stepBoundDown: STEP_DOWN_MINUTES,
    calibratedP90: calibrated,
    engineBudget: budget,
    extraMinutes: Math.max(0, calibrated - budget),
    observationSamples: ev.observation?.samples ?? 0,
    observationDistinctObservers: ev.observation?.distinctObservers ?? 0,
    observedP90: obsOk ? Math.round(ev.observation!.p90) : null,
    outcomeCompliantReturns: ev.outcomes.compliantReturns,
    outcomeMissed: ev.outcomes.missed,
    meanSignedError: obsOk ? prior - Math.round(ev.observation!.p90) : null,
    outcomeCoverageRate: coverage === null ? null : Math.round(coverage * 1000) / 1000,
    evidence: obsOk && outOk ? "observations_and_outcomes" : obsOk ? "observations" : "outcomes",
    minObservationSamples: MIN_CALIBRATION_OBSERVATIONS,
    minDistinctObservers: MIN_CALIBRATION_OBSERVERS,
    minOutcomeReturns: MIN_OUTCOME_RETURNS,
    policyVersion: CALIBRATION_POLICY_VERSION,
    truthVersion: LAYOVER_TRUTH_VERSION,
    windowStart: new Date(window.startMs).toISOString(),
    windowEnd: new Date(window.endMs).toISOString(),
    expiresAt: new Date(nowMs + CALIBRATION_TTL_MS).toISOString(),
  };
}

function p90Of(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1))]!;
}

/**
 * Screen a HISTORICAL corpus. `screenObservations` judges a reading as LIVE
 * evidence and rejects it once its class TTL (45 minutes for a traveller
 * report) has passed — right for a queue someone is about to stand in, wrong
 * for a distribution, which is made of past readings. So the history keeps
 * every structural rule and drops only expiry: unknown fact type, non-finite,
 * implausible (§23's declared range), unparseable or future-dated, duplicate
 * ids, readings outside the evidence window, and the same per-observer rate
 * limit (`OBSERVATION_RATE_LIMIT`) so one flood cannot become a band.
 */
export function screenHistoricalObservations(
  corpus: AirportObservation[],
  window: { startMs: number; endMs: number },
): AirportObservation[] {
  const seen = new Set<string>();
  const perObserver = new Map<string, number[]>();
  const kept: AirportObservation[] = [];
  const sorted = [...corpus].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  for (const o of sorted) {
    if (o.factType !== CALIBRATED_FACT_TYPE || seen.has(o.observationId)) continue;
    seen.add(o.observationId);
    const at = Date.parse(o.observedAt);
    if (!Number.isFinite(o.value) || isImplausible(o.factType, o.value) || !Number.isFinite(at)) continue;
    if (at > window.endMs || at < window.startMs) continue;
    const times = perObserver.get(o.observerId) ?? [];
    const recent = times.filter((t) => at - t <= OBSERVATION_RATE_LIMIT.windowMinutes * 60_000);
    if (recent.length >= OBSERVATION_RATE_LIMIT.maxPerWindow) continue;
    times.push(at);
    perObserver.set(o.observerId, times);
    kept.push(o);
  }
  return kept;
}

/**
 * Per-hour observation evidence from a screened HISTORICAL corpus: counts and
 * the p90 only. An hour below the distinct-observer floor contributes NOTHING
 * (the aggregate's anonymity rule): its readings are one person's afternoon.
 */
export function observationEvidenceByHour(
  corpus: AirportObservation[],
  timezone: string,
  window: { startMs: number; endMs: number },
): Map<number, { samples: number; distinctObservers: number; p90: number }> {
  const byHour = new Map<number, { values: number[]; observers: Set<string> }>();
  for (const o of screenHistoricalObservations(corpus, window)) {
    const h = localHour(timezone, new Date(o.observedAt));
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    const b = byHour.get(h) ?? { values: [], observers: new Set<string>() };
    b.values.push(o.value);
    b.observers.add(o.observerId);
    byHour.set(h, b);
  }
  const out = new Map<number, { samples: number; distinctObservers: number; p90: number }>();
  for (const [h, b] of byHour) {
    if (b.observers.size < MIN_DISTINCT_OBSERVERS_PER_BAND) continue;
    out.set(h, { samples: b.values.length, distinctObservers: b.observers.size, p90: p90Of(b.values) });
  }
  return out;
}

/** The observation history in the evidence window (expired rows included — see `screenHistoricalObservations`). */
export async function readObservationHistory(
  db: SupabaseClient,
  airportRef: string,
  window: { startMs: number; endMs: number },
): Promise<{ ok: true; corpus: AirportObservation[] } | { ok: false }> {
  const { data, error } = await db.from("airport_fact_observations")
    .select("id,airport_ref,fact_type,value,observer_kind,observer_id,observer_trust,source_ref,observed_at")
    .eq("airport_ref", airportRef).eq("fact_type", CALIBRATED_FACT_TYPE)
    .gte("observed_at", new Date(window.startMs).toISOString()).lte("observed_at", new Date(window.endMs).toISOString())
    .order("observed_at", { ascending: false }).limit(5000);
  if (error || !Array.isArray(data)) {
    logger.warn({ err: error, airportRef }, "calibration: observation history unreadable — observations do not contribute");
    return { ok: false };
  }
  return {
    ok: true,
    corpus: (data as Array<Record<string, unknown>>).map((r) => ({
      observationId: String(r.id),
      airportRef: String(r.airport_ref),
      factType: CALIBRATED_FACT_TYPE,
      value: Number(r.value),
      observerKind: r.observer_kind as ObserverKind,
      observerId: String(r.observer_id),
      observedAt: String(r.observed_at),
      sourceRef: String(r.source_ref),
    })),
  };
}

export type OutcomeEvidenceRead =
  | { ok: true; byHour: Map<number, { compliantReturns: number; missed: number }> }
  | { ok: false; reason: "outcomes_storage_unavailable" | "outcomes_unreadable" };

const isMissingSchema = (e: { code?: string; message?: string } | null | undefined) =>
  ["42P01", "PGRST205", "42703", "PGRST204"].includes(e?.code ?? "") || /does not exist|schema cache/i.test(e?.message ?? "");

/**
 * Outcome evidence for one airport: layovers that LEFT the airport and
 * re-entered, with the certified hard-return time they were given (the newest
 * computation at or before the re-entry). A return at or before that deadline
 * is COMPLIANT; a compliant return whose boarding was MISSED is the model
 * under-predicting at the re-entry's local hour. Session ids are used to join
 * and are never returned.
 */
export async function readOutcomeEvidence(
  db: SupabaseClient,
  airportId: string,
  timezone: string,
  window: { startMs: number; endMs: number },
): Promise<OutcomeEvidenceRead> {
  const ready = await airportOutcomeSchemaReadiness(db); if (ready.state !== "ready") return { ok: false, reason: ready.state === "missing" ? "outcomes_storage_unavailable" : "outcomes_unreadable" }; const sessions = await db.from("layover_sessions").select("id").eq("airport_id", airportId).limit(5000);
  if (sessions.error) return { ok: false, reason: isMissingSchema(sessions.error) ? "outcomes_storage_unavailable" : "outcomes_unreadable" };
  const ids = (sessions.data ?? []).map((r: { id: string }) => r.id);
  const byHour = new Map<number, { compliantReturns: number; missed: number }>();
  if (ids.length === 0) return { ok: true, byHour };
  const outcomes = await db.from("layover_outcomes")
    .select("session_id,actual_airport_return_at,boarding_outcome,left_airport")
    .in("session_id", ids).eq("left_airport", true)
    .gte("actual_airport_return_at", new Date(window.startMs).toISOString())
    .lte("actual_airport_return_at", new Date(window.endMs).toISOString());
  if (outcomes.error) return { ok: false, reason: isMissingSchema(outcomes.error) ? "outcomes_storage_unavailable" : "outcomes_unreadable" };
  const rows = (outcomes.data ?? []) as Array<{ session_id: string; actual_airport_return_at: string | null; boarding_outcome: string }>;
  if (rows.length === 0) return { ok: true, byHour };
  const comps = await db.from("layover_certified_computations")
    .select("session_id,hard_return_time,computed_at")
    .in("session_id", rows.map((r) => r.session_id))
    .order("computed_at", { ascending: false });
  if (comps.error) return { ok: false, reason: isMissingSchema(comps.error) ? "outcomes_storage_unavailable" : "outcomes_unreadable" };
  const bySession = new Map<string, Array<{ hard: number; at: number }>>();
  for (const c of (comps.data ?? []) as Array<{ session_id: string; hard_return_time: string; computed_at: string }>) {
    const list = bySession.get(c.session_id) ?? [];
    list.push({ hard: Date.parse(c.hard_return_time), at: Date.parse(c.computed_at) });
    bySession.set(c.session_id, list);
  }
  for (const r of rows) {
    const back = Date.parse(String(r.actual_airport_return_at));
    if (!Number.isFinite(back)) continue;
    const certified = (bySession.get(r.session_id) ?? []).find((c) => Number.isFinite(c.at) && c.at <= back);
    if (!certified || !Number.isFinite(certified.hard)) continue; // no prediction to measure against
    if (back > certified.hard) continue; // a late return measures the traveller, not the model
    const h = localHour(timezone, new Date(back));
    const b = byHour.get(h) ?? { compliantReturns: 0, missed: 0 };
    b.compliantReturns += 1;
    if (r.boarding_outcome === "MISSED") b.missed += 1;
    byHour.set(h, b);
  }
  return { ok: true, byHour };
}

/** A calibration payload must carry no identifier: no observer handle, no bare UUID, anywhere in it. */
export function assertCalibrationCarriesNoIdentifiers(steps: CalibrationStep[]): void {
  const text = JSON.stringify(steps);
  if (/\btv1-[0-9a-f]{40}\b/i.test(text) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) {
    throw new Error("layoverCalibration: an identifier reached a calibration payload; calibrations store counts and percentiles only");
  }
}

export type RecalibrationResult =
  | {
      ok: true;
      applied: number;
      calibrationVersion: number | null;
      bands: CalibrationStep[];
      /** Why outcomes did not contribute, when they did not. */
      outcomes: "used" | "none_in_window" | "outcomes_storage_unavailable" | "outcomes_unreadable";
      observations: "used" | "none_meeting_rule" | "observations_unreadable";
    }
  | { ok: false; reason: "no_airport_ref" | "read_failed" | "storage_unavailable" | "write_failed"; message: string };

/**
 * Recalibrate one airport now. Writes only when at least one band meets the
 * minimum-sample rule; writes through `airport_calibration_apply` (atomic).
 */
export async function recalibrateAirport(
  db: SupabaseClient,
  airport: { id: string; iataCode: string | null; timezone: string },
  nowMs: number,
): Promise<RecalibrationResult> {
  const ready = await airportCalibrationSchemaReadiness(db); if (ready.state !== "ready") return { ok: false, reason: ready.state === "missing" ? "storage_unavailable" : "read_failed", message: "Airport calibration schema readiness could not be confirmed; migration 3880 is required." }; const window = { startMs: nowMs - EVIDENCE_WINDOW_MS, endMs: nowMs };
  const ref = airport.iataCode && airport.iataCode !== "UNK" ? airport.iataCode : airport.id;
  if (!ref) return { ok: false, reason: "no_airport_ref", message: "the airport has no observation reference" };

  const corpus = await readObservationHistory(db, ref, window);
  const obsByHour = corpus.ok ? observationEvidenceByHour(corpus.corpus, airport.timezone, window) : new Map();
  const outRead = await readOutcomeEvidence(db, airport.id, airport.timezone, window);
  const outByHour = outRead.ok ? outRead.byHour : new Map<number, { compliantReturns: number; missed: number }>();

  const current = await db.from("airport_time_band_calibrations")
    .select("local_hour,calibrated_p90_minutes")
    .eq("airport_id", airport.id).eq("fact_type", CALIBRATED_FACT_TYPE).is("superseded_at", null);
  if (current.error) {
    return { ok: false, reason: isMissingSchema(current.error) ? "storage_unavailable" : "read_failed", message: String(current.error.message) };
  }
  const prevByHour = new Map<number, number>();
  for (const r of (current.data ?? []) as Array<{ local_hour: number; calibrated_p90_minutes: string | number }>) {
    const v = Number(r.calibrated_p90_minutes);
    if (Number.isFinite(v)) prevByHour.set(Number(r.local_hour), v);
  }

  const steps: CalibrationStep[] = [];
  for (let h = 0; h < 24; h++) {
    const step = recalibrateBand(prevByHour.get(h) ?? null, {
      hour: h,
      observation: obsByHour.get(h) ?? null,
      outcomes: outByHour.get(h) ?? { compliantReturns: 0, missed: 0 },
    }, window, nowMs);
    if (step) steps.push(step);
  }
  const outcomesState: Extract<RecalibrationResult, { ok: true }>["outcomes"] = !outRead.ok ? outRead.reason
    : steps.some((s) => s.evidence !== "observations") ? "used" : "none_in_window";
  const obsState: Extract<RecalibrationResult, { ok: true }>["observations"] = !corpus.ok ? "observations_unreadable"
    : steps.some((s) => s.evidence !== "outcomes") ? "used" : "none_meeting_rule";
  if (steps.length === 0) {
    return { ok: true, applied: 0, calibrationVersion: null, bands: [], outcomes: outcomesState, observations: obsState };
  }

  assertCalibrationCarriesNoIdentifiers(steps);
  const { data, error } = await db.rpc("airport_calibration_apply", { p_airport_id: airport.id, p_bands: steps });
  if (error) {
    logger.warn({ err: error.message, airportId: airport.id }, "recalibration not stored");
    return { ok: false, reason: isMissingSchema(error) || error.code === "42883" || error.code === "PGRST202" ? "storage_unavailable" : "write_failed", message: String(error.message) };
  }
  const out = (data ?? {}) as { outcome?: string; calibrationVersion?: number };
  if (out.outcome !== "applied") return { ok: false, reason: "write_failed", message: `unexpected outcome ${String(out.outcome)}` };
  return { ok: true, applied: steps.length, calibrationVersion: Number(out.calibrationVersion ?? 0), bands: steps, outcomes: outcomesState, observations: obsState };
}

import { airportCalibrationSchemaReadiness, airportOutcomeSchemaReadiness } from "./airportCurationSchema.js";
