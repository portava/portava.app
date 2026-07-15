/**
 * Tests for the map-travelers privacy core: eligibility (who appears),
 * coarsening (where markers sit), and freshness bucketing.
 *
 * Run: npx tsx --test src/test/mapTravelers.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveDiscoveryVisibility,
  coarsenPosition,
  freshnessBucket,
  hash01,
} from "../lib/mapTravelers";

// ── effectiveDiscoveryVisibility — the opt-in gate ───────────────────────────

test("missing prefs row → product default city_only (visible at city precision)", () => {
  assert.equal(effectiveDiscoveryVisibility(null), "city_only");
  assert.equal(effectiveDiscoveryVisibility(undefined), "city_only");
  assert.equal(effectiveDiscoveryVisibility({}), "city_only");
});

test("location_mode off → hidden, regardless of overrides", () => {
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "off" }), null);
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "off", discovery_visibility: "neighborhood" }),
    null,
  );
});

test("sharing_paused → hidden, regardless of mode", () => {
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "nearby", sharing_paused: true }),
    null,
  );
});

test("explicit no_location override → hidden", () => {
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "nearby", discovery_visibility: "no_location" }),
    null,
  );
});

test("mode defaults map to expected precision", () => {
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "city_only" }), "city_only");
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "nearby" }), "neighborhood");
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "live_during_activity" }),
    "neighborhood",
  );
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "trusted_circle_live" }),
    "venue_tagged",
  );
});

test("explicit discovery_visibility override wins over mode default", () => {
  assert.equal(
    effectiveDiscoveryVisibility({ location_mode: "city_only", discovery_visibility: "neighborhood" }),
    "neighborhood",
  );
});

test("unknown mode value → safe default city_only, not a crash", () => {
  assert.equal(effectiveDiscoveryVisibility({ location_mode: "something_new" }), "city_only");
});

// ── coarsenPosition — no precise coordinates ever ─────────────────────────────

test("area coarsening: output is inside the ~2.2km cell but not the raw point", () => {
  const raw = { lat: 10.31672, lng: 123.89071 }; // Cebu-ish
  const out = coarsenPosition("user-a", raw.lat, raw.lng, "neighborhood");
  assert.equal(out.precision, "area");
  // Same 0.02° cell…
  assert.equal(Math.floor(out.lat / 0.02), Math.floor(raw.lat / 0.02));
  assert.equal(Math.floor(out.lng / 0.02), Math.floor(raw.lng / 0.02));
  // …but never off the cell edges (0.15–0.85 of the cell).
  const fracLat = out.lat / 0.02 - Math.floor(out.lat / 0.02);
  assert.ok(fracLat >= 0.14 && fracLat <= 0.86, `fracLat ${fracLat}`);
});

test("city coarsening uses the ~11km grid", () => {
  const out = coarsenPosition("user-a", 10.31672, 123.89071, "city_only");
  assert.equal(out.precision, "city");
  assert.equal(Math.floor(out.lat / 0.1), Math.floor(10.31672 / 0.1));
});

test("coarsening is deterministic per user and differs between users", () => {
  const a1 = coarsenPosition("user-a", 10.316, 123.89, "neighborhood");
  const a2 = coarsenPosition("user-a", 10.316, 123.89, "neighborhood");
  const b = coarsenPosition("user-b", 10.316, 123.89, "neighborhood");
  assert.deepEqual(a1, a2);
  assert.notDeepEqual({ lat: a1.lat, lng: a1.lng }, { lat: b.lat, lng: b.lng });
});

test("tiny raw movements inside one cell do NOT move the marker (no averaging attack)", () => {
  const p1 = coarsenPosition("user-a", 10.3161, 123.8901, "neighborhood");
  const p2 = coarsenPosition("user-a", 10.3169, 123.8909, "neighborhood");
  assert.deepEqual(p1, p2);
});

test("venue_tagged and exact_hidden are still capped at area precision", () => {
  for (const vis of ["venue_tagged", "exact_hidden"]) {
    const out = coarsenPosition("user-a", 10.31672, 123.89071, vis);
    assert.equal(out.precision, "area");
    assert.notEqual(out.lat, 10.31672);
  }
});

// ── freshnessBucket — coarse buckets only, stale users drop off ───────────────

test("freshness buckets: live < 15min, recent < 60min, stale → null", () => {
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.equal(freshnessBucket(iso(5 * 60 * 1000), now), "live");
  assert.equal(freshnessBucket(iso(30 * 60 * 1000), now), "recent");
  assert.equal(freshnessBucket(iso(90 * 60 * 1000), now), null);
  assert.equal(freshnessBucket(null, now), null);
  assert.equal(freshnessBucket("not-a-date", now), null);
});

// ── hash01 sanity ─────────────────────────────────────────────────────────────

test("hash01 is deterministic, in [0,1), and spreads across seeds", () => {
  assert.equal(hash01("abc"), hash01("abc"));
  const vals = ["a", "b", "c", "d", "e"].map(hash01);
  for (const v of vals) assert.ok(v >= 0 && v < 1);
  assert.ok(new Set(vals.map((v) => v.toFixed(3))).size >= 4);
});
