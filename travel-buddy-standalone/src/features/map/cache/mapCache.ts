/**
 * mapCache — the §28 offline / degraded-mode cache for the Map.
 *
 * WHY THIS EXISTS
 * ===============
 * Two spec rules pull against each other and this module is where they are
 * reconciled:
 *
 *   §33 "The map should progressively improve; it should not blank while live
 *        intelligence is loading."
 *   §28 "Clearly label stale cached intelligence with last-updated time."
 *   §37 "Do not let stale claims remain visually live."
 *
 * So the cache must serve INSTANTLY (so the first frame is never an empty grey
 * rectangle) and must make its own staleness IMPOSSIBLE TO MISS (so nothing it
 * serves is mistaken for a live observation).
 *
 * THE ONE RULE THAT MAKES THAT SAFE
 * =================================
 * `rehydrate()` NEVER returns the freshness that was stored. It recomputes
 * freshness as of `now` and takes the WORSE of (stored, recomputed), so a
 * cached `live` object comes back as `recent` / `aging` / `stale` /
 * `historical` depending purely on how long it has been sitting there.
 * Freshness in this module only ever decays; there is no code path that
 * upgrades it. Every rehydrated object also carries `cachedAt` and a
 * `staleness` descriptor so the UI can render "Last updated 14m ago" without
 * doing any arithmetic of its own.
 *
 * PRIVACY DECAY (§23)
 * ===================
 * §23's ladder — Precise → Approximate → Last known → Expired — applies to
 * cached data too, and more strictly: an object stored at
 * `precise_temporary` is NEVER returned at that precision. On rehydrate it is
 * degraded to `approximate` (with its GEOMETRY actually coarsened, not merely
 * relabelled), then to a coarser "last known" rung, then dropped entirely.
 * Nothing downstream of the projection may sharpen geometry (see
 * src/types/mapObjects.ts) and a cache that restored precision would be
 * exactly that violation, delayed by a restart.
 *
 * STORAGE
 * =======
 * AsyncStorage, keyed `map:cache:v1:<class>:<scope>` — the same
 * version-prefixed namespace idiom as src/services/discoveryLocalCache.ts, and
 * the same "never throw, a cache miss is not an error" contract. The storage
 * API is injected (`StorageLike`, identical to the interface in
 * src/components/discovery/discoverMapFilterStorage.ts) so every line here is
 * testable without a native module; `mapCache` is the app-bound singleton.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FRESHNESS_THRESHOLDS_MS,
  isRenderable,
  narrowestPrivacyClass,
  precisionRank,
  type FreshnessState,
  type MapGeometry,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../../types/mapObjects.ts';

// ── Storage interface ─────────────────────────────────────────────────────────

/** Minimal subset of AsyncStorage this module needs. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// ── Versioning + key namespace ────────────────────────────────────────────────

/**
 * Bump to invalidate every cached entry at once. A stored entry whose
 * `version` differs is discarded on read rather than migrated — cached map
 * intelligence is by definition re-fetchable, so a migration would be all risk
 * and no benefit.
 */
export const MAP_CACHE_VERSION = 'v1';

export const MAP_CACHE_KEY_PREFIX = `map:cache:${MAP_CACHE_VERSION}`;

/** The index lives alongside the entries and is versioned with them. */
export const MAP_CACHE_INDEX_KEY = `${MAP_CACHE_KEY_PREFIX}:__index`;

// ── Cache classes (§28) ───────────────────────────────────────────────────────

/**
 * The seven things §28 says to cache. Each is its own class because each has a
 * genuinely different shelf life: a trip is planned days ahead, a crowd
 * observation is worthless in an hour, and safety information must survive
 * both.
 */
export const MAP_CACHE_CLASSES = [
  'base_map_region',
  'trip',
  'event_map',
  'saved_places',
  'crew_state',
  'place_intel',
  'safety',
] as const;

export type MapCacheClass = (typeof MAP_CACHE_CLASSES)[number];

