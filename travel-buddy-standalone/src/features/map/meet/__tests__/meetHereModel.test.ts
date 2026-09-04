/**
 * meetHereModel — §25 "Meet Here".
 *
 * The property under test is the one that makes this a privacy surface rather
 * than a button: a meeting point publishes a location to several people, so it
 * must never publish at a rung more precise than the subject it refers to, and
 * must refuse outright when the subject is an aggregate.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEET_POINT_CEILING,
  MEET_REFUSAL_TEXT,
  defaultAudienceFor,
  mayNameSubject,
  proposeMeetHere,
  type MeetTarget,
} from '../meetHereModel.ts';
import {
  PRIVACY_CLASSES,
  point,
  precisionRank,
  type MapObject,
  type PrivacyClass,
} from '../../../../types/mapObjects.ts';

function obj(over: Partial<MapObject> = {}): MapObject {
  return {
    id: 'gem:g1',
    kind: 'hidden_gem',
    geometry: point(16.05, 108.2),
    title: 'Rooftop stairwell',
    privacyClass: 'place_level',
    renderingPriority: 40,
    ...over,
  };
}

describe('the rung a meeting point publishes at', () => {
  test('never exceeds the subjectrung — checked across the whole ladder', () => {
    for (const cls of PRIVACY_CLASSES) {
      const d = proposeMeetHere({ kind: 'object', object: obj({ privacyClass: cls }) });
      if (!d.ok) continue;
      assert.ok(
        precisionRank(d.proposal.sharedAs) <= precisionRank(cls),
        `subject at ${cls} produced a meeting point at ${d.proposal.sharedAs}`,
      );
    }
  });

  test('never exceeds the meeting-point ceiling either', () => {
    const d = proposeMeetHere({
      kind: 'object',
      object: obj({ privacyClass: 'precise_temporary' }),
    });
    assert.ok(d.ok);
    assert.equal(d.proposal.sharedAs, MEET_POINT_CEILING);
    assert.notEqual(
      d.proposal.sharedAs,
      'precise_temporary',
      'precise_temporary is for Safe Return and deliberate live sessions, not a dropped pin',
    );
  });

  test('a place_level subject publishes at place_level', () => {
    const d = proposeMeetHere({ kind: 'object', object: obj({ privacyClass: 'place_level' }) });
    assert.ok(d.ok);
    assert.equal(d.proposal.sharedAs, 'place_level');
  });

  test('an approximate subject stays approximate — the point cannot sharpen it', () => {
    const d = proposeMeetHere({ kind: 'object', object: obj({ privacyClass: 'approximate' }) });
    assert.ok(d.ok);
    assert.equal(d.proposal.sharedAs, 'approximate');
  });
});

describe('refusals', () => {
  test('an aggregate subject cannot anchor a meeting point', () => {
    // "Meet me where those 18 travellers are" is not a place, and resolving it
    // to a point would sharpen an aggregate.
    const d = proposeMeetHere({
      kind: 'object',
      object: obj({ kind: 'social_zone', privacyClass: 'aggregate_only' }),
    });
    assert.equal(d.ok, false);
    assert.equal((d as { reason: string }).reason, 'aggregate_subject');
  });

  test('the "none" rung is refused as not visible', () => {
    const d = proposeMeetHere({ kind: 'object', object: obj({ privacyClass: 'none' }) });
    assert.equal(d.ok, false);
    assert.equal((d as { reason: string }).reason, 'not_visible');
  });

  test('an object with unusable geometry is refused', () => {
    const d = proposeMeetHere({
      kind: 'object',
      object: obj({ geometry: { type: 'Point', coordinates: [NaN, NaN] } }),
    });
    assert.equal(d.ok, false);
    assert.equal((d as { reason: string }).reason, 'no_geometry');
  });

  test('a non-finite coordinate is refused', () => {
    for (const t of [
      { kind: 'coordinate', lat: NaN, lng: 0 },
      { kind: 'coordinate', lat: 0, lng: Infinity },
    ] as MeetTarget[]) {
      assert.equal(proposeMeetHere(t).ok, false);
    }
  });

  test('every refusal reason has user-facing text', () => {
    for (const reason of Object.keys(MEET_REFUSAL_TEXT)) {
      assert.ok(MEET_REFUSAL_TEXT[reason as keyof typeof MEET_REFUSAL_TEXT].length > 0);
    }
  });
});

describe('the user’s own dropped pin', () => {
  test('is allowed at place_level — nobody else’s position was reduced for it', () => {
    const d = proposeMeetHere({ kind: 'coordinate', lat: 16.05, lng: 108.2, label: 'The bridge' });
    assert.ok(d.ok);
    assert.equal(d.proposal.sharedAs, 'place_level');
    assert.equal(d.proposal.title, 'The bridge');
    assert.equal(d.proposal.subjectId, null);
  });

  test('never titles itself with a raw coordinate pair', () => {
    const d = proposeMeetHere({ kind: 'coordinate', lat: 16.05, lng: 108.2 });
    assert.ok(d.ok);
    assert.equal(d.proposal.title, 'Dropped pin');
    assert.doesNotMatch(d.proposal.title, /\d/);
  });

  test('a blank label falls back rather than producing an empty title', () => {
    const d = proposeMeetHere({ kind: 'coordinate', lat: 1, lng: 2, label: '   ' });
    assert.ok(d.ok);
    assert.equal(d.proposal.title, 'Dropped pin');
  });
});

describe('naming the subject', () => {
  test('only at place_level or above', () => {
    assert.equal(mayNameSubject('place_level'), true);
    assert.equal(mayNameSubject('approximate'), false);
    assert.equal(mayNameSubject('aggregate_only'), false);
    assert.equal(mayNameSubject('none'), false);
  });
});

describe('default audience', () => {
  test('follows the subject kind', () => {
    const kinds: Array<[MapObject['kind'], string]> = [
      ['crew_member', 'crew'],
      ['trip_stop', 'crew'],
      ['meeting_point', 'crew'],
      ['buddy_zone', 'buddy'],
      ['event', 'group'],
      ['hidden_gem', 'friends'],
    ];
    for (const [kind, expected] of kinds) {
      assert.equal(
        defaultAudienceFor({ kind: 'object', object: obj({ kind, privacyClass: 'place_level' }) }),
        expected,
        `kind ${kind}`,
      );
    }
  });

  test('a dropped pin defaults to friends', () => {
    assert.equal(defaultAudienceFor({ kind: 'coordinate', lat: 1, lng: 2 }), 'friends');
  });
});

describe('the anchor', () => {
  test('is the subject’s centroid, not a re-derived point', () => {
    const d = proposeMeetHere({ kind: 'object', object: obj() });
    assert.ok(d.ok);
    assert.deepEqual(d.proposal.anchor, { lat: 16.05, lng: 108.2 });
  });

  test('carries the subject id so the caller can attribute the meeting', () => {
    const d = proposeMeetHere({ kind: 'object', object: obj({ id: 'event:e9' }) });
    assert.ok(d.ok);
    assert.equal(d.proposal.subjectId, 'event:e9');
  });
});
