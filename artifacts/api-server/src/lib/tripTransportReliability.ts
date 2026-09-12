/**
 * Trips spec §15.1 `TransportSegment.reliability` — census-trips TR287
 * ("0..1 on the segment. Nothing estimates it yet"). PURE.
 *
 * A segment's reliability is the crew's stated value when they gave one
 * (2782's column), else an estimate: a per-mode baseline, lowered by the
 * segment's own state and by §16 signals that bear on it — high taxi demand
 * for a taxi-like segment departing within six hours, rain arriving on the
 * day of a walk or a ride, an event delay on the segment's day for anything
 * scheduled — and never raised by anything. Every factor that applied is
 * named, so a renderer and Compass can say why, not just how much.
 *
 * The estimate is a REASONED DEFAULT, not a forecast: the baselines are the
 * provider's constants (TravelTimeProvider has the same standing for travel
 * time), and a stated value always wins.
 */
import type { PulseInterpretation, TaxiDemandValue, RainArrivingValue, EventDelayedValue } from "../services/trips/TripSignals.js";

export const MODE_BASELINE_RELIABILITY: Readonly<Record<string, number>> = {
  walk: 0.98, bike: 0.9, drive: 0.9, car: 0.9,
  train: 0.92, rail: 0.92, metro: 0.9, subway: 0.9, tram: 0.88, bus: 0.8, coach: 0.82, ferry: 0.85,
  flight: 0.9, plane: 0.9,
  taxi: 0.85, rideshare: 0.85, ride_hail: 0.85, uber: 0.85, grab: 0.85, transit: 0.85,
};
export const DEFAULT_BASELINE_RELIABILITY = 0.75;
export const TAXI_LIKE_MODES = new Set(["taxi", "rideshare", "ride_hail", "uber", "grab"]);
export const WEATHER_EXPOSED_MODES = new Set(["walk", "bike", "ferry"]);
const SIX_HOURS = 6 * 3_600_000;
const HIGH_DEMAND = new Set(["surge", "high", "very_high", "critical"]);

export interface ReliabilitySegment {
  id: string;
  mode: string;
  state: string;
  plannedDepartureAt: string | null;
  /** 2782's column: the crew's own number, or null. */
  reliability: number | null;
}

export interface ReliabilityEstimate {
  segmentId: string;
  mode: string;
  /** 0..1 */
  value: number;
  basis: "stated" | "estimated";
  baseline: number;
  /** Every adjustment that applied, in order, with its size. */
  factors: Array<{ kind: string; delta: number; detail: string }>;
  reading: string;
}

export function estimateTransportReliability(seg: ReliabilitySegment, signals: readonly PulseInterpretation[], now: number): ReliabilityEstimate {
  const mode = seg.mode.toLowerCase();
  const baseline = MODE_BASELINE_RELIABILITY[mode] ?? DEFAULT_BASELINE_RELIABILITY;
  const factors: ReliabilityEstimate["factors"] = [];
  const dep = seg.plannedDepartureAt ? Date.parse(seg.plannedDepartureAt) : NaN;
  const depDay = Number.isFinite(dep) ? new Date(dep).toISOString().slice(0, 10) : null;
  const state = seg.state.toLowerCase();

  if (typeof seg.reliability === "number" && Number.isFinite(seg.reliability)) {
    const value = clamp(seg.reliability);
    return { segmentId: seg.id, mode: seg.mode, value, basis: "stated", baseline, factors, reading: `stated by the crew: ${value.toFixed(2)} (2782); no estimate applied` };
  }
  let value = baseline;
  if (state === "cancelled") { factors.push({ kind: "state_cancelled", delta: -value, detail: "the segment is cancelled" }); value = 0; }
  else if (state === "disrupted") { factors.push({ kind: "state_disrupted", delta: -(value - 0.2), detail: "the segment is disrupted (§17)" }); value = 0.2; }
  else if (state === "completed") { factors.push({ kind: "state_completed", delta: 1 - value, detail: "the segment completed" }); value = 1; }
  else {
    for (const s of signals) {
      if (s.kind === "taxi_demand_high" && TAXI_LIKE_MODES.has(mode)) {
        const v = s.estimate.value as TaxiDemandValue;
        const soon = !Number.isFinite(dep) || (dep >= now - SIX_HOURS && dep <= now + SIX_HOURS);
        if (HIGH_DEMAND.has(String(v.condition)) && soon) { factors.push({ kind: "taxi_demand_high", delta: -0.25, detail: `taxi demand is ${v.condition} in ${v.zone} within six hours of departure` }); value -= 0.25; }
      }
      if (s.kind === "rain_arriving" && WEATHER_EXPOSED_MODES.has(mode)) {
        const v = s.estimate.value as RainArrivingValue;
        if (depDay && v.date === depDay) { factors.push({ kind: "rain_arriving", delta: -0.15, detail: `rain on ${v.date} (${v.precipMm} mm) on the day of a ${mode} segment` }); value -= 0.15; }
      }
      if (s.kind === "event_delayed" && depDay) {
        const v = s.estimate.value as EventDelayedValue;
        const when = v.newStartsAt ? v.newStartsAt.slice(0, 10) : null;
        if (when === depDay && typeof v.delayMinutes === "number" && v.delayMinutes >= 30) { factors.push({ kind: "event_delayed", delta: -0.1, detail: `an event on ${depDay} is delayed ${v.delayMinutes} min; departures around it are less certain` }); value -= 0.1; }
      }
    }
  }
  value = clamp(value);
  const reading = factors.length === 0
    ? `estimated from the ${mode} baseline ${baseline.toFixed(2)}; no signal bears on it`
    : `estimated: ${mode} baseline ${baseline.toFixed(2)}, ${factors.map((f) => `${f.kind} ${f.delta >= 0 ? "+" : ""}${f.delta.toFixed(2)}`).join(", ")}`;
  return { segmentId: seg.id, mode: seg.mode, value, basis: "estimated", baseline, factors, reading };
}

function clamp(v: number): number { return Math.max(0, Math.min(1, Math.round(v * 1000) / 1000)); }
