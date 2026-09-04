/**
 * offlineBaseMap — §28 "Cache current base-map region", implemented on the
 * MapLibre RN OfflineManager and governed by the `base_map_region` cache class.
 *
 * WHY THIS EXISTS
 * ===============
 * §28's first bullet is "Cache current base-map region". The base map is TILES,
 * not MapObjects, so it cannot live in mapCache's object store — MapLibre's own
 * OfflineManager owns the tile database (a native pack). What mapCache DOES own
 * is the `base_map_region` CLASS: its retention policy (7-day TTL, at most 8
 * regions — MAP_CACHE_POLICIES.base_map_region) and its §28 staleness labelling
 * ("Last updated 3d ago"). This module wires the two together:
 *
 *   - the TILES are created / inspected / deleted through OfflineManager;
 *   - each pack carries `class`/`scope`/`createdAt` in its native metadata, so
 *     this module can find "our" packs and age them;
 *   - the class POLICY (ttl + maxEntries) prunes them, so offline geography does
 *     not grow without bound or outlive its usefulness;
 *   - a matching `base_map_region` entry is written into mapCache (with an empty
 *     object list — tiles are not objects), giving the class a real producer and
 *     letting the §28 offline banner read a region's staleness the same way it
 *     reads every other cached layer's.
 *
 * FAIL-SOFT
 * =========
 * The OfflineManager is a native singleton; under Jest / web / a stripped build
 * it is absent. Every entry point resolves it through `resolveManager`, which
 * returns null when it cannot be required, and every function then reports
 * `offline_unavailable` rather than throwing — caching the base map is an
 * enhancement, never a precondition for the map to work.
 *
 * DEPENDENCY INJECTION
 * ====================
 * `offlineManager`, `cache` and `now` are all injectable (mirroring MapCache's
 * own `MapCacheOptions`), so this module is exercised with an in-memory cache
 * and a fake pack store — no native module, no clock — the same way
 * mapCache.test.ts drives MapCache.
 */

import { DARK_MAP_STYLE_URL } from '../../../constants/mapStyle.ts';
import {
  MAP_CACHE_POLICIES,
  describeStaleness,
  normalizeScope,
  mapCache as appMapCache,
  type MapCache,
  type Staleness,
} from './mapCache.ts';

/** The one cache class this module produces. */
export const OFFLINE_BASE_MAP_CLASS = 'base_map_region' as const;

/** How this module stamps and recognises its own packs in native metadata. */
export const OFFLINE_PACK_METADATA_CLASS = 'base_map_region';

// ── The slice of the OfflineManager API this module uses ──────────────────────
//
// Declared structurally rather than imported so the module has no static
// dependency on the native package: tests inject a fake, and the app resolves
// the real singleton lazily (resolveManager).

export interface OfflinePackStatusLike {
  state: 'inactive' | 'active' | 'complete';
  percentage: number;
  completedResourceCount: number;
  requiredResourceCount: number;
}

export interface OfflinePackLike {
  /** Native pack id (UUID), the handle OfflineManager.deletePack takes. */
  readonly id: string;
  readonly metadata: Record<string, unknown>;
  status(): Promise<OfflinePackStatusLike>;
}

export interface OfflinePackCreateOptionsLike {
  mapStyle: string;
  bounds: [west: number, south: number, east: number, north: number];
  minZoom?: number;
  maxZoom?: number;
  metadata?: Record<string, unknown>;
}

export interface OfflineManagerLike {
  createPack(
    options: OfflinePackCreateOptionsLike,
    progressListener?: (pack: OfflinePackLike, status: OfflinePackStatusLike) => void,
    errorListener?: (pack: OfflinePackLike, error: { message: string }) => void,
  ): Promise<OfflinePackLike>;
  getPacks(): Promise<OfflinePackLike[]>;
  deletePack(name: string): Promise<void>;
}

// ── Region descriptor ─────────────────────────────────────────────────────────

export interface BaseMapRegionBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface BaseMapRegionRequest {
  /** Region identity (a city / trip / event scope). Normalised like mapCache. */
  scope: string;
  bounds: BaseMapRegionBounds;
  /** Style to pack. Defaults to the app's §4 dark base. */
  styleUrl?: string;
  /** Zoom band to pack. Defaults are deliberately conservative (see below). */
  minZoom?: number;
  maxZoom?: number;
}

/** One packed region, as the UI sees it. */
export interface BaseMapRegionInfo {
  scope: string;
  createdAt: number;
  /** §28 "Last updated …" descriptor, from the class's own staleness helper. */
  staleness: Staleness;
  /** Past the base_map_region TTL. */
  expired: boolean;
}

