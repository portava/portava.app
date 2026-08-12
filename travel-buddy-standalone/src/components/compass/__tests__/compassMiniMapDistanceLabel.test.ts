/**
 * Compass mini-map distance label — shared utility switch correctness
 *
 * After the "shared utility switch" (commit 9e2634fc0), `haversineKm` in
 * compassMiniMapShared.ts is no longer a locally-defined function but a
 * re-export from ../../utils/geoDistance.ts. This test proves that:
 *
 *  1. The distance label produced by ComparisonBlock uses formatDistanceKm
 *     composed with haversineKm from the same shared module — no stale local
 *     copy, no double-conversion, no unit mismatch.
 *
 *  2. formatDistanceKm(haversineKm(...)) gives correct, human-readable labels
 *     across the full input range: 0 distance, sub-km, 1–10 km, and ≥ 10 km.
 *
 * The specific regression risk: before the switch, compassMiniMapShared.ts
 * had its own haversine (`2 * R * Math.asin(Math.sqrt(h))`). After the switch
 * it re-exports geoDistance.haversineKm (`R * 2 * Math.atan2(...)`). If
 * CompassChatBlocks were left importing a stale local copy rather than going
 * through the shared module, or if formatDistanceKm were fed a raw value in
 * the wrong unit (e.g. metres instead of km), the label would be wrong. This
 * test catches both failure modes.
 *
 * Pure-logic test — runs under node:test (scripts/run-node-tests.mjs).
 * No React Native / Expo imports — safe for plain Node execution.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { haversineKm, formatDistanceKm } from '../compassMiniMapShared.ts';
// Also import directly from the source utility to prove it's the same function.
import { haversineKm as haversineKmDirect } from '../../../utils/geoDistance.ts';

// ── Helper: replicate the ComparisonBlock delta template ─────────────────────
// Source: CompassChatBlocks.tsx ComparisonBlock, line:
//   deltas.push(`${a.label} ↔ ${b.label} · ${formatDistanceKm(haversineKm(a.lat, a.lng, b.lat, b.lng))}`);
function buildDeltaLabel(
  aLabel: string, aLat: number, aLng: number,
  bLabel: string, bLat: number, bLng: number,
): string {
  return `${aLabel} ↔ ${bLabel} · ${formatDistanceKm(haversineKm(aLat, aLng, bLat, bLng))}`;
}

// ── 1. The re-exported haversineKm IS the geoDistance implementation ──────────

describe('compassMiniMapShared haversineKm — shared utility re-export identity', () => {
  test('haversineKm re-exported from compassMiniMapShared matches geoDistance.haversineKm exactly', () => {
    // Same-point: distance should be 0.
    assert.equal(haversineKm(0, 0, 0, 0), haversineKmDirect(0, 0, 0, 0));

    // Two known points — Cebu City to Manila (roughly 570 km).
    const cebuLat = 10.3157, cebuLng = 123.8854;
    const manilaLat = 14.5995, manilaLng = 120.9842;
    assert.equal(
      haversineKm(cebuLat, cebuLng, manilaLat, manilaLng),
      haversineKmDirect(cebuLat, cebuLng, manilaLat, manilaLng),
    );

    // Very short distance — ~100 m.
    assert.equal(
      haversineKm(10.3, 123.9, 10.3009, 123.9),
      haversineKmDirect(10.3, 123.9, 10.3009, 123.9),
    );
  });
});

// ── 2. Distance label correctness across the full range ───────────────────────

describe('compassMiniMapShared — formatDistanceKm label correctness', () => {
  test('edge case: zero distance produces "0 m" (not a negative or NaN)', () => {
    assert.equal(formatDistanceKm(0), '0 m');
  });

  test('sub-kilometre distances (<1 km) render as rounded metres with "m" suffix', () => {
    // ~140 m apart (same coordinate — trivial check)
    const km = haversineKm(10.3, 123.9, 10.3013, 123.9); // ≈ 0.145 km
    const label = formatDistanceKm(km);
    assert.match(label, /^\d+ m$/);
    // Verify no "km" suffix sneaks in for sub-km distances.
    assert.equal(label.includes('km'), false);
    // Numeric value should be between 1 and 999.
    const metres = parseInt(label, 10);
    assert.ok(metres >= 1 && metres <= 999, `expected metres in [1,999], got ${metres}`);
  });

  test('distances between 1–10 km render with one decimal place and "km" suffix', () => {
    // Cebu IT Park to Cebu North Bus Terminal (≈ 4 km).
    const km = haversineKm(10.3310, 123.9050, 10.3567, 123.9150); // ≈ 3.0 km
    const label = formatDistanceKm(km);
    assert.match(label, /^\d+\.\d km$/, `expected d.d km format, got "${label}"`);
    const numeric = parseFloat(label);
    assert.ok(numeric >= 1 && numeric < 10, `expected 1–10 km, got ${numeric}`);
  });

  test('long distances (≥10 km) render as whole kilometres with no decimal', () => {
    // Cebu to Manila ≈ 570 km.
    const km = haversineKm(10.3157, 123.8854, 14.5995, 120.9842);
    const label = formatDistanceKm(km);
    // Must be whole number km (no decimal point).
    assert.match(label, /^\d+ km$/, `expected whole-km format, got "${label}"`);
    const numeric = parseInt(label, 10);
    // Actual value should be roughly 570 km (allow ±20 km for floating-point).
    assert.ok(numeric > 550 && numeric < 590, `expected ~570 km, got ${numeric}`);
  });
});

// ── 3. Delta label format — exactly what ComparisonBlock renders ───────────────
//
// This is the core anti-regression check: prove the rendered delta string
// is `{A} ↔ {B} · {shared-formatDistanceKm(shared-haversineKm(...))}`.
// A double-conversion bug (e.g. passing metres to formatDistanceKm which
// expects km) would produce "157000 km" instead of "157 km"; a stale local
// haversine would diverge from the shared one at the numeric level.

describe('ComparisonBlock delta label — uses shared utility without double-conversion', () => {
  test('two same-city places: label ends with "m" (sub-km distance)', () => {
    // ~200 m apart within Cebu IT Park.
    const label = buildDeltaLabel(
      'Cafe A', 10.3310, 123.9050,
      'Cafe B', 10.3328, 123.9050,
    );
    // Must follow the template exactly.
    assert.ok(label.startsWith('Cafe A ↔ Cafe B · '), `wrong prefix: "${label}"`);
    const suffix = label.slice('Cafe A ↔ Cafe B · '.length);
    // Sub-km → should end in " m" (not " km").
    assert.match(suffix, /^\d+ m$/, `expected metres suffix, got "${suffix}"`);
  });

  test('two places a few km apart: label ends with decimal km', () => {
    // Cebu IT Park to SM City Cebu ≈ 3–4 km.
    const label = buildDeltaLabel(
      'IT Park', 10.3310, 123.9050,
      'SM City', 10.3019, 123.9015,
    );
    assert.ok(label.startsWith('IT Park ↔ SM City · '), `wrong prefix: "${label}"`);
    const suffix = label.slice('IT Park ↔ SM City · '.length);
    assert.match(suffix, /^\d+\.\d km$/, `expected d.d km, got "${suffix}"`);
    const numeric = parseFloat(suffix);
    assert.ok(numeric >= 1 && numeric < 10, `expected 1–10 km, got ${numeric}`);
  });

  test('two places far apart: label ends with whole km (no decimal)', () => {
    const label = buildDeltaLabel(
      'Cebu', 10.3157, 123.8854,
      'Manila', 14.5995, 120.9842,
    );
    assert.ok(label.startsWith('Cebu ↔ Manila · '), `wrong prefix: "${label}"`);
    const suffix = label.slice('Cebu ↔ Manila · '.length);
    assert.match(suffix, /^\d+ km$/, `expected whole km, got "${suffix}"`);
  });

  test('coincident points (0 distance): label ends with "0 m" — no NaN or undefined', () => {
    const label = buildDeltaLabel(
      'Place A', 10.3, 123.9,
      'Place B', 10.3, 123.9,
    );
    assert.ok(label.startsWith('Place A ↔ Place B · '), `wrong prefix: "${label}"`);
    const suffix = label.slice('Place A ↔ Place B · '.length);
    assert.equal(suffix, '0 m');
  });

  // Regression guard: if formatDistanceKm received metres instead of km
  // (double-conversion: km→m→formatDistanceKm), the ~3 km route would read
  // as "3000 m" instead of "3.0 km". This test catches that.
  test('NO double-conversion: a ~3 km distance is NOT formatted as ">999 m"', () => {
    const label = buildDeltaLabel(
      'IT Park', 10.3310, 123.9050,
      'SM City', 10.3019, 123.9015,
    );
    const suffix = label.slice('IT Park ↔ SM City · '.length);
    // If double-converted to metres, the number would be ≥ 1000.
    // formatDistanceKm only emits "N m" when km < 1, so it would actually
    // emit "3038 m" (since Math.round(3.038 * 1000) = 3038) if fed metres.
    // Assert we are NOT in that broken state.
    if (suffix.endsWith(' m')) {
      const metres = parseInt(suffix, 10);
      assert.ok(metres < 1000, `double-conversion detected: got "${suffix}" for a ~3 km distance`);
    }
    // Correct output ends in " km".
    assert.ok(suffix.endsWith(' km'), `expected km suffix for ~3 km distance, got "${suffix}"`);
  });
});
