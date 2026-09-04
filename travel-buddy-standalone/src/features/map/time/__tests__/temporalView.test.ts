/**
 * buildTemporalView — Map spec §15: the join between the producer's per-offset
 * payload and the §15 UI.
 *
 * The defect it closes: `toTemporalObjects` used to be handed the NOW map and
 * asked to relabel it, so a forecast offset would put a forecast badge on live
 * objects (§37). buildTemporalView is fed the REAL per-offset payload instead —
 * predictions for the future, observed history for the past — and:
 *
 *   • forecast objects stay `prediction`, carry no observedAt, never live;
 *   • an offset with nothing to show yields an EMPTY timeline (CityTimeline's
 *     honest "no city trend" state), not a blank that reads as "all quiet";
 *   • forecastConfidence is the WEAKEST among forecasts (fail-closed).
 *
 * Run: node --import tsx/esm --test src/features/map/time/__tests__/temporalView.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildTemporalView } from '../temporalView.ts';
import { NOW_OFFSET, offsetKey, type TimeOffset } from '../timeMachine.ts';
import { point, type MapObject } from '../../../../types/mapObjects.ts';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const PLUS_60: TimeOffset = { kind: 'relative', minutes: 60 };

/** A future prediction as the temporal producer emits it. */
function predictionObject(id: string, confidence: MapObject['confidence']): MapObject {
  return {
    id,
    kind: 'prediction',
    geometry: point(16.05, 108.2),
    title: 'Expected',
    confidence,
    privacyClass: 'place_level',
    renderingPriority: 50,
  };
}

describe('buildTemporalView — forecast payload', () => {
  it('keeps producer predictions as forecasts (kind prediction, no observedAt, not live)', () => {
    const objects = [predictionObject('prediction:event:e1', 'strong')];
    const view = buildTemporalView(objects, PLUS_60, { now: NOW });
    assert.equal(view.objects.length, 1);
    const o = view.objects[0];
    assert.equal(o.temporalMode, 'forecast');
    assert.equal(o.kind, 'prediction');
    assert.equal((o as { observedAt?: string }).observedAt, undefined);
    assert.notEqual(o.freshness, 'live');
  });

  it('reports the WEAKEST forecast confidence for the control badge', () => {
    const objects = [
      predictionObject('prediction:event:e1', 'strong'),
      predictionObject('prediction:zone:z1', 'provisional'),
    ];
    const view = buildTemporalView(objects, PLUS_60, { now: NOW });
    assert.equal(view.forecastConfidence, 'provisional');
  });

  it('an empty offset yields an empty timeline (honest empty state) and null confidence', () => {
    const view = buildTemporalView([], PLUS_60, { now: NOW });
    assert.equal(view.objects.length, 0);
    assert.equal(view.timeline.bands.length, 0);
    assert.equal(view.forecastConfidence, null);
    // The timeline still carries the offset so the UI can label its empty state.
    assert.equal(view.timeline.offsetKey, offsetKey(PLUS_60));
  });
});

describe('buildTemporalView — NOW payload', () => {
  it('leaves NOW objects as observations (no forecast badge, no confidence)', () => {
    const observed: MapObject = {
      id: 'place:p1',
      kind: 'place',
      geometry: point(16.05, 108.2),
      title: 'A place',
      confidence: 'live',
      freshness: 'live',
      privacyClass: 'place_level',
      renderingPriority: 40,
    };
    const view = buildTemporalView([observed], NOW_OFFSET, { now: NOW });
    assert.equal(view.objects[0].temporalMode, 'now');
    assert.equal(view.objects[0].kind, 'place');
    assert.equal(view.forecastConfidence, null);
  });
});
