/**
 * Trips spec §8.4 — the risk register's four triggers, PURE
 * (census-trips TR144–TR147).
 *
 *   Risk                     Trigger                                        Mitigation
 *   Tight arrival            Flight ETA shifts beyond threshold.            Move/cancel downstream plan; alert affected participants.
 *   Weather-sensitive        Forecast confidence + event dependency crosses  Prepare indoor fallback.
 *                            threshold.
 *   Late check-in            Arrival estimate exceeds desk policy.           Contact property / alternate entry plan.
 *   Crew transport mismatch  Party size > available vehicle capacity.       Split transport or prebook larger vehicle.
 *
 * Each trigger is a function of stated inputs and returns whether it fired,
 * the evidence, the spec's mitigation verbatim, and what it affects. The
 * projection (TripTodayProjection) gathers the inputs; nothing here reads.
 */
import type { PulseInterpretation } from "./TripSignals.js";

export const RISK_TRIGGER_KINDS = ["tight_arrival", "weather_sensitive", "late_check_in", "crew_transport_mismatch"] as const;
export type RiskTriggerKind = (typeof RISK_TRIGGER_KINDS)[number];

/** §8.4's third column, verbatim. */
export const RISK_MITIGATIONS: Readonly<Record<RiskTriggerKind, string>> = {
  tight_arrival: "Move/cancel downstream plan; alert affected participants.",
  weather_sensitive: "Prepare indoor fallback.",
  late_check_in: "Contact property / alternate entry plan.",
  crew_transport_mismatch: "Split transport or prebook larger vehicle.",
};

export interface TriggerCommitment {
  id: string;
  type: string;
  /** ISO. */
  startsAt: string | null;
  requiredArrivalAt: string | null;
  /** A live estimate of when the traveller will actually arrive (a flight ETA, a transit estimate). */
  estimatedArrivalAt?: string | null;
  /** ISO — a lodging commitment's desk closes / check-in ends. */
  checkInDeadlineAt?: string | null;
  /** Participant ids this commitment applies to. */
  participantIds?: string[];
}

export interface TriggerPlan {
  id: string;
  title: string | null;
  startsAt: string | null;
  endsAt: string | null;
  weatherSensitive: boolean;
  /** Attendance count when known (2771), else the crew size. */
  partySize: number | null;
}

export interface TriggerTransport {
  id: string;
  mode: string;
  state: string;
  plannedDepartureAt: string | null;
  partySize: number | null;
  /** Seats the segment actually provides, when known (a booked vehicle). */
  capacity: number | null;
  /** The plan or commitment it serves, when known. */
  servesId?: string | null;
}

export interface RiskTriggerInputs {
  now: number;
  commitments: TriggerCommitment[];
  plans: TriggerPlan[];
  transport: TriggerTransport[];
  /** The pulse's kept signals: rain arriving carries the forecast confidence. */
  signals: PulseInterpretation[];
  /** The crew size, for party-size defaults. */
  crewSize: number;
}

export interface RiskTrigger {
  kind: RiskTriggerKind;
  fired: boolean;
  /** Which objects: commitment / plan / transport ids. */
  affectedIds: string[];
  /** Participants to alert, when the mitigation says so. */
  participantIds: string[];
  evidence: string;
  mitigation: string;
  /** How far past the threshold, in the trigger's own unit. */
  magnitude: number | null;
}

/** A flight ETA this much later than the arrival it feeds is "beyond threshold". */
export const TIGHT_ARRIVAL_THRESHOLD_MIN = 30;
/** A forecast at or above this confidence, on a plan that depends on the weather, fires. */
export const WEATHER_CONFIDENCE_THRESHOLD = 0.5;
/** A vehicle's default seats when the segment does not say. */
export const DEFAULT_VEHICLE_CAPACITY: Readonly<Record<string, number>> = { taxi: 4, rideshare: 4, ride_hail: 4, car: 4, car_hire: 5, van: 8, minibus: 16, bus: 50, train: 999, metro: 999, ferry: 999, walk: 999, bike: 1, scooter: 1 };

const ms = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };

