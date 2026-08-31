/**
 * Compass Map Mode guards (spec §14, §37).
 *
 * The two properties these tests exist for:
 *  1. Compass cannot upgrade the live state it was handed — a pick over a stale
 *     place stays stale, and one over an unconfirmed place stays unconfirmed.
 *  2. The three-to-five bound is enforced at BOTH ends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPASS_MAP_MAX_PICKS,
  COMPASS_MAP_MIN_PICKS,
  COMPASS_STAR_TREATMENT,
  buildCompassMapMode,
  buildWhyLines,
  carryLiveState,
  clampToSource,
  selectCompassPicks,
  suppressNoise,
  toMapObjects,
} from '../compassMapModel.ts';
import type { CompassMapCandidate } from '../compassMapModel.ts';
import { RENDERING_PRIORITY } from '../../../../types/mapObjects.ts';

function candidate(over: Partial<CompassMapCandidate> = {}): CompassMapCandidate {
  return {
    id: over.id ?? 'c1',
    title: over.title ?? 'Bar Nova',
    lat: 16.06,
    lng: 108.22,
    score: 1,
    ...over,
  };
}

function many(n: number): CompassMapCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    candidate({ id: `c${i}`, title: `Place ${i}`, score: 100 - i }),
  );
}

// ── The guard: no upgrades ─────────────────────────────────────────────────────

test('clampToSource cannot raise confidence above the source band', () => {
  const out = clampToSource({ confidence: 'strong' }, { confidence: 'provisional' });
  assert.equal(out.confidence, 'provisional');
});

test('clampToSource keeps a LOWER proposed confidence (downgrades are allowed)', () => {
  const out = clampToSource({ confidence: 'unverified' }, { confidence: 'strong' });
  assert.equal(out.confidence, 'unverified');
});

test('clampToSource cannot make a stale source look fresher', () => {
  const out = clampToSource({ freshness: 'live' }, { freshness: 'stale' });
  assert.equal(out.freshness, 'stale');
});

test('clampToSource fails closed when the source stated nothing', () => {
  const out = clampToSource({ freshness: 'live', confidence: 'strong' }, {});
  assert.equal(out.freshness, 'unknown');
  assert.equal(out.confidence, undefined, 'a band never given cannot be claimed');
});

test('clampToSource carries observations verbatim and ignores proposed ones', () => {
  const out = clampToSource(
    { activity: 'peak', trend: 'increasing_quickly' },
    { activity: 'quiet', trend: 'cooling', freshness: 'live', confidence: 'live' },
  );
  assert.equal(out.activity, 'quiet');
  assert.equal(out.trend, 'cooling');
});

test('clampToSource is idempotent', () => {
  const src = { freshness: 'aging', confidence: 'likely_current' } as const;
  const once = clampToSource({ freshness: 'live', confidence: 'strong' }, src);
  const twice = clampToSource(once, src);
  assert.deepEqual(twice, once);
});

test('a Compass pick over a stale place stays stale end to end', () => {
  const stale = candidate({
    id: 'stale-1',
    source: {
      freshness: 'stale',
      confidence: 'provisional',
      activity: 'quiet',
      trend: 'getting_quieter',
    },
  });
  const picks = selectCompassPicks([stale], { min: 1 });
  assert.equal(picks.ok, true);
  const [obj] = toMapObjects(picks.picks);

  assert.equal(obj.freshness, 'stale');
  assert.equal(obj.confidence, 'provisional');
  assert.equal(obj.activity, 'quiet');
  assert.equal(obj.trend, 'getting_quieter');
});

test('a stale pick gets neither the "getting busier" nor the "strong evidence" line', () => {
  const c = candidate({
    matchesIntent: true,
    intentLabel: 'Party',
    minutesAway: 7,
    source: { freshness: 'stale', confidence: 'strong', trend: 'getting_busier' },
  });
  const state = carryLiveState(c.source);
  const why = buildWhyLines(c, state).map((l) => l.factor);

  assert.ok(why.includes('matches_intent'));
  assert.ok(why.includes('minutes_away'));
  assert.ok(!why.includes('getting_busier'), 'a stale trend is not a live condition');
  assert.ok(!why.includes('strong_current_evidence'), 'stale evidence is not current');
});

test('a live pick gets the full §14 panel in the spec\'s order', () => {
  const c = candidate({
    matchesIntent: true,
    intentLabel: 'Party',
    minutesAway: 7,
    crewMinutesAway: 10,
    nearbyNextOptions: 3,
    source: { freshness: 'live', confidence: 'strong', trend: 'getting_busier' },
  });
  const why = buildWhyLines(c, carryLiveState(c.source));
  assert.deepEqual(
    why.map((l) => l.factor),
    [
      'matches_intent',
      'getting_busier',
      'minutes_away',
      'strong_current_evidence',
      'crew_minutes_away',
      'good_next_options',
    ],
  );
  assert.deepEqual(
    why.map((l) => l.text),
    [
      'Matches current Party intent',
      'Getting busier',
      '7 minutes away',
      'Strong current evidence',
      'Crew 10 minutes away',
      'Good next options nearby',
    ],
  );
});

// ── The bound, at both ends ────────────────────────────────────────────────────

test('the upper bound truncates to five picks', () => {
  const res = selectCompassPicks(many(9));
  assert.equal(res.ok, true);
  assert.equal(res.picks.length, COMPASS_MAP_MAX_PICKS);
  assert.equal(res.picks.length, 5);
  assert.deepEqual(res.picks.map((p) => p.rank), [1, 2, 3, 4, 5]);
});

test('the lower bound refuses rather than padding', () => {
  const res = selectCompassPicks(many(2));
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'insufficient_candidates');
  assert.equal(res.available, 2);
  assert.equal(res.picks.length, 2, 'the candidates are still returned for LIVE mode');
});

test('exactly three candidates satisfy the bound', () => {
  const res = selectCompassPicks(many(COMPASS_MAP_MIN_PICKS));
  assert.equal(res.ok, true);
  assert.equal(res.picks.length, 3);
});

test('candidates the map cannot place do not count toward the bound', () => {
  const placeable = many(2);
  const unplaceable = [
    { ...candidate({ id: 'x1', title: 'Nowhere' }), lat: Number.NaN },
    { ...candidate({ id: 'x2', title: 'Nowhere 2' }), lng: Number.NaN },
  ];
  const res = selectCompassPicks([...placeable, ...unplaceable]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.available, 2);
});

test('duplicate ids cannot consume two of the five slots', () => {
  const dupes = [
    candidate({ id: 'a', score: 5 }),
    candidate({ id: 'a', score: 4 }),
    candidate({ id: 'b', score: 3 }),
    candidate({ id: 'c', score: 2 }),
  ];
  const res = selectCompassPicks(dupes);
  assert.equal(res.ok, true);
  assert.deepEqual(res.picks.map((p) => p.candidate.id), ['a', 'b', 'c']);
});

test('ordering is deterministic and total', () => {
  const tied = [
    candidate({ id: 'z', title: 'Same', score: 5, minutesAway: 4 }),
    candidate({ id: 'a', title: 'Same', score: 5, minutesAway: 4 }),
    candidate({ id: 'm', title: 'Same', score: 5, minutesAway: 4 }),
  ];
  const first = selectCompassPicks(tied).picks.map((p) => p.candidate.id);
  const second = selectCompassPicks([...tied].reverse()).picks.map((p) => p.candidate.id);
  assert.deepEqual(first, ['a', 'm', 'z']);
  assert.deepEqual(second, first);
});

// ── Projection ─────────────────────────────────────────────────────────────────

test('every pick sits on the Compass rung of the §31 ladder with the §6 star', () => {
  const { picks, objects } = buildCompassMapMode(many(5));
  assert.equal(picks.ok, true);
  assert.equal(objects.length, 5);
  for (const o of objects) {
    assert.equal(o.renderingPriority, RENDERING_PRIORITY.compass_recommendation);
    assert.equal(o.payload?.treatment, COMPASS_STAR_TREATMENT);
    assert.equal(o.payload?.compassPick, true);
  }
});

test('Compass picks yield to safety and navigation but outrank ordinary places', () => {
  assert.ok(RENDERING_PRIORITY.compass_recommendation < RENDERING_PRIORITY.safety);
  assert.ok(RENDERING_PRIORITY.compass_recommendation < RENDERING_PRIORITY.active_navigation);
  assert.ok(RENDERING_PRIORITY.compass_recommendation < RENDERING_PRIORITY.trip_crew);
  assert.ok(RENDERING_PRIORITY.compass_recommendation > RENDERING_PRIORITY.relevant_place);
});

test('map object ids carry the source entity id for the §26 bridge', () => {
  const [obj] = toMapObjects(selectCompassPicks([candidate({ id: 'place-77' })], { min: 1 }).picks);
  assert.equal(obj.id, 'place:place-77');
  assert.equal(obj.payload?.sourceId, 'place-77');
});

test('suppressNoise drops low-priority clutter but keeps safety and crew', () => {
  const objs = toMapObjects(selectCompassPicks(many(3)).picks);
  const noisy = [
    ...objs,
    { ...objs[0], id: 'poi:1', renderingPriority: RENDERING_PRIORITY.generic_poi },
    { ...objs[0], id: 'saved:1', renderingPriority: RENDERING_PRIORITY.saved_place },
    { ...objs[0], id: 'safety:1', renderingPriority: RENDERING_PRIORITY.safety },
  ];
  const kept = suppressNoise(noisy).map((o) => o.id);
  assert.ok(!kept.includes('poi:1'));
  assert.ok(!kept.includes('saved:1'));
  assert.ok(kept.includes('safety:1'));
});
