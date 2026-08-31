/**
 * mapCache tests — the §28/§33/§37 contract.
 *
 * The load-bearing assertions:
 *   - rehydrate NEVER returns the stored freshness; it only ever decays.
 *   - a `precise_temporary` object NEVER returns at its original precision,
 *     and its coordinates are actually coarsened, not merely relabelled.
 *   - per-class TTL is enforced, and the safety class is exempt.
 *   - LRU eviction is bounded AND reported.
 *   - a version mismatch discards cleanly instead of half-reading.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAP_CACHE_INDEX_KEY,
  MAP_CACHE_POLICIES,
  MAP_CACHE_VERSION,
  MapCache,
  cacheKey,
  coarsenGeometry,
  decayFreshness,
  decayLocation,
  describeStaleness,
  formatAge,
  freshnessForAge,
  rehydrate,
  worseFreshness,
  type MapCacheEntry,
  type StorageLike,
} from '../mapCache.ts';
import {
  KIND_DEFAULT_PRIORITY,
  centroidOf,
  mayRenderAsLive,
  precisionRank,
  point,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../../../types/mapObjects.ts';

// ── Test doubles ──────────────────────────────────────────────────────────────

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  reads = 0;
  writes = 0;
  removes = 0;

  async getItem(key: string): Promise<string | null> {
    this.reads += 1;
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.writes += 1;
    this.map.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.removes += 1;
    this.map.delete(key);
  }

  entryKeys(): string[] {
    return [...this.map.keys()].filter((k) => k !== MAP_CACHE_INDEX_KEY);
  }
}

/** A storage whose writes always fail — the "cache errors are silent" path. */
class BrokenStorage implements StorageLike {
  async getItem(): Promise<string | null> {
    throw new Error('native storage unavailable');
  }
  async setItem(): Promise<void> {
    throw new Error('native storage unavailable');
  }
  async removeItem(): Promise<void> {
    throw new Error('native storage unavailable');
  }
}

const T0 = Date.UTC(2026, 7, 31, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function obj(overrides: Partial<MapObject> = {}): MapObject {
  const kind: MapObjectKind = overrides.kind ?? 'place';
  return {
    id: overrides.id ?? 'o1',
    kind,
    geometry: overrides.geometry ?? point(16.0544, 108.2022),
    title: overrides.title ?? 'Test object',
    privacyClass: overrides.privacyClass ?? 'place_level',
    renderingPriority: overrides.renderingPriority ?? KIND_DEFAULT_PRIORITY[kind],
    ...overrides,
  } as MapObject;
}

function entry(overrides: Partial<MapCacheEntry> = {}): MapCacheEntry {
  return {
    version: MAP_CACHE_VERSION,
    cacheClass: 'place_intel',
    scope: 'da nang',
    cachedAt: T0,
    objects: [],
    ...overrides,
  };
}

// ── Freshness ladder ──────────────────────────────────────────────────────────

test('freshnessForAge maps every §7 band, boundaries inclusive-upward', () => {
  // Boundaries belong to the FRESHER band, matching the server's deriveFreshness
  // exactly — these thresholds are FRESHNESS_THRESHOLDS_MS from the contract,
  // not a second table (see the note on FRESHNESS_AGE_MS).
  assert.equal(freshnessForAge(0), 'live');
  assert.equal(freshnessForAge(5 * MIN), 'live');
  assert.equal(freshnessForAge(5 * MIN + 1), 'recent');
  assert.equal(freshnessForAge(30 * MIN), 'recent');
  assert.equal(freshnessForAge(30 * MIN + 1), 'aging');
  assert.equal(freshnessForAge(3 * HOUR), 'aging');
  assert.equal(freshnessForAge(3 * HOUR + 1), 'stale');
  assert.equal(freshnessForAge(DAY), 'stale');
  assert.equal(freshnessForAge(DAY + 1), 'historical');
  assert.equal(freshnessForAge(30 * DAY), 'historical');
});

test('freshnessForAge clamps negative ages (clock skew) instead of going exotic', () => {
  assert.equal(freshnessForAge(-5 * MIN), 'live');
});

test('worseFreshness picks the less fresh of two states, unknown worst', () => {
  assert.equal(worseFreshness('live', 'stale'), 'stale');
  assert.equal(worseFreshness('historical', 'live'), 'historical');
  assert.equal(worseFreshness('unknown', 'historical'), 'unknown');
  assert.equal(worseFreshness('recent', 'recent'), 'recent');
});

test('decayFreshness never returns the stored value when time has passed', () => {
  const stored = obj({ freshness: 'live', observedAt: new Date(T0).toISOString() });
  assert.equal(decayFreshness(stored, T0), 'live');
  assert.equal(decayFreshness(stored, T0 + 20 * MIN), 'recent');
  assert.equal(decayFreshness(stored, T0 + 2 * HOUR), 'aging');
  assert.equal(decayFreshness(stored, T0 + 6 * HOUR), 'stale');
  assert.equal(decayFreshness(stored, T0 + 2 * DAY), 'historical');
});

test('decayFreshness never UPGRADES: a stored historical stays historical', () => {
  const memory = obj({
    kind: 'memory',
    freshness: 'historical',
    observedAt: new Date(T0).toISOString(),
  });
  assert.equal(decayFreshness(memory, T0), 'historical');
});

test('decayFreshness fails closed to unknown with no observedAt', () => {
  assert.equal(decayFreshness(obj({ freshness: 'live' }), T0 + MIN), 'unknown');
});

test('decayFreshness caps an expired object at stale even when just observed', () => {
  const expiring = obj({
    freshness: 'live',
    observedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 30_000).toISOString(),
  });
  assert.equal(decayFreshness(expiring, T0 + 10_000), 'live');
  // 40s old => age says 'live', but it has expired => stale.
  assert.equal(decayFreshness(expiring, T0 + 40_000), 'stale');
  assert.equal(mayRenderAsLive(decayFreshness(expiring, T0 + 40_000)), false);
});

