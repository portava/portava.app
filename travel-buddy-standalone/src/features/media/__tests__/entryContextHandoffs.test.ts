/**
 * features/media — §14 entry-context producers (census-media §19: MD88 Place ·
 * MD89 Event · MD90 People · MD91 Trip · MD92 Map).
 *
 * census F8 recorded that `setPerspectiveViewerContext` had exactly one caller
 * passing exactly one kind. Each builder here is a producer for one more kind,
 * and each is tested for the thing §14 says its collection IS — and, because
 * §46.2 forbids a stranger feed, for what it must NOT contain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  placeHandoff,
  mapClusterHandoff,
  experienceHandoff,
  experienceKindOf,
  personHandoff,
} from '../state/entryContextHandoffs.ts';
import { buildPerspectiveCollection } from '../state/perspectiveViewer.ts';
import type { MediaProjection } from '../types/media.ts';
import type { PlaceCurrentView } from '../types/perspective.ts';
import type { MediaExperienceProjection } from '../types/mediaExperience.ts';
import type { PeopleLensGroup } from '../types/peopleLens.ts';

const PLACE = '11111111-1111-1111-1111-111111111111';
const OTHER_PLACE = '22222222-2222-2222-2222-222222222222';

function m(id: string, over: Partial<MediaProjection> = {}): MediaProjection {
  return { id, mediaType: 'image', thumbnailUrl: null, observationClass: 'observed', freshness: 'fresh', ...over };
}

function view(over: Partial<PlaceCurrentView> = {}): PlaceCurrentView {
  return {
    placeId: PLACE,
    placeName: 'An Thuong',
    stateLabel: null,
    currentPicture: {
      strength: 'moderate',
      updatedAt: null,
      ageMinutes: null,
      perspectiveCount: 3,
      contributorCount: 2,
      sourceCount: 2,
      trend: 'steady',
    },
    groups: [{ key: 'nightlife', label: 'Nightlife', count: 2 }],
    heroMedia: [
      m('a', { place: { id: PLACE, name: 'An Thuong' }, perspectiveKey: 'nightlife' }),
      m('b', { place: { id: PLACE, name: 'An Thuong' }, perspectiveKey: 'nightlife' }),
    ],
    ...over,
  };
}

function experience(over: Partial<MediaExperienceProjection> = {}): MediaExperienceProjection {
  return {
    id: 'exp-1',
    kind: 'event',
    title: 'Beach Festival',
    placeIds: [PLACE],
    perspectiveCount: 2,
    contributorCount: 2,
    freshness: 'fresh',
    heroMedia: [m('e1'), m('e2', { place: { id: OTHER_PLACE, name: 'Gate' } })],
    ...over,
  };
}

function person(over: Partial<PeopleLensGroup> = {}): PeopleLensGroup {
  return {
    contributor: { id: 'maya', displayName: 'Maya', verified: true },
    relation: 'followed',
    perspectiveCount: 2,
    freshness: 'fresh',
    media: [m('p1', { contributor: { id: 'maya', displayName: 'Maya', verified: true } }), m('p2')],
    ...over,
  };
}

test('MD88 Place: the collection is that place\'s perspectives, opened on the tapped one', () => {
  const h = placeHandoff(view(), 'b')!;
  assert.equal(h.input.kind, 'place');
  assert.equal(h.input.entityId, PLACE);
  assert.equal(h.initialMediaId, 'b');
  assert.equal(placeHandoff(view({ heroMedia: [] })), null, 'nothing to show opens nothing');
});

test('MD92 Map: the current geographic cluster — kind `map`, scoped to the cluster\'s canonical place', () => {
  const cluster = { placeId: PLACE, label: 'An Thuong', perspectiveCount: 2, freshness: 'fresh' as const };
  const h = mapClusterHandoff(cluster, view())!;
  assert.equal(h.input.kind, 'map');
  assert.equal(h.input.entityId, PLACE);
  // A view for a DIFFERENT place is never staged under this cluster.
  assert.equal(mapClusterHandoff(cluster, view({ placeId: OTHER_PLACE })), null);
  // And the collection, built from it, excludes a foreign place's media — a map
  // cluster is place-shaped, not a feed.
  const foreign = view({
    heroMedia: [...view().heroMedia, m('x', { place: { id: OTHER_PLACE, name: 'Elsewhere' }, perspectiveKey: 'nightlife' })],
  });
  const col = buildPerspectiveCollection(mapClusterHandoff(cluster, foreign)!.input);
  assert.deepEqual(col.items.map((i) => i.id), ['a', 'b']);
});

test('MD89 Event / MD91 Trip: the kind comes from the projection, and the collection is that experience\'s media', () => {
  const ev = experienceHandoff(experience(), 'e2')!;
  assert.equal(ev.input.kind, 'event');
  assert.equal(ev.input.entityId, 'exp-1');
  assert.equal(ev.initialMediaId, 'e2');
  // An event spans places; its own gated hero media is the whole collection.
  assert.deepEqual(buildPerspectiveCollection(ev.input).items.map((i) => i.id), ['e1', 'e2']);

  const trip = experienceHandoff(experience({ kind: 'trip', title: 'Vietnam' }))!;
  assert.equal(trip.input.kind, 'trip');
  assert.equal(trip.input.entityLabel, 'Vietnam');
});

test('an experience that is neither an Event nor a Trip gets NO entry context — the kind is never guessed', () => {
  assert.equal(experienceKindOf(experience({ kind: null, eventId: null, tripId: null })), null);
  assert.equal(experienceHandoff(experience({ kind: null, eventId: null, tripId: null })), null);
  assert.equal(experienceKindOf(experience({ kind: null, tripId: 't1' })), 'trip');
  assert.equal(experienceKindOf(experience({ kind: null, eventId: 'e1' })), 'event');
  assert.equal(experienceKindOf(experience({ kind: null, eventId: 'e1', tripId: 't1' })), null, 'ambiguous is not guessed');
});

test('MD90 People: that PERSON\'s context — another contributor\'s media is dropped, not paged in', () => {
  const g = person({
    media: [
      m('p1', { contributor: { id: 'maya', displayName: 'Maya', verified: true } }),
      m('stranger', { contributor: { id: 'kai', displayName: 'Kai', verified: false } }),
      m('p2'),
    ],
  });
  const h = personHandoff(g)!;
  assert.equal(h.input.kind, 'people');
  assert.equal(h.input.entityId, 'maya');
  assert.deepEqual((h.input.media ?? []).map((x) => x.id), ['p1', 'p2']);
  // …and the viewer's own scoping holds the same line if a foreign item arrives anyway.
  const col = buildPerspectiveCollection({ ...h.input, media: g.media });
  assert.deepEqual(col.items.map((i) => i.id), ['p1', 'p2']);
});

test('a People group with no contributor id opens nothing', () => {
  assert.equal(personHandoff(person({ contributor: { id: '', displayName: 'x', verified: false } })), null);
});