export function evaluateRiskTriggers(inputs: RiskTriggerInputs): RiskTrigger[] {
  const out: RiskTrigger[] = [];
  const upcoming = (t: number | null) => t !== null && t > inputs.now;

  // Tight arrival: a commitment whose live ETA is later than the arrival it needs by more than the threshold; downstream = later commitments and plans that day.
  const tight = inputs.commitments.filter((c) => {
    const need = ms(c.requiredArrivalAt) ?? ms(c.startsAt); const eta = ms(c.estimatedArrivalAt);
    return need !== null && eta !== null && upcoming(need) && eta - need > TIGHT_ARRIVAL_THRESHOLD_MIN * 60_000;
  });
  if (tight.length > 0) {
    const worst = tight.map((c) => (ms(c.estimatedArrivalAt)! - (ms(c.requiredArrivalAt) ?? ms(c.startsAt))!) / 60_000).sort((a, b) => b - a)[0];
    const firstEta = Math.min(...tight.map((c) => ms(c.estimatedArrivalAt)!));
    const downstream = [
      ...inputs.commitments.filter((c) => !tight.includes(c) && (ms(c.requiredArrivalAt) ?? ms(c.startsAt) ?? -1) > firstEta - 6 * 3_600_000 && (ms(c.requiredArrivalAt) ?? ms(c.startsAt) ?? -1) < firstEta + 12 * 3_600_000).map((c) => c.id),
      ...inputs.plans.filter((p) => (ms(p.startsAt) ?? -1) > firstEta - 6 * 3_600_000 && (ms(p.startsAt) ?? -1) < firstEta + 12 * 3_600_000).map((p) => p.id),
    ];
    out.push({
      kind: "tight_arrival", fired: true, affectedIds: [...tight.map((c) => c.id), ...downstream],
      participantIds: [...new Set(tight.flatMap((c) => c.participantIds ?? []))],
      evidence: `${tight.length} arrival(s) estimated ${Math.round(worst)} min later than needed (threshold ${TIGHT_ARRIVAL_THRESHOLD_MIN}); ${downstream.length} downstream item(s) within twelve hours`,
      mitigation: RISK_MITIGATIONS.tight_arrival, magnitude: Math.round(worst),
    });
  } else out.push({ kind: "tight_arrival", fired: false, affectedIds: [], participantIds: [], evidence: "no live arrival estimate exceeds its needed arrival by the threshold", mitigation: RISK_MITIGATIONS.tight_arrival, magnitude: null });

  // Weather-sensitive: a rain signal whose confidence crosses the threshold, on a plan that depends on the weather.
  const rain = inputs.signals.filter((s) => s.kind === "rain_arriving" && s.estimate.confidence >= WEATHER_CONFIDENCE_THRESHOLD);
  const dependent = inputs.plans.filter((p) => p.weatherSensitive && rain.some((s) => s.effects.some((e) => e.kind === "plan_invalidated" && e.subjectIds.includes(p.id))));
  if (dependent.length > 0) {
    const conf = Math.max(...rain.map((s) => s.estimate.confidence));
    out.push({
      kind: "weather_sensitive", fired: true, affectedIds: dependent.map((p) => p.id), participantIds: [],
      evidence: `rain forecast at confidence ${conf.toFixed(2)} (threshold ${WEATHER_CONFIDENCE_THRESHOLD}) on ${dependent.length} weather-dependent plan(s)`,
      mitigation: RISK_MITIGATIONS.weather_sensitive, magnitude: Math.round(conf * 100) / 100,
    });
  } else out.push({ kind: "weather_sensitive", fired: false, affectedIds: [], participantIds: [], evidence: rain.length > 0 ? "rain is forecast but no weather-dependent plan sits under it" : "no confident rain forecast on a weather-dependent plan", mitigation: RISK_MITIGATIONS.weather_sensitive, magnitude: null });

  // Late check-in: a lodging commitment whose arrival estimate (or required arrival) is after the desk's deadline.
  const late = inputs.commitments.filter((c) => {
    const desk = ms(c.checkInDeadlineAt); if (desk === null || !upcoming(desk)) return false;
    const arrive = ms(c.estimatedArrivalAt) ?? ms(c.requiredArrivalAt) ?? ms(c.startsAt);
    return arrive !== null && arrive > desk;
  });
  if (late.length > 0) {
    const over = Math.max(...late.map((c) => ((ms(c.estimatedArrivalAt) ?? ms(c.requiredArrivalAt) ?? ms(c.startsAt))! - ms(c.checkInDeadlineAt)!) / 60_000));
    out.push({ kind: "late_check_in", fired: true, affectedIds: late.map((c) => c.id), participantIds: [...new Set(late.flatMap((c) => c.participantIds ?? []))], evidence: `arrival estimate exceeds the desk policy by ${Math.round(over)} min at ${late.length} property(ies)`, mitigation: RISK_MITIGATIONS.late_check_in, magnitude: Math.round(over) });
  } else out.push({ kind: "late_check_in", fired: false, affectedIds: [], participantIds: [], evidence: "no arrival estimate exceeds a desk policy", mitigation: RISK_MITIGATIONS.late_check_in, magnitude: null });

  // Crew transport mismatch: an upcoming segment whose party is larger than its seats.
  const mismatched = inputs.transport.filter((t) => {
    if (t.state === "completed" || t.state === "COMPLETED") return false;
    const dep = ms(t.plannedDepartureAt); if (dep !== null && dep < inputs.now) return false;
    const party = t.partySize ?? inputs.plans.find((p) => p.id === t.servesId)?.partySize ?? inputs.crewSize;
    const cap = t.capacity ?? DEFAULT_VEHICLE_CAPACITY[t.mode.toLowerCase()] ?? null;
    return cap !== null && party > cap;
  });
  if (mismatched.length > 0) {
    const worst = Math.max(...mismatched.map((t) => (t.partySize ?? inputs.crewSize) - (t.capacity ?? DEFAULT_VEHICLE_CAPACITY[t.mode.toLowerCase()] ?? 0)));
    out.push({ kind: "crew_transport_mismatch", fired: true, affectedIds: mismatched.map((t) => t.id), participantIds: [], evidence: `${mismatched.length} segment(s) carry a party ${worst} over the vehicle's seats`, mitigation: RISK_MITIGATIONS.crew_transport_mismatch, magnitude: worst });
  } else out.push({ kind: "crew_transport_mismatch", fired: false, affectedIds: [], participantIds: [], evidence: "every upcoming segment's party fits its vehicle, or its capacity is unknown", mitigation: RISK_MITIGATIONS.crew_transport_mismatch, magnitude: null });

  return out;
}