// ── Staleness labels (§28) ────────────────────────────────────────────────────

test('formatAge renders the §28 last-updated vocabulary', () => {
  assert.equal(formatAge(0), 'just now');
  assert.equal(formatAge(59_000), 'just now');
  assert.equal(formatAge(60_000), '1m');
  assert.equal(formatAge(14 * MIN), '14m');
  assert.equal(formatAge(59 * MIN), '59m');
  assert.equal(formatAge(3 * HOUR), '3h');
  assert.equal(formatAge(2 * DAY), '2d');
});

test('describeStaleness produces a renderable label and a stale flag', () => {
  const fresh = describeStaleness(T0, T0 + 20_000, false);
  assert.equal(fresh.label, 'Last updated just now');
  assert.equal(fresh.stale, false);
  assert.equal(fresh.expired, false);

  const old = describeStaleness(T0, T0 + 14 * MIN, true);
  assert.equal(old.label, 'Last updated 14m ago');
  assert.equal(old.ageMs, 14 * MIN);
  assert.equal(old.stale, true);
  assert.equal(old.expired, true);
});

// ── §23 location decay ────────────────────────────────────────────────────────

test('decayLocation leaves fixed features alone', () => {
  const r = decayLocation('place_level', 'place', 6 * HOUR);
  assert.equal(r.stage, 'precise');
  assert.equal(r.privacyClass, 'place_level');
  assert.equal(r.gridMeters, 0);
});

test('decayLocation degrades precise_temporary immediately, at any age', () => {
  const r = decayLocation('precise_temporary', 'crew_member', 0);
  assert.equal(r.stage, 'approximate');
  assert.equal(r.privacyClass, 'approximate');
  assert.ok(precisionRank(r.privacyClass!) < precisionRank('precise_temporary'));
});

test('decayLocation walks the §23 ladder: approximate -> last known -> expired', () => {
  assert.equal(decayLocation('precise_temporary', 'crew_member', 14 * MIN).stage, 'approximate');
  assert.equal(decayLocation('precise_temporary', 'crew_member', 15 * MIN).stage, 'last_known');
  assert.equal(decayLocation('precise_temporary', 'crew_member', 59 * MIN).stage, 'last_known');

  const expired = decayLocation('precise_temporary', 'crew_member', HOUR);
  assert.equal(expired.stage, 'expired');
  assert.equal(expired.privacyClass, null);
});

