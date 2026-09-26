/**
 * features/media — Search, filter and My World state (census-media §19:
 * MD27 · MD228 · MD294 client half · MD331 · MD332 · MD26 · MD314).
 *
 * Pure-module and transport cases, run under node:test. The transport cases
 * stub `fetch` and assert the exact request the screens make, because a search
 * screen that renders the right lists from the wrong request proves nothing.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_MEDIA_FILTERS,
  mediaFilterReducer,
  hasSearchCriteria,
  toSearchQueryString,
} from '../state/mediaFilterStore.ts';
import {
  INITIAL_MY_MEDIA_STATE,
  myMediaReducer,
  orderedBuckets,
  activeBucket,
  mapMediaOf,
} from '../state/myMediaStore.ts';
import { experienceIdsFrom, MAX_LENS_EXPERIENCES } from '../state/experienceSources.ts';
import { earlierPerspectives } from '../state/timeBands.ts';
import { mapContextRefs, buildContextGraph, whereTakenHref } from '../state/mediaContextGraph.ts';
import {
  _setTestFreshToken,
  _clearTestFreshToken,
  fetchMediaSearch,
  mapMediaSearchResults,
  isMediaSearchEmpty,
  fetchGems,
  fetchMediaMap,
  fetchWorld,
  mapTimeline,
} from '../services/mediaProjection.ts';
import type { MyWorldBucket } from '../types/myWorld.ts';
import type { MediaProjection } from '../types/media.ts';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';

function m(id: string, over: Partial<MediaProjection> = {}): MediaProjection {
  return { id, mediaType: 'image', thumbnailUrl: null, observationClass: 'observed', freshness: 'recent', ...over };
}

// ── transport stub ────────────────────────────────────────────────────────────
let calls: string[] = [];
const realFetch = globalThis.fetch;
function stubFetch(body: unknown, status = 200) {
  calls = [];
  (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}
afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  _clearTestFreshToken();
});

// ── mediaFilterStore (MD331) ──────────────────────────────────────────────────

test('EMPTY MEANS EMPTY: a criteria-free filter state produces no request at all', () => {
  assert.equal(hasSearchCriteria(INITIAL_MEDIA_FILTERS), false);
  assert.equal(toSearchQueryString(INITIAL_MEDIA_FILTERS), null);
  assert.equal(toSearchQueryString(mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'set_query', q: '   ' })), null);
});

test('a trip scope with no trip is a mistake, not a criterion', () => {
  const f = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'set_scope', scope: 'trip' });
  assert.equal(toSearchQueryString(f), null);
  const g = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'set_scope', scope: 'trip', tripId: 'T1' });
  assert.equal(toSearchQueryString(g), 'scope=trip&tripId=T1');
  // Leaving the trip scope drops the trip id.
  assert.equal(mediaFilterReducer(g, { type: 'set_scope', scope: 'all' }).tripId, null);
});

test('§38 "Show my Bangkok rooftop photos" is q + city + scope=me — the route\'s own parameter names', () => {
  let f = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'set_query', q: 'rooftop' });
  f = mediaFilterReducer(f, { type: 'set_city', city: 'Bangkok' });
  f = mediaFilterReducer(f, { type: 'set_scope', scope: 'me' });
  assert.equal(toSearchQueryString(f), 'q=rooftop&city=Bangkok&scope=me');
});

test('§38 "What does An Thuong look like right now?" is the term + freshOnly — and "Right now" survives a new term', () => {
  let f = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'toggle_fresh' });
  f = mediaFilterReducer(f, { type: 'set_query', q: 'An Thuong' });
  assert.equal(toSearchQueryString(f), 'q=An+Thuong&freshOnly=true');
});

test('category toggles, "right now" is freshOnly, a media id asks "where was this taken"', () => {
  let f = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'toggle_category', category: 'nightlife' });
  f = mediaFilterReducer(f, { type: 'toggle_fresh' });
  assert.equal(toSearchQueryString(f), 'category=nightlife&freshOnly=true');
  f = mediaFilterReducer(f, { type: 'toggle_category', category: 'nightlife' });
  assert.equal(f.category, null);
  const w = mediaFilterReducer(INITIAL_MEDIA_FILTERS, { type: 'set_media', mediaId: U1 });
  assert.equal(toSearchQueryString(w), `mediaId=${U1}`);
});

// ── search transport + mapper (MD27 / MD228 / MD294 client) ───────────────────

test('fetchMediaSearch(null) answers locally and makes NO request', async () => {
  stubFetch({});
  _setTestFreshToken('tok');
  const r = await fetchMediaSearch(null);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 0);
});

test('fetchMediaSearch sends the filter query to GET /api/media/search and maps all seven §38 kinds', async () => {
  stubFetch({
    criteriaUsed: ['q', 'scope'],
    media: [{ id: 'm1', mediaType: 'image', thumbnailUrl: 't', observationClass: 'observed' }],
    places: [{ placeId: U1, label: 'Vertigo', perspectiveCount: 2, freshPerspectiveCount: 1, freshness: 'fresh' }],
    people: [{ id: 'u1', username: 'maya', perspectiveCount: 2, verified: true }],
    hiddenGems: [{ gemId: 'g1', name: 'Cove', placeId: U1 }],
    experiences: [],
    events: [{ id: 'e1', kind: 'event', title: 'Beach Festival', placeIds: [], perspectiveCount: 0, freshness: 'none' }],
    trips: [{ id: 't1', kind: 'trip', title: 'Vietnam', placeIds: [U1], perspectiveCount: 3 }, { id: 'bad', kind: 'event' }],
    unsupported: ['visual similarity'],
    undetermined: ['hiddenGems'],
  });
  _setTestFreshToken('tok');
  const r = await fetchMediaSearch('q=rooftop&scope=me');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /\/api\/media\/search\?q=rooftop&scope=me$/);
  assert.ok(r.ok);
  const d = r.ok ? r.data : null;
  assert.equal(d!.media.length, 1);
  assert.equal(d!.places[0]!.placeId, U1);
  assert.equal(d!.people[0]!.username, 'maya');
  assert.equal(d!.hiddenGems[0]!.gemId, 'g1');
  assert.deepEqual(d!.events.map((e) => e.title), ['Beach Festival']);
  assert.equal(d!.events[0]!.perspectiveCount, 0, 'found by name, not by photo');
  assert.deepEqual(d!.trips.map((t) => t.id), ['t1'], 'a result of the wrong kind is dropped, never relabelled');
  assert.deepEqual(d!.undetermined, ['hiddenGems']);
  assert.equal(isMediaSearchEmpty(d!), false);
  assert.equal(isMediaSearchEmpty(mapMediaSearchResults({})), true);
});

test('fetchGems / fetchMediaMap / fetchWorld send the coarse `city` LABEL the routes actually parse', async () => {
  _setTestFreshToken('tok');
  stubFetch({ gems: [], determined: true, undetermined: [] });
  await fetchGems({ city: 'Da Nang' });
  assert.match(calls[0]!, /\/api\/media\/gems\?city=Da%20Nang$/);
  stubFetch({ clusters: [] });
  await fetchMediaMap({ city: 'Da Nang' });
  assert.match(calls[0]!, /\/api\/media\/map\?city=Da%20Nang$/);
  stubFetch({});
  await fetchWorld({ city: 'Da Nang', cityId: 'x' });
  assert.match(calls[0]!, /[?&]city=Da\+Nang/);
});

test('fetchGems maps the server gem-state shape into the lens (the old mapper dropped every gem)', async () => {
  _setTestFreshToken('tok');
  stubFetch({ gems: [{ gemId: 'g1', name: 'Cove', state: 'still_hidden', confidence: { score: 0.4, band: 'provisional' } }], determined: true, undetermined: [] });
  const r = await fetchGems({ city: 'Da Nang' });
  assert.ok(r.ok);
  assert.deepEqual(r.ok ? r.data.gems.map((g) => g.gemId) : [], ['g1']);
});

// ── myMediaStore (MD332) ──────────────────────────────────────────────────────

function bucket(key: string, media: MediaProjection[], ownerOnly = false): MyWorldBucket {
  return { key, label: key, ownerOnly, count: media.length, media };
}

test('myMediaStore: §30 order, a selection falls back rather than pointing at nothing, search is state not a route', () => {
  const b = orderedBuckets([bucket('drafts', []), bucket('zzz', []), bucket('tagged', []), bucket('all', [])]);
  assert.deepEqual(b.map((x) => x.key), ['all', 'tagged', 'drafts', 'zzz']);
  assert.equal(activeBucket(b, 'missing')?.key, 'all');
  let s = myMediaReducer(INITIAL_MY_MEDIA_STATE, { type: 'open_search' });
  assert.equal(s.searchOpen, true);
  s = myMediaReducer(s, { type: 'select_bucket', key: 'tagged' });
  assert.deepEqual(s, { selectedKey: 'tagged', searchOpen: false });
});

test('My World\'s map places published + tagged media once each — never a draft, archive, upload or processing item', () => {
  const pub = m('p', { place: { id: U1, name: 'Rooftop' } });
  const tagged = m('t', { place: { id: U2, name: 'Beach' } });
  const draft = m('d', { place: { id: U2, name: 'Beach' } });
  const out = mapMediaOf([
    bucket('all', [pub]),
    bucket('posts', [pub]),
    bucket('tagged', [tagged]),
    bucket('drafts', [draft], true),
    bucket('processing', [m('x')]),
  ]);
  assert.deepEqual(out.map((x) => x.id), ['p', 't']);
});

// ── experience sources (MD89 / MD91 producers have a surface) ─────────────────

test('experience ids: deep-linked first, then my events, my trips, nearby events; UUIDs only; de-duplicated; capped', () => {
  const ids = experienceIdsFrom({
    deepLinked: [U2, 'not-a-uuid', null],
    myEvents: [{ id: U1 }, { id: U2 }],
    myTrips: [{ id: '33333333-3333-3333-3333-333333333333' }],
    nearbyEvents: [{ id: '44444444-4444-4444-4444-444444444444' }],
  });
  assert.deepEqual(ids, [U2, U1, '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444']);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000` }));
  assert.equal(experienceIdsFrom({ myTrips: many }).length, MAX_LENS_EXPERIENCES);
});

// ── timeline screen model (MD26) ──────────────────────────────────────────────

test('earlierPerspectives: only OBSERVED Earlier media, newest first, once each — a pattern is never a perspective', () => {
  const tl = mapTimeline({
    bands: {
      earlier: {
        items: [
          { renderClass: 'observed', itemKind: 'media', media: { id: 'old', capturedAt: '2026-09-01T00:00:00Z', mediaType: 'image', observationClass: 'observed' } },
          { renderClass: 'observed', itemKind: 'media', media: { id: 'new', capturedAt: '2026-09-02T00:00:00Z', mediaType: 'image', observationClass: 'observed' } },
          { renderClass: 'observed', itemKind: 'media', media: { id: 'new', capturedAt: '2026-09-02T00:00:00Z', mediaType: 'image', observationClass: 'observed' } },
          { renderClass: 'typical', itemKind: 'pattern', media: { id: 'pattern', mediaType: 'image' } },
        ],
      },
    },
  });
  assert.deepEqual(earlierPerspectives(tl).map((x) => x.id), ['new', 'old']);
  assert.deepEqual(earlierPerspectives(null), []);
});

// ── §7 context graph (MD314) ──────────────────────────────────────────────────

test('context refs keep the §28 Shared Moment edge the action-rail mapper narrows away; unknown kinds are DROPPED', () => {
  const refs = mapContextRefs({
    entityRefs: [
      { kind: 'media', id: 'm1', label: null },
      { kind: 'place', id: U1, label: 'An Thuong' },
      { kind: 'shared_moment', id: 'sm1', label: 'Sunset crew' },
      { kind: 'observation_guess', id: 'o1', label: 'x' },
    ],
  });
  assert.deepEqual(refs.map((r) => r.kind), ['place', 'shared_moment']);
});

test('the §7 graph shows only what the server resolved — no trip edge without a trip ref, event only from an Event entry', () => {
  const media = m('m1', {
    contributor: { id: 'u1', displayName: 'Maya', username: 'maya', verified: true },
    place: { id: U1, name: 'Projection label' },
    capturedAt: '2026-09-03T21:40:00Z',
  });
  const noRefs = buildContextGraph({ media, refs: [] });
  assert.deepEqual(noRefs.map((e) => e.kind), ['person', 'place', 'time']);
  assert.equal(noRefs.some((e) => e.kind === 'trip' || e.kind === 'event'), false);

  const full = buildContextGraph({
    media,
    refs: [
      { kind: 'place', id: U1, label: 'An Thuong' },
      { kind: 'trip', id: 't1', label: 'Vietnam' },
      { kind: 'gem', id: 'g1', label: 'Cove' },
      { kind: 'shared_moment', id: 'sm1', label: 'Sunset crew' },
    ],
    entry: { kind: 'event', entityId: 'e1', entityLabel: 'Beach Festival' },
  });
  assert.deepEqual(full.map((e) => e.kind), ['person', 'place', 'event', 'trip', 'hidden_gem', 'shared_moment', 'time']);
  assert.equal(full.find((e) => e.kind === 'place')!.label, 'An Thuong', 'the viewer-gated ref wins over the projection label');
  assert.equal(full.find((e) => e.kind === 'shared_moment')!.href, '/shared-moments/sm1');
  assert.equal(buildContextGraph({ media, refs: [], entry: { kind: 'place', entityId: U1, entityLabel: 'x' } }).some((e) => e.kind === 'event'), false);
  assert.equal(whereTakenHref('m1'), '/media-search?mediaId=m1');
});