export interface MapCacheClassPolicy {
  /** How long an entry of this class may be READ back at all. */
  ttlMs: number;
  /**
   * §28: "Cache emergency/safety information where appropriate." Safety
   * information is exempt from aggressive eviction — an exempt class is never
   * chosen as an LRU victim, is never purged by a sweep, and is still served
   * (flagged `expired`) past its TTL. Being offline in an emergency is exactly
   * when this data matters, so it is the one class allowed to outstay its
   * welcome. It is still labelled stale like everything else.
   */
  evictionExempt: boolean;
  /** Per-class cap on distinct scopes; the least-recently-used one is dropped. */
  maxEntries: number;
  /** Why this TTL — kept next to the number so it cannot drift into folklore. */
  note: string;
}

export const MAP_CACHE_POLICIES: Record<MapCacheClass, MapCacheClassPolicy> = {
  // Geography is effectively static; re-fetching it is pure waste and its
  // absence is what makes the map blank, which §33 forbids.
  base_map_region: {
    ttlMs: 7 * 24 * 60 * 60 * 1_000,
    evictionExempt: false,
    maxEntries: 8,
    note: '7 days — base geography barely changes and its absence is what blanks the map (§33).',
  },
  // The user's own plan. They may open it on a plane with no signal; it must
  // outlive the trip itself.
  trip: {
    ttlMs: 30 * 24 * 60 * 60 * 1_000,
    evictionExempt: false,
    maxEntries: 4,
    note: '30 days — user-owned plan data, read offline mid-travel.',
  },
  // An event map is only interesting around the event, but the venue and
  // meeting points must survive a dead-signal venue for the whole day.
  event_map: {
    ttlMs: 7 * 24 * 60 * 60 * 1_000,
    evictionExempt: false,
    maxEntries: 6,
    note: '7 days — venue geometry and meeting points outlive the event day, indoor signal is unreliable.',
  },
  // User-owned, deliberate, and small. Losing it degrades the product more
  // than a stale row does.
  saved_places: {
    ttlMs: 30 * 24 * 60 * 60 * 1_000,
    evictionExempt: false,
    maxEntries: 4,
    note: '30 days — user-owned saves; losing them is worse than showing them aged.',
  },
  // §12's "Last seen 3m ago" ladder. The ENTRY may live two hours, but the
  // per-object §23 location decay below expires the geometry an hour in — the
  // entry outliving the geometry is deliberate, so a rehydrate still knows a
  // crew member existed even after their position has expired.
  crew_state: {
    ttlMs: 2 * 60 * 60 * 1_000,
    evictionExempt: false,
    maxEntries: 4,
    note: '2 hours — presence is temporary (§23); geometry expires sooner via the location ladder.',
  },
  // Crowd claims carry a 15-minute server TTL. Holding an hour lets the map
  // paint immediately and label the result honestly as aging, instead of
  // painting nothing.
  place_intel: {
    ttlMs: 60 * 60 * 1_000,
    evictionExempt: false,
    maxEntries: 24,
    note: '1 hour — crowd TTL is 15 min server-side; an hour buys a non-blank first frame, clearly labelled aging.',
  },
  // §28's explicit exemption.
  safety: {
    ttlMs: 30 * 24 * 60 * 60 * 1_000,
    evictionExempt: true,
    maxEntries: 16,
    note: '30 days and eviction-exempt (§28) — offline in an emergency is when this matters most.',
  },
};

export function isCacheClass(value: string): value is MapCacheClass {
  return (MAP_CACHE_CLASSES as readonly string[]).includes(value);
}

/** `map:cache:v1:<class>:<scope>` — scope is a city, trip id, event id, … */
export function cacheKey(cacheClass: MapCacheClass, scope: string): string {
  return `${MAP_CACHE_KEY_PREFIX}:${cacheClass}:${normalizeScope(scope)}`;
}

export function normalizeScope(scope: string): string {
  return String(scope ?? '').trim().toLowerCase() || 'default';
}

// ── Freshness decay (§7, §37) ─────────────────────────────────────────────────

