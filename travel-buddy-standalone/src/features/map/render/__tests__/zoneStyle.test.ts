/**
 * Tests for §6's semantic visual language.
 *
 * The load-bearing tests here are the EXHAUSTIVE ones. §37's "Do not make
 * predictions look like observations" is not a property you can spot-check —
 * one unlucky combination of activity, trend, confidence and freshness that
 * slips through and a forecast is drawn as a measurement. So the forecast
 * guarantee is asserted over the full cross-product of every declared value on
 * every axis (6 × 6 × 5 × 6 = 1080 states), and so is the §6 rule that a zone
 * never gets a hard stroke.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_RAMP,
  ARROW_DIRECTIONS,
  DEFAULT_ACTIVITY,
  FLOW_STATES,
  FLOW_STATE_LABELS,
  FORECAST_DASH_ARRAY,
  INFERRED_CAUSE_STYLE,
  MAX_FILL_OPACITY,
  MAX_ZONE_OUTLINE_OPACITY,
  MEANINGFUL_CHANGE_TRENDS,
  MIN_FILL_OPACITY,
  MIN_ZONE_OUTLINE_BLUR_PX,
  OUTLINE_STYLES,
  SOCIAL_RAMP,
  ZONE_KINDS,
  flowStateOf,
  flowStateStyle,
  inferredCauseStyle,
  isZoneKind,
  resolveArrowDirection,
  resolveOutlineStyle,
  zoneStyle,
  zoneStyleForObject,
} from '../zoneStyle.ts';
import type { FlowState } from '../zoneStyle.ts';
import {
  ACTIVITY_LEVELS,
  CONFIDENCE_STATES,
  FRESHNESS_STATES,
  MAP_OBJECT_KINDS,
  TREND_STATES,
  isForecastKind,
  point,
} from '../../../../types/mapObjects.ts';
import type {
  ActivityLevel,
  ConfidenceState,
  FreshnessState,
  MapObject,
  MapObjectKind,
  TrendState,
} from '../../../../types/mapObjects.ts';

/** Every (activity, trend, confidence, freshness) combination, plus undefined. */
function* allStates(): Generator<{
  activity?: ActivityLevel;
  trend?: TrendState;
  confidence?: ConfidenceState;
  freshness?: FreshnessState;
}> {
  const activities: (ActivityLevel | undefined)[] = [undefined, ...ACTIVITY_LEVELS];
  const trends: (TrendState | undefined)[] = [undefined, ...TREND_STATES];
  const confidences: (ConfidenceState | undefined)[] = [undefined, ...CONFIDENCE_STATES];
  const freshnesses: (FreshnessState | undefined)[] = [undefined, ...FRESHNESS_STATES];
  for (const activity of activities) {
    for (const trend of trends) {
      for (const confidence of confidences) {
        for (const freshness of freshnesses) {
          yield { activity, trend, confidence, freshness };
        }
      }
    }
  }
}

const HEX = /^#[0-9A-Fa-f]{6}$/;

// ── Vocabulary shape ──────────────────────────────────────────────────────────

test('the vocabulary is exactly §6: three outline treatments, four arrow states', () => {
  assert.deepEqual([...OUTLINE_STYLES], ['solid', 'pulsing', 'dashed']);
  assert.deepEqual([...ARROW_DIRECTIONS], ['none', 'forward', 'reverse', 'outward']);
  assert.deepEqual([...FLOW_STATES], ['strong', 'moderate', 'emerging', 'dispersing', 'unusual']);
});

test('isZoneKind covers the four area kinds and nothing else', () => {
  for (const kind of MAP_OBJECT_KINDS) {
    assert.equal(
      isZoneKind(kind),
      (ZONE_KINDS as readonly MapObjectKind[]).includes(kind),
      kind,
    );
  }
});

test('both ramps define every activity level as a valid hex pair', () => {
  for (const level of ACTIVITY_LEVELS) {
    for (const [name, ramp] of [['activity', ACTIVITY_RAMP], ['social', SOCIAL_RAMP]] as const) {
      const entry = ramp[level];
      assert.ok(entry, `${name}/${level} missing`);
      assert.match(entry.fill, HEX, `${name}/${level} fill`);
      assert.match(entry.outline, HEX, `${name}/${level} outline`);
      assert.ok(entry.baseFillOpacity > 0 && entry.baseFillOpacity <= MAX_FILL_OPACITY);
    }
  }
});

test('fill opacity rises monotonically with activity in both ramps', () => {
  for (const ramp of [ACTIVITY_RAMP, SOCIAL_RAMP]) {
    for (let i = 1; i < ACTIVITY_LEVELS.length; i += 1) {
      assert.ok(
        ramp[ACTIVITY_LEVELS[i]].baseFillOpacity > ramp[ACTIVITY_LEVELS[i - 1]].baseFillOpacity,
        `${ACTIVITY_LEVELS[i]} must be heavier than ${ACTIVITY_LEVELS[i - 1]}`,
      );
    }
  }
});

