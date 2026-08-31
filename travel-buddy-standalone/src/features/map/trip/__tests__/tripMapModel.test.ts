/**
 * Trip Map guards (spec §11).
 *
 * The property these tests exist for: "the map should not silently rewrite the
 * canonical Trip." `optimizeToday` is handed a frozen-in-place snapshot and the
 * suite asserts, by deep equality, that the caller's array is byte-identical
 * afterwards — and that acceptance is a value the caller persists, not an
 * effect this module performs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPTIMIZE_FACTORS,
  TRIP_ROUTE_MAP_KIND,
  acceptProposal,
  anchorTimeOf,
  crewCentroid,
  dismissProposal,
  haversineKm,
  nextStopOf,
  optimizeToday,
  proposalMoves,
  routeLengthKm,
  tripToMapObjects,
} from '../tripMapModel.ts';
import type { TripMapSource, TripStop } from '../tripMapModel.ts';
import { RENDERING_PRIORITY, isRenderable, precisionRank } from '../../../../types/mapObjects.ts';

const NOW = '2026-08-31T18:00:00.000Z';

function stop(over: Partial<TripStop> & { id: string; orderIndex: number }): TripStop {
  return {
    title: `Stop ${over.id}`,
    lat: 16.06,
    lng: 108.22,
    status: 'pending',
    ...over,
  };
}

/** Four stops laid out west→east; the canonical order zig-zags on purpose. */
function zigZagDay(): TripStop[] {
  return [
    stop({ id: 'a', orderIndex: 0, lat: 16.06, lng: 108.20, title: 'West Cafe' }),
    stop({ id: 'b', orderIndex: 1, lat: 16.06, lng: 108.28, title: 'Far East Bar' }),
    stop({ id: 'c', orderIndex: 2, lat: 16.06, lng: 108.21, title: 'Near Gallery' }),
    stop({ id: 'd', orderIndex: 3, lat: 16.06, lng: 108.29, title: 'Farthest Club' }),
  ];
}

// ── No silent rewrite ──────────────────────────────────────────────────────────

test('optimizeToday never mutates its input array or its stops', () => {
  const stops = zigZagDay();
  const before = JSON.parse(JSON.stringify(stops));

  const proposal = optimizeToday(stops, {
    now: NOW,
    origin: { lat: 16.06, lng: 108.19 },
    savedIdeas: [
      { id: 'idea-1', title: 'Rooftop', lat: 16.0601, lng: 108.205 },
    ],
    crew: [{ id: 'crew-1', displayName: 'Mai', lat: 16.06, lng: 108.21 }],
    weather: { outdoorRisk: 'high', summary: 'Heavy rain until 8pm' },
  });

  assert.deepEqual(stops, before, 'the caller\'s stops must be untouched');
  assert.notEqual(proposal.proposed, stops);
  for (const p of proposal.proposed) {
    assert.ok(!stops.includes(p), 'proposed stops must not be the caller\'s objects');
  }
});

test('mutating the proposal cannot reach the caller\'s stops', () => {
  const stops = zigZagDay();
  const before = JSON.parse(JSON.stringify(stops));
  const proposal = optimizeToday(stops, { now: NOW });

  proposal.proposed[0].title = 'CLOBBERED';
  proposal.proposed[0].live = { activity: 'peak' };
  proposal.proposed.reverse();

  assert.deepEqual(stops, before);
});

test('acceptProposal returns an ordering for the caller to persist — it writes nothing', () => {
  const stops = zigZagDay();
  const before = JSON.parse(JSON.stringify(stops));
  const proposal = optimizeToday(stops, { now: NOW, origin: { lat: 16.06, lng: 108.19 } });

  const change = acceptProposal(proposal, NOW);
  assert.equal(change.persisted, false, 'the type says false; so does the value');
  assert.equal(change.decision.kind, 'accepted');
  assert.deepEqual(change.orderedStopIds, proposal.proposed.map((s) => s.id));
  assert.deepEqual(stops, before, 'accepting still changes nothing here');
});