/**
 * Age boundaries for the §7 freshness column, upper-bound exclusive. These
 * mirror the vocabulary the spec's own table uses ("Live", "2m ago", "8m ago",
 * "Recently", "Last confirmed 1h ago", "Historical").
 */
// Re-exported from the contract, NOT redeclared. `rehydrate` recomputes the
// same `freshness` field the server stamps on the wire, so a second table here
// would mean one object reading "Live" from the network and "aging" from the
// cache at the same age. This module's extra conservatism comes from
// `worseFreshness(stored, recomputed)` — never from different numbers.
export const FRESHNESS_AGE_MS = FRESHNESS_THRESHOLDS_MS;

/** 0 = most current. `unknown` is worst, because it is the fail-closed default. */
const FRESHNESS_RANK: Record<FreshnessState, number> = {
  live: 0,
  recent: 1,
  aging: 2,
  stale: 3,
  historical: 4,
  unknown: 5,
};

export function freshnessRank(state: FreshnessState): number {
  return FRESHNESS_RANK[state] ?? FRESHNESS_RANK.unknown;
}

/** The LESS fresh of two states. The only combinator this module uses. */
export function worseFreshness(a: FreshnessState, b: FreshnessState): FreshnessState {
  return freshnessRank(a) >= freshnessRank(b) ? a : b;
}

/** Freshness implied purely by age. Negative ages (clock skew) clamp to 0. */
export function freshnessForAge(ageMs: number): FreshnessState {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : Number.POSITIVE_INFINITY;
  if (age <= FRESHNESS_AGE_MS.live) return 'live';
  if (age <= FRESHNESS_AGE_MS.recent) return 'recent';
  if (age <= FRESHNESS_AGE_MS.aging) return 'aging';
  if (age <= FRESHNESS_AGE_MS.stale) return 'stale';
  return 'historical';
}

function parseTime(value: string | number | undefined | null): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Freshness as of `now`, never better than what was stored.
 *
 * - No `observedAt` => `unknown` (fail-closed, per mapObjects.ts).
 * - Past `expiresAt` => at worst `stale`; it may not be presented as current.
 * - The result is the worse of the stored value and the recomputed one, so a
 *   `historical` memory stays historical and a `live` crowd claim decays.
 */
export function decayFreshness(obj: MapObject, now: number): FreshnessState {
  const observedAt = parseTime(obj.observedAt);
  let computed: FreshnessState = observedAt == null ? 'unknown' : freshnessForAge(now - observedAt);

  const expiresAt = parseTime(obj.expiresAt);
  if (expiresAt != null && now >= expiresAt) {
    computed = worseFreshness(computed, 'stale');
  }

  return worseFreshness(obj.freshness ?? 'unknown', computed);
}

// ── Staleness descriptor (§28 "label stale cached intelligence") ──────────────

export interface Staleness {
  /** Epoch ms the entry was written. */
  cachedAt: number;
  /** now - cachedAt, clamped at 0. */
  ageMs: number;
  /** Compact age, e.g. "14m", "3h", "2d", or "just now". */
  age: string;
  /** Ready-to-render, e.g. "Last updated 14m ago". */
  label: string;
  /** True unless this is fresh enough that "cached" would be misleading noise. */
  stale: boolean;
  /** True when the entry is past its class TTL. */
  expired: boolean;
}

/** Below this an entry is so young that a staleness chip is just noise. */
export const STALENESS_QUIET_MS = 60 * 1_000;