export type OfflineResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'offline_unavailable' | 'not_found' | 'error'; message?: string };

export interface OfflineBaseMapDeps {
  /** The native manager; omitted ⇒ resolved lazily, null under Jest/web. */
  offlineManager?: OfflineManagerLike | null;
  /** The object cache whose base_map_region class this module produces. */
  cache?: MapCache;
  now?: () => number;
}

/**
 * Zoom band packed by default. §17's Street level is ~15-16, so 10-16 covers
 * "the city I am in, down to its streets" without the exponential tile blow-up
 * of packing to 20 for a whole city bbox. Callers with a small venue bbox can
 * raise maxZoom.
 */
export const DEFAULT_MIN_ZOOM = 10;
export const DEFAULT_MAX_ZOOM = 16;

const NOOP_PROGRESS = (_pack: OfflinePackLike, _status: OfflinePackStatusLike): void => {};
const NOOP_ERROR = (_pack: OfflinePackLike, _error: { message: string }): void => {};

/** Lazily resolve the native singleton; null when it cannot be required. */
function resolveManager(injected?: OfflineManagerLike | null): OfflineManagerLike | null {
  if (injected !== undefined) return injected;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@maplibre/maplibre-react-native') as { OfflineManager?: OfflineManagerLike };
    return mod.OfflineManager ?? null;
  } catch {
    return null;
  }
}

function packScope(pack: OfflinePackLike): string | null {
  const meta = pack.metadata ?? {};
  if (meta['class'] !== OFFLINE_PACK_METADATA_CLASS) return null;
  const scope = meta['scope'];
  return typeof scope === 'string' ? scope : null;
}

function packCreatedAt(pack: OfflinePackLike): number {
  const at = pack.metadata?.['createdAt'];
  return typeof at === 'number' && Number.isFinite(at) ? at : 0;
}

/** Our packs, newest first. */
async function ourPacks(manager: OfflineManagerLike): Promise<OfflinePackLike[]> {
  const all = await manager.getPacks();
  return all
    .filter((p) => packScope(p) !== null)
    .sort((a, b) => packCreatedAt(b) - packCreatedAt(a));
}

/**
 * Create (or refresh) the offline base-map pack for a region.
 *
 * Enforces the base_map_region entry cap BEFORE creating: an existing pack for
 * the same scope is replaced, and if that still leaves us at the cap the OLDEST
 * region is evicted — the same least-recently-created rule mapCache applies to
 * the class, so offline geography cannot grow past `maxEntries`.
 */
