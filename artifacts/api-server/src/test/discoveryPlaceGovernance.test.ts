import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeClient, startRouter, call, type RouterHarness } from './telegraphCertificationHarness.js';
import { _setTestClient, _clearTestClient } from '../lib/http.js';
import reviewsRouter from '../routes/reviews.js';
import collectionsRouter from '../routes/collections.js';
import tagsRouter from '../routes/tags.js';
import hashtagsRouter from '../routes/hashtags.js';
import tripsExpansionRouter from '../routes/trips-expansion.js';
import pulseRouter from '../routes/pulse.js';
import { governDiscoveryPlaces, readDiscoveryPlaceFacts, readPlaceInteractionVisibility } from '../lib/discoveryPlaceGovernance.js';
import { applyGemPrivacy, applyGemPrivacyBatch } from '../services/hiddenGems/HiddenGemPrivacyGuard.js';
import { readMemberGeography, servableMembers } from '../services/trails/TrailService.js';
import { readDiscoveryCandidatesForViewer } from '../lib/discoveryCandidate.js';
import { filterMapPlaceGovernance } from '../lib/mapPlaceGovernance.js';

const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
const canonical = (n: number, extra: Record<string, unknown> = {}) => ({ id: id(n), status: 'active', name: `Place ${n}`, latitude: 38.71, longitude: -9.13, primary_category: 'cafe', ...extra });
const community = (n: number) => ({ id: id(n), status: 'active', name: `Community ${n}`, lat: 38.71, lng: -9.13 });
const member = (n: number) => ({ id: id(n + 100), source_type: 'place', source_id: id(n), contributor_id: null } as any);