export function formatAge(ageMs: number): string {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  if (age < STALENESS_QUIET_MS) return 'just now';
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(age / 3_600_000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(age / 86_400_000);
  return `${days}d`;
}

export function describeStaleness(cachedAt: number, now: number, expired: boolean): Staleness {
  const ageMs = Math.max(0, now - cachedAt);
  const age = formatAge(ageMs);
  return {
    cachedAt,
    ageMs,
    age,
    label: age === 'just now' ? 'Last updated just now' : `Last updated ${age} ago`,
    stale: ageMs >= STALENESS_QUIET_MS,
    expired,
  };
}

// ── §23 location decay ────────────────────────────────────────────────────────

/** §23: "Temporary location should decay automatically." */
export const LOCATION_STAGES = ['precise', 'approximate', 'last_known', 'expired'] as const;
export type LocationStage = (typeof LOCATION_STAGES)[number];

/**
 * Kinds whose geometry is a PERSON'S position rather than a fixed feature.
 * These follow the decay ladder even when they were stored at `approximate`,
 * because "where my friend was" goes wrong with time in a way "where the bar
 * is" does not.
 */
export const TEMPORARY_LOCATION_KINDS: readonly MapObjectKind[] = [
  'crew_member',
  'social_zone',
  'buddy_zone',
];

/** Age past which an approximate temporary position becomes "last known". */
export const LOCATION_LAST_KNOWN_AFTER_MS = 15 * 60 * 1_000;
/** Age past which a temporary position is dropped entirely (§23 "Expired"). */
export const LOCATION_EXPIRES_AFTER_MS = 60 * 60 * 1_000;

/** Grid the geometry is snapped to at each rung, in metres. */
export const LOCATION_GRID_M: Readonly<Record<'approximate' | 'last_known', number>> = {
  approximate: 250,
  last_known: 500,
};

function snap(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return value;
  return Math.round(value / step) * step;
}

/**
 * Snap coordinates to a metre grid. This is what makes the degrade REAL: an
 * object relabelled `approximate` while still carrying doorstep coordinates
 * would be a §23 violation wearing a privacy label.
 */
export function coarsenGeometry(geometry: MapGeometry, gridMeters: number): MapGeometry {
  const latStep = gridMeters / 111_320;
  const coarsenPos = (pos: readonly number[]): [number, number] => {
    const [lng, lat] = pos;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [lng, lat] as [number, number];
    const snappedLat = snap(lat, latStep);
    const cos = Math.cos((snappedLat * Math.PI) / 180);
    // Near the poles the longitude grid collapses; fall back to the lat step so
    // the divisor never approaches zero.
    const lngStep = Math.abs(cos) < 1e-6 ? latStep : latStep / Math.abs(cos);
    return [snap(lng, lngStep), snappedLat];
  };

  if (geometry.type === 'Point') {
    return { type: 'Point', coordinates: coarsenPos(geometry.coordinates) };
  }
  if (geometry.type === 'LineString') {
    return { type: 'LineString', coordinates: geometry.coordinates.map(coarsenPos) };
  }
  return {
    type: 'Polygon',
    coordinates: geometry.coordinates.map((ring) => ring.map(coarsenPos)),
  };
}

export interface LocationDecayResult {
  stage: LocationStage;
  /** null when the object must be DROPPED (stage 'expired'). */
  privacyClass: PrivacyClass | null;
  /** Metre grid applied, or 0 when the geometry was left alone. */
  gridMeters: number;
}

/**
 * Where an object's position sits on the §23 ladder after `ageMs` in the cache.
 *
 * The entry rung `precise_temporary` is DELIBERATELY unreachable as an output:
 * a temporary precise fix was granted for a moment, and the cache is not that
 * moment. Rehydrate is the ladder's first step, always.
 */
export function decayLocation(
  privacyClass: PrivacyClass,
  kind: MapObjectKind,
  ageMs: number,
): LocationDecayResult {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : Number.POSITIVE_INFINITY;
  const temporary =
    privacyClass === 'precise_temporary' || TEMPORARY_LOCATION_KINDS.includes(kind);

  if (!temporary) {
    // A fixed feature (a place, an event, a trip stop) does not move; its
    // geometry is not a privacy-decaying fact. Freshness still decays.
    return { stage: 'precise', privacyClass, gridMeters: 0 };
  }

  if (age >= LOCATION_EXPIRES_AFTER_MS) {
    return { stage: 'expired', privacyClass: null, gridMeters: 0 };
  }

  const stage: 'approximate' | 'last_known' =
    age >= LOCATION_LAST_KNOWN_AFTER_MS ? 'last_known' : 'approximate';

  // narrowestPrivacyClass guarantees this can only ever tighten: an object
  // stored at `aggregate_only` stays aggregate_only, it is never widened to
  // `approximate` by passing through here.
  const degraded = narrowestPrivacyClass(privacyClass, 'approximate');
  const gridMeters =
    precisionRank(degraded) >= precisionRank('approximate') ? LOCATION_GRID_M[stage] : 0;

  return { stage, privacyClass: degraded, gridMeters };
}

// ── Entries + rehydrate ───────────────────────────────────────────────────────

export interface MapCacheEntry {
  version: string;
  cacheClass: MapCacheClass;
  scope: string;
  /** Epoch ms this entry was written. */
  cachedAt: number;
  objects: MapObject[];
}

/** A cached object, re-derived as of `now`. Never the stored freshness. */
export interface RehydratedMapObject extends MapObject {
  freshness: FreshnessState;
  /** Always true — the renderer must be able to tell cache from network. */
  fromCache: true;
  cachedAt: number;
  staleness: Staleness;
  /** Which §23 rung the geometry now sits on. */
  locationStage: LocationStage;
  /** True when this object came back less precise than it was stored. */
  privacyDegraded: boolean;
}

export interface RehydrateResult {
  cacheClass: MapCacheClass;
  scope: string;
  cachedAt: number;
  ageMs: number;
  /** Past the class TTL. Exempt classes are still served in this state. */
  expired: boolean;
  /** Entry-level "Last updated 14m ago" for the offline banner. */
  staleness: Staleness;
  objects: RehydratedMapObject[];
  /** Objects dropped because their temporary location expired (§23). */
  droppedForPrivacy: number;
  /** Objects returned at a coarser rung than they were stored at. */
  degradedForPrivacy: number;
  /** Objects dropped because degradation left them unrenderable. */
  droppedUnrenderable: number;
}

/**
 * THE core function. Returns the cached objects with freshness recomputed as
 * of `now` and privacy re-decayed — never the values that were stored.
 *
 * Pure: no I/O, no clock read. `now` is always injected.
 */
export function rehydrate(entry: MapCacheEntry, now: number): RehydrateResult {
  const policy = MAP_CACHE_POLICIES[entry.cacheClass];
  const ageMs = Math.max(0, now - entry.cachedAt);
  const expired = policy ? ageMs >= policy.ttlMs : true;
  const entryStaleness = describeStaleness(entry.cachedAt, now, expired);

  const objects: RehydratedMapObject[] = [];
  let droppedForPrivacy = 0;
  let degradedForPrivacy = 0;
  let droppedUnrenderable = 0;

  for (const stored of entry.objects ?? []) {
    if (!stored || typeof stored !== 'object') continue;

    // §23 first: an object whose position has expired must not be rendered at
    // all, no matter how its freshness reads.
    const observedAt = parseTime(stored.observedAt);
    // Position age is measured from the observation when we have one, and from
    // the cache write otherwise — never from "now minus nothing".
    const positionAgeMs = observedAt == null ? ageMs : Math.max(0, now - observedAt);
    const decay = decayLocation(stored.privacyClass, stored.kind, positionAgeMs);

    if (decay.privacyClass == null) {
      droppedForPrivacy += 1;
      continue;
    }

    const degraded = precisionRank(decay.privacyClass) < precisionRank(stored.privacyClass);
    const geometry =
      decay.gridMeters > 0 ? coarsenGeometry(stored.geometry, decay.gridMeters) : stored.geometry;

    const next: RehydratedMapObject = {
      ...stored,
      geometry,
      privacyClass: decay.privacyClass,
      freshness: decayFreshness(stored, now),
      fromCache: true,
      cachedAt: entry.cachedAt,
      staleness: describeStaleness(observedAt ?? entry.cachedAt, now, expired),
      locationStage: decay.stage,
      privacyDegraded: degraded,
    };

    if (!isRenderable(next)) {
      droppedUnrenderable += 1;
      continue;
    }

    if (degraded) degradedForPrivacy += 1;
    objects.push(next);
  }

  return {
    cacheClass: entry.cacheClass,
    scope: entry.scope,
    cachedAt: entry.cachedAt,
    ageMs,
    expired,
    staleness: entryStaleness,
    objects,
    droppedForPrivacy,
    degradedForPrivacy,
    droppedUnrenderable,
  };
}

// ── Index + LRU store ─────────────────────────────────────────────────────────

interface IndexRow {
  key: string;
  cacheClass: MapCacheClass;
  scope: string;
  bytes: number;
  cachedAt: number;
  lastAccessedAt: number;
}

interface CacheIndex {
  version: string;
  rows: IndexRow[];
}

/** Total serialized budget across every class. ~2 MB of JSON. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export interface MapCacheOptions {
  storage: StorageLike;
  maxBytes?: number;
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
}

export interface WriteResult {
  stored: boolean;
  bytes: number;
  /** How many OTHER entries were evicted to make room. Always reported. */
  evicted: number;
  evictedKeys: string[];
  reason?: 'entry_too_large' | 'write_failed';
}