test('decayLocation grid tightens as the object ages', () => {
  assert.equal(decayLocation('precise_temporary', 'crew_member', MIN).gridMeters, 250);
  assert.equal(decayLocation('precise_temporary', 'crew_member', 30 * MIN).gridMeters, 500);
});

test('decayLocation never WIDENS a narrow class', () => {
  const r = decayLocation('aggregate_only', 'social_zone', MIN);
  assert.equal(r.privacyClass, 'aggregate_only');
  assert.equal(r.gridMeters, 0, 'an aggregate object has no point precision to coarsen');
});

test('coarsenGeometry actually moves the coordinates onto a grid', () => {
  const precise = point(16.054407, 108.202167);
  const coarse = coarsenGeometry(precise, 250);
  const a = centroidOf(precise)!;
  const b = centroidOf(coarse)!;
  assert.notDeepEqual(a, b, 'coarsening must change the coordinates, not just the label');
  // Snapped to a ~250 m grid => at most ~half a cell of movement.
  assert.ok(Math.abs(a.lat - b.lat) < 250 / 111_320, 'lat stays within one grid cell');
  // Snapping is idempotent: coarsening the coarse point again is a no-op.
  assert.deepEqual(coarsenGeometry(coarse, 250), coarse);
});

test('coarsenGeometry handles polygons and line strings vertex-wise', () => {
  const poly = coarsenGeometry(
    {
      type: 'Polygon',
      coordinates: [
        [
          [108.202167, 16.054407],
          [108.203167, 16.054407],
          [108.203167, 16.055407],
          [108.202167, 16.054407],
        ],
      ],
    },
    500,
  );
  assert.equal(poly.type, 'Polygon');
  assert.equal((poly as { coordinates: number[][][] }).coordinates[0].length, 4);

  const line = coarsenGeometry(
    {
      type: 'LineString',
      coordinates: [
        [108.202167, 16.054407],
        [108.212167, 16.064407],
      ],
    },
    250,
  );
  assert.equal(line.type, 'LineString');
  assert.equal((line as { coordinates: number[][] }).coordinates.length, 2);
});

// ── rehydrate ─────────────────────────────────────────────────────────────────

test('rehydrate recomputes freshness as of now, not as of the write', () => {
  const e = entry({
    objects: [
      obj({ id: 'a', freshness: 'live', observedAt: new Date(T0).toISOString() }),
      obj({ id: 'b', freshness: 'recent', observedAt: new Date(T0 - 5 * HOUR).toISOString() }),
    ],
  });

  const out = rehydrate(e, T0 + 45 * MIN);
  const a = out.objects.find((o) => o.id === 'a')!;
  const b = out.objects.find((o) => o.id === 'b')!;

  assert.equal(a.freshness, 'aging', 'a stored live object is 45m old => aging');
  assert.equal(b.freshness, 'stale', '5h45m old => stale');
  assert.equal(mayRenderAsLive(a.freshness), false);
  assert.equal(mayRenderAsLive(b.freshness), false);
});

test('rehydrate crosses every freshness boundary as the clock advances', () => {
  const e = entry({ objects: [obj({ freshness: 'live', observedAt: new Date(T0).toISOString() })] });
  const at = (ms: number) => rehydrate(e, T0 + ms).objects[0].freshness;

  assert.equal(at(0), 'live');
  assert.equal(at(5 * MIN + 1), 'recent');
  assert.equal(at(30 * MIN + 1), 'aging');
  assert.equal(at(3 * HOUR + 1), 'stale');
  assert.equal(at(DAY + 1), 'historical');
});

test('rehydrate stamps cachedAt, fromCache and a staleness label on every object', () => {
  const e = entry({
    objects: [obj({ freshness: 'live', observedAt: new Date(T0 - 14 * MIN).toISOString() })],
  });
  const out = rehydrate(e, T0);
  const o = out.objects[0];

  assert.equal(o.fromCache, true);
  assert.equal(o.cachedAt, T0);
  assert.equal(o.staleness.label, 'Last updated 14m ago');
  assert.equal(out.staleness.label, 'Last updated just now', 'entry itself was written now');
});