test('social zones use a different hue family from activity zones', () => {
  // §39: "What is happening?" and "Who is relevant?" are different questions
  // and must not be answered in the same colour.
  for (const level of ACTIVITY_LEVELS) {
    assert.notEqual(ACTIVITY_RAMP[level].fill, SOCIAL_RAMP[level].fill, level);
  }
  const social = zoneStyle({ kind: 'social_zone', activity: 'busy' });
  const activity = zoneStyle({ kind: 'activity_zone', activity: 'busy' });
  assert.notEqual(social.fillColor, activity.fillColor);
  assert.equal(zoneStyle({ kind: 'buddy_zone', activity: 'busy' }).fillColor, social.fillColor);
});

// ── §37: a forecast can never look like an observation ────────────────────────

test('§37: a forecast is structurally incapable of a solid outline (exhaustive)', () => {
  const forecastKinds = MAP_OBJECT_KINDS.filter(isForecastKind);
  assert.ok(forecastKinds.length > 0, 'no forecast kinds declared');

  let checked = 0;
  for (const kind of forecastKinds) {
    for (const state of allStates()) {
      const s = zoneStyle({ kind, ...state });
      assert.equal(s.outlineStyle, 'dashed', `${kind} ${JSON.stringify(state)}`);
      assert.notEqual(s.outlineStyle, 'solid');
      assert.ok(s.dashArray != null && s.dashArray.length > 0);
      assert.equal(s.pulse, null, 'a forecast must not pulse either');
      assert.equal(s.isForecast, true);
      // The raw predicate agrees with the composed style.
      assert.equal(resolveOutlineStyle(kind, state.trend, state.freshness), 'dashed');
      checked += 1;
    }
  }
  assert.ok(checked >= 1000, `only ${checked} states checked`);
});

test('§37: a forecast is labelled as predicted and dimmer than the same observation', () => {
  const input = { activity: 'busy', trend: 'getting_busier', confidence: 'strong', freshness: 'live' } as const;
  const predicted = zoneStyle({ kind: 'prediction', ...input });
  const observed = zoneStyle({ kind: 'activity_zone', ...input });
  assert.ok(predicted.legend.startsWith('Predicted · '), predicted.legend);
  assert.ok(!observed.legend.includes('Predicted'));
  assert.ok(predicted.fillOpacity < observed.fillOpacity);
  assert.ok(predicted.outlineOpacity < observed.outlineOpacity);
});

test('a non-forecast zone never returns a dash array', () => {
  for (const kind of ZONE_KINDS) {
    if (isForecastKind(kind)) continue;
    for (const state of allStates()) {
      const s = zoneStyle({ kind, ...state });
      assert.equal(s.dashArray, null, `${kind} ${JSON.stringify(state)}`);
      assert.notEqual(s.outlineStyle, 'dashed');
    }
  }
});

test('dashArray is non-null exactly when the outline is dashed, and pulse when pulsing', () => {
  for (const kind of ZONE_KINDS) {
    for (const state of allStates()) {
      const s = zoneStyle({ kind, ...state });
      assert.equal(s.dashArray != null, s.outlineStyle === 'dashed');
      assert.equal(s.pulse != null, s.outlineStyle === 'pulsing');
    }
  }
  assert.deepEqual(
    zoneStyle({ kind: 'prediction' }).dashArray,
    FORECAST_DASH_ARRAY,
  );
});

// ── §6: pulsing outline = meaningful recent change ────────────────────────────

test('§6: a live zone with a meaningful change pulses', () => {
  for (const trend of MEANINGFUL_CHANGE_TRENDS) {
    const s = zoneStyle({ kind: 'activity_zone', trend, freshness: 'live', confidence: 'strong' });
    assert.equal(s.outlineStyle, 'pulsing', trend);
    assert.ok(s.pulse != null);
    assert.ok(s.pulse.periodMs > 0);
    assert.ok(s.pulse.minOpacity < s.pulse.maxOpacity);
    assert.ok(s.pulse.maxOpacity <= MAX_ZONE_OUTLINE_OPACITY);
  }
});

test('§32: a stable or merely cooling zone does not pulse', () => {
  for (const trend of ['stable', 'cooling'] as const) {
    const s = zoneStyle({ kind: 'activity_zone', trend, freshness: 'live', confidence: 'strong' });
    assert.equal(s.outlineStyle, 'solid', trend);
    assert.equal(s.pulse, null);
  }
});