test('dismissProposal leaves the canonical ordering standing', () => {
  const stops = zigZagDay();
  const proposal = optimizeToday(stops, { now: NOW, origin: { lat: 16.06, lng: 108.19 } });
  const change = dismissProposal(proposal, NOW);

  assert.equal(change.decision.kind, 'dismissed');
  assert.equal(change.persisted, false);
  assert.deepEqual(change.orderedStopIds, ['a', 'b', 'c', 'd']);
  assert.deepEqual(change.insertions, []);
});

// ── The optimizer itself ───────────────────────────────────────────────────────

test('a zig-zag day is reordered into a shorter route', () => {
  const stops = zigZagDay();
  const proposal = optimizeToday(stops, { now: NOW, origin: { lat: 16.06, lng: 108.19 } });

  assert.equal(proposal.unchanged, false);
  assert.ok(proposal.distanceKm.proposed < proposal.distanceKm.current);
  assert.deepEqual(proposal.proposed.map((s) => s.id), ['a', 'c', 'b', 'd']);
  assert.ok(proposal.rationale.some((r) => r.factor === 'distance'));
});

test('an already-optimal day reports unchanged', () => {
  const stops = [
    stop({ id: 'a', orderIndex: 0, lng: 108.20 }),
    stop({ id: 'b', orderIndex: 1, lng: 108.21 }),
    stop({ id: 'c', orderIndex: 2, lng: 108.22 }),
  ];
  const proposal = optimizeToday(stops, { now: NOW, origin: { lat: 16.06, lng: 108.19 } });
  assert.equal(proposal.unchanged, true);
  assert.deepEqual(proposal.proposed.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(proposal.insertions.length, 0);
});

test('reservations and event starts are hard anchors and keep their relative order', () => {
  const stops = [
    stop({ id: 'dinner', orderIndex: 0, lng: 108.29, reservationAt: '2026-08-31T19:00:00.000Z' }),
    stop({ id: 'show', orderIndex: 1, lng: 108.20, eventStartsAt: '2026-08-31T21:00:00.000Z' }),
    stop({ id: 'drinks', orderIndex: 2, lng: 108.285 }),
  ];
  const proposal = optimizeToday(stops, { now: NOW, origin: { lat: 16.06, lng: 108.30 } });
  const ids = proposal.proposed.map((s) => s.id);

  assert.ok(ids.indexOf('dinner') < ids.indexOf('show'), 'anchors stay in time order');
  assert.ok(
    proposal.rationale.some((r) => r.factor === 'reservation_times'),
    'the rationale cites the reservation',
  );
  assert.ok(proposal.rationale.some((r) => r.factor === 'event_schedules'));
});

test('anchorTimeOf prefers a reservation over an event start, and ignores planned arrival', () => {
  assert.equal(
    anchorTimeOf(stop({ id: 'x', orderIndex: 0, reservationAt: '2026-08-31T19:00:00.000Z', eventStartsAt: '2026-08-31T20:00:00.000Z' })),
    Date.parse('2026-08-31T19:00:00.000Z'),
  );
  assert.equal(
    anchorTimeOf(stop({ id: 'y', orderIndex: 0, plannedArrivalTime: '2026-08-31T19:00:00.000Z' })),
    null,
  );
});

test('a stop that closes early is not scheduled after an anchor it would miss', () => {
  const stops = [
    stop({ id: 'late-show', orderIndex: 0, lng: 108.20, eventStartsAt: '2026-08-31T22:00:00.000Z' }),
    stop({ id: 'closes-early', orderIndex: 1, lng: 108.20, closesAt: '2026-08-31T20:00:00.000Z' }),
  ];
  const proposal = optimizeToday(stops, { now: NOW, origin: { lat: 16.06, lng: 108.20 } });
  const ids = proposal.proposed.map((s) => s.id);
  assert.deepEqual(ids, ['closes-early', 'late-show']);
  assert.ok(proposal.rationale.some((r) => r.factor === 'closing_times'));
});

test('live conditions only influence the plan when the observation is actually live', () => {
  const base = () => [
    stop({ id: 'anchor', orderIndex: 0, lng: 108.20, eventStartsAt: '2026-08-31T23:00:00.000Z' }),
    stop({ id: 'rising', orderIndex: 1, lng: 108.24 }),
  ];

  const stale = base();
  stale[1].live = { trend: 'getting_busier', freshness: 'stale', confidence: 'strong' };
  const staleProposal = optimizeToday(stale, { now: NOW, origin: { lat: 16.06, lng: 108.25 } });
  assert.ok(
    !staleProposal.rationale.some((r) => r.factor === 'live_conditions'),
    'a stale trend must not move the day',
  );

  const live = base();
  live[1].live = { trend: 'getting_busier', freshness: 'live', confidence: 'strong' };
  const liveProposal = optimizeToday(live, { now: NOW, origin: { lat: 16.06, lng: 108.25 } });
  assert.ok(liveProposal.rationale.some((r) => r.factor === 'live_conditions'));
});

test('crew position is cited when a stop sits near the crew', () => {
  const stops = zigZagDay();
  const proposal = optimizeToday(stops, {
    now: NOW,
    origin: { lat: 16.06, lng: 108.19 },
    crew: [{ id: 'k', displayName: 'Mai', lat: 16.06, lng: 108.21 }],
  });
  assert.ok(proposal.rationale.some((r) => r.factor === 'crew_position'));
});

test('bad weather is cited and pushes outdoor stops later', () => {
  const stops = [
    stop({ id: 'indoor', orderIndex: 0, lng: 108.22 }),
    stop({ id: 'outdoor', orderIndex: 1, lng: 108.221, outdoor: true }),
  ];
  const proposal = optimizeToday(stops, {
    now: NOW,
    origin: { lat: 16.06, lng: 108.219 },
    weather: { outdoorRisk: 'high', summary: 'Heavy rain until 8pm' },
  });
  const weatherLine = proposal.rationale.find((r) => r.factor === 'weather');
  assert.ok(weatherLine, 'weather is one of the §11 factors and must be cited when used');
  assert.match(weatherLine.text, /Heavy rain until 8pm/);
  const ids = proposal.proposed.map((s) => s.id);
  assert.ok(ids.indexOf('outdoor') > ids.indexOf('indoor'));
});

test('a saved idea on the path is PROPOSED, capped, and flagged as an insertion', () => {
  const stops = [
    stop({ id: 'a', orderIndex: 0, lng: 108.200 }),
    stop({ id: 'b', orderIndex: 1, lng: 108.210 }),
  ];
  const proposal = optimizeToday(stops, {
    now: NOW,
    origin: { lat: 16.06, lng: 108.199 },
    savedIdeas: [
      { id: 'idea-near', title: 'Rooftop', lat: 16.06, lng: 108.2051 },
      { id: 'idea-far', title: 'Other side of town', lat: 16.20, lng: 108.60 },
    ],
  });

  assert.equal(proposal.insertions.length, 1, 'capped at one insertion by default');
  assert.equal(proposal.insertions[0].id, 'idea-near');
  assert.equal(proposal.insertions[0].proposedInsertion, true);
  assert.ok(proposal.proposed.some((s) => s.id === 'idea-near'));
  assert.ok(!proposal.proposed.some((s) => s.id === 'idea-far'), 'a big detour is withdrawn');
  assert.ok(proposal.rationale.some((r) => r.factor === 'saved_ideas'));

  const change = acceptProposal(proposal, NOW);
  assert.deepEqual(change.insertions.map((s) => s.id), ['idea-near']);
});

test('arrived stops are a frozen prefix and skipped stops are excluded untouched', () => {
  const stops = [
    stop({ id: 'done1', orderIndex: 0, status: 'arrived', lng: 108.29 }),
    stop({ id: 'done2', orderIndex: 1, status: 'arrived', lng: 108.28 }),
    stop({ id: 'gone', orderIndex: 2, status: 'cancelled', lng: 108.20 }),
    stop({ id: 'next', orderIndex: 3, lng: 108.21 }),
    stop({ id: 'later', orderIndex: 4, lng: 108.205 }),
  ];
  const proposal = optimizeToday(stops, { now: NOW });

  assert.deepEqual(proposal.proposed.slice(0, 2).map((s) => s.id), ['done1', 'done2']);
  assert.deepEqual(proposal.excluded.map((s) => s.id), ['gone']);
  assert.ok(!proposal.proposed.some((s) => s.id === 'gone'));
});

test('the same input always yields the same proposal', () => {
  const ctx = { now: NOW, origin: { lat: 16.06, lng: 108.19 } };
  const a = optimizeToday(zigZagDay(), ctx).proposed.map((s) => s.id);
  const b = optimizeToday([...zigZagDay()].reverse(), ctx).proposed.map((s) => s.id);
  assert.deepEqual(a, b);
});

test('the rationale only cites factors from the §11 list', () => {
  const proposal = optimizeToday(zigZagDay(), { now: NOW, origin: { lat: 16.06, lng: 108.19 } });
  for (const line of proposal.rationale) {
    assert.ok(OPTIMIZE_FACTORS.includes(line.factor), `${line.factor} is not a §11 factor`);
    assert.ok(line.text.length > 0);
  }
});

test('proposalMoves reports where each stop went', () => {
  const proposal = optimizeToday(zigZagDay(), { now: NOW, origin: { lat: 16.06, lng: 108.19 } });
  const moves = proposalMoves(proposal);
  const c = moves.find((m) => m.stopId === 'c');
  assert.ok(c);
  assert.equal(c.from, 2);
  assert.equal(c.to, 1);
  assert.equal(c.delta, -1);
  assert.equal(c.added, false);
});

// ── Helpers ────────────────────────────────────────────────────────────────────

test('haversineKm and routeLengthKm behave', () => {
  assert.equal(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0);
  assert.ok(Math.abs(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111.19) < 0.5);
  assert.equal(haversineKm(null, { lat: 0, lng: 0 }), Number.POSITIVE_INFINITY);
  assert.equal(routeLengthKm([]), 0);
});

test('crewCentroid averages positions and returns null with no crew', () => {
  assert.equal(crewCentroid([]), null);
  const c = crewCentroid([
    { id: '1', displayName: 'A', lat: 0, lng: 0 },
    { id: '2', displayName: 'B', lat: 2, lng: 4 },
  ]);
  assert.deepEqual(c, { lat: 1, lng: 2 });
});

test('nextStopOf picks the earliest upcoming anchored stop', () => {
  const stops = [
    stop({ id: 'past', orderIndex: 0, status: 'arrived' }),
    stop({ id: 'later', orderIndex: 1, reservationAt: '2026-08-31T22:00:00.000Z' }),
    stop({ id: 'soon', orderIndex: 2, reservationAt: '2026-08-31T19:00:00.000Z' }),
  ];
  assert.equal(nextStopOf(stops, NOW)?.id, 'soon');
  assert.equal(nextStopOf([], NOW), null);
});

// ── Projection ─────────────────────────────────────────────────────────────────

function fullSource(): TripMapSource {
  return {
    tripId: 'trip-1',
    lodging: { id: 'stay-1', title: 'Sea View Hotel', lat: 16.05, lng: 108.24 },
    stops: [
      stop({ id: 's1', orderIndex: 0, lng: 108.20 }),
      stop({ id: 's2', orderIndex: 1, lng: 108.21, reservationAt: '2026-08-31T19:00:00.000Z' }),
    ],
    nextStopId: 's2',
    savedIdeas: [{ id: 'idea-1', title: 'Night Market', lat: 16.07, lng: 108.22 }],
    crew: [{ id: 'crew-1', displayName: 'Mai', lat: 16.061, lng: 108.215, presenceLabel: 'Nearby ~40-80m' }],
    meetingPoints: [{ id: 'mp-1', title: 'Food Court', lat: 16.062, lng: 108.216 }],
    routes: [
      {
        id: 'r-1',
        active: true,
        path: [
          { lat: 16.06, lng: 108.20 },
          { lat: 16.06, lng: 108.21 },
        ],
      },
    ],
    safeReturn: { id: 'sr-1', title: 'Back to Sea View Hotel', lat: 16.05, lng: 108.24, anchor: 'lodging' },
    compassAlternatives: [
      {
        id: 'alt-1',
        title: 'Quieter rooftop',
        lat: 16.063,
        lng: 108.219,
        forStopId: 's2',
        live: { freshness: 'stale', confidence: 'provisional', trend: 'getting_busier' },
      },
    ],
  };
}

test('tripToMapObjects projects every §11 element exactly once', () => {
  const objects = tripToMapObjects(fullSource());
  const roles = objects.map((o) => o.payload?.role);
  assert.deepEqual(roles, [
    'lodging',
    'stop',
    'next_stop',
    'saved_idea',
    'crew',
    'meeting_point',
    'route',
    'safe_return',
    'compass_alternative',
  ]);
  for (const o of objects) assert.ok(isRenderable(o), `${o.id} must be renderable`);
});

test('the next stop is promoted to the active-navigation rung', () => {
  const objects = tripToMapObjects(fullSource());
  const next = objects.find((o) => o.payload?.role === 'next_stop');
  const other = objects.find((o) => o.payload?.role === 'stop');
  assert.equal(next?.renderingPriority, RENDERING_PRIORITY.active_navigation);
  assert.equal(other?.renderingPriority, RENDERING_PRIORITY.selected_destination);
});

test('Safe Return outranks everything else on the map (§5)', () => {
  const objects = tripToMapObjects(fullSource());
  const safety = objects.find((o) => o.payload?.role === 'safe_return');
  assert.equal(safety?.renderingPriority, RENDERING_PRIORITY.safety);
  for (const o of objects) {
    if (o.payload?.role !== 'safe_return') {
      assert.ok(o.renderingPriority <= (safety?.renderingPriority ?? 0));
    }
  }
});

test('crew geometry defaults to approximate and a privacy ceiling can only tighten it', () => {
  const loose = tripToMapObjects(fullSource());
  const crew = loose.find((o) => o.payload?.role === 'crew');
  assert.equal(crew?.privacyClass, 'approximate');

  const tight = tripToMapObjects(fullSource(), { privacyCeiling: 'aggregate_only' });
  for (const o of tight) {
    assert.ok(
      precisionRank(o.privacyClass) <= precisionRank('aggregate_only'),
      `${o.id} escaped the ceiling with ${o.privacyClass}`,
    );
  }
});

test('a Compass alternative over a stale place stays stale on the Trip Map too', () => {
  const alt = tripToMapObjects(fullSource()).find((o) => o.payload?.role === 'compass_alternative');
  assert.equal(alt?.freshness, 'stale');
  assert.equal(alt?.confidence, 'provisional');
  assert.equal(alt?.renderingPriority, RENDERING_PRIORITY.compass_recommendation);
});

test('routes ride as LineString geometry on the documented kind', () => {
  const route = tripToMapObjects(fullSource()).find((o) => o.payload?.role === 'route');
  assert.equal(route?.kind, TRIP_ROUTE_MAP_KIND);
  assert.equal(route?.geometry.type, 'LineString');
  assert.equal(route?.renderingPriority, RENDERING_PRIORITY.active_navigation);
});

test('a one-point route is dropped rather than drawn as a degenerate line', () => {
  const src = fullSource();
  const objects = tripToMapObjects({
    ...src,
    routes: [{ id: 'r-bad', path: [{ lat: 16.06, lng: 108.2 }] }],
  });
  assert.ok(!objects.some((o) => o.payload?.role === 'route'));
});

test('every object carries its canonical id for the §26 bridge', () => {
  for (const o of tripToMapObjects(fullSource())) {
    assert.equal(typeof o.payload?.sourceId, 'string');
    assert.ok((o.payload?.sourceId as string).length > 0);
    assert.equal(o.payload?.tripId, 'trip-1');
  }
});