describe('Discovery current canonical moderation at public boundaries', () => {
  it('rechecks cached IDs on every call and cannot use a curated shadow after withholding', async () => {
    const db = makeFakeClient({ places: [canonical(1)], discovery_places: [community(1), community(2)] });
    const rows = [`db/${id(1)}`, `db/${id(2)}`, 'osm/node/1'];
    assert.deepEqual((await governDiscoveryPlaces(db, rows, value => value)).rows, rows);
    db._store.places![0]!.moderation_status = 'withheld';
    assert.deepEqual((await governDiscoveryPlaces(db, rows, value => value)).rows, rows.slice(1));
    assert.deepEqual((await readDiscoveryPlaceFacts(db, [id(1), id(2)]))?.map(row => row.id), [id(2)]);
  });
  it('reads canonical coordinates/categories and prefers them to a same-ID community row', async () => {
    const db = makeFakeClient({ places: [canonical(1)], discovery_places: [community(1), community(2)] });
    const rows = await readDiscoveryPlaceFacts(db, [id(1), id(2)]);
    const place = rows!.find(row => row.id === id(1))!;
    assert.equal(place.name, 'Place 1'); assert.equal(place.lat, 38.71); assert.equal(place.category, 'cafe'); assert.equal(place.submitted_by, null);
    assert.equal(rows!.length, 2);
  });
  it('refuses inactive canonical shadows and never fabricates a missing source', async () => {
    const db = makeFakeClient({ places: [canonical(1, { status: 'closed' })], discovery_places: [community(1)] });
    assert.deepEqual(await readDiscoveryPlaceFacts(db, [id(1), id(9)]), []);
    assert.deepEqual(await servableMembers(db, [member(1), member(9)], null), []);
  });
  it('withholds merged aliases when their target is withheld', async () => {
    const db = makeFakeClient({ places: [canonical(1, { merged_into_place_id: id(2) }), canonical(2, { moderation_status: 'withheld' })] });
    assert.deepEqual((await governDiscoveryPlaces(db, [id(1), id(2)], value => value)).rows, []);
  });
  it('withholds alternate community and OSM aliases through both registry relationships', async () => {
    const db = makeFakeClient({ places: [canonical(1, { moderation_status: 'withheld' })],
      discovery_places: [{ ...community(2), canonical_location_id: id(1), osm_id: 'node/1' }],
      external_place_references: [{ provider: 'osm', provider_place_id: 'way/2', place_id: id(1) }] });
    const rows = [`db/${id(2)}`, 'osm/node/1', 'node/1', 'way/2', 'node/3'];
    assert.deepEqual((await governDiscoveryPlaces(db, rows, value => value)).rows, ['node/3']);
    assert.equal(await readPlaceInteractionVisibility(db, id(2)), false);
    db._store.places![0]!.moderation_status = 'visible';
    assert.deepEqual((await governDiscoveryPlaces(db, rows, value => value)).rows, rows);
  });
  it('does not reveal an OSM alias of a held same-ID community shadow', async () => {
    const db = makeFakeClient({ places: [canonical(1, { moderation_status: 'withheld' })], discovery_places: [{ ...community(1), osm_id: 'node/1' }] });
    assert.deepEqual((await governDiscoveryPlaces(db, ['node/1'], value => value)).rows, []);
  });
  it('follows a community UUID through its OSM key even without a canonical_location_id', async () => {
    const db = makeFakeClient({ places: [canonical(1, { moderation_status: 'withheld' })],
      discovery_places: [{ ...community(2), osm_id: 'node/1' }],
      external_place_references: [{ provider: 'osm', provider_place_id: 'node/1', place_id: id(1) }] });
    assert.deepEqual(await governDiscoveryPlaces(db, [id(2)], value => value), { rows: [], readable: true });
    assert.equal(await readPlaceInteractionVisibility(db, id(2)), false);
    db._store.places![0]!.moderation_status = 'visible';
    assert.deepEqual((await governDiscoveryPlaces(db, [id(2)], value => value)).rows, [id(2)]);
  });
  it('does not serve a community UUID when its provider relationship cannot be checked', async () => {
    const db = makeFakeClient({ discovery_places: [{ ...community(2), osm_id: 'node/1' }] },
      { errors: { external_place_references: { code: '57014', message: 'timeout' } } });
    assert.deepEqual(await governDiscoveryPlaces(db, [id(2)], value => value), { rows: [], readable: false });
  });
  it('does not treat unreadable alias mappings as evidence that external places are unlinked', async () => {
    const db = makeFakeClient({}, { errors: { external_place_references: { code: '57014', message: 'timeout' } } });
    assert.deepEqual(await governDiscoveryPlaces(db, ['node/1'], value => value), { readable: false, rows: [] });
  });
  it('reports unreadability while keeping unrelated external results', async () => {
    const db = makeFakeClient({}, { errors: { places: { code: '57014', message: 'timeout' } } });
    assert.deepEqual(await governDiscoveryPlaces(db, [id(1), 'osm/node/1'], value => value), { rows: ['osm/node/1'], readable: false });
    assert.equal(await readDiscoveryPlaceFacts(db, [id(1)]), null);
    const result = await readDiscoveryCandidatesForViewer(db, [{ id: id(1) } as any], null, null);
    assert.deepEqual(result.candidates, []); assert.deepEqual(result.degraded, ['canonical_place_governance']);
  });
  it('reads more than one database batch without silently truncating', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => canonical(i + 1));
    assert.equal((await readDiscoveryPlaceFacts(makeFakeClient({ places: rows }), rows.map(row => row.id)))!.length, 205);
    assert.equal(await readDiscoveryPlaceFacts(makeFakeClient({ places: rows }, { maxRows: 1 }), [id(1), id(2)]), null);
  });
  it('removes withheld place geography and same-ID community coordinate shadows', async () => {
    const db = makeFakeClient({ places: [canonical(1, { moderation_status: 'withheld' })], discovery_places: [community(1)] });
    const result = await readMemberGeography(db, [member(1)]);
    assert.deepEqual(result.cellBySource, {}); assert.equal(result.venueOf.size, 0);
  });
  it('rechecks cached Saved and Memory map pins through their community and provider identities', async () => {
    const db = makeFakeClient({ places: [canonical(1)], discovery_places: [{ ...community(2), osm_id: 'node/1' }],
      external_place_references: [{ provider: 'osm', provider_place_id: 'node/1', place_id: id(1) }] });
    const objects = [
      { id: `saved:dp:${id(2)}`, kind: 'saved_place', payload: { placeId: `db/${id(2)}` } },
      { id: 'saved:raw:node/1', kind: 'saved_place', payload: { placeId: 'node/1' } },
      { id: `memory:${id(10)}`, kind: 'memory', payload: { subjectType: 'place', subjectId: id(2) } },
    ] as any;
    assert.deepEqual((await filterMapPlaceGovernance(db, objects)).objects, objects);
    db._store.places![0]!.moderation_status = 'withheld';
    assert.deepEqual(await filterMapPlaceGovernance(db, objects), { readable: true, objects: [] });
    db._store.places![0]!.moderation_status = 'visible';
    assert.deepEqual((await filterMapPlaceGovernance(db, objects)).objects, objects);
  });
  it('cannot substitute a visible canonical pin ID for a withheld community alias', async () => {
    const db = makeFakeClient({ places: [canonical(1, { moderation_status: 'withheld' }), canonical(3)],
      discovery_places: [{ ...community(2), canonical_location_id: id(1) }] });
    const objects = [{ id: `saved:dp:${id(2)}`, kind: 'saved_place', payload: { placeId: `db/${id(2)}`, canonicalPlaceId: id(3) } }] as any;
    assert.deepEqual(await filterMapPlaceGovernance(db, objects), { readable: true, objects: [] });
  });
  it('withholds unreadable map aliases without dropping unrelated objects', async () => {
    const db = makeFakeClient({}, { errors: { discovery_places: { message: 'offline' } } });
    const unrelated = { id: 'traveler:1', kind: 'traveler', payload: {} } as any;
    const pin = { id: `memory:${id(10)}`, kind: 'memory', payload: { subjectType: 'place', subjectId: id(2) } } as any;
    assert.deepEqual(await filterMapPlaceGovernance(db, [pin, unrelated]), { readable: false, objects: [unrelated] });
  });
});