test('rehydrate NEVER returns a precise_temporary object at its original precision', () => {
  const preciseGeom = point(16.054407, 108.202167);
  const e = entry({
    cacheClass: 'crew_state',
    cachedAt: T0,
    objects: [
      obj({
        id: 'crew-1',
        kind: 'crew_member',
        title: 'Sam',
        privacyClass: 'precise_temporary',
        geometry: preciseGeom,
        freshness: 'live',
        observedAt: new Date(T0).toISOString(),
      }),
    ],
  });

  // Even at zero elapsed time, the cache is not the moment precision was granted.
  for (const elapsed of [0, 1_000, 5 * MIN, 14 * MIN]) {
    const out = rehydrate(e, T0 + elapsed);
    const o = out.objects[0];
    assert.notEqual(o.privacyClass, 'precise_temporary', `elapsed=${elapsed}`);
    assert.equal(o.privacyClass, 'approximate');
    assert.equal(o.privacyDegraded, true);
    assert.equal(o.locationStage, 'approximate');
    assert.notDeepEqual(
      o.geometry,
      preciseGeom,
      'geometry must be coarsened, not merely relabelled',
    );
    assert.equal(out.degradedForPrivacy, 1);
  }
});

test('rehydrate moves a temporary position to last_known then drops it entirely', () => {
  const e = entry({
    cacheClass: 'crew_state',
    cachedAt: T0,
    objects: [
      obj({
        id: 'crew-1',
        kind: 'crew_member',
        privacyClass: 'precise_temporary',
        freshness: 'live',
        observedAt: new Date(T0).toISOString(),
      }),
    ],
  });

  const lastKnown = rehydrate(e, T0 + 20 * MIN);
  assert.equal(lastKnown.objects[0].locationStage, 'last_known');
  assert.equal(lastKnown.objects[0].privacyClass, 'approximate');
  assert.equal(lastKnown.droppedForPrivacy, 0);

  const gone = rehydrate(e, T0 + 90 * MIN);
  assert.equal(gone.objects.length, 0, '§23 Expired => dropped, not rendered');
  assert.equal(gone.droppedForPrivacy, 1);
});

test('rehydrate ages a temporary position from the CACHE WRITE when it has no observedAt', () => {
  const e = entry({
    cacheClass: 'crew_state',
    cachedAt: T0,
    objects: [obj({ kind: 'crew_member', privacyClass: 'precise_temporary' })],
  });
  assert.equal(rehydrate(e, T0 + 5 * MIN).objects.length, 1);
  assert.equal(rehydrate(e, T0 + 2 * HOUR).objects.length, 0);
});

test('rehydrate leaves fixed places at full stored precision', () => {
  const geom = point(16.054407, 108.202167);
  const e = entry({ objects: [obj({ privacyClass: 'place_level', geometry: geom })] });
  const out = rehydrate(e, T0 + 3 * HOUR);
  assert.equal(out.objects[0].privacyClass, 'place_level');
  assert.deepEqual(out.objects[0].geometry, geom);
  assert.equal(out.objects[0].privacyDegraded, false);
  assert.equal(out.degradedForPrivacy, 0);
});

test('rehydrate drops objects that are unrenderable after degradation', () => {
  const e = entry({
    objects: [
      obj({ id: 'ok' }),
      obj({ id: 'no-title', title: '   ' }),
      obj({ id: 'private', privacyClass: 'none' }),
    ],
  });
  const out = rehydrate(e, T0);
  assert.deepEqual(
    out.objects.map((o) => o.id),
    ['ok'],
  );
  assert.equal(out.droppedUnrenderable, 2);
});

test('rehydrate reports entry expiry against the class TTL', () => {
  const e = entry({ cacheClass: 'place_intel', cachedAt: T0 });
  assert.equal(rehydrate(e, T0 + 30 * MIN).expired, false);
  assert.equal(rehydrate(e, T0 + 2 * HOUR).expired, true);
});

test('rehydrate tolerates a malformed object list without throwing', () => {
  const e = entry({ objects: [null as unknown as MapObject, obj({ id: 'ok' })] });
  const out = rehydrate(e, T0);
  assert.equal(out.objects.length, 1);
});

// ── Class policies ────────────────────────────────────────────────────────────