test('§37: a stale zone never pulses, however dramatic its trend', () => {
  for (const freshness of ['aging', 'stale', 'historical', 'unknown'] as const) {
    for (const trend of TREND_STATES) {
      const s = zoneStyle({ kind: 'activity_zone', trend, freshness, confidence: 'strong' });
      assert.equal(s.outlineStyle, 'solid', `${freshness}/${trend}`);
      assert.equal(s.pulse, null);
    }
  }
  // Missing freshness is the fail-closed case: also no pulse.
  assert.equal(zoneStyle({ kind: 'activity_zone', trend: 'increasing_quickly' }).pulse, null);
});

// ── §6: zones do not imply exact borders ──────────────────────────────────────

test('§6: no zone state produces a hard stroke or a saturated plate (exhaustive)', () => {
  for (const kind of ZONE_KINDS) {
    for (const state of allStates()) {
      const s = zoneStyle({ kind, ...state });
      const where = `${kind} ${JSON.stringify(state)}`;
      assert.ok(s.outlineOpacity <= MAX_ZONE_OUTLINE_OPACITY, `${where} outlineOpacity ${s.outlineOpacity}`);
      assert.ok(s.outlineBlurPx >= MIN_ZONE_OUTLINE_BLUR_PX, `${where} outlineBlurPx`);
      assert.ok(s.fillBlurPx > 0, `${where} fillBlurPx`);
      assert.ok(s.fillOpacity >= MIN_FILL_OPACITY, `${where} fillOpacity floor`);
      assert.ok(s.fillOpacity <= MAX_FILL_OPACITY, `${where} fillOpacity ceiling`);
      assert.ok(s.outlineWidth > 0 && s.outlineWidth <= 3, `${where} outlineWidth`);
      assert.match(s.fillColor, HEX, `${where} fillColor`);
      assert.match(s.outlineColor, HEX, `${where} outlineColor`);
    }
  }
});

test('weakening confidence or freshness only ever dims a zone', () => {
  const base = { kind: 'activity_zone', activity: 'busy', freshness: 'live' } as const;
  let previous = Infinity;
  for (const confidence of [...CONFIDENCE_STATES].reverse()) {
    const s = zoneStyle({ ...base, confidence });
    assert.ok(s.fillOpacity <= previous + 1e-12, `confidence ${confidence} brightened`);
    previous = s.fillOpacity;
  }
  previous = Infinity;
  for (const freshness of ['live', 'recent', 'aging', 'stale', 'historical'] as const) {
    const s = zoneStyle({ kind: 'activity_zone', activity: 'busy', confidence: 'strong', freshness });
    assert.ok(s.fillOpacity <= previous + 1e-12, `freshness ${freshness} brightened`);
    previous = s.fillOpacity;
  }
});

test('an unknown-freshness zone is not brighter than an explicitly stale one', () => {
  const unknown = zoneStyle({ kind: 'activity_zone', activity: 'busy', confidence: 'strong', freshness: 'unknown' });
  const stale = zoneStyle({ kind: 'activity_zone', activity: 'busy', confidence: 'strong', freshness: 'stale' });
  assert.ok(unknown.fillOpacity <= stale.fillOpacity);
});

test('a missing activity level falls back to the documented default', () => {
  const missing = zoneStyle({ kind: 'activity_zone', confidence: 'strong', freshness: 'live' });
  const explicit = zoneStyle({ kind: 'activity_zone', activity: DEFAULT_ACTIVITY, confidence: 'strong', freshness: 'live' });
  assert.deepEqual(missing, explicit);
});

// ── §6: directional arrows ────────────────────────────────────────────────────

test('§6: only crowd_flow carries arrows', () => {
  for (const kind of MAP_OBJECT_KINDS) {
    for (const trend of [undefined, ...TREND_STATES]) {
      const dir = resolveArrowDirection(kind, trend);
      if (kind === 'crowd_flow') assert.notEqual(dir, 'none', `${kind}/${trend}`);
      else assert.equal(dir, 'none', `${kind}/${trend}`);
    }
  }
  assert.equal(zoneStyle({ kind: 'activity_zone' }).arrowDirection, 'none');
});

test('a dispersal radiates outward rather than pointing at a destination', () => {
  assert.equal(resolveArrowDirection('crowd_flow', 'rapidly_dispersing'), 'outward');
  assert.equal(resolveArrowDirection('crowd_flow', 'getting_quieter'), 'outward');
  assert.equal(resolveArrowDirection('crowd_flow', 'increasing_quickly'), 'forward');
  assert.equal(resolveArrowDirection('crowd_flow', 'stable'), 'forward');
  assert.equal(resolveArrowDirection('crowd_flow', undefined), 'forward');
});

// ── §10 flow states ───────────────────────────────────────────────────────────