describe('Hidden Gems and place activity respect linked-place holds', () => {
  const gem = { id: id(10), canonical_place_id: id(1), sensitivity_level: 'public', latitude: 38.71, longitude: -9.13 };
  it('removes a linked gem from detail and saved/list responses, including its owner', async () => {
    const db = makeFakeClient({ places: [canonical(1, { moderation_status: 'withheld' })] });
    assert.equal(await applyGemPrivacy(gem, db as any, id(20)), null);
    assert.deepEqual(await applyGemPrivacyBatch([gem], db as any, id(20)), []);
  });
  it('fails an unreadable linked place instead of reporting an empty collection', async () => {
    const db = makeFakeClient({}, { errors: { places: { code: '57014', message: 'timeout' } } });
    await assert.rejects(applyGemPrivacyBatch([gem], db as any, null), /visibility could not be checked/);
    assert.equal(await readPlaceInteractionVisibility(db, id(1)), null);
  });
  it('keeps freehand gems and currently visible canonical gems', async () => {
    const db = makeFakeClient({ places: [canonical(1)] });
    assert.equal((await applyGemPrivacyBatch([gem, { ...gem, id: id(11), canonical_place_id: null }], db as any, null)).length, 2);
  });
  it('refuses reviews/votes through either a canonical ID or a linked gem ID', async () => {
    const db = makeFakeClient({ places: [canonical(1, { moderation_status: 'withheld' })], hidden_gems: [gem] });
    assert.equal(await readPlaceInteractionVisibility(db, id(1)), false);
    assert.equal(await readPlaceInteractionVisibility(db, id(10)), false);
    assert.equal(await readPlaceInteractionVisibility(db, id(12)), true);
  });
});