test('every cache class has a positive TTL, a cap, and a documented rationale', () => {
  for (const [name, policy] of Object.entries(MAP_CACHE_POLICIES)) {
    assert.ok(policy.ttlMs > 0, `${name} ttl`);
    assert.ok(policy.maxEntries > 0, `${name} maxEntries`);
    assert.ok(policy.note.length > 20, `${name} note explains the number`);
  }
});

test('safety is the only eviction-exempt class (§28)', () => {
  const exempt = Object.entries(MAP_CACHE_POLICIES)
    .filter(([, p]) => p.evictionExempt)
    .map(([k]) => k);
  assert.deepEqual(exempt, ['safety']);
});

test('volatile classes have shorter TTLs than user-owned ones', () => {
  assert.ok(MAP_CACHE_POLICIES.place_intel.ttlMs < MAP_CACHE_POLICIES.saved_places.ttlMs);
  assert.ok(MAP_CACHE_POLICIES.crew_state.ttlMs < MAP_CACHE_POLICIES.place_intel.ttlMs * 3);
  assert.ok(MAP_CACHE_POLICIES.trip.ttlMs >= 30 * DAY);
});

// ── MapCache: read / write round trip ─────────────────────────────────────────

test('write then read round-trips, with freshness recomputed on the way out', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now });

  const res = await cache.write('place_intel', 'Da Nang', [
    obj({ id: 'p1', freshness: 'live', observedAt: new Date(T0).toISOString() }),
  ]);
  assert.equal(res.stored, true);
  assert.equal(res.evicted, 0);
  assert.ok(res.bytes > 0);

  now = T0 + 45 * MIN;
  const out = await cache.read('place_intel', 'Da Nang');
  assert.ok(out);
  assert.equal(out!.objects[0].freshness, 'aging');
  assert.equal(out!.staleness.label, 'Last updated 45m ago');
});

test('scope is normalized so "Da Nang" and "da nang" share one entry', async () => {
  const storage = new MemoryStorage();
  const cache = new MapCache({ storage, now: () => T0 });
  await cache.write('place_intel', 'Da Nang', [obj({ id: 'a' })]);
  await cache.write('place_intel', ' da nang ', [obj({ id: 'b' })]);
  assert.equal(storage.entryKeys().length, 1);
  const out = await cache.read('place_intel', 'DA NANG');
  assert.equal(out!.objects[0].id, 'b');
});

test('read returns null on a miss', async () => {
  const cache = new MapCache({ storage: new MemoryStorage(), now: () => T0 });
  assert.equal(await cache.read('trip', 'nope'), null);
});

// ── TTL + safety exemption ────────────────────────────────────────────────────

test('a non-exempt entry past its TTL is discarded on read', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now });
  await cache.write('place_intel', 'da nang', [obj({ id: 'a' })]);

  now = T0 + MAP_CACHE_POLICIES.place_intel.ttlMs;
  assert.equal(await cache.read('place_intel', 'da nang'), null);
  assert.equal(storage.map.has(cacheKey('place_intel', 'da nang')), false, 'key removed');
});

test('safety information is still served past its TTL, flagged expired (§28)', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now });
  await cache.write('safety', 'da nang', [
    obj({
      id: 'flood',
      kind: 'safety_notice',
      title: 'Flood warning — riverside',
      observedAt: new Date(T0).toISOString(),
      freshness: 'live',
    }),
  ]);

  now = T0 + MAP_CACHE_POLICIES.safety.ttlMs + DAY;
  const out = await cache.read('safety', 'da nang');
  assert.ok(out, 'safety survives its TTL — offline in an emergency is the point');
  assert.equal(out!.expired, true);
  assert.equal(out!.staleness.expired, true);
  assert.equal(out!.objects[0].freshness, 'historical', 'still not presented as live');
});

test('sweep purges expired non-exempt entries and keeps exempt ones', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now });
  await cache.write('place_intel', 'a', [obj({ id: 'a' })]);
  await cache.write('crew_state', 'b', [obj({ id: 'b' })]);
  await cache.write('safety', 'c', [obj({ id: 'c', kind: 'safety_notice' })]);

  now = T0 + 365 * DAY;
  const swept = await cache.sweep();
  assert.equal(swept.removedExpired, 2);
  assert.equal(swept.keptExempt, 1);
  assert.deepEqual(storage.entryKeys(), [cacheKey('safety', 'c')]);
});

