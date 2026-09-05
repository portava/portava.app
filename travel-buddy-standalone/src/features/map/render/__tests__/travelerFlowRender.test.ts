/**
 * §36 Phase 7 on the client: what the renderer will and will not draw.
 *
 * THE THING BEING GUARDED
 * =======================
 * The server publishes a city→city cohort as a BUCKET and never as a number.
 * That is worth nothing if the client will happily render an object carrying an
 * exact count — from a stale cache, a hand-built fixture, or a future server
 * that forgets. So the client refuses one, and this suite is where that refusal
 * is asserted rather than assumed.
 *
 * The refusal is the MIRROR IMAGE of §10's. `CrowdFlowLine` requires
 * `count >= MIN_FLOW_COHORT` — a §10 flow without enough people is not an
 * aggregate. `TravelerFlowLine` requires NO count at all — a Phase 7 edge that
 * names how many people is not bucketed. Both are structural (`count?: never`
 * against a cohort floor), and collapsing the two components into one would
 * have meant deleting one guarantee or making it conditional.
 *
 * Run:
 *   node --import tsx/esm --test src/features/map/render/__tests__/travelerFlowRender.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  UNPUBLISHABLE_BUCKET,
  eligibleTravelerFlows,
  isAggregateEdge,
  isPublishableBucket,
  travelerFlowLabel,
  type TravelerFlowObject,
} from '../../../../components/map/TravelerFlowLine.tsx';
import { eligibleFlows, MIN_FLOW_COHORT } from '../../../../components/map/CrowdFlowLine.tsx';
import { ZONE_KINDS, isZoneKind, zoneStyle } from '../zoneStyle.ts';
import { isKindVisibleAtBand, kindsVisibleAtBand } from '../collision.ts';
import { ACTIVITY_LEVELS, type MapObject } from '../../../../types/mapObjects.ts';
import { LAYER_FOR_KIND, kindsForLayer } from '../../layers/layerModel.ts';

const LINE = {
  type: 'LineString' as const,
  coordinates: [[108.2, 16.05], [100.5, 13.75]] as [number, number][],
};

function edge(over: Partial<TravelerFlowObject> = {}): MapObject {
  return {
    id: 'travelerflow:city-a:city-b',
    kind: 'traveler_flow',
    geometry: LINE,
    title: 'Da Nang → Bangkok',
    freshness: 'historical',
    confidence: 'unverified',
    activity: 'quiet',
    privacyClass: 'aggregate_only',
    renderingPriority: 50,
    payload: {
      cohortBucket: 'quiet',
      fromCityLabel: 'Da Nang',
      toCityLabel: 'Bangkok',
      windowDays: 30,
      singleFamily: true,
    },
    ...over,
  } as unknown as MapObject;
}

describe('the client refuses a traveler-flow edge that names a cohort', () => {
  it('draws a well-formed bucketed edge', () => {
    // NOT VACUOUS: every refusal below is only meaningful because this passes.
    assert.equal(eligibleTravelerFlows([edge()]).length, 1);
  });

  it('refuses one carrying an exact count', () => {
    // The whole point of bucketing, enforced at the last possible moment.
    assert.deepEqual(eligibleTravelerFlows([edge({ count: 42 } as never)]), []);
    assert.deepEqual(eligibleTravelerFlows([edge({ count: 0 } as never)]), []);
  });

  it('refuses one whose bucket is the rung the server never publishes', () => {
    // `bucketCohort` returns null below k, so `very_quiet` can only come from
    // something that did not go through it.
    assert.equal(isPublishableBucket(UNPUBLISHABLE_BUCKET), false);
    assert.deepEqual(
      eligibleTravelerFlows([edge({ payload: { ...(edge().payload as object), cohortBucket: UNPUBLISHABLE_BUCKET } } as never)]),
      [],
    );
  });

  it('refuses one whose bucket is not an activity level at all', () => {
    for (const junk of ['huge', '', null, undefined, 12, {}]) {
      assert.equal(isPublishableBucket(junk), false, String(junk));
    }
    // …and every real level except the unpublishable one is accepted, so the
    // check cannot rot into "refuse everything".
    for (const level of ACTIVITY_LEVELS) {
      assert.equal(isPublishableBucket(level), level !== UNPUBLISHABLE_BUCKET, level);
    }
  });

  it('refuses geometry that was never reduced to the aggregate rung (§18, §23)', () => {
    for (const cls of ['place_level', 'approximate', 'precise_temporary', 'none'] as const) {
      assert.equal(isAggregateEdge({ privacyClass: cls }), false, cls);
      assert.deepEqual(eligibleTravelerFlows([edge({ privacyClass: cls } as never)]), []);
    }
    assert.equal(isAggregateEdge({ privacyClass: 'aggregate_only' }), true);
  });

  it('refuses a degenerate or wrong-typed geometry', () => {
    assert.deepEqual(eligibleTravelerFlows([edge({ geometry: { type: 'Point', coordinates: [1, 2] } } as never)]), []);
    assert.deepEqual(
      eligibleTravelerFlows([edge({ geometry: { type: 'LineString', coordinates: [[1, 2]] } } as never)]),
      [],
    );
  });

  it('never names a number of people in its label', () => {
    const label = travelerFlowLabel(edge() as unknown as TravelerFlowObject);
    assert.match(label, /Da Nang → Bangkok/);
    assert.match(label, /over 30 days/, 'the window must be stated or a 30-day aggregate reads live');
    assert.ok(!/\d+\s*(people|travell?ers)/i.test(label), label);
  });
});

describe('the two flow renderers hold OPPOSITE guarantees', () => {
  it('a §10 crowd flow needs a cohort count; a Phase 7 edge must not have one', () => {
    const crowd: MapObject = {
      id: 'flow:a:b', kind: 'crowd_flow', geometry: LINE, title: 'Strong movement',
      privacyClass: 'aggregate_only', renderingPriority: 50, count: MIN_FLOW_COHORT,
    };
    assert.equal(eligibleFlows([crowd]).length, 1);
    // …and without the count it is refused, which is the guarantee being
    // contrasted, not an incidental detail.
    assert.equal(eligibleFlows([{ ...crowd, count: undefined }]).length, 0);

    // The Phase 7 edge is refused by the crowd-flow renderer (wrong kind) and
    // the crowd flow is refused by the Phase 7 one (wrong kind), so neither can
    // be drawn under the other's rules.
    assert.equal(eligibleFlows([edge()]).length, 0);
    assert.equal(eligibleTravelerFlows([crowd]).length, 0);
  });
});

describe('World Pulse renders through the EXISTING zone model', () => {
  it('is a real zone kind, so ActivityZoneLayer draws it with no new renderer', () => {
    assert.ok((ZONE_KINDS as readonly string[]).includes('world_pulse'));
    assert.equal(isZoneKind('world_pulse'), true);
  });

  it('takes the activity ramp, not the social one, and is never dashed', () => {
    const busy = zoneStyle({ kind: 'world_pulse', activity: 'busy', freshness: 'recent', confidence: 'provisional' });
    const social = zoneStyle({ kind: 'social_zone', activity: 'busy', freshness: 'recent', confidence: 'provisional' });
    assert.notEqual(busy.fillColor, social.fillColor, 'a pulse must not read as a social zone');
    // §37: dashed means FORECAST. A pulse is an observation, so it may never be
    // dashed under any combination of inputs.
    for (const activity of ACTIVITY_LEVELS) {
      for (const freshness of ['live', 'recent', 'aging', 'stale', 'historical', 'unknown'] as const) {
        const s = zoneStyle({ kind: 'world_pulse', activity, freshness });
        assert.notEqual(s.outlineStyle, 'dashed', `${activity}/${freshness}`);
        assert.equal(s.isForecast, false);
      }
    }
  });

  it('a quieter pulse is drawn fainter than a busier one', () => {
    const quiet = zoneStyle({ kind: 'world_pulse', activity: 'quiet', freshness: 'recent' });
    const peak = zoneStyle({ kind: 'world_pulse', activity: 'peak', freshness: 'recent' });
    assert.ok(peak.fillOpacity > quiet.fillOpacity);
  });
});

describe('§17: the Phase 7 kinds render where the spec puts them', () => {
  it('the world band carries the world-scale kinds', () => {
    for (const kind of ['world_pulse', 'traveler_flow', 'personal_city'] as const) {
      assert.equal(isKindVisibleAtBand(kind, 'world'), true, kind);
    }
    // The per-city profile enters with the city band, not before it.
    assert.equal(isKindVisibleAtBand('city_model', 'world'), false);
    assert.equal(isKindVisibleAtBand('city_model', 'city'), true);
  });

  it('the band model stays cumulative — nothing vanishes as you zoom in', () => {
    for (const kind of ['world_pulse', 'traveler_flow', 'city_model', 'personal_city'] as const) {
      const bands = (['city', 'district', 'street', 'venue'] as const)
        .map((b) => isKindVisibleAtBand(kind, b));
      assert.deepEqual(bands, [true, true, true, true], kind);
    }
    assert.ok(kindsVisibleAtBand('world').includes('world_pulse'));
  });
});

describe('§16: the public aggregates and the private summary are separate layers', () => {
  it('one toggle can never govern both', () => {
    const publicLayer = LAYER_FOR_KIND.world_pulse;
    assert.equal(LAYER_FOR_KIND.traveler_flow, publicLayer);
    assert.equal(LAYER_FOR_KIND.city_model, publicLayer);
    assert.notEqual(LAYER_FOR_KIND.personal_city, publicLayer);
    assert.deepEqual(kindsForLayer(publicLayer), ['world_pulse', 'traveler_flow', 'city_model']);
    assert.deepEqual(kindsForLayer(LAYER_FOR_KIND.personal_city), ['personal_city']);
  });
});
