/**
 * loadingStrategy tests — §33's ladder and §34's debounce.
 *
 * The load-bearing assertions:
 *   - the ladder never regresses, whatever order responses arrive in;
 *   - there is no rung at which the map is allowed to be blank;
 *   - nothing wears a live treatment before live state has landed (§37);
 *   - shouldRequery needs BOTH a settled camera and a meaningful move, so a
 *     drag across a city is one query, not two hundred (§34).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MIN_SHIFT_FRACTION,
  DEFAULT_MIN_ZOOM_DELTA,
  DEFAULT_REFRESH_AFTER_MS,
  INITIAL_STAGE,
  LOADING_STAGES,
  MAP_LAYERS,
  PERFORMANCE_TARGETS,
  TERMINAL_STAGE,
  advanceStage,
  hasReached,
  haversineKm,
  isStage,
  loadingLadder,
  meetsInitialMapTarget,
  meetsViewportIntelligenceTarget,
  nextStage,
  renderableAt,
  shouldRequery,
  stageRank,
  viewportSpanKm,
  type LoadingStage,
  type Viewport,
} from '../loadingStrategy.ts';

// ── The ladder (§33) ──────────────────────────────────────────────────────────

test('the ladder is exactly §33s sequence', () => {
  assert.deepEqual(LOADING_STAGES, [
    'cached_geography',
    'current_position',
    'canonical',
    'live_state',
    'social_state',
    'compass',
  ]);
  assert.equal(INITIAL_STAGE, 'cached_geography');
  assert.equal(TERMINAL_STAGE, 'compass');
});

test('stageRank is a strict total order along the ladder', () => {
  for (let i = 1; i < LOADING_STAGES.length; i += 1) {
    assert.ok(stageRank(LOADING_STAGES[i]) > stageRank(LOADING_STAGES[i - 1]));
  }
});

test('nextStage walks every rung and terminates at the top', () => {
  const walked: LoadingStage[] = [INITIAL_STAGE];
  let cur: LoadingStage | null = INITIAL_STAGE;
  while ((cur = nextStage(cur as LoadingStage))) walked.push(cur);
  assert.deepEqual(walked, [...LOADING_STAGES]);
  assert.equal(nextStage(TERMINAL_STAGE), null);
});

test('isStage rejects anything not on the ladder', () => {
  assert.equal(isStage('live_state'), true);
  assert.equal(isStage('everything'), false);
});

test('advanceStage NEVER regresses, whatever order responses arrive in', () => {
  assert.equal(advanceStage('cached_geography', 'canonical'), 'canonical');
  // A slow social response landing after Compass must not walk the map back.
  assert.equal(advanceStage('compass', 'social_state'), 'compass');
  assert.equal(advanceStage('live_state', 'cached_geography'), 'live_state');
  assert.equal(advanceStage('canonical', 'canonical'), 'canonical');
});

test('folding the stages in ANY order still ends at the highest reached', () => {
  const shuffles: LoadingStage[][] = [
    ['compass', 'cached_geography', 'live_state', 'canonical'],
    ['canonical', 'compass', 'current_position'],
    ['social_state', 'live_state', 'cached_geography', 'compass', 'canonical'],
  ];
  for (const order of shuffles) {
    let cur: LoadingStage = INITIAL_STAGE;
    let high = 0;
    for (const reached of order) {
      cur = advanceStage(cur, reached);
      assert.ok(stageRank(cur) >= high, 'the ladder went backwards');
      high = stageRank(cur);
    }
    assert.equal(cur, 'compass');
  }
});

test('hasReached gates work off the ladder order', () => {
  assert.equal(hasReached('live_state', 'canonical'), true);
  assert.equal(hasReached('canonical', 'live_state'), false);
  assert.equal(hasReached('canonical', 'canonical'), true);
});

// ── The anti-blank contract ───────────────────────────────────────────────────

test('the map may never blank at ANY rung, and always has layers to draw', () => {
  for (const cap of loadingLadder()) {
    assert.equal(cap.mayBlank, false, `${cap.stage} may not blank (§33)`);
    assert.ok(cap.layers.length > 0, `${cap.stage} must have something to draw`);
  }
});

test('rung one already draws the base map and cached objects', () => {
  const cap = renderableAt('cached_geography');
  assert.deepEqual(cap.layers, ['base_map', 'cached_objects']);
  assert.equal(cap.usable, false, 'not yet oriented — no user position');
});

test('layers are cumulative and monotone up the ladder', () => {
  let prev: readonly string[] = [];
  for (const stage of LOADING_STAGES) {
    const layers = renderableAt(stage).layers;
    for (const earlier of prev) {
      assert.ok(layers.includes(earlier as never), `${stage} dropped layer ${earlier}`);
    }
    assert.ok(layers.length >= prev.length);
    prev = layers;
  }
  assert.deepEqual([...renderableAt('compass').layers].sort(), [...MAP_LAYERS].sort());
});

test('no live treatment and a mandatory cache label below live_state (§37, §28)', () => {
  for (const stage of ['cached_geography', 'current_position', 'canonical'] as LoadingStage[]) {
    const cap = renderableAt(stage);
    assert.equal(cap.liveTreatmentAllowed, false, `${stage} must not render live`);
    assert.equal(cap.requiresCacheLabel, true, `${stage} must carry "Last updated …"`);
  }
  for (const stage of ['live_state', 'social_state', 'compass'] as LoadingStage[]) {
    const cap = renderableAt(stage);
    assert.equal(cap.liveTreatmentAllowed, true);
    assert.equal(cap.requiresCacheLabel, false);
  }
});

test('the map becomes "usable" once geography and position have landed (§34)', () => {
  assert.equal(renderableAt('cached_geography').usable, false);
  assert.equal(renderableAt('current_position').usable, true);
  assert.equal(renderableAt('compass').usable, true);
});

test('crew and social layers appear only at social_state', () => {
  assert.ok(!renderableAt('live_state').layers.includes('crew'));
  assert.ok(renderableAt('social_state').layers.includes('crew'));
  assert.ok(!renderableAt('social_state').layers.includes('compass_recommendations'));
  assert.ok(renderableAt('compass').layers.includes('compass_recommendations'));
});

// ── §34 targets ───────────────────────────────────────────────────────────────

test('the §34 numbers are encoded, not remembered', () => {
  assert.equal(PERFORMANCE_TARGETS.initialUsableMapMs, 2_000);
  assert.equal(PERFORMANCE_TARGETS.viewportIntelligenceMinMs, 500);
  assert.equal(PERFORMANCE_TARGETS.viewportIntelligenceMaxMs, 800);
  assert.equal(PERFORMANCE_TARGETS.cameraSettleMs, 250);
  assert.ok(Math.abs(PERFORMANCE_TARGETS.frameBudgetMs - 16.667) < 0.01);
});

test('target predicates read the right side of the boundary', () => {
  assert.equal(meetsInitialMapTarget(1_900), true);
  assert.equal(meetsInitialMapTarget(2_000), true);
  assert.equal(meetsInitialMapTarget(2_001), false);
  assert.equal(meetsViewportIntelligenceTarget(780), true);
  assert.equal(meetsViewportIntelligenceTarget(1_200), false);
});

// ── Geometry helpers ──────────────────────────────────────────────────────────

test('haversineKm matches known distances', () => {
  assert.equal(haversineKm({ lat: 16.0544, lng: 108.2022 }, { lat: 16.0544, lng: 108.2022 }), 0);
  // ~1 degree of latitude is ~111 km.
  const d = haversineKm({ lat: 16, lng: 108 }, { lat: 17, lng: 108 });
  assert.ok(Math.abs(d - 111.2) < 1, `expected ~111 km, got ${d}`);
});

test('viewportSpanKm shrinks as zoom increases', () => {
  const at = (zoom: number) => viewportSpanKm({ center: { lat: 16.05, lng: 108.2 }, zoom });
  assert.ok(at(10) > at(14));
  assert.ok(at(14) > at(17));
  // Zooming in one level halves the span.
  assert.ok(Math.abs(at(14) / at(15) - 2) < 0.01);
});

// ── shouldRequery (§34) ───────────────────────────────────────────────────────

const CITY: Viewport = { center: { lat: 16.0544, lng: 108.2022 }, zoom: 14, widthPx: 390 };

function moved(v: Viewport, dLat: number, dLng = 0, dZoom = 0): Viewport {
  return {
    center: { lat: v.center.lat + dLat, lng: v.center.lng + dLng },
    zoom: v.zoom + dZoom,
    widthPx: v.widthPx,
  };
}

test('the first query fires immediately — no settle gate on initial load', () => {
  const d = shouldRequery(null, CITY, { settledForMs: 0 });
  assert.equal(d.requery, true);
  assert.equal(d.reason, 'initial');
});

test('a big move mid-gesture does NOT query — the camera must settle first', () => {
  const far = moved(CITY, 0.5);
  const d = shouldRequery(CITY, far, { settledForMs: 40 });
  assert.equal(d.requery, false);
  assert.equal(d.reason, 'camera_moving');
  assert.ok(d.shiftFraction > DEFAULT_MIN_SHIFT_FRACTION, 'the move itself was significant');
});

test('a settled but sub-threshold pan does NOT query (never on every pixel)', () => {
  // ~2 m of movement.
  const nudge = moved(CITY, 0.00002);
  const d = shouldRequery(CITY, nudge, { settledForMs: 5_000 });
  assert.equal(d.requery, false);
  assert.equal(d.reason, 'below_threshold');
  assert.ok(d.shiftFraction < DEFAULT_MIN_SHIFT_FRACTION);
});

test('a settled, significant pan DOES query', () => {
  const span = viewportSpanKm(CITY);
  // Move a full viewport width north.
  const far = moved(CITY, span / 111.2);
  const d = shouldRequery(CITY, far, { settledForMs: PERFORMANCE_TARGETS.cameraSettleMs });
  assert.equal(d.requery, true);
  assert.equal(d.reason, 'significant_pan');
  assert.ok(d.shiftFraction >= DEFAULT_MIN_SHIFT_FRACTION);
});

test('the settle boundary is inclusive at exactly cameraSettleMs', () => {
  const span = viewportSpanKm(CITY);
  const far = moved(CITY, span / 111.2);
  assert.equal(shouldRequery(CITY, far, { settledForMs: 249 }).requery, false);
  assert.equal(shouldRequery(CITY, far, { settledForMs: 250 }).requery, true);
});

test('a settled zoom change queries on its own, with no pan at all', () => {
  const zoomed = moved(CITY, 0, 0, DEFAULT_MIN_ZOOM_DELTA);
  const d = shouldRequery(CITY, zoomed, { settledForMs: 1_000 });
  assert.equal(d.requery, true);
  assert.equal(d.reason, 'zoom_changed');
  assert.equal(d.centerShiftKm, 0);
});

test('a sub-threshold zoom wobble does not query', () => {
  const wobble = moved(CITY, 0, 0, 0.2);
  assert.equal(shouldRequery(CITY, wobble, { settledForMs: 1_000 }).requery, false);
});

test('a two-hundred-frame drag produces exactly ONE query (§34)', () => {
  const span = viewportSpanKm(CITY);
  const totalDeltaLat = (span * 2) / 111.2; // two viewport widths
  let prev = CITY;
  let queries = 0;

  for (let frame = 1; frame <= 200; frame += 1) {
    const cur: Viewport = {
      center: { lat: CITY.center.lat + (totalDeltaLat * frame) / 200, lng: CITY.center.lng },
      zoom: CITY.zoom,
      widthPx: CITY.widthPx,
    };
    // Mid-gesture: the camera has never been at rest.
    const d = shouldRequery(prev, cur, { settledForMs: 0 });
    if (d.requery) {
      queries += 1;
      prev = cur;
    }
  }
  assert.equal(queries, 0, 'not one query during the drag');

  // The gesture ends and the camera settles.
  const settled: Viewport = {
    center: { lat: CITY.center.lat + totalDeltaLat, lng: CITY.center.lng },
    zoom: CITY.zoom,
    widthPx: CITY.widthPx,
  };
  const final = shouldRequery(prev, settled, { settledForMs: 300 });
  assert.equal(final.requery, true);
  assert.equal(final.reason, 'significant_pan');
});

test('the threshold is a FRACTION of the viewport, so it scales with zoom', () => {
  // 300 m of pan: trivial at city zoom, significant at street zoom.
  const dLat = 0.3 / 111.2;
  const city: Viewport = { center: { lat: 16.0544, lng: 108.2022 }, zoom: 12, widthPx: 390 };
  const street: Viewport = { center: { lat: 16.0544, lng: 108.2022 }, zoom: 17, widthPx: 390 };

  assert.equal(shouldRequery(city, moved(city, dLat), { settledForMs: 1_000 }).requery, false);
  assert.equal(shouldRequery(street, moved(street, dLat), { settledForMs: 1_000 }).requery, true);
});

test('a settled, unmoved viewport refreshes once the data goes stale', () => {
  const still = moved(CITY, 0.000001);
  const fresh = shouldRequery(CITY, still, {
    settledForMs: 10_000,
    lastQueryAt: 1_000,
    now: 1_000 + DEFAULT_REFRESH_AFTER_MS - 1,
  });
  assert.equal(fresh.requery, false);

  const aged = shouldRequery(CITY, still, {
    settledForMs: 10_000,
    lastQueryAt: 1_000,
    now: 1_000 + DEFAULT_REFRESH_AFTER_MS,
  });
  assert.equal(aged.requery, true);
  assert.equal(aged.reason, 'refresh_interval');
});

test('the refresh floor can be disabled, and never fires mid-gesture', () => {
  const still = moved(CITY, 0.000001);
  const disabled = shouldRequery(CITY, still, {
    settledForMs: 10_000,
    lastQueryAt: 0,
    now: 10 * DEFAULT_REFRESH_AFTER_MS,
    refreshAfterMs: null,
  });
  assert.equal(disabled.requery, false);

  const moving = shouldRequery(CITY, still, {
    settledForMs: 0,
    lastQueryAt: 0,
    now: 10 * DEFAULT_REFRESH_AFTER_MS,
  });
  assert.equal(moving.requery, false);
  assert.equal(moving.reason, 'camera_moving');
});

test('thresholds are overridable per caller', () => {
  const nudge = moved(CITY, 0.0005);
  assert.equal(shouldRequery(CITY, nudge, { settledForMs: 1_000 }).requery, false);
  assert.equal(
    shouldRequery(CITY, nudge, { settledForMs: 1_000, minShiftFraction: 0.001 }).requery,
    true,
  );
  assert.equal(
    shouldRequery(CITY, moved(CITY, 0, 0, 0.2), { settledForMs: 1_000, minZoomDelta: 0.1 }).requery,
    true,
  );
});

test('every decision reports the numbers it decided on', () => {
  const d = shouldRequery(CITY, moved(CITY, 0.01, 0, 0.1), { settledForMs: 1_000 });
  assert.ok(d.centerShiftKm > 0);
  assert.ok(d.viewportSpanKm > 0);
  assert.ok(Math.abs(d.shiftFraction - d.centerShiftKm / d.viewportSpanKm) < 1e-9);
  assert.ok(Math.abs(d.zoomDelta - 0.1) < 1e-9);
});