describe('Reviews/votes HTTP moderation admission and reads', () => {
  let harness: RouterHarness;
  before(async () => { harness = await startRouter(reviewsRouter); });
  after(async () => { _clearTestClient(); await harness.close(); });
  function fixture(unread = false) {
    const db = makeFakeClient({
      profiles: [{ id: id(20), account_status: 'active' }],
      places: [canonical(1, { moderation_status: 'withheld' })],
      discovery_places: [community(1)],
      hidden_gems: [{ id: id(10), canonical_place_id: id(1) }],
      reviews: [{ id: id(30), reviewer_id: id(20), entity_type: 'place', entity_id: id(1), state: 'published' }],
      place_votes: [{ user_id: id(20), entity_type: 'place', entity_id: id(1), vote: 'worth_it' },
        { user_id: id(21), entity_type: 'place', entity_id: id(1), vote: 'worth_it' }],
    }, unread ? { errors: { places: { code: '57014', message: 'timeout' } } } : {});
    _setTestClient(db as never, true); return db;
  }
  for (const target of [1, 10]) {
    it(`withholds review/vote reads for ${target === 1 ? 'canonical' : 'linked gem'} ID`, async () => {
      fixture();
      for (const suffix of ['reviews', 'votes']) assert.equal((await call(harness.base, 'GET', `/places/${id(target)}/${suffix}`, id(20))).status, 404);
    });
    it(`refuses new reviews/votes through ${target === 1 ? 'canonical shadow' : 'linked gem'}`, async () => {
      const db = fixture();
      assert.equal((await call(harness.base, 'POST', '/reviews', id(20), { entityType: 'place', entityId: id(target), rating: 5 })).status, 404);
      assert.equal((await call(harness.base, 'POST', `/places/${id(target)}/votes`, id(20), { vote: 'worth_it', entityType: target === 10 ? 'gem' : 'place' })).status, 404);
      assert.equal(db._observed.inserts.length + db._observed.upserts.length, 0);
    });
  }
  it('refuses owner edits and my-review reads while a place is held', async () => {
    const db = fixture();
    assert.equal((await call(harness.base, 'PATCH', `/reviews/${id(30)}`, id(20), { rating: 2 })).status, 404);
    assert.equal((await call(harness.base, 'GET', `/reviews/my-review?entityType=place&entityId=${id(1)}`, id(20))).status, 404);
    assert.equal(db._observed.updates.length, 0);
  });
  it('returns a retriable failure when moderation cannot be read', async () => {
    fixture(true);
    assert.equal((await call(harness.base, 'GET', `/places/${id(1)}/reviews`, id(20))).status, 503);
    assert.equal((await call(harness.base, 'POST', '/reviews', id(20), { entityType: 'place', entityId: id(1), rating: 5 })).status, 503);
  });
  it('still erases a held-place vote without revealing the remaining aggregate', async () => {
    const db = fixture();
    const result = await call(harness.base, 'POST', `/places/${id(1)}/votes`, id(20), { vote: null });
    assert.equal(result.status, 200); assert.deepEqual(result.body, { worthItCount: 0, skipItCount: 0, myVote: null });
    assert.deepEqual(db._store.place_votes!.map(row => row.user_id), [id(21)]);
  });
  it('allows public review/vote reads again after restoration', async () => {
    const db = fixture(); db._store.places![0]!.moderation_status = 'visible';
    for (const suffix of ['reviews', 'votes']) assert.equal((await call(harness.base, 'GET', `/places/${id(1)}/${suffix}`, id(20))).status, 200);
  });
  it('maps atomic admission refusal to an unavailable place after a read/write moderation race', async () => {
    const db = makeFakeClient({ profiles: [{ id: id(20), account_status: 'active' }], places: [canonical(1)], discovery_places: [community(1)] },
      { errors: { reviews: { code: 'PT409', message: 'canonical_place_unavailable', ops: ['insert'] },
        place_votes: { code: 'PT409', message: 'canonical_place_unavailable', ops: ['upsert'] } } });
    _setTestClient(db as never, true);
    assert.equal((await call(harness.base, 'POST', '/reviews', id(20), { entityType: 'place', entityId: id(1), rating: 5 })).status, 404);
    assert.equal((await call(harness.base, 'POST', `/places/${id(1)}/votes`, id(20), { vote: 'worth_it' })).status, 404);
    assert.equal(db._store.reviews?.length ?? 0, 0); assert.equal(db._store.place_votes?.length ?? 0, 0);
  });
});


