/**
 * offlineBaseMap tests — §28 "Cache current base-map region".
 *
 * The load-bearing assertions:
 *   - create packs the region through OfflineManager with the right style,
 *     [w,s,e,n] bounds, zoom band and class/scope metadata, AND records a
 *     base_map_region entry in mapCache so the class has a real producer.
 *   - status / list reflect the native pack and carry the class's §28 staleness.
 *   - the base_map_region POLICY governs the packs: a same-scope create
 *     replaces, the entry cap evicts the oldest, and prune drops expired ones.
 *   - with no native manager (Jest / web / stripped build) every call reports
 *     `offline_unavailable` and never throws.
 *
 * A fake OfflineManager + an in-memory MapCache + an injected clock drive it —
 * no native module, mirroring mapCache.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBaseMapRegionPack,
  getBaseMapRegionStatus,
  listBaseMapRegions,
  removeBaseMapRegion,
  pruneBaseMapRegions,
  DEFAULT_MIN_ZOOM,
  DEFAULT_MAX_ZOOM,
  type OfflineManagerLike,
  type OfflinePackLike,
  type OfflinePackStatusLike,
  type OfflineBaseMapDeps,
} from '../offlineBaseMap.ts';
import { DARK_MAP_STYLE_URL } from '../../../../constants/mapStyle.ts';
import { MapCache, MAP_CACHE_POLICIES, type StorageLike } from '../mapCache.ts';

// ── Test doubles ──────────────────────────────────────────────────────────────

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

interface CreateCall {
  options: {
    mapStyle: string;
    bounds: [number, number, number, number];
    minZoom?: number;
    maxZoom?: number;
    metadata?: Record<string, unknown>;
  };
}

class FakePack implements OfflinePackLike {
  constructor(
    readonly id: string,
    readonly metadata: Record<string, unknown>,
    private readonly state: OfflinePackStatusLike,
  ) {}
  async status(): Promise<OfflinePackStatusLike> {
    return this.state;
  }
}

class FakeOfflineManager implements OfflineManagerLike {
  packs: FakePack[] = [];
  createCalls: CreateCall[] = [];
  private seq = 0;

  async createPack(options: CreateCall['options']): Promise<OfflinePackLike> {
    this.createCalls.push({ options });
    const pack = new FakePack(`pack-${++this.seq}`, options.metadata ?? {}, {
      state: 'active',
      percentage: 0,
      completedResourceCount: 0,
      requiredResourceCount: 100,
    });
    this.packs.push(pack);
    return pack;
  }
  async getPacks(): Promise<OfflinePackLike[]> {
    return [...this.packs];
  }
  async deletePack(id: string): Promise<void> {
    this.packs = this.packs.filter((p) => p.id !== id);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 8, 4, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const BOUNDS = { west: 100.4, south: 13.6, east: 100.7, north: 13.9 };

function makeDeps(overrides: Partial<OfflineBaseMapDeps> = {}): {
  deps: OfflineBaseMapDeps;
  manager: FakeOfflineManager;
  cache: MapCache;
  storage: MemoryStorage;
  clock: { t: number };
} {
  const manager = new FakeOfflineManager();
  const storage = new MemoryStorage();
  const clock = { t: T0 };
  const cache = new MapCache({ storage, now: () => clock.t });
  const deps: OfflineBaseMapDeps = {
    offlineManager: manager,
    cache,
    now: () => clock.t,
    ...overrides,
  };
  return { deps, manager, cache, storage, clock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('create packs the region and records a base_map_region cache entry', async () => {
  const { deps, manager, cache } = makeDeps();

  const res = await createBaseMapRegionPack({ scope: 'Bangkok', bounds: BOUNDS }, deps);
  assert.equal(res.ok, true);

  // The pack was created with the app's dark style, [w,s,e,n] bounds, the
  // default zoom band, and class/scope metadata.
  assert.equal(manager.createCalls.length, 1);
  const opts = manager.createCalls[0].options;
  assert.equal(opts.mapStyle, DARK_MAP_STYLE_URL);
  assert.deepEqual(opts.bounds, [BOUNDS.west, BOUNDS.south, BOUNDS.east, BOUNDS.north]);
  assert.equal(opts.minZoom, DEFAULT_MIN_ZOOM);
  assert.equal(opts.maxZoom, DEFAULT_MAX_ZOOM);
  assert.equal(opts.metadata?.class, 'base_map_region');
  assert.equal(opts.metadata?.scope, 'bangkok'); // normalised

  // The class now has a producer: mapCache holds a base_map_region entry.
  const entry = await cache.read('base_map_region', 'Bangkok');
  assert.ok(entry, 'expected a base_map_region cache entry');
  assert.equal(entry!.objects.length, 0); // base map is tiles, not objects
});

test('status returns the native pack download state', async () => {
  const { deps } = makeDeps();
  await createBaseMapRegionPack({ scope: 'Tokyo', bounds: BOUNDS }, deps);

  const res = await getBaseMapRegionStatus('Tokyo', deps);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.state, 'active');
});

test('status of an unpacked region reports not_found', async () => {
  const { deps } = makeDeps();
  const res = await getBaseMapRegionStatus('Nowhere', deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'not_found');
});

test('list returns regions newest-first with §28 staleness and expiry', async () => {
  const { deps, clock } = makeDeps();
  await createBaseMapRegionPack({ scope: 'Bangkok', bounds: BOUNDS }, deps);
  clock.t += 2 * DAY;
  await createBaseMapRegionPack({ scope: 'Manila', bounds: BOUNDS }, deps);

  clock.t += 60 * 1000; // a minute after Manila
  const res = await listBaseMapRegions(deps);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.value.map((r) => r.scope), ['manila', 'bangkok']); // newest first
  // Neither is past the 7-day TTL yet.
  assert.equal(res.value.every((r) => r.expired === false), true);
  // Bangkok is the older one, so its staleness age is larger.
  const bangkok = res.value.find((r) => r.scope === 'bangkok')!;
  assert.ok(bangkok.staleness.ageMs >= 2 * DAY);
});

test('creating the same scope twice replaces rather than duplicates', async () => {
  const { deps, manager } = makeDeps();
  await createBaseMapRegionPack({ scope: 'Bangkok', bounds: BOUNDS }, deps);
  await createBaseMapRegionPack({ scope: 'Bangkok', bounds: BOUNDS }, deps);

  const bangkokPacks = manager.packs.filter((p) => p.metadata['scope'] === 'bangkok');
  assert.equal(bangkokPacks.length, 1);
});

test('the entry cap evicts the oldest region when full', async () => {
  const { deps, manager, clock } = makeDeps();
  const cap = MAP_CACHE_POLICIES.base_map_region.maxEntries;

  // Fill to the cap, each a little later so ages differ.
  for (let i = 0; i < cap; i++) {
    clock.t += 60 * 1000;
    await createBaseMapRegionPack({ scope: `city-${i}`, bounds: BOUNDS }, deps);
  }
  assert.equal(manager.packs.length, cap);

  // One more evicts the oldest (city-0).
  clock.t += 60 * 1000;
  await createBaseMapRegionPack({ scope: 'city-new', bounds: BOUNDS }, deps);

  assert.equal(manager.packs.length, cap);
  assert.equal(manager.packs.some((p) => p.metadata['scope'] === 'city-0'), false);
  assert.equal(manager.packs.some((p) => p.metadata['scope'] === 'city-new'), true);
});

test('prune drops regions past the base_map_region TTL', async () => {
  const { deps, manager, clock } = makeDeps();
  await createBaseMapRegionPack({ scope: 'stale-city', bounds: BOUNDS }, deps);
  clock.t += 6 * DAY;
  await createBaseMapRegionPack({ scope: 'fresh-city', bounds: BOUNDS }, deps);

  // Advance past the 7-day TTL for stale-city (created at T0) but not fresh-city.
  clock.t += 2 * DAY; // stale-city age 8d, fresh-city age 2d
  const res = await pruneBaseMapRegions(deps);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.removed, 1);
  assert.equal(manager.packs.some((p) => p.metadata['scope'] === 'stale-city'), false);
  assert.equal(manager.packs.some((p) => p.metadata['scope'] === 'fresh-city'), true);
});

test('remove deletes the pack and its cache record', async () => {
  const { deps, manager, cache } = makeDeps();
  await createBaseMapRegionPack({ scope: 'Bangkok', bounds: BOUNDS }, deps);
  assert.ok(await cache.read('base_map_region', 'Bangkok'));

  const res = await removeBaseMapRegion('Bangkok', deps);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.value.removed, true);
  assert.equal(manager.packs.length, 0);
  assert.equal(await cache.read('base_map_region', 'Bangkok'), null);
});

test('every entry point fails soft when the native manager is unavailable', async () => {
  // offlineManager: null models Jest / web / a stripped build.
  const deps: OfflineBaseMapDeps = { offlineManager: null };

  for (const call of [
    () => createBaseMapRegionPack({ scope: 'x', bounds: BOUNDS }, deps),
    () => getBaseMapRegionStatus('x', deps),
    () => listBaseMapRegions(deps),
    () => removeBaseMapRegion('x', deps),
    () => pruneBaseMapRegions(deps),
  ]) {
    const res = await call();
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.reason, 'offline_unavailable');
  }
});