export interface SweepResult {
  /** Entries removed for being past their class TTL. */
  removedExpired: number;
  /** Entries removed to get back under the byte budget. */
  evictedLru: number;
  /** Eviction-exempt entries deliberately left in place (§28 safety). */
  keptExempt: number;
  bytes: number;
}

export interface MapCacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  byClass: Record<string, { entries: number; bytes: number }>;
  /** Cumulative evictions since this instance was constructed. */
  evictions: number;
}

/**
 * A versioned, namespaced, size-bounded cache over an injected storage API.
 *
 * Every method swallows storage errors: a cache failure degrades the map, it
 * never breaks it. That is the same contract discoveryLocalCache.ts keeps.
 */
export class MapCache {
  private readonly storage: StorageLike;
  private readonly maxBytes: number;
  private readonly clock: () => number;
  private evictions = 0;

  constructor(options: MapCacheOptions) {
    this.storage = options.storage;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.clock = options.now ?? Date.now;
  }

  // — index —

  private async loadIndex(): Promise<CacheIndex> {
    try {
      const raw = await this.storage.getItem(MAP_CACHE_INDEX_KEY);
      if (!raw) return { version: MAP_CACHE_VERSION, rows: [] };
      const parsed = JSON.parse(raw) as CacheIndex;
      if (!parsed || parsed.version !== MAP_CACHE_VERSION || !Array.isArray(parsed.rows)) {
        // Version mismatch: drop everything the OLD index pointed at, then
        // start clean. Leaving orphans behind would leak bytes forever.
        await this.purgeIndex(parsed);
        return { version: MAP_CACHE_VERSION, rows: [] };
      }
      return { version: MAP_CACHE_VERSION, rows: parsed.rows.filter((r) => r && isCacheClass(r.cacheClass)) };
    } catch {
      return { version: MAP_CACHE_VERSION, rows: [] };
    }
  }

