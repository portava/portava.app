/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; sweep SW4): the place sheet says a live state that was not read.
 *
 * The NOW gateway reads live claims for at most 25 eligible objects per answer and fails a throwing read closed to "no
 * claim"; it now marks each such object `liveUnread: true` (routes' enrichWithLiveClaims). The sheet said "No live
 * activity has been observed here" for it — an observation nobody made.
 *
 *   LU1  an object marked liveUnread, with no activity → "Live activity couldn't be checked for this place"
 *   LU0  CONTROL: an unmarked object with no activity → "No live activity has been observed here" (unchanged)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { point, RENDERING_PRIORITY, type MapObject } from '../../../../types/mapObjects.ts';
import { buildLivePlaceView, missingReason } from '../livePlaceModel.ts';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const obj = (over: Partial<MapObject> = {}): MapObject => ({ id: 'p1', kind: 'place', geometry: point(16.06, 108.22), title: 'Bến Cafe', privacyClass: 'place_level', renderingPriority: RENDERING_PRIORITY.relevant_place, ...over });

describe('§114 SW4: a live state that was not read is said unread', () => {
  it('LU1 liveUnread, no activity → "Live activity couldn\'t be checked for this place"', () => {
    const vm = buildLivePlaceView(obj({ liveUnread: true } as Partial<MapObject>), null, { now: NOW });
    assert.equal(missingReason(vm!, 'live_state'), "Live activity couldn't be checked for this place");
  });
  it('LU0 CONTROL: unmarked, no activity → "No live activity has been observed here"', () => {
    const vm = buildLivePlaceView(obj(), null, { now: NOW });
    assert.equal(missingReason(vm!, 'live_state'), 'No live activity has been observed here');
  });
});