// ── LRU eviction ──────────────────────────────────────────────────────────────

test('the byte budget evicts least-recently-used entries and REPORTS the count', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  // Room for roughly two of these entries.
  const cache = new MapCache({ storage, now: () => now, maxBytes: 1_000 });

  const filler = (id: string) =>
    obj({ id, title: `Place ${id}`, subtitle: 'x'.repeat(200) });

  await cache.write('place_intel', 'one', [filler('1')]);
  now += MIN;
  await cache.write('place_intel', 'two', [filler('2')]);
  now += MIN;
  const third = await cache.write('place_intel', 'three', [filler('3')]);

  assert.ok(third.evicted >= 1, 'writing past the budget must evict');
  assert.deepEqual(third.evictedKeys, [cacheKey('place_intel', 'one')], 'oldest access first');
  assert.equal(await cache.read('place_intel', 'one'), null);
  assert.ok(await cache.read('place_intel', 'three'));

  const stats = await cache.stats();
  assert.equal(stats.evictions, third.evicted);
  assert.ok(stats.bytes <= 1_400);
});

test('a read TOUCHES an entry so LRU protects what the user is actually looking at', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now, maxBytes: 1_000 });
  const filler = (id: string) => obj({ id, subtitle: 'x'.repeat(200) });

  await cache.write('place_intel', 'one', [filler('1')]);
  now += MIN;
  await cache.write('place_intel', 'two', [filler('2')]);

  now += MIN;
  await cache.read('place_intel', 'one'); // 'one' is now the most recently used

  now += MIN;
  const third = await cache.write('place_intel', 'three', [filler('3')]);
  assert.deepEqual(third.evictedKeys, [cacheKey('place_intel', 'two')]);
  assert.ok(await cache.read('place_intel', 'one'));
});

test('safety entries are never chosen as LRU victims, even when oldest', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now, maxBytes: 1_000 });
  const filler = (id: string) => obj({ id, subtitle: 'x'.repeat(200) });

  await cache.write('safety', 'sos', [
    obj({ id: 's', kind: 'safety_notice', subtitle: 'x'.repeat(200) }),
  ]);
  now += MIN;
  await cache.write('place_intel', 'one', [filler('1')]);
  now += MIN;
  const third = await cache.write('place_intel', 'two', [filler('2')]);

  assert.ok(!third.evictedKeys.includes(cacheKey('safety', 'sos')));
  assert.ok(await cache.read('safety', 'sos'));
});

test('the per-class entry cap evicts within the class only', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now });
  const cap = MAP_CACHE_POLICIES.trip.maxEntries;

  for (let i = 0; i <= cap; i += 1) {
    await cache.write('trip', `trip-${i}`, [obj({ id: `t${i}`, kind: 'trip_stop' })]);
    now += MIN;
  }

  const stats = await cache.stats();
  assert.equal(stats.byClass.trip.entries, cap);
  assert.equal(await cache.read('trip', 'trip-0'), null, 'oldest trip evicted');
  assert.ok(await cache.read('trip', `trip-${cap}`));
});

test('an entry larger than the whole budget is refused, not stored', async () => {
  const storage = new MemoryStorage();
  const cache = new MapCache({ storage, now: () => T0, maxBytes: 200 });
  const res = await cache.write('place_intel', 'huge', [obj({ subtitle: 'x'.repeat(5_000) })]);
  assert.equal(res.stored, false);
  assert.equal(res.reason, 'entry_too_large');
  assert.equal(storage.entryKeys().length, 0);
});

// ── Version discipline ────────────────────────────────────────────────────────

test('an entry written under a different cache version is discarded cleanly', async () => {
  const storage = new MemoryStorage();
  const cache = new MapCache({ storage, now: () => T0 });
  const key = cacheKey('place_intel', 'da nang');
  storage.map.set(
    key,
    JSON.stringify({ ...entry({ objects: [obj()] }), version: 'v0' }),
  );

  assert.equal(await cache.read('place_intel', 'da nang'), null);
  assert.equal(storage.map.has(key), false, 'the stale-version key is removed, not left behind');
});