test('§10: every flow state has a complete observed style', () => {
  for (const state of FLOW_STATES) {
    const s = flowStateStyle(state);
    assert.match(s.lineColor, HEX, state);
    assert.ok(s.lineWidth > 0 && s.lineOpacity > 0 && s.lineOpacity <= 1, state);
    assert.ok(s.arrowSpacingPx > 0 && s.arrowOpacity > 0, state);
    assert.equal(s.representation, 'observed', state);
    assert.equal(s.label, FLOW_STATE_LABELS[state]);
  }
});

test('§6: no observed flow state borrows the forecast dash vocabulary', () => {
  for (const state of FLOW_STATES) {
    assert.equal(flowStateStyle(state).lineDashArray, null, state);
  }
});

test('flow strength is carried by width and opacity, monotonically', () => {
  const strong = flowStateStyle('strong');
  const moderate = flowStateStyle('moderate');
  const emerging = flowStateStyle('emerging');
  assert.ok(strong.lineWidth > moderate.lineWidth);
  assert.ok(moderate.lineWidth > emerging.lineWidth);
  assert.ok(strong.lineOpacity > moderate.lineOpacity);
  assert.ok(moderate.lineOpacity > emerging.lineOpacity);
  // Denser arrows mean stronger movement.
  assert.ok(strong.arrowSpacingPx < moderate.arrowSpacingPx);
  assert.ok(moderate.arrowSpacingPx < emerging.arrowSpacingPx);
});

test('an unknown flow state degrades to the weakest treatment, not the strongest', () => {
  const fallback = flowStateStyle('nonsense' as FlowState);
  assert.deepEqual(fallback, flowStateStyle('emerging'));
});

test('§10: observed movement and inferred cause are separately represented', () => {
  const observed = flowStateStyle('strong');
  const inferred = inferredCauseStyle();
  assert.equal(observed.representation, 'observed');
  assert.equal(inferred.representation, 'inferred');
  assert.notEqual(observed.representation, inferred.representation);
  // The inference is dashed and pointless — literally: it has no arrows.
  assert.ok(inferred.lineDashArray.length > 0);
  assert.equal(inferred.arrowDirection, 'none');
  // The observed style has no arrowDirection field at all, and the inferred one
  // has no arrow spacing, so neither can be passed where the other is expected.
  assert.equal((observed as unknown as Record<string, unknown>).arrowDirection, undefined);
  assert.equal((inferred as unknown as Record<string, unknown>).arrowSpacingPx, undefined);
  assert.equal(inferred, INFERRED_CAUSE_STYLE);
});

test('flowStateOf derives the §10 state from the projection axes', () => {
  assert.equal(flowStateOf({ anomalous: true, activity: 'peak', confidence: 'strong' }), 'unusual');
  assert.equal(flowStateOf({ trend: 'rapidly_dispersing' }), 'dispersing');
  assert.equal(flowStateOf({ trend: 'getting_quieter' }), 'dispersing');
  assert.equal(flowStateOf({ trend: 'cooling' }), 'dispersing');
  assert.equal(
    flowStateOf({ activity: 'peak', confidence: 'strong', freshness: 'live' }),
    'strong',
  );
  assert.equal(
    flowStateOf({ trend: 'increasing_quickly', confidence: 'live', freshness: 'recent' }),
    'strong',
  );
  assert.equal(flowStateOf({ activity: 'busy' }), 'moderate');
  assert.equal(flowStateOf({}), 'emerging');
  // High confidence but stale evidence must not read as strong movement (§37).
  assert.notEqual(
    flowStateOf({ activity: 'peak', confidence: 'strong', freshness: 'stale' }),
    'strong',
  );
});

test('flowStateOf always returns a declared state', () => {
  for (const state of allStates()) {
    for (const anomalous of [false, true]) {
      const s = flowStateOf({ ...state, anomalous });
      assert.ok(FLOW_STATES.includes(s), JSON.stringify({ ...state, anomalous }));
    }
  }
});

// ── MapObject bridge ──────────────────────────────────────────────────────────

test('zoneStyleForObject reads the five axes off the object', () => {
  const obj: MapObject = {
    id: 'z1',
    kind: 'activity_zone',
    geometry: point(16.05, 108.2),
    title: 'Riverside',
    activity: 'very_busy',
    trend: 'getting_busier',
    confidence: 'strong',
    freshness: 'live',
    privacyClass: 'aggregate_only',
    renderingPriority: 50,
  };
  assert.deepEqual(
    zoneStyleForObject(obj),
    zoneStyle({
      kind: 'activity_zone',
      activity: 'very_busy',
      trend: 'getting_busier',
      confidence: 'strong',
      freshness: 'live',
    }),
  );
  assert.equal(zoneStyleForObject(obj).outlineStyle, 'pulsing');
});

test('zoneStyle is a pure function of its input', () => {
  const input = { kind: 'activity_zone', activity: 'busy', trend: 'stable' } as const;
  assert.deepEqual(zoneStyle({ ...input }), zoneStyle({ ...input }));
});
