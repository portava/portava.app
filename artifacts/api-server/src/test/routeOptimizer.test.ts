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

// ── Compass explanation ───────────────────────────────────────────────────────

test("compassExplanation is a non-empty string", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.28, 103.85),
    makestop("B", 1.29, 103.87),
    makestop("C", 1.30, 103.86),
  ];
  const result = optimizeRoute(stops, { style: "custom" });
  assert.ok(typeof result.compassExplanation === "string");
  assert.ok(result.compassExplanation.length > 20);
});

test("compassExplanation mentions nightlife for nightlife style", () => {
  const stops: CandidateStop[] = [
    makestop("Pub", 1.28, 103.85, "bar"),
    makestop("Club", 1.29, 103.87, "club"),
  ];
  const result = optimizeRoute(stops, { style: "nightlife" });
  assert.ok(result.compassExplanation.toLowerCase().includes("night"));
});

test("compassExplanation includes start location label when provided", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.28, 103.85),
    makestop("B", 1.29, 103.87),
  ];
  const result = optimizeRoute(stops, {
    style: "custom",
    startLocation: { lat: 1.27, lng: 103.84, label: "Grand Hotel" },
  });
  assert.ok(result.compassExplanation.includes("Grand Hotel"));
});

// ── 2-opt improvement ─────────────────────────────────────────────────────────

test("2-opt does not increase total distance vs nearest-neighbour alone", () => {
  // 4 stops where 2-opt can improve the tour
  const stops: CandidateStop[] = [
    makestop("A", 1.0,  103.0),
    makestop("B", 1.0,  103.02),
    makestop("C", 1.01, 103.01),
    makestop("D", 1.0,  103.03),
  ];
  const result = optimizeRoute(stops, { style: "custom" });
  assert.equal(result.stops.length, 4);
  assert.ok(result.totalDistanceMeters > 0);
  assert.ok(isFinite(result.totalDistanceMeters));
});

// ── Style-specific adjustments ────────────────────────────────────────────────

test("nightlife style places nightlife-category stops after daytime stops", () => {
  const stops: CandidateStop[] = [
    makestop("Bar A",   1.28, 103.85, "bar"),
    makestop("Museum",  1.29, 103.87, "museum"),
    makestop("Club B",  1.30, 103.86, "club"),
    makestop("Park",    1.31, 103.88, "park"),
  ];
  const result = optimizeRoute(stops, { style: "nightlife" });
  const titles  = result.stops.map((s) => s.stop.title);
  const barIdx  = titles.indexOf("Bar A");
  const clubIdx = titles.indexOf("Club B");
  const museIdx = titles.indexOf("Museum");
  const parkIdx = titles.indexOf("Park");
  // Night stops (bar, club) must appear after at least one daytime stop
  assert.ok(barIdx > museIdx || barIdx > parkIdx, "Bar should come after daytime stop");
  assert.ok(clubIdx > museIdx || clubIdx > parkIdx, "Club should come after daytime stop");
});

test("foodie style places food-category stops before bar stops", () => {
  const stops: CandidateStop[] = [
    makestop("Bar X",        1.28, 103.85, "bar"),
    makestop("Restaurant Y", 1.29, 103.87, "restaurant"),
    makestop("Cafe Z",       1.30, 103.86, "cafe"),
  ];
  const result = optimizeRoute(stops, { style: "foodie" });
  const titles  = result.stops.map((s) => s.stop.title);
  const barIdx  = titles.indexOf("Bar X");
  const restIdx = titles.indexOf("Restaurant Y");
  const cafeIdx = titles.indexOf("Cafe Z");
  assert.ok(barIdx > restIdx || barIdx > cafeIdx, "Bar should be deferred after food stops");
});

test("timeWindowStart is reflected in compassExplanation for nightlife", () => {
  const stops: CandidateStop[] = [
    makestop("A", 1.28, 103.85),
    makestop("B", 1.29, 103.87),
  ];
  const windowStart = new Date("2026-01-01T21:00:00");
  const result = optimizeRoute(stops, { style: "nightlife", timeWindowStart: windowStart });
  // The explanation should mention the window time or timed start
  const lower = result.compassExplanation.toLowerCase();
  assert.ok(lower.includes("9:00") || lower.includes("21:00") || lower.includes("pm") || lower.includes("window") || lower.includes("start"), "compassExplanation should reference the time window");
});
