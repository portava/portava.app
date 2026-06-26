/**
 * Unit tests for the route optimizer (pure function, no DB needed).
 * Uses node:test runner + assert (no vitest — blocked by firewall).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeRoute, type CandidateStop, type OptimizeOptions } from "../services/routeOptimizer.js";

const makestop = (title: string, lat: number, lng: number, category?: string): CandidateStop => ({
  title, lat, lng, category,
});

test("returns valid ordered array for 3 stops", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.28, 103.85),
    makestop("B", 1.29, 103.87),
    makestop("C", 1.30, 103.86),
  ];
  const opts: OptimizeOptions = { style: "custom" };
  const result = optimizeRoute(stops, opts);

  assert.equal(result.stops.length, 3);
  assert.equal(result.legs.length, 2);
  assert.equal(result.isApproximated, true);
});

test("rejects stops with no coordinates — emits warning", () => {
  const stops: CandidateStop[] = [
    { title: "No-coord stop", lat: NaN, lng: NaN },
    makestop("B", 1.29, 103.87),
    makestop("C", 1.30, 103.86),
  ];
  const result = optimizeRoute(stops, { style: "custom" });
  assert.equal(result.stops.length, 2);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings[0]!.includes("No-coord stop"));
});

test("labels all distances as approximated", () => {
  const stops: CandidateStop[] = [
    makestop("X", 1.28, 103.85),
    makestop("Y", 1.30, 103.88),
  ];
  const result = optimizeRoute(stops, { style: "custom" });
  assert.equal(result.isApproximated, true);
  for (const leg of result.legs) {
    assert.equal(leg.isApproximated, true);
  }
});

test("empty input returns empty arrays", () => {
  const result = optimizeRoute([], { style: "custom" });
  assert.equal(result.stops.length, 0);
  assert.equal(result.legs.length, 0);
  assert.equal(result.totalDistanceMeters, 0);
});

test("low_walking style flags long legs for rideshare", () => {
  const stops: CandidateStop[] = [
    makestop("Near", 1.0, 100.0),
    makestop("Far", 1.05, 100.05), // ~7 km away
  ];
  const result = optimizeRoute(stops, { style: "low_walking" });
  assert.equal(result.legs[0]!.rideshareRecommended, true);
  assert.equal(result.legs[0]!.mode, "rideshare");
});

test("short walk stays as walk mode", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.0000, 100.0000),
    makestop("B", 1.0005, 100.0005), // ~70 m
  ];
  const result = optimizeRoute(stops, { style: "custom" });
  assert.equal(result.legs[0]!.mode, "walk");
  assert.equal(result.legs[0]!.rideshareRecommended, false);
});

test("start location is prepended as first stop", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.28, 103.85),
    makestop("B", 1.29, 103.87),
  ];
  const result = optimizeRoute(stops, {
    style: "custom",
    startLocation: { lat: 1.27, lng: 103.84, label: "Hotel" },
  });
  assert.equal(result.stops[0]!.stop.title, "Hotel");
  assert.equal(result.stops.length, 3);
});

test("end location is appended as last stop", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.28, 103.85),
    makestop("B", 1.29, 103.87),
  ];
  const result = optimizeRoute(stops, {
    style: "custom",
    endLocation: { lat: 1.27, lng: 103.84, label: "Home" },
  });
  assert.equal(result.stops[result.stops.length - 1]!.stop.title, "Home");
});

test("totalDuration equals sum of leg durations", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.28, 103.85),
    makestop("B", 1.29, 103.87),
    makestop("C", 1.30, 103.86),
  ];
  const result = optimizeRoute(stops, { style: "custom" });
  const legSum = result.legs.reduce((acc, l) => acc + l.durationSeconds, 0);
  assert.equal(result.totalDurationSeconds, legSum);
});