test('an index written under a different version purges the entries it pointed at', async () => {
  const storage = new MemoryStorage();
  const orphan = `map:cache:v0:place_intel:old`;
  storage.map.set(orphan, 'whatever');
  storage.map.set(
    MAP_CACHE_INDEX_KEY,
    JSON.stringify({
      version: 'v0',
      rows: [
        {
          key: orphan,
          cacheClass: 'place_intel',
          scope: 'old',
          bytes: 9,
          cachedAt: T0,
          lastAccessedAt: T0,
        },
      ],
    }),
  );

  const cache = new MapCache({ storage, now: () => T0 });
  const stats = await cache.stats();
  assert.equal(stats.entries, 0);
  assert.equal(storage.map.has(orphan), false, 'orphaned bytes are reclaimed, not leaked');
});

test('corrupt JSON in an entry is discarded rather than thrown', async () => {
  const storage = new MemoryStorage();
  const cache = new MapCache({ storage, now: () => T0 });
  storage.map.set(cacheKey('place_intel', 'x'), '{not json');
  assert.equal(await cache.read('place_intel', 'x'), null);
  assert.equal(storage.map.has(cacheKey('place_intel', 'x')), false);
});

test('corrupt JSON in the index degrades to an empty index rather than throwing', async () => {
  const storage = new MemoryStorage();
  storage.map.set(MAP_CACHE_INDEX_KEY, 'nope{');
  const cache = new MapCache({ storage, now: () => T0 });
  const stats = await cache.stats();
  assert.equal(stats.entries, 0);
});

test('cache keys are namespaced and version-prefixed', () => {
  assert.equal(cacheKey('trip', 'Trip-42'), `map:cache:${MAP_CACHE_VERSION}:trip:trip-42`);
  assert.ok(MAP_CACHE_INDEX_KEY.startsWith(`map:cache:${MAP_CACHE_VERSION}:`));
});

// ── Failure containment ───────────────────────────────────────────────────────

test('a storage that throws on every call never breaks the caller', async () => {
  const cache = new MapCache({ storage: new BrokenStorage(), now: () => T0 });
  assert.equal(await cache.read('place_intel', 'x'), null);
  const res = await cache.write('place_intel', 'x', [obj()]);
  assert.equal(res.stored, false);
  await cache.remove('place_intel', 'x');
  const swept = await cache.sweep();
  assert.equal(swept.removedExpired, 0);
});

test('clear removes every entry the cache knows about', async () => {
  const storage = new MemoryStorage();
  const cache = new MapCache({ storage, now: () => T0 });
  await cache.write('place_intel', 'a', [obj({ id: 'a' })]);
  await cache.write('saved_places', 'b', [obj({ id: 'b' })]);
  await cache.clear();
  assert.equal(storage.map.size, 0);
});

// ── The §33 promise, end to end ───────────────────────────────────────────────

test('an offline open paints cached objects immediately, none of them live', async () => {
  const storage = new MemoryStorage();
  let now = T0;
  const cache = new MapCache({ storage, now: () => now });

  const kinds: Array<[MapObjectKind, PrivacyClass]> = [
    ['place', 'place_level'],
    ['event', 'place_level'],
    ['hidden_gem', 'approximate'],
    ['trip_stop', 'place_level'],
  ];
  await cache.write(
    'place_intel',
    'da nang',
    kinds.map(([kind, privacyClass], i) =>
      obj({
        id: `o${i}`,
        kind,
        privacyClass,
        freshness: 'live',
        confidence: 'strong',
        observedAt: new Date(T0).toISOString(),
      }),
    ),
  );

  now = T0 + 47 * MIN;
  const out = await cache.read('place_intel', 'da nang');
  assert.ok(out, 'the map has something to draw before any network call');
  assert.equal(out!.objects.length, kinds.length);
  for (const o of out!.objects) {
    assert.equal(mayRenderAsLive(o.freshness), false, `${o.id} must not render live`);
    assert.equal(o.fromCache, true);
    assert.equal(o.staleness.label, 'Last updated 47m ago');
    assert.equal(o.confidence, 'strong', 'confidence is a separate axis and is NOT decayed');
  }
});