export async function createBaseMapRegionPack(
  request: BaseMapRegionRequest,
  deps: OfflineBaseMapDeps = {},
): Promise<OfflineResult<{ scope: string }>> {
  const manager = resolveManager(deps.offlineManager);
  if (!manager) return { ok: false, reason: 'offline_unavailable' };

  const cache = deps.cache ?? appMapCache;
  const now = (deps.now ?? Date.now)();
  const scope = normalizeScope(request.scope);
  const policy = MAP_CACHE_POLICIES[OFFLINE_BASE_MAP_CLASS];
  const { west, south, east, north } = request.bounds;

  try {
    const existing = await ourPacks(manager);

    // Replace a same-scope pack so a refresh does not double-count against the
    // cap or leave stale tiles beside fresh ones.
    for (const pack of existing) {
      if (packScope(pack) === scope) await deletePack(manager, pack);
    }

    // Evict oldest regions until creating one more stays within the cap.
    let remaining = (await ourPacks(manager)).filter((p) => packScope(p) !== scope);
    while (remaining.length >= policy.maxEntries) {
      const oldest = remaining[remaining.length - 1];
      await deletePack(manager, oldest);
      const victim = packScope(oldest);
      if (victim) await cache.remove(OFFLINE_BASE_MAP_CLASS, victim).catch(() => {});
      remaining = remaining.slice(0, -1);
    }

    await manager.createPack(
      {
        mapStyle: request.styleUrl ?? DARK_MAP_STYLE_URL,
        // MapLibre bounds order is [west, south, east, north].
        bounds: [west, south, east, north],
        minZoom: request.minZoom ?? DEFAULT_MIN_ZOOM,
        maxZoom: request.maxZoom ?? DEFAULT_MAX_ZOOM,
        metadata: { class: OFFLINE_PACK_METADATA_CLASS, scope, createdAt: now },
      },
      // No-op listeners: callers poll status() rather than subscribe, and the
      // native manager stores whatever is passed and later CALLS it on a
      // progress/error event — an undefined listener would crash there.
      NOOP_PROGRESS,
      NOOP_ERROR,
    );

    // Record the region in the base_map_region class. Empty object list: the
    // base map is tiles (owned by OfflineManager), not MapObjects — this entry
    // exists so the class has a producer and the §28 banner can read staleness.
    await cache.write(OFFLINE_BASE_MAP_CLASS, scope, []).catch(() => {});

    return { ok: true, value: { scope } };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** The download status of a region's pack. */
export async function getBaseMapRegionStatus(
  scope: string,
  deps: OfflineBaseMapDeps = {},
): Promise<OfflineResult<OfflinePackStatusLike>> {
  const manager = resolveManager(deps.offlineManager);
  if (!manager) return { ok: false, reason: 'offline_unavailable' };
  const target = normalizeScope(scope);
  try {
    const pack = (await ourPacks(manager)).find((p) => packScope(p) === target);
    if (!pack) return { ok: false, reason: 'not_found' };
    return { ok: true, value: await pack.status() };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Every packed base-map region, newest first, each with its §28 staleness. */
export async function listBaseMapRegions(
  deps: OfflineBaseMapDeps = {},
): Promise<OfflineResult<BaseMapRegionInfo[]>> {
  const manager = resolveManager(deps.offlineManager);
  if (!manager) return { ok: false, reason: 'offline_unavailable' };
  const now = (deps.now ?? Date.now)();
  const policy = MAP_CACHE_POLICIES[OFFLINE_BASE_MAP_CLASS];
  try {
    const packs = await ourPacks(manager);
    const value = packs.map((p): BaseMapRegionInfo => {
      const createdAt = packCreatedAt(p);
      const expired = now - createdAt >= policy.ttlMs;
      return { scope: packScope(p) as string, createdAt, staleness: describeStaleness(createdAt, now, expired), expired };
    });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove a region's offline pack and its cache record. */
export async function removeBaseMapRegion(
  scope: string,
  deps: OfflineBaseMapDeps = {},
): Promise<OfflineResult<{ removed: boolean }>> {
  const manager = resolveManager(deps.offlineManager);
  if (!manager) return { ok: false, reason: 'offline_unavailable' };
  const cache = deps.cache ?? appMapCache;
  const target = normalizeScope(scope);
  try {
    const pack = (await ourPacks(manager)).find((p) => packScope(p) === target);
    if (!pack) {
      await cache.remove(OFFLINE_BASE_MAP_CLASS, target).catch(() => {});
      return { ok: true, value: { removed: false } };
    }
    await deletePack(manager, pack);
    await cache.remove(OFFLINE_BASE_MAP_CLASS, target).catch(() => {});
    return { ok: true, value: { removed: true } };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Drop packs past the base_map_region TTL and re-assert the entry cap. Runs the
 * same policy mapCache's own sweep applies to the class, but over the native
 * tile store. Returns how many regions it removed.
 */
export async function pruneBaseMapRegions(
  deps: OfflineBaseMapDeps = {},
): Promise<OfflineResult<{ removed: number }>> {
  const manager = resolveManager(deps.offlineManager);
  if (!manager) return { ok: false, reason: 'offline_unavailable' };
  const cache = deps.cache ?? appMapCache;
  const now = (deps.now ?? Date.now)();
  const policy = MAP_CACHE_POLICIES[OFFLINE_BASE_MAP_CLASS];
  try {
    let packs = await ourPacks(manager);
    let removed = 0;

    // 1. Expired regions.
    for (const pack of packs) {
      if (now - packCreatedAt(pack) < policy.ttlMs) continue;
      await deletePack(manager, pack);
      const s = packScope(pack);
      if (s) await cache.remove(OFFLINE_BASE_MAP_CLASS, s).catch(() => {});
      removed += 1;
    }

    // 2. Entry cap — oldest first, over what survives.
    packs = (await ourPacks(manager));
    while (packs.length > policy.maxEntries) {
      const oldest = packs[packs.length - 1];
      await deletePack(manager, oldest);
      const s = packScope(oldest);
      if (s) await cache.remove(OFFLINE_BASE_MAP_CLASS, s).catch(() => {});
      removed += 1;
      packs = packs.slice(0, -1);
    }

    return { ok: true, value: { removed } };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a pack by its native id — the handle OfflineManager.deletePack takes. */
async function deletePack(manager: OfflineManagerLike, pack: OfflinePackLike): Promise<void> {
  await manager.deletePack(pack.id);
}
