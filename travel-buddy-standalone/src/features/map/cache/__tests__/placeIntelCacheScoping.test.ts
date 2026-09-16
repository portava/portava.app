/**
 * placeIntelCacheScoping — the regression test for a LIVE cross-account leak in
 * the `place_intel` cache.
 *
 * WHAT THE DEFECT WAS
 * ===================
 * `useMapEntities` wrote its whole merged object list through to the cache
 * under the bare city name, and seeded from the same key:
 *
 *     const scope = city ?? 'unknown';
 *     const cached = await mapCache.read('place_intel', scope);
 *     ...
 *     if (city && merged.length > 0) mapCache.write('place_intel', city, merged);
 *
 * `merged` is not place intelligence. It is the viewer's own trip stops, their
 * crew members, the buddies and travelers the gateway resolved AGAINST THEIR
 * BLOCK LIST, and their memory pins. The key named a CITY and nothing else.
 *
 * AsyncStorage is not cleared on sign-out (see SessionContext's
 * clearScopedStorageForUser, which enumerates a fixed prefix list the map cache
 * is not on), so the next account to open the map in the same city read the
 * previous account's private objects straight back out, and
 * `mapObjectsToEntities` rendered them as though the gateway had just served
 * them. On a shared device it did not even need a sign-out.
 *
 * WHAT THESE TESTS PIN
 * ====================
 * Both halves of the fix, exercised through the REAL MapCache rather than by
 * asserting on the key-builder in isolation:
 *
 *   1. the scope carries the account, so account B cannot read account A's
 *      entry — `leaks under the old city-only keying` below reproduces the
 *      defect against the same cache instance to show the two keyings actually
 *      differ in outcome, not just in string shape;
 *   2. viewer-scoped objects never reach a cross-session store at all, so a
 *      future keying mistake cannot leak a trip again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MapCache, type StorageLike } from '../mapCache.ts';
import {
  isPlaceIntelCacheSafe,
  mapProjectionCacheScope,
} from '../../projection/clientProjection.ts';
import { point, type MapObject } from '../../../../types/mapObjects.ts';

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}

const T0 = Date.parse('2026-08-31T12:00:00.000Z');

function obj(over: Partial<MapObject> & Pick<MapObject, 'id' | 'kind'>): MapObject {
  return {
    title: 'x',
    geometry: point(16.05, 108.2),
    privacyClass: 'approximate',
    renderPriority: 50,
    ...over,
  } as MapObject;
}

/** The camera and layer set both accounts happen to be looking at. */
const VIEWPORT = {
  city: 'Da Nang',
  lat: 16.0544,
  lng: 108.2022,
  zoom: 12,
  radiusKm: 50,
  enabledLayers: ['trips', 'gems'] as const,
};

/** A trip stop: the viewer's own itinerary, and the object that leaked. */
const ALICE_TRIP = obj({ id: 'trip:alice-1', kind: 'trip_stop', title: 'Songkran' });
/** A public gem: the same answer for everybody standing here. */
const PUBLIC_GEM = obj({ id: 'gem:1', kind: 'hidden_gem', title: 'Rooftop stairwell' });

test("account B cannot read account A's cached map projection", async () => {
  const cache = new MapCache({ storage: new MemoryStorage(), now: () => T0 });

  const aliceScope = mapProjectionCacheScope({ accountId: 'alice', ...VIEWPORT })!;
  const bobScope = mapProjectionCacheScope({ accountId: 'bob', ...VIEWPORT })!;

  const written = await cache.write('place_intel', aliceScope, [PUBLIC_GEM]);
  assert.equal(written.stored, true, 'precondition: Alice wrote an entry');

  // Alice still reads her own back — the fix must not simply break the cache.
  const alice = await cache.read('place_intel', aliceScope);
  assert.equal(alice?.objects.length, 1);

  // Bob, on the same device, in the same city, with the same camera and the
  // same layers, gets NOTHING.
  const bob = await cache.read('place_intel', bobScope);
  assert.equal(bob, null, "account B read account A's place_intel entry");
});