  private async purgeIndex(index: unknown): Promise<void> {
    const rows = (index as CacheIndex | null)?.rows;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && typeof row.key === 'string') {
          try {
            await this.storage.removeItem(row.key);
          } catch {
            // silent
          }
        }
      }
    }
    try {
      await this.storage.removeItem(MAP_CACHE_INDEX_KEY);
    } catch {
      // silent
    }
  }

  private async saveIndex(index: CacheIndex): Promise<void> {
    try {
      await this.storage.setItem(
        MAP_CACHE_INDEX_KEY,
        JSON.stringify({ version: MAP_CACHE_VERSION, rows: index.rows }),
      );
    } catch {
      // silent
    }
  }

  // — read —

  /**
   * Read and rehydrate one entry. Returns null on miss, parse failure, version
   * mismatch, or a non-exempt expiry (the entry is removed in the last two
   * cases). An eviction-exempt class past its TTL is still returned, flagged
   * `expired: true` — §28's safety exemption.
   */
  async read(cacheClass: MapCacheClass, scope: string): Promise<RehydrateResult | null> {
    const key = cacheKey(cacheClass, scope);
    const now = this.clock();
    let raw: string | null = null;
    try {
      raw = await this.storage.getItem(key);
    } catch {
      return null;
    }
    if (!raw) return null;

    let entry: MapCacheEntry | null = null;
    try {
      entry = JSON.parse(raw) as MapCacheEntry;
    } catch {
      await this.remove(cacheClass, scope);
      return null;
    }

    if (
      !entry ||
      entry.version !== MAP_CACHE_VERSION ||
      !isCacheClass(entry.cacheClass) ||
      typeof entry.cachedAt !== 'number' ||
      !Array.isArray(entry.objects)
    ) {
      await this.remove(cacheClass, scope);
      return null;
    }

    const policy = MAP_CACHE_POLICIES[entry.cacheClass];
    const expired = now - entry.cachedAt >= policy.ttlMs;
    if (expired && !policy.evictionExempt) {
      await this.remove(cacheClass, scope);
      return null;
    }

    // LRU touch.
    const index = await this.loadIndex();
    const row = index.rows.find((r) => r.key === key);
    if (row) {
      row.lastAccessedAt = now;
      await this.saveIndex(index);
    }

    return rehydrate(entry, now);
  }

  // — write —

  /**
   * Persist objects for a class/scope, evicting least-recently-used entries as
   * needed to stay inside the byte budget. The eviction count is REPORTED, not
   * silent — a map that quietly forgets the user's trip is a bug we need to be
   * able to see in telemetry.
   */
  async write(
    cacheClass: MapCacheClass,
    scope: string,
    objects: MapObject[],
  ): Promise<WriteResult> {
    const now = this.clock();
    const key = cacheKey(cacheClass, scope);
    const entry: MapCacheEntry = {
      version: MAP_CACHE_VERSION,
      cacheClass,
      scope: normalizeScope(scope),
      cachedAt: now,
      objects: Array.isArray(objects) ? objects : [],
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(entry);
    } catch {
      return { stored: false, bytes: 0, evicted: 0, evictedKeys: [], reason: 'write_failed' };
    }
    const bytes = serialized.length;
    const policy = MAP_CACHE_POLICIES[cacheClass];

    // A single entry larger than the whole budget would evict everything else
    // and still not fit. Refuse it — unless it is safety information, which is
    // exempt from being squeezed out.
    if (bytes > this.maxBytes && !policy.evictionExempt) {
      return { stored: false, bytes, evicted: 0, evictedKeys: [], reason: 'entry_too_large' };
    }

    const index = await this.loadIndex();
    const rows = index.rows.filter((r) => r.key !== key);
    rows.push({ key, cacheClass, scope: entry.scope, bytes, cachedAt: now, lastAccessedAt: now });

    const evictedKeys = await this.enforceLimits(rows, key);

    try {
      await this.storage.setItem(key, serialized);
    } catch {
      return { stored: false, bytes, evicted: evictedKeys.length, evictedKeys, reason: 'write_failed' };
    }
    await this.saveIndex({ version: MAP_CACHE_VERSION, rows });

    return { stored: true, bytes, evicted: evictedKeys.length, evictedKeys };
  }

  /**
   * Trim `rows` in place until both the per-class entry cap and the total byte
   * budget hold. `protectedKey` is the entry currently being written; evicting
   * it would make the write pointless.
   */
  private async enforceLimits(rows: IndexRow[], protectedKey: string | null): Promise<string[]> {
    const evicted: string[] = [];

    const dropRow = async (row: IndexRow) => {
      const at = rows.indexOf(row);
      if (at >= 0) rows.splice(at, 1);
      evicted.push(row.key);
      this.evictions += 1;
      try {
        await this.storage.removeItem(row.key);
      } catch {
        // silent
      }
    };

    // Per-class cap: oldest access first.
    for (const cls of MAP_CACHE_CLASSES) {
      const policy = MAP_CACHE_POLICIES[cls];
      let inClass = rows.filter((r) => r.cacheClass === cls);
      while (inClass.length > policy.maxEntries) {
        const victim = inClass
          .filter((r) => r.key !== protectedKey)
          .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)[0];
        if (!victim) break;
        await dropRow(victim);
        inClass = rows.filter((r) => r.cacheClass === cls);
      }
    }

    // Total budget: LRU across every NON-EXEMPT class. Safety entries are never
    // chosen as victims (§28), even when that means overshooting the budget.
    const total = () => rows.reduce((sum, r) => sum + r.bytes, 0);
    while (total() > this.maxBytes) {
      const victim = rows
        .filter((r) => r.key !== protectedKey && !MAP_CACHE_POLICIES[r.cacheClass].evictionExempt)
        .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)[0];
      if (!victim) break; // only exempt/protected entries remain — accept the overshoot
      await dropRow(victim);
    }

    return evicted;
  }

  // — remove / sweep / stats —

  async remove(cacheClass: MapCacheClass, scope: string): Promise<void> {
    const key = cacheKey(cacheClass, scope);
    try {
      await this.storage.removeItem(key);
    } catch {
      // silent
    }
    const index = await this.loadIndex();
    const next = index.rows.filter((r) => r.key !== key);
    if (next.length !== index.rows.length) {
      await this.saveIndex({ version: MAP_CACHE_VERSION, rows: next });
    }
  }

  /**
   * Drop everything past its TTL and re-assert the byte budget. Safety entries
   * are counted in `keptExempt` and left alone.
   */
  async sweep(): Promise<SweepResult> {
    const now = this.clock();
    const index = await this.loadIndex();
    const rows = [...index.rows];
    let removedExpired = 0;
    let keptExempt = 0;

    for (const row of [...rows]) {
      const policy = MAP_CACHE_POLICIES[row.cacheClass];
      const expired = now - row.cachedAt >= policy.ttlMs;
      if (!expired) continue;
      if (policy.evictionExempt) {
        keptExempt += 1;
        continue;
      }
      const at = rows.indexOf(row);
      if (at >= 0) rows.splice(at, 1);
      removedExpired += 1;
      try {
        await this.storage.removeItem(row.key);
      } catch {
        // silent
      }
    }

    const evicted = await this.enforceLimits(rows, null);
    await this.saveIndex({ version: MAP_CACHE_VERSION, rows });

    return {
      removedExpired,
      evictedLru: evicted.length,
      keptExempt,
      bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
    };
  }

  /** Drop every entry this cache knows about. */
  async clear(): Promise<void> {
    const index = await this.loadIndex();
    await this.purgeIndex(index);
  }

  async stats(): Promise<MapCacheStats> {
    const index = await this.loadIndex();
    const byClass: Record<string, { entries: number; bytes: number }> = {};
    let bytes = 0;
    for (const row of index.rows) {
      bytes += row.bytes;
      const bucket = byClass[row.cacheClass] ?? { entries: 0, bytes: 0 };
      bucket.entries += 1;
      bucket.bytes += row.bytes;
      byClass[row.cacheClass] = bucket;
    }
    return { entries: index.rows.length, bytes, maxBytes: this.maxBytes, byClass, evictions: this.evictions };
  }
}

// ── App-bound singleton ───────────────────────────────────────────────────────

/**
 * AsyncStorage, wrapped so a native failure can never escape as a rejection —
 * the same "cache errors are silent" contract as discoveryLocalCache.ts.
 */
export const asyncStorageAdapter: StorageLike = {
  async getItem(key) {
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      // silent
    }
  },
  async removeItem(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // silent
    }
  },
};

/** The instance the app uses. Tests construct their own with memory storage. */
export const mapCache = new MapCache({ storage: asyncStorageAdapter });

export default mapCache;