describe('Saved place collection previews use current catalog and moderation', () => {
  let harness: RouterHarness;
  before(async () => { harness = await startRouter(collectionsRouter); });
  after(async () => { _clearTestClient(); await harness.close(); });
  function fixture(extra: Record<string, any[]> = {}, failPolicy = false) {
    const db = makeFakeClient({
      profiles: [{ id: id(20), account_status: 'active' }],
      collections: [{ id: id(30), owner_id: id(20) }],
      collection_items: [{ id: id(40), collection_id: id(30), entity_type: 'place', entity_id: id(2), saved_at: '2026-11-05T00:00:00Z' }],
      places: [canonical(1)],
      discovery_places: [{ ...community(2), osm_id: 'node/1', image_url: 'https://example.test/cover.jpg' }],
      external_place_references: [{ provider: 'osm', provider_place_id: 'node/1', place_id: id(1) }],
      ...extra,
    }, failPolicy ? { errors: { places: { code: '57014', message: 'timeout' } } } : {});
    _setTestClient(db, true); return db;
  }
  async function saved() {
    const response = await call(harness.base, 'GET', `/users/me/collections/${id(30)}/items`, id(20));
    assert.equal(response.status, 200);
    return response.body.items;
  }
  it('keeps a saved row while withholding its place preview, and recovers after restoration', async () => {
    const db = fixture();
    assert.equal((await saved())[0].title, 'Community 2');
    db._store.places![0]!.moderation_status = 'withheld';
    assert.deepEqual((await saved())[0], { id: id(40), entityType: 'place', entityId: id(2), savedAt: '2026-11-05T00:00:00Z', title: null, coverUrl: null });
    db._store.places![0]!.moderation_status = 'visible';
    assert.equal((await saved())[0].coverUrl, 'https://example.test/cover.jpg');
  });
  it('resolves canonical saved places that have no community duplicate', async () => {
    fixture({ places: [canonical(2)], discovery_places: [] });
    assert.equal((await saved())[0].title, 'Place 2');
  });
  it('keeps saved items without exposing a preview when current policy is unreadable', async () => {
    fixture({}, true);
    const rows = await saved();
    assert.equal(rows.length, 1); assert.equal(rows[0].entityId, id(2));
    assert.equal(rows[0].title, null); assert.equal(rows[0].coverUrl, null);
  });
  it('does not substitute another entity type with the same UUID for an unavailable place', async () => {
    fixture({ places: [canonical(1, { moderation_status: 'withheld' })],
      collection_items: [
        { id: id(40), collection_id: id(30), entity_type: 'place', entity_id: id(2), saved_at: '2026-11-05T00:00:00Z' },
        { id: id(41), collection_id: id(30), entity_type: 'hashtag', entity_id: id(2), saved_at: '2026-11-05T00:00:00Z' },
      ], hashtags: [{ id: id(2), slug: 'public-tag' }],
    });
    const rows = await saved();
    assert.equal(rows.find((row: any) => row.entityType === 'place').title, null);
    assert.equal(rows.find((row: any) => row.entityType === 'hashtag').title, '#public-tag');
  });
});


for (const surface of [
  { name: 'tag suggestions', router: tagsRouter, path: '/tags/suggestions?q=community', key: 'suggestions' },
  { name: 'hashtag places', router: hashtagsRouter, path: '/hashtags/travel/feed?tab=places', key: 'items' },
  { name: 'trip nearby places', router: tripsExpansionRouter, path: `/trips/${id(50)}/nearby-places`, key: 'places' },
  { name: 'Pulse place cards', router: pulseRouter, path: '/pulse?city=Lisbon', key: 'placeCards' },
]) {
  describe(`Current place moderation on ${surface.name}`, () => {
    let harness: RouterHarness;
    before(async () => { harness = await startRouter(surface.router); });
    after(async () => { _clearTestClient(); await harness.close(); });
    function fixture(fail = false) {
      const db = makeFakeClient({
        profiles: [{ id: id(20), account_status: 'active' }],
        places: [canonical(1)],
        discovery_places: [{ ...community(2), city: 'Lisbon', osm_id: 'node/1' }],
        external_place_references: [{ provider: 'osm', provider_place_id: 'node/1', place_id: id(1) }],
        hashtags: [{ id: id(30), slug: 'travel', is_blocked: false }],
        hashtag_usage: [{ hashtag_id: id(30), source_type: 'discovery_place', source_id: id(2), created_at: new Date().toISOString() }],
        trips: [{ id: id(50), owner_id: id(20), visibility: 'public', status: 'active', destination_city: 'Lisbon' }],
      }, fail ? { errors: { places: { code: '57014', message: 'timeout' } } } : {});
      _setTestClient(db, true); return db;
    }
    it('serves the active community listing, withholds its provider alias after a hold, and restores it', async () => {
      const db = fixture();
      const read = async () => {
        const response = await call(harness.base, 'GET', surface.path, id(20));
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response.body[surface.key];
      };
      assert.equal((await read()).length, 1);
      db._store.places![0]!.moderation_status = 'withheld';
      assert.deepEqual(await read(), []);
      db._store.places![0]!.moderation_status = 'visible';
      assert.equal((await read()).length, 1);
    });
    it('never serves a place when its current moderation cannot be read', async () => {
      fixture(true);
      const response = await call(harness.base, 'GET', surface.path, id(20));
      if (surface.name === 'trip nearby places') assert.equal(response.status, 503);
      else { assert.equal(response.status, 200); assert.deepEqual(response.body[surface.key], []); }
    });
  });
}
