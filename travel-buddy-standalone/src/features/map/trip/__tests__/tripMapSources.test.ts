/**
 * tripMapSources guards (spec §11, §19, §20, §23).
 *
 * The properties these tests exist for:
 *   - Every §11 element is composed from its OWNING system's DTO, so the Trip
 *     Map is fed the whole itinerary — lodging, stops, saved ideas, meeting
 *     points, routes, Safe Return context and Compass alternatives — not just
 *     stops (the state before this unit).
 *   - CREW NEVER CARRIES COORDINATES (§23 ruling). `getCrewMap` returns area
 *     labels, so crew is surfaced as coarse `crewAreas` text with no geometry,
 *     and `source.crew` is left empty — no crew ring is ever fabricated from an
 *     area label, and `tripToMapObjects` therefore emits zero `crew_member`
 *     objects for a composed source.
 *   - The composition invents no coordinate and sharpens no privacy: private or
 *     coordinate-less items are dropped rather than placed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeCompassAlternatives,
  composeCrewAreas,
  composeRoutes,
  composeSafeReturn,
  composeSavedIdeas,
  composeTripMap,
  partitionPlanItems,
  persistOptimizeAcceptance,
  type TripCrewArea,
} from '../tripMapSources.ts';
import { optimizeToday, tripToMapObjects, type TripLodging, type TripStop, type TripSavedIdea } from '../tripMapModel.ts';
import type { TripPlanItem } from '../../../../types/models.ts';
import type { BookmarkedPlace } from '../../../../services/discoveryBookmarks.ts';
import type { CrewMemberCard, CrewStatusLabel } from '../../../../services/tripCrewLocation.ts';
import type { FullRoutePlan, RoutePlan, RouteStop, RouteLeg, RoutePlanStatus } from '../../../../services/routePlan.ts';
import type { SafeReturnSession } from '../../../../services/safeReturn.ts';
import type { CompassRecommendation } from '../../../../services/compass.ts';

const TRIP_ID = 'trip-danang-1';

// ── Fixture builders (real production shapes; no `as any`) ───────────────────────

function planItem(over: Partial<TripPlanItem> & { id: string }): TripPlanItem {
  return {
    tripId: TRIP_ID,
    creatorId: 'user-1',
    title: `Item ${over.id}`,
    category: 'activity',
    status: 'confirmed',
    sourceType: 'manual',
    sourceId: null,
    dayDate: '2026-09-05',
    startsAt: null,
    endsAt: null,
    locationName: null,
    notes: null,
    sortOrder: 0,
    visibility: 'members',
    lat: 16.06,
    lng: 108.22,
    locationIsPrivate: false,
    warnings: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function bookmark(over: Partial<BookmarkedPlace> & { id: string }): BookmarkedPlace {
  return {
    name: `Saved ${over.id}`,
    category: 'cafe',
    type: 'coffee_shop',
    address: null,
    savedAt: 1_725_000_000_000,
    lat: 16.07,
    lng: 108.23,
    ...over,
  };
}

function crewCard(over: Partial<CrewMemberCard> & { userId: string }): CrewMemberCard {
  return {
    name: `Member ${over.userId}`,
    handle: null,
    avatarUrl: null,
    statusLabel: 'neighborhood',
    areaLabel: 'Riverside',
    planCheckInStatus: null,
    safeReturnActive: false,
    liveShareActive: false,
    liveShareExpiresAt: null,
    ghostMode: false,
    updatedAt: '2026-09-04T10:00:00.000Z',
    ...over,
  };
}

function routeStop(id: string, orderIndex: number, lat: number, lng: number): RouteStop {
  return {
    id,
    routePlanId: 'plan-1',
    sourceType: 'trip_plan_item',
    sourceId: null,
    title: `RouteStop ${id}`,
    structuredLocation: { label: `RouteStop ${id}`, lat, lng },
    orderIndex,
    plannedArrivalTime: null,
    plannedDepartureTime: null,
    checkpointStatus: 'pending',
    arrivedAt: null,
    notes: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function routeLeg(over: Partial<RouteLeg> & { id: string }): RouteLeg {
  return {
    routePlanId: 'plan-1',
    fromStopId: 'rs-1',
    toStopId: 'rs-2',
    distanceMeters: 500,
    durationSeconds: 360,
    mode: 'walk',
    provider: 'approximated',
    isApproximated: false,
    safetyNotes: null,
    ...over,
  };
}

function fullPlan(over: {
  status?: RoutePlanStatus;
  isApproximated?: boolean;
  stops?: RouteStop[];
  legs?: RouteLeg[];
}): FullRoutePlan {
  const plan: RoutePlan = {
    id: 'plan-1',
    ownerUserId: 'user-1',
    tripId: TRIP_ID,
    title: 'Night route',
    startLocation: null,
    endLocation: null,
    routeStyle: 'nightlife',
    status: over.status ?? 'active',
    compassExplanation: null,
    isApproximated: over.isApproximated ?? false,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  return {
    plan,
    stops: over.stops ?? [routeStop('rs-1', 0, 16.06, 108.22), routeStop('rs-2', 1, 16.08, 108.24)],
    legs: over.legs ?? [],
  };
}

function safeReturn(over: Partial<SafeReturnSession> & { id: string }): SafeReturnSession {
  return {
    status: 'active',
    escalationLevel: 0,
    timerStartAt: '2026-09-05T20:00:00.000Z',
    timerEndAt: '2026-09-05T23:00:00.000Z',
    trustedCircleEnabled: true,
    liveShareEnabled: false,
    notifyHostEnabled: false,
    notifyTripCrewEnabled: true,
    planItemId: null,
    tripId: TRIP_ID,
    triggerReason: null,
    emergencyNote: null,
    closedAt: null,
    createdAt: '2026-09-05T19:00:00.000Z',
    updatedAt: '2026-09-05T19:00:00.000Z',
    ...over,
  };
}

function compassRec(over: Partial<CompassRecommendation> & { id: string }): CompassRecommendation {
  return {
    type: 'place',
    category: 'dining',
    title: `Pick ${over.id}`,
    ...over,
  };
}

const LODGING: TripLodging = { id: 'lodge-1', title: 'The Stay', lat: 16.05, lng: 108.21 };

// ── partitionPlanItems ───────────────────────────────────────────────────────────

test('partitionPlanItems splits accommodation, meeting points and stops by category', () => {
  const items: TripPlanItem[] = [
    planItem({ id: 'acc-1', category: 'accommodation', title: 'Hotel A', sortOrder: 0, lat: 16.05, lng: 108.21 }),
    planItem({ id: 'acc-2', category: 'accommodation', title: 'Hotel B', sortOrder: 1 }),
    planItem({ id: 'mp-1', category: 'meeting_point', title: 'Fountain', sortOrder: 2, startsAt: '2026-09-05T18:00:00.000Z' }),
    planItem({ id: 'stop-1', category: 'dining', title: 'Dinner', sortOrder: 3, sourceId: 'place-99' }),
  ];
  const { lodging, stops, meetingPoints, scheduledIds } = partitionPlanItems(items);

  // Only the FIRST accommodation becomes home base (§11 lists lodging once).
  assert.equal(lodging?.id, 'acc-1');
  assert.equal(lodging?.title, 'Hotel A');

  assert.equal(meetingPoints.length, 1);
  assert.equal(meetingPoints[0].id, 'mp-1');
  assert.equal(meetingPoints[0].startsAt, '2026-09-05T18:00:00.000Z');

  assert.equal(stops.length, 1);
  assert.equal(stops[0].id, 'stop-1');
  assert.equal(stops[0].orderIndex, 3);

  // scheduledIds carries both the item id and its sourceId so a saved idea that
  // is already scheduled is not offered a second time.
  assert.ok(scheduledIds.has('stop-1'));
  assert.ok(scheduledIds.has('place-99'));
});

test('partitionPlanItems drops private and coordinate-less items rather than placing them', () => {
  const items: TripPlanItem[] = [
    planItem({ id: 'private-1', category: 'dining', locationIsPrivate: true }),
    planItem({ id: 'nocoord-1', category: 'dining', lat: null, lng: null }),
    planItem({ id: 'ok-1', category: 'dining' }),
  ];
  const { stops, scheduledIds } = partitionPlanItems(items);
  assert.deepEqual(stops.map((s) => s.id), ['ok-1']);
  assert.ok(!scheduledIds.has('private-1'));
  assert.ok(!scheduledIds.has('nocoord-1'));
});

test('partitionPlanItems maps a fixed lock to the reservation anchor and leaves flexible revisable', () => {
  const items: TripPlanItem[] = [
    planItem({ id: 'fixed', category: 'dining', lockType: 'fixed', startsAt: '2026-09-05T19:30:00.000Z' }),
    planItem({ id: 'flex', category: 'dining', lockType: 'flexible', startsAt: '2026-09-05T20:30:00.000Z' }),
  ];
  const { stops } = partitionPlanItems(items);
  const fixed = stops.find((s) => s.id === 'fixed');
  const flex = stops.find((s) => s.id === 'flex');
  assert.equal(fixed?.reservationAt, '2026-09-05T19:30:00.000Z');
  assert.equal(flex?.reservationAt, null);
  // planned arrival stays on both — it is what the optimizer may revise.
  assert.equal(flex?.plannedArrivalTime, '2026-09-05T20:30:00.000Z');
});

// ── composeCrewAreas — the §23 coordinate-less path ──────────────────────────────

test('composeCrewAreas produces area labels and NEVER a coordinate', () => {
  const crew: CrewMemberCard[] = [
    crewCard({ userId: 'u1', areaLabel: 'Riverside', statusLabel: 'neighborhood' }),
    crewCard({ userId: 'u2', ghostMode: true }),
    crewCard({ userId: 'u3', statusLabel: 'not_shared' }),
    crewCard({ userId: 'u4', statusLabel: 'location_hidden' }),
    crewCard({ userId: 'u5', statusLabel: 'safe_return_active', safeReturnActive: true, areaLabel: 'City only' }),
  ];
  const areas = composeCrewAreas(crew);

  // ghostMode + not_shared + location_hidden are dropped.
  assert.deepEqual(areas.map((a) => a.userId).sort(), ['u1', 'u5']);

  // The shape carries NO geometry — assert no lat/lng exists on any object.
  for (const a of areas) {
    assert.ok(!('lat' in a), 'crew area must not carry lat');
    assert.ok(!('lng' in a), 'crew area must not carry lng');
  }
  const sr = areas.find((a) => a.userId === 'u5') as TripCrewArea;
  assert.equal(sr.safeReturnActive, true);
});

// ── composeSavedIdeas ────────────────────────────────────────────────────────────

test('composeSavedIdeas drops coordinate-less, already-scheduled and duplicate saves', () => {
  const saved: BookmarkedPlace[] = [
    bookmark({ id: 'b1' }),
    bookmark({ id: 'b2', lat: null, lng: null }),
    bookmark({ id: 'scheduled', lat: 16.09, lng: 108.25 }),
    bookmark({ id: 'b1' }), // duplicate id
  ];
  const ideas = composeSavedIdeas(saved, new Set(['scheduled']));
  assert.deepEqual(ideas.map((i) => i.id), ['b1']);
  assert.equal(ideas[0].subtitle, 'coffee_shop');
});

// ── composeRoutes ────────────────────────────────────────────────────────────────

test('composeRoutes draws one ordered line and flags approximation from plan or legs', () => {
  const routes = composeRoutes(fullPlan({ status: 'active' }));
  assert.equal(routes.length, 1);
  assert.equal(routes[0].active, true);
  assert.equal(routes[0].isApproximated, false);
  assert.deepEqual(
    routes[0].path.map((p) => [p.lat, p.lng]),
    [[16.06, 108.22], [16.08, 108.24]],
  );

  const approxByLeg = composeRoutes(fullPlan({ legs: [routeLeg({ id: 'l1', isApproximated: true })] }));
  assert.equal(approxByLeg[0].isApproximated, true);

  const approxByPlan = composeRoutes(fullPlan({ isApproximated: true }));
  assert.equal(approxByPlan[0].isApproximated, true);
});

test('composeRoutes returns nothing for a null plan or a single-point path', () => {
  assert.deepEqual(composeRoutes(null), []);
  assert.deepEqual(composeRoutes(fullPlan({ stops: [routeStop('only', 0, 16.06, 108.22)] })), []);
});

// ── composeSafeReturn ────────────────────────────────────────────────────────────

test('composeSafeReturn anchors an active session to lodging and returns null otherwise', () => {
  const ctx = composeSafeReturn(safeReturn({ id: 'sr-1' }), LODGING);
  assert.ok(ctx);
  assert.equal(ctx?.anchor, 'lodging');
  assert.equal(ctx?.lat, LODGING.lat);
  assert.equal(ctx?.lng, LODGING.lng);
  assert.equal(ctx?.lastDepartureAt, '2026-09-05T23:00:00.000Z');

  // Not active → nothing to draw.
  assert.equal(composeSafeReturn(safeReturn({ id: 'sr-2', status: 'safe' }), LODGING), null);
  // No lodging to anchor to → nothing rather than an invented location.
  assert.equal(composeSafeReturn(safeReturn({ id: 'sr-3' }), null), null);
});

// ── composeCompassAlternatives ───────────────────────────────────────────────────

test('composeCompassAlternatives only places recommendations that already carry a coordinate', () => {
  const recs: CompassRecommendation[] = [
    compassRec({ id: 'c1', data: { lat: 16.1, lng: 108.3 }, reason: 'Getting busier' }),
    compassRec({ id: 'c2', data: { lat: 'nope' } }),
    compassRec({ id: 'c3' }),
  ];
  const alts = composeCompassAlternatives(recs, 'stop-next');
  assert.deepEqual(alts.map((a) => a.id), ['c1']);
  assert.equal(alts[0].forStopId, 'stop-next');
  assert.equal(alts[0].subtitle, 'Getting busier');
  assert.equal(alts[0].lat, 16.1);
});

// ── composeTripMap — the whole §11 composition ───────────────────────────────────

test('composeTripMap feeds every §11 source and leaves crew coordinate-less', () => {
  const planItems: TripPlanItem[] = [
    planItem({ id: 'acc-1', category: 'accommodation', title: 'The Stay', sortOrder: 0, lat: 16.05, lng: 108.21 }),
    planItem({ id: 'stop-1', category: 'dining', title: 'Dinner', sortOrder: 1, startsAt: '2026-09-05T19:00:00.000Z' }),
    planItem({ id: 'stop-2', category: 'activity', title: 'Bar', sortOrder: 2, startsAt: '2026-09-05T21:00:00.000Z' }),
    planItem({ id: 'mp-1', category: 'meeting_point', title: 'Fountain', sortOrder: 3 }),
  ];
  const composed = composeTripMap({
    tripId: TRIP_ID,
    planItems,
    savedPlaces: [bookmark({ id: 'save-1' })],
    crew: [crewCard({ userId: 'u1', areaLabel: 'Riverside' })],
    routePlan: fullPlan({ status: 'active' }),
    safeReturnSession: safeReturn({ id: 'sr-1' }),
    compassRecommendations: [compassRec({ id: 'c1', data: { lat: 16.1, lng: 108.3 } })],
    now: '2026-09-05T18:00:00.000Z',
  });

  const { source, crewAreas } = composed;
  assert.equal(source.tripId, TRIP_ID);
  assert.equal(source.lodging?.id, 'acc-1');
  assert.equal(source.stops?.length, 2);
  assert.equal(source.meetingPoints?.length, 1);
  assert.equal(source.savedIdeas?.length, 1);
  assert.equal(source.routes?.length, 1);
  assert.ok(source.safeReturn);
  assert.equal(source.compassAlternatives?.length, 1);
  // Next stop derived from `now`: the 19:00 dinner is the earliest upcoming.
  assert.equal(source.nextStopId, 'stop-1');
  assert.equal(source.compassAlternatives?.[0].forStopId, 'stop-1');

  // §23: crew is surfaced as coarse labels, NOT geometry.
  assert.deepEqual(source.crew, []);
  assert.equal(crewAreas.length, 1);
  assert.equal(crewAreas[0].areaLabel, 'Riverside');

  // Projecting the composed source emits every §11 element and ZERO crew pins.
  const objs = tripToMapObjects(source, { now: '2026-09-05T18:00:00.000Z' });
  const kinds = objs.map((o) => o.kind);
  assert.ok(kinds.includes('safety_notice'), 'safe return projects');
  assert.ok(kinds.includes('meeting_point'), 'meeting point projects');
  assert.equal(objs.filter((o) => o.kind === 'crew_member').length, 0, 'no crew ring from an area label');
  // The area label never leaks a coordinate into a projected object either.
  for (const o of objs) {
    if (o.geometry.type === 'Point') {
      assert.ok(Number.isFinite(o.geometry.coordinates[0]));
    }
  }
});

test('composeTripMap honours an explicit next stop over the clock', () => {
  const composed = composeTripMap({
    tripId: TRIP_ID,
    planItems: [
      planItem({ id: 'stop-1', category: 'dining', sortOrder: 0, startsAt: '2026-09-05T19:00:00.000Z' }),
      planItem({ id: 'stop-2', category: 'activity', sortOrder: 1, startsAt: '2026-09-05T21:00:00.000Z' }),
    ],
    compassRecommendations: [compassRec({ id: 'c1', data: { lat: 16.1, lng: 108.3 } })],
    nextStopId: 'stop-2',
  });
  assert.equal(composed.source.nextStopId, 'stop-2');
  assert.equal(composed.source.compassAlternatives?.[0].forStopId, 'stop-2');
});

// ── persistOptimizeAcceptance — the write path (§11, §20) ────────────────────────

function tripStop(over: Partial<TripStop> & { id: string; orderIndex: number }): TripStop {
  return { title: `Stop ${over.id}`, lat: 16.06, lng: 108.22, status: 'pending', ...over };
}

test('persistOptimizeAcceptance calls the reorder write path and reflects persisted state', async () => {
  const stops: TripStop[] = [
    tripStop({ id: 's1', orderIndex: 0, lat: 16.00, lng: 108.00 }),
    tripStop({ id: 's2', orderIndex: 1, lat: 16.10, lng: 108.10 }),
    tripStop({ id: 's3', orderIndex: 2, lat: 16.05, lng: 108.05 }),
  ];
  const proposal = optimizeToday(stops, { now: '2026-09-05T18:00:00.000Z' });

  const calls: string[][] = [];
  const result = await persistOptimizeAcceptance(proposal, '2026-09-05T18:05:00.000Z', {
    reorder: async (ids: string[]) => { calls.push(ids); },
  });

  assert.equal(result.persisted, true, 'a successful write is reflected as persisted');
  assert.equal(calls.length, 1, 'the reorder write path was called exactly once');
  // What was persisted matches the accepted proposal's ordering of existing stops.
  assert.deepEqual(calls[0], result.orderedStopIds);
  assert.deepEqual(result.orderedStopIds.slice().sort(), ['s1', 's2', 's3']);
});

test('persistOptimizeAcceptance does NOT claim persisted when the write path throws', async () => {
  const stops: TripStop[] = [
    tripStop({ id: 's1', orderIndex: 0, lat: 16.00, lng: 108.00 }),
    tripStop({ id: 's2', orderIndex: 1, lat: 16.10, lng: 108.10 }),
  ];
  const proposal = optimizeToday(stops, { now: '2026-09-05T18:00:00.000Z' });

  let attempted = false;
  const result = await persistOptimizeAcceptance(proposal, '2026-09-05T18:05:00.000Z', {
    reorder: async () => { attempted = true; throw new Error('forbidden'); },
  });

  assert.equal(attempted, true, 'the write was attempted');
  assert.equal(result.persisted, false, 'a failed write is never reported as saved (§20)');
  assert.equal(result.error, 'forbidden');
});

test('persistOptimizeAcceptance reorders existing stops and adds accepted saved ideas through the canonical path', async () => {
  // Two stops with a saved idea sitting almost on the line between them, so the
  // optimizer proposes inserting it (barely a detour).
  const stops: TripStop[] = [
    tripStop({ id: 's1', orderIndex: 0, lat: 16.000, lng: 108.000 }),
    tripStop({ id: 's2', orderIndex: 1, lat: 16.000, lng: 108.010 }),
  ];
  const savedIdeas: TripSavedIdea[] = [
    { id: 'idea-1', title: 'Coffee', lat: 16.000, lng: 108.005 },
  ];
  const proposal = optimizeToday(stops, {
    now: '2026-09-05T18:00:00.000Z',
    savedIdeas,
    maxSavedIdeaInsertions: 1,
  });
  assert.equal(proposal.insertions.length, 1, 'the saved idea is proposed as an insertion');

  const reorderCalls: string[][] = [];
  const added: TripStop[] = [];
  const result = await persistOptimizeAcceptance(proposal, '2026-09-05T18:05:00.000Z', {
    reorder: async (ids: string[]) => { reorderCalls.push(ids); },
    addSavedIdea: async (idea: TripStop) => { added.push(idea); return `item-${idea.id}`; },
  });

  assert.equal(result.persisted, true);
  // The reorder is over EXISTING stops only — the insertion has no plan-item id yet.
  assert.deepEqual(reorderCalls[0].slice().sort(), ['s1', 's2']);
  assert.ok(!reorderCalls[0].includes('idea-1'), 'the un-created insertion is not sent to reorder');
  // The accepted saved idea was added through the canonical Trips path.
  assert.deepEqual(added.map((s) => s.id), ['idea-1']);
  assert.deepEqual(result.addedInsertionItemIds, ['item-idea-1']);
});
