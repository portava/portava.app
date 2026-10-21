/**
 * Trips §18.1 "cached map tiles where permitted" — census-trips TR340.
 *
 * The trip's area is packed through the Map programme's §28 base-map region
 * mechanism (offlineBaseMap.ts), under the trip's own scope, ONLY where
 * permitted: the device holds packs, data-saver is off, and there is a
 * city-sized area to pack. Driven with a fake OfflineManager and an in-memory
 * MapCache, as offlineBaseMap.test.ts drives the mechanism itself.
 *
 * Run: node --import tsx/esm --test src/features/trips/offline/__tests__/tripOfflineTiles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheTripTiles, describeTripTiles, tripTileArea, tripTileScope, tripTileStatus,
  DESTINATION_HALF_SPAN_DEG, MAX_TILE_SPAN_DEG, TILE_PAD_DEG, TRIP_TILE_MAX_ZOOM, TRIP_TILE_MIN_ZOOM,
} from '../tripOfflineTiles.ts';
import { OFFLINE_PACK_METADATA_CLASS, type OfflineManagerLike, type OfflinePackLike, type OfflinePackStatusLike } from '../../../map/cache/offlineBaseMap.ts';
import { MapCache, type StorageLike } from '../../../map/cache/mapCache.ts';
import { DARK_MAP_STYLE_URL } from '../../../../constants/mapStyle.ts';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  async getItem(k: string) { return this.map.get(k) ?? null; }
  async setItem(k: string, v: string) { this.map.set(k, v); }
  async removeItem(k: string) { this.map.delete(k); }
}
class FakePack implements OfflinePackLike {
  constructor(readonly id: string, readonly metadata: Record<string, unknown>, public state: OfflinePackStatusLike) {}
  async status() { return this.state; }
}
class FakeManager implements OfflineManagerLike {
  packs: FakePack[] = [];
  created: any[] = [];
  fail = false;
  async createPack(options: any) {
    if (this.fail) throw new Error('disk full');
    this.created.push(options);
    const p = new FakePack(`p${this.created.length}`, options.metadata ?? {}, { state: 'active', percentage: 42.4, completedResourceCount: 1, requiredResourceCount: 3 });
    this.packs.push(p);
    return p;
  }
  async getPacks() { return [...this.packs]; }
  async deletePack(id: string) { this.packs = this.packs.filter((p) => p.id !== id); }
}
const deps = (manager: OfflineManagerLike | null) => ({ offlineManager: manager, cache: new MapCache({ storage: new MemoryStorage(), now: () => 0 }), now: () => 1_000 });

const TRIP = 'trip-tr340';
const PARIS = { lat: 48.8566, lng: 2.3522 };

test('the area: a destination alone is a box around it; with meeting points it is their padded union', () => {
  const alone = tripTileArea(PARIS, []);
  assert.ok(alone.ok);
  if (!alone.ok) return;
  assert.ok(Math.abs(alone.bounds.north - (PARIS.lat + DESTINATION_HALF_SPAN_DEG)) < 1e-9);
  assert.ok(Math.abs(alone.bounds.west - (PARIS.lng - DESTINATION_HALF_SPAN_DEG)) < 1e-9);
  const withPoints = tripTileArea(PARIS, [{ lat: 48.87, lng: 2.30 }, { lat: 48.84, lng: 2.40 }]);
  assert.ok(withPoints.ok);
  if (!withPoints.ok) return;
  assert.ok(Math.abs(withPoints.bounds.west - (2.30 - TILE_PAD_DEG)) < 1e-9);
  assert.ok(Math.abs(withPoints.bounds.east - (2.40 + TILE_PAD_DEG)) < 1e-9);
  assert.ok(Math.abs(withPoints.bounds.north - (48.87 + TILE_PAD_DEG)) < 1e-9);
  assert.ok(Math.abs(withPoints.bounds.south - (48.84 - TILE_PAD_DEG)) < 1e-9);
});

test('no usable location is no area; a continent is not a city', () => {
  assert.deepEqual(tripTileArea(null, []), { ok: false, reason: 'no_area' });
  assert.deepEqual(tripTileArea({ lat: null as any, lng: null as any }, []), { ok: false, reason: 'no_area' });
  assert.deepEqual(tripTileArea({ lat: 0, lng: 0 }, []), { ok: false, reason: 'no_area' }, 'null island is a missing value, not a destination');
  assert.deepEqual(tripTileArea({ lat: 95, lng: 2 }, []), { ok: false, reason: 'no_area' });
  assert.deepEqual(tripTileArea(PARIS, [{ lat: PARIS.lat + MAX_TILE_SPAN_DEG + 0.01, lng: PARIS.lng }]), { ok: false, reason: 'area_too_large' });
});

test('permitted: the trip area is packed under the trip scope, the §28 style and class, at street level', async () => {
  const manager = new FakeManager();
  const r = await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [{ lat: 48.86, lng: 2.33 }] }, { mediaAllowed: true, offline: deps(manager) });
  assert.deepEqual(r, { state: 'cached', scope: tripTileScope(TRIP) });
  assert.equal(manager.created.length, 1);
  const o = manager.created[0];
  assert.equal(o.mapStyle, DARK_MAP_STYLE_URL);
  assert.equal(o.minZoom, TRIP_TILE_MIN_ZOOM);
  assert.equal(o.maxZoom, TRIP_TILE_MAX_ZOOM);
  assert.equal(o.metadata.class, OFFLINE_PACK_METADATA_CLASS);
  assert.equal(o.metadata.scope, tripTileScope(TRIP));
  const [w, s, e, n] = o.bounds;
  assert.ok(w < PARIS.lng && e > PARIS.lng && s < PARIS.lat && n > PARIS.lat, 'the destination is inside the pack');
});

test('a refresh REPLACES the trip pack rather than adding a second one', async () => {
  const manager = new FakeManager();
  const d = deps(manager);
  await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [] }, { mediaAllowed: true, offline: d });
  await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [] }, { mediaAllowed: true, offline: d });
  assert.equal(manager.packs.filter((p) => p.metadata.scope === tripTileScope(TRIP)).length, 1);
});

test('NOT permitted: data saver, no area, too wide an area, or a device without packs — and nothing is downloaded', async () => {
  const manager = new FakeManager();
  assert.deepEqual(await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [] }, { mediaAllowed: false, offline: deps(manager) }), { state: 'not_permitted', reason: 'data_saver' });
  assert.deepEqual(await cacheTripTiles(TRIP, { destination: null, meetingPoints: [] }, { mediaAllowed: true, offline: deps(manager) }), { state: 'not_permitted', reason: 'no_area' });
  assert.deepEqual(await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [{ lat: 40, lng: -3 }] }, { mediaAllowed: true, offline: deps(manager) }), { state: 'not_permitted', reason: 'area_too_large' });
  assert.equal(manager.created.length, 0);
  assert.deepEqual(await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [] }, { mediaAllowed: true, offline: deps(null) }), { state: 'not_permitted', reason: 'offline_unavailable' });
});

test('a pack that fails is a stated failure, never a throw', async () => {
  const manager = new FakeManager();
  manager.fail = true;
  assert.deepEqual(await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [] }, { mediaAllowed: true, offline: deps(manager) }), { state: 'failed', detail: 'disk full' });
});

test('status: none, downloading (rounded), complete, or unavailable', async () => {
  const manager = new FakeManager();
  const d = deps(manager);
  assert.deepEqual(await tripTileStatus(TRIP, d), { state: 'none' });
  await cacheTripTiles(TRIP, { destination: PARIS, meetingPoints: [] }, { mediaAllowed: true, offline: d });
  assert.deepEqual(await tripTileStatus(TRIP, d), { state: 'downloading', percentage: 42 });
  manager.packs[0]!.state = { state: 'complete', percentage: 100, completedResourceCount: 3, requiredResourceCount: 3 };
  assert.deepEqual(await tripTileStatus(TRIP, d), { state: 'complete' });
  assert.deepEqual(await tripTileStatus(TRIP, deps(null)), { state: 'unavailable' });
});

test('the card line says why a map was not saved, and how far a saved one has got', () => {
  assert.match(describeTripTiles({ state: 'not_permitted', reason: 'data_saver' }, null) ?? '', /data saver is on/);
  assert.match(describeTripTiles({ state: 'not_permitted', reason: 'no_area' }, null) ?? '', /no location/);
  assert.match(describeTripTiles({ state: 'not_permitted', reason: 'area_too_large' }, null) ?? '', /too wide/);
  assert.match(describeTripTiles({ state: 'not_permitted', reason: 'offline_unavailable' }, null) ?? '', /not available on this device/);
  assert.match(describeTripTiles({ state: 'failed', detail: 'disk full' }, null) ?? '', /disk full/);
  assert.match(describeTripTiles(null, { state: 'downloading', percentage: 42 }) ?? '', /42%/);
  assert.match(describeTripTiles({ state: 'cached', scope: 'trip:x' }, { state: 'complete' }) ?? '', /saved for offline use/);
  assert.equal(describeTripTiles(null, { state: 'none' }), null);
});

test('the trip screen hands the card the trip\'s own destination coordinates (wiring pin)', async () => {
  const { readFileSync } = await import('node:fs'); const { fileURLToPath } = await import('node:url'); const { dirname } = await import('node:path'); const __dir = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(`${__dir}/../../../../../app/trip/[id].tsx`, 'utf8');
  assert.match(src, /<TripOfflineCard tripId=\{trip\.id\} destination=\{\{ lat: \(realTrip as any\)\?\.destinationLat, lng: \(realTrip as any\)\?\.destinationLng \}\} \/>/);
  const card = readFileSync(`${__dir}/../TripOfflineCard.tsx`, 'utf8');
  assert.match(card, /<TripOfflineTiles tripId=\{tripId\} stored=\{stored\} destination=\{destination\} \{\.\.\.tiles\} \/>/);
});

test('each trip has its OWN pack: refreshing one trip never replaces another trip\'s map', async () => {
  assert.equal(tripTileScope('abc'), 'trip:abc');
  const manager = new FakeManager();
  const d = deps(manager);
  await cacheTripTiles('trip-a', { destination: PARIS, meetingPoints: [] }, { mediaAllowed: true, offline: d });
  await cacheTripTiles('trip-b', { destination: { lat: 41.39, lng: 2.17 }, meetingPoints: [] }, { mediaAllowed: true, offline: d });
  assert.deepEqual(manager.packs.map((p) => p.metadata.scope).sort(), ['trip:trip-a', 'trip:trip-b']);
});
