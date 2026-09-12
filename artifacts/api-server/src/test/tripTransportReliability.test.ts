/**
 * Trips spec §15.1 `reliability` on a transport segment (census-trips TR287):
 * stated by the crew or estimated from a mode baseline lowered by the
 * segment's state and §16 signals, every factor named. Pure.
 *
 * Run: node --import tsx/esm --test src/test/tripTransportReliability.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { estimateTransportReliability, MODE_BASELINE_RELIABILITY, DEFAULT_BASELINE_RELIABILITY } from "../lib/tripTransportReliability.js";
import type { PulseInterpretation } from "../services/trips/TripSignals.js";

const NOW = Date.parse("2026-09-13T12:00:00.000Z");
const seg = (o: Partial<Parameters<typeof estimateTransportReliability>[0]> = {}) => ({ id: "t1", mode: "taxi", state: "planned", plannedDepartureAt: "2026-09-13T14:00:00.000Z", reliability: null, ...o });
const signal = (kind: PulseInterpretation["kind"], value: unknown): PulseInterpretation => ({
  kind, subjectId: "s", interpretation: "", effects: [], relevance: [],
  estimate: { value: value as any, confidence: 0.8, sourceClass: "observed" as any, observedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(), fallbackUsed: false, contradictorySources: [] } as any,
});

describe("TR287 — transport reliability", () => {
  it("a stated value wins and is reported as stated, whatever the signals say", () => {
    const r = estimateTransportReliability(seg({ reliability: 0.4 }), [signal("taxi_demand_high", { zone: "centre", condition: "surge" })], NOW);
    assert.equal(r.basis, "stated"); assert.equal(r.value, 0.4); assert.deepEqual(r.factors, []);
  });
  it("estimated from the mode baseline; an unknown mode gets the default", () => {
    assert.equal(estimateTransportReliability(seg(), [], NOW).value, MODE_BASELINE_RELIABILITY.taxi);
    assert.equal(estimateTransportReliability(seg({ mode: "hovercraft" }), [], NOW).value, DEFAULT_BASELINE_RELIABILITY);
    assert.equal(estimateTransportReliability(seg({ mode: "Train" }), [], NOW).baseline, MODE_BASELINE_RELIABILITY.train, "mode is case-insensitive");
  });
  it("high taxi demand within six hours of a taxi-like departure lowers it by 0.25 and is named; a train is untouched; a departure tomorrow is untouched", () => {
    const surge = [signal("taxi_demand_high", { zone: "centre", condition: "surge" })];
    const r = estimateTransportReliability(seg(), surge, NOW);
    assert.equal(r.value, Math.round((MODE_BASELINE_RELIABILITY.taxi - 0.25) * 1000) / 1000); assert.equal(r.factors[0]!.kind, "taxi_demand_high");
    assert.equal(estimateTransportReliability(seg({ mode: "train" }), surge, NOW).factors.length, 0);
    assert.equal(estimateTransportReliability(seg({ plannedDepartureAt: "2026-09-14T14:00:00.000Z" }), surge, NOW).factors.length, 0);
    assert.equal(estimateTransportReliability(seg(), [signal("taxi_demand_high", { zone: "centre", condition: "normal" })], NOW).factors.length, 0, "normal demand is not a factor");
  });
  it("rain on the day lowers a walk or a ferry, not a metro; an event delayed 30+ minutes that day lowers anything scheduled", () => {
    const rain = [signal("rain_arriving", { date: "2026-09-13", precipMm: 12, weatherCode: 61 })];
    assert.equal(estimateTransportReliability(seg({ mode: "walk" }), rain, NOW).factors[0]!.kind, "rain_arriving");
    assert.equal(estimateTransportReliability(seg({ mode: "metro" }), rain, NOW).factors.length, 0);
    const delayed = [signal("event_delayed", { eventId: "e", status: "delayed", delayMinutes: 45, newStartsAt: "2026-09-13T20:00:00.000Z" })];
    assert.equal(estimateTransportReliability(seg({ mode: "bus" }), delayed, NOW).factors[0]!.kind, "event_delayed");
  });
  it("state outranks signals: disrupted is 0.2, cancelled is 0, completed is 1; never below 0 or above 1", () => {
    const surge = [signal("taxi_demand_high", { zone: "centre", condition: "surge" })];
    assert.equal(estimateTransportReliability(seg({ state: "disrupted" }), surge, NOW).value, 0.2);
    assert.equal(estimateTransportReliability(seg({ state: "cancelled" }), surge, NOW).value, 0);
    assert.equal(estimateTransportReliability(seg({ state: "completed" }), surge, NOW).value, 1);
    assert.equal(estimateTransportReliability(seg({ reliability: 7 }), [], NOW).value, 1);
  });
});