test('leaks under the old city-only keying — the defect, reproduced', async () => {
  const cache = new MapCache({ storage: new MemoryStorage(), now: () => T0 });

  // Exactly what the shipped code did: `mapCache.write('place_intel', city, ...)`.
  await cache.write('place_intel', VIEWPORT.city, [ALICE_TRIP]);

  // And exactly what the next account's seed did: `city ?? 'unknown'`.
  const whatBobUsedToSee = await cache.read('place_intel', VIEWPORT.city);
  assert.equal(
    whatBobUsedToSee?.objects.length,
    1,
    'precondition: the old keying is what leaked, so it must leak here',
  );
  assert.equal((whatBobUsedToSee!.objects[0] as MapObject).id, 'trip:alice-1');

  // The new keying, given the identical inputs, does not.
  const underNewKeying = await cache.read(
    'place_intel',
    mapProjectionCacheScope({ accountId: 'bob', ...VIEWPORT })!,
  );
  assert.equal(underNewKeying, null);
});

test('an unresolved identity gets no key, rather than a shared one', async () => {
  const cache = new MapCache({ storage: new MemoryStorage(), now: () => T0 });

  const signedIn = mapProjectionCacheScope({ accountId: 'alice', ...VIEWPORT });
  assert.ok(signedIn);

  // SessionContext starts `userId` at null and resolves it asynchronously, so
  // this is not only the signed-out case — it is every viewer's cold mount.
  // A shared fallback bucket here would be written by Alice during her
  // hydration window and read by Bob during his, which is the original defect.
  assert.equal(mapProjectionCacheScope({ accountId: null, ...VIEWPORT }), null);

  // useMapEntities therefore skips both sides. Alice's entry stays hers, and
  // nothing an identity-less frame produced is ever stored to be found later.
  await cache.write('place_intel', signedIn, [PUBLIC_GEM]);
  assert.equal((await cache.read('place_intel', signedIn))?.objects.length, 1);
});

test('viewer-scoped objects never reach the cache in the first place', async () => {
  const cache = new MapCache({ storage: new MemoryStorage(), now: () => T0 });
  const scope = mapProjectionCacheScope({ accountId: 'alice', ...VIEWPORT })!;

  // The write-through filters exactly as useMapEntities does.
  const merged = [ALICE_TRIP, PUBLIC_GEM];
  const cacheable = merged.filter(isPlaceIntelCacheSafe);
  await cache.write('place_intel', scope, cacheable);

  const back = await cache.read('place_intel', scope);
  assert.deepEqual(
    back?.objects.map((o) => (o as MapObject).id),
    ['gem:1'],
    'only the public gem may be stored; the trip stop must be dropped before the write',
  );
});

test('two cameras in the same city do not rehydrate each other', async () => {
  const cache = new MapCache({ storage: new MemoryStorage(), now: () => T0 });

  const wide = mapProjectionCacheScope({ accountId: 'alice', ...VIEWPORT })!;
  const zoomedIn = mapProjectionCacheScope({ accountId: 'alice', ...VIEWPORT, zoom: 16 })!;
  const otherLayers = mapProjectionCacheScope({
    accountId: 'alice',
    ...VIEWPORT,
    enabledLayers: ['gems'],
  })!;

  await cache.write('place_intel', wide, [PUBLIC_GEM]);
  assert.equal(await cache.read('place_intel', zoomedIn), null);
  assert.equal(await cache.read('place_intel', otherLayers), null);
});

test('coordinate-only deep links no longer collide on a single "unknown" entry', async () => {
  const cache = new MapCache({ storage: new MemoryStorage(), now: () => T0 });

  const daNang = mapProjectionCacheScope({
    accountId: 'alice', ...VIEWPORT, city: null,
  })!;
  const paris = mapProjectionCacheScope({
    accountId: 'alice', ...VIEWPORT, city: null, lat: 48.8566, lng: 2.3522,
  })!;

  await cache.write('place_intel', daNang, [PUBLIC_GEM]);
  assert.equal(
    await cache.read('place_intel', paris),
    null,
    'a deep link into Paris read the entry cached for Da Nang',
  );
  // And the Da Nang deep link is cached at all, which the old `if (city && ...)`
  // write guard never did for a link that carried no city.
  assert.equal((await cache.read('place_intel', daNang))?.objects.length, 1);
});

// ── Entries already on the device ────────────────────────────────────────────
//
// Bumping MAP_CACHE_VERSION makes v1 entries unreachable, because no code path
// constructs a `map:cache:v1:…` key any more. Unreachable is not gone: every
// device that has used the map is still holding a v1 `place_intel` entry keyed
// by city alone, containing whichever account wrote it last. These pin the
// erasure.

/** Storage that can also enumerate, as AsyncStorage can. */
class EnumerableStorage extends MemoryStorage {
  async getAllKeys(): Promise<readonly string[]> {
    return [...this.map.keys()];
  }
}

/** What a v1 install actually left behind: entries plus their v1 index. */
function seedV1(storage: MemoryStorage, scopes: string[]): string[] {
  const keys = scopes.map((s) => `map:cache:v1:place_intel:${s}`);
  for (const key of keys) {
    storage.map.set(key, JSON.stringify({
      version: 'v1',
      cacheClass: 'place_intel',
      scope: key.split(':').pop(),
      cachedAt: T0,
      objects: [ALICE_TRIP],
    }));
  }
  storage.map.set('map:cache:v1:__index', JSON.stringify({
    version: 'v1',
    rows: keys.map((key) => ({
      key, cacheClass: 'place_intel', scope: key.split(':').pop(),
      bytes: 100, cachedAt: T0, lastAccessedAt: T0,
    })),
  }));
  return keys;
}

test('v1 entries are erased from the device, not merely orphaned', async () => {
  const storage = new EnumerableStorage();
  const keys = seedV1(storage, ['da nang', 'hoi an']);
  const cache = new MapCache({ storage, now: () => T0 });

  const removed = await cache.purgeSupersededVersions();

  for (const key of keys) {
    assert.equal(storage.map.get(key), undefined, `${key} survived the purge`);
  }
  assert.equal(storage.map.get('map:cache:v1:__index'), undefined);
  assert.equal(removed, keys.length + 1);
});

test('the purge also catches v1 entries whose index row was lost', async () => {
  const storage = new EnumerableStorage();
  seedV1(storage, ['da nang']);
  // An entry the index never recorded — an index write that failed after the
  // entry write. Only the getAllKeys pass can see this one.
  storage.map.set('map:cache:v1:place_intel:orphan', JSON.stringify({ version: 'v1', objects: [] }));

  const cache = new MapCache({ storage, now: () => T0 });
  await cache.purgeSupersededVersions();

  assert.equal(storage.map.get('map:cache:v1:place_intel:orphan'), undefined);
  assert.deepEqual([...storage.map.keys()], []);
});

test('the purge works on storage that cannot enumerate, via the v1 index', async () => {
  // MemoryStorage has no getAllKeys, like a minimal StorageLike.
  const storage = new MemoryStorage();
  const keys = seedV1(storage, ['da nang', 'hoi an']);
  const cache = new MapCache({ storage, now: () => T0 });

  await cache.purgeSupersededVersions();

  for (const key of keys) assert.equal(storage.map.get(key), undefined);
  assert.equal(storage.map.get('map:cache:v1:__index'), undefined);
});

test('the purge leaves current-version entries completely alone', async () => {
  const storage = new EnumerableStorage();
  seedV1(storage, ['da nang']);
  const cache = new MapCache({ storage, now: () => T0 });
  const scope = mapProjectionCacheScope({ accountId: 'alice', ...VIEWPORT })!;
  await cache.write('place_intel', scope, [PUBLIC_GEM]);

  await cache.purgeSupersededVersions();

  assert.equal((await cache.read('place_intel', scope))?.objects.length, 1);
  assert.ok([...storage.map.keys()].every((k) => !k.startsWith('map:cache:v1:')));
});

test('the purge is one-shot per session and idempotent', async () => {
  const storage = new EnumerableStorage();
  seedV1(storage, ['da nang']);
  const cache = new MapCache({ storage, now: () => T0 });

  const first = await cache.purgeSupersededVersions();
  assert.ok(first > 0);
  // A second call does no storage work at all — it is an upgrade step, not a
  // sweep that should run on every read.
  assert.equal(await cache.purgeSupersededVersions(), 0);
});

test('a storage that throws leaves the entries in place rather than breaking the map', async () => {
  const storage = new EnumerableStorage();
  const keys = seedV1(storage, ['da nang']);
  storage.removeItem = async () => { throw new Error('storage refused'); };
  const cache = new MapCache({ storage, now: () => T0 });

  assert.equal(await cache.purgeSupersededVersions(), 0);
  // Still there, and nothing threw out to the caller.
  assert.ok(storage.map.get(keys[0]) !== undefined);
});
