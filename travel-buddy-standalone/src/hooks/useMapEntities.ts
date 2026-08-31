/**
 * useMapEntities — the map's data source, now gateway-first (Map spec §19).
 *
 * WHAT CHANGED AND WHY
 * ====================
 * This hook used to fire five independent fetches and merge the raw service
 * payloads itself. Spec §19 forbids exactly that: "Never place raw database
 * rows directly on the map" and "The mobile client should not independently
 * reconstruct Portava intelligence rules." Merging raw rows on the device means
 * freshness, confidence, privacy class and rendering priority would each have
 * to be re-derived here — five times, in five different ways.
 *
 * So the hook now produces `MapObject[]` (src/types/mapObjects.ts) from two
 * places, in this order of preference:
 *
 *   1. THE GATEWAY — GET /api/map/projection returns events and hidden gems
 *      already shaped, ranked, privacy-classed and (where the intel pipeline
 *      has anything to say) carrying freshness, a confidence band and
 *      provenance. Nothing about them is re-derived here.
 *
 *   2. PER-LAYER FETCHERS — buddies, trips and friends/circle still fetch
 *      individually, because their privacy logic lives inline inside route
 *      handlers and lifting it out server-side is a separate change that
 *      deserves its own tests. They are normalized into the SAME MapObject
 *      contract by features/map/projection/clientProjection.ts, so the renderer
 *      cannot tell which path produced an object.
 *
 * Travelers are deliberately NOT requested from the gateway even though it can
 * serve them: they render through their own useMapTravelers/TravelerMapLayer
 * path, and pulling them in here as well would double-draw them. Retiring that
 * path is its own change.
 *
 * FAIL-SOFT (this is the important part)
 * ======================================
 * `map_projection_enabled` is OFF by default, and the endpoint answers
 * `{ enabled: false, objects: [] }` rather than an error. When the gateway is
 * disabled OR the call fails, the hook falls back to the ORIGINAL per-layer
 * fetchers for events and gems too — so behaviour with the flag off is exactly
 * what it was before this change, and switching the flag off is a real rollback
 * rather than a blank map.
 *
 * BACKWARDS COMPATIBILITY
 * =======================
 * `entities` still returns `MapEntity[]`, so EntityMarkers / MapCarousel /
 * MapEntityPreviewCard keep working untouched. `objects` exposes the full
 * contract for surfaces that have migrated. Each entity's `payload` is its
 * MapObject, so a component can migrate incrementally without a second fetch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MapEntity, ToggleableEntityType } from '../types/mapTypes.ts';
import { mapObjectsToEntities } from '../types/mapTypes.ts';
import type { MapObject, MapObjectKind } from '../types/mapObjects.ts';
import { compareByRenderingPriority } from '../types/mapObjects.ts';
import { searchBuddies } from '../services/rentABuddy.ts';
import { listEvents } from '../services/events.ts';
import { listGems } from '../services/hiddenGems.ts';
import { listMyTrips } from '../services/trips.ts';
import { listVisibleCircleLocations } from '../services/map.ts';
import { bboxFromCenter, fetchMapProjection } from '../services/mapProjection.ts';
import {
  projectBuddy,
  projectEventLocal,
  projectFriend,
  projectGemLocal,
  projectTrip,
} from '../features/map/projection/clientProjection.ts';
import { coarsenForFriend, isMapVisibleEvent, isMapVisibleTrip } from './mapEntityFilters.ts';
import { mapCache } from '../features/map/cache/mapCache.ts';
import type { Staleness } from '../features/map/cache/mapCache.ts';
import { advanceStage, type LoadingStage } from '../features/map/cache/loadingStrategy.ts';

/** Which contract kinds the gateway is asked for, per legacy layer toggle. */
const GATEWAY_KIND_FOR_LAYER: Partial<Record<ToggleableEntityType, MapObjectKind>> = {
  events: 'event',
  gems: 'hidden_gem',
};

/** The radius the gateway viewport covers when the caller only knows a centre. */
const DEFAULT_VIEWPORT_RADIUS_KM = 50;

// ── Per-layer fetchers (unchanged privacy behaviour, MapObject output) ────────

async function fetchBuddies(
  city: string,
  lat: number | null,
  lng: number | null,
): Promise<MapObject[]> {
  const coordParams =
    lat != null && lng != null
      ? ({ lat, lng } as { lat: number; lng: number })
      : ({} as Record<string, never>);

  const result = await searchBuddies({ city, perPage: 50, ...coordParams });
  if (!result.ok || !result.data) return [];

  const out: MapObject[] = [];
  for (const buddy of result.data.buddies) {
    const obj = projectBuddy(buddy);
    if (obj) out.push(obj);
  }
  return out;
}

async function fetchEvents(lat: number, lng: number, now: number): Promise<MapObject[]> {
  const nowDate = new Date(now);
  const cutoff = new Date(now + 24 * 60 * 60 * 1000);
  const result = await listEvents({
    nearLat: lat,
    nearLng: lng,
    nearRadiusKm: 50,
    dateFrom: nowDate.toISOString(),
    dateTo: cutoff.toISOString(),
    limit: 60,
  });
  if (!result.ok || !result.data) return [];

  const out: MapObject[] = [];
  for (const ev of result.data.events) {
    // Coordinate + visibility guard: only located public / friends_only events
    // may appear as public map pins (see isMapVisibleEvent). Unchanged.
    if (!isMapVisibleEvent(ev)) continue;
    const obj = projectEventLocal(ev, now);
    if (obj) out.push(obj);
  }
  return out;
}

async function fetchGems(city: string): Promise<MapObject[]> {
  let gems: any[];
  try {
    gems = await listGems({ city, limit: 100 });
  } catch {
    return [];
  }
  const out: MapObject[] = [];
  for (const gem of gems) {
    const obj = projectGemLocal(gem);
    if (obj) out.push(obj);
  }
  return out;
}

async function fetchTrips(): Promise<MapObject[]> {
  let trips: any[];
  try {
    trips = await listMyTrips();
  } catch {
    return [];
  }
  const out: MapObject[] = [];
  for (const trip of trips) {
    // Private trips and coordinate-less trips never appear on the map. Unchanged.
    if (!isMapVisibleTrip(trip)) continue;
    const obj = projectTrip(trip);
    if (obj) out.push(obj);
  }
  return out;
}

async function fetchFriends(): Promise<MapObject[]> {
  let locs: any[];
  try {
    locs = await listVisibleCircleLocations();
  } catch {
    return [];
  }
  const out: MapObject[] = [];
  for (const loc of locs) {
    if (loc.lat == null || loc.lng == null) continue;
    // Apply area-level jitter BEFORE projecting, so the projector only ever
    // sees coordinates that are already safe to render. Unchanged.
    const { lat, lng } = coarsenForFriend(loc.userId, loc.lat, loc.lng);
    const obj = projectFriend({ ...loc, lat, lng });
    if (obj) out.push(obj);
  }
  return out;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

/** Where a given load's objects came from — surfaced for diagnostics and tests. */
export type MapEntitiesSource = 'gateway' | 'legacy' | 'mixed';

export interface UseMapEntitiesResult {
  /** Legacy view, for components that have not migrated to MapObject. */
  entities: MapEntity[];
  /** The full contract (spec §18), ranked by the §31 priority ladder. */
  objects: MapObject[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** 'gateway' when every gateway-eligible kind came from the projection. */
  source: MapEntitiesSource;
  /**
   * The gateway's bounded live-claim enrichment report. `skipped > 0` means not
   * every eligible object was checked for live claims, so the live picture is
   * incomplete — never present it as exhaustive.
   */
  liveEnrichment: { considered: number; enriched: number; skipped: number } | null;
  /**
   * §33's ladder position. The screen renders progressively off this rather
   * than off `if (data)`, which is what stops the map blanking while live
   * intelligence loads.
   */
  stage: LoadingStage;
  /**
   * Set while the objects on screen came from cache (§28). Carries
   * "Last updated 14m ago" — a cached object must never be presented as
   * current, and rehydrate() has already downgraded its freshness.
   */
  staleness: Staleness | null;
}

export function useMapEntities(opts: {
  enabledLayers: ToggleableEntityType[];
  city: string | null;
  lat: number | null;
  lng: number | null;
  /** Map zoom, forwarded to the gateway for viewport aggregation. */
  zoom?: number;
  /** Viewport radius the gateway should cover; defaults to 50 km. */
  radiusKm?: number;
}): UseMapEntitiesResult {
  const { enabledLayers, city, lat, lng, zoom = 12, radiusKm = DEFAULT_VIEWPORT_RADIUS_KM } = opts;

  const [objects, setObjects] = useState<MapObject[]>([]);
  const [entities, setEntities] = useState<MapEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<MapEntitiesSource>('legacy');
  const [liveEnrichment, setLiveEnrichment] =
    useState<UseMapEntitiesResult['liveEnrichment']>(null);
  const [stage, setStage] = useState<LoadingStage>('cached_geography');
  const [staleness, setStaleness] = useState<Staleness | null>(null);

  const inFlight = useRef(false);
  const hasLoaded = useRef(false);

  // Tracks whether another fetch was requested while one was in-flight, so the
  // hook re-runs once the active fetch resolves rather than silently dropping
  // the update (e.g. when persisted layer prefs load mid-fetch). Unchanged.
  const pendingRefetch = useRef(false);

  // ── §33 cache-first seed ────────────────────────────────────────────────────
  // "The map should progressively improve; it should not blank while live
  // intelligence is loading." Runs once per scope, before any network call, and
  // never overwrites objects that have already arrived from the network.
  const seededRef = useRef<string | null>(null);
  useEffect(() => {
    const scope = city ?? 'unknown';
    if (seededRef.current === scope) return;
    seededRef.current = scope;
    let cancelled = false;
    void (async () => {
      const cached = await mapCache.read('place_intel', scope).catch(() => null);
      if (cancelled || !cached || cached.objects.length === 0) return;
      // A later network result always wins; a cache seed must never clobber it.
      if (hasLoaded.current) return;
      setObjects(cached.objects as MapObject[]);
      setEntities(mapObjectsToEntities(cached.objects as MapObject[]));
      setStaleness(cached.staleness);
      setStage((prev) => advanceStage(prev, 'cached_geography'));
    })();
    return () => { cancelled = true; };
  }, [city]);

  const doFetch = useCallback(async () => {
    if (inFlight.current) {
      pendingRefetch.current = true;
      return;
    }
    if (enabledLayers.length === 0) {
      setObjects([]);
      setEntities([]);
      return;
    }
    inFlight.current = true;
    pendingRefetch.current = false;
    if (!hasLoaded.current) setLoading(true);

    const now = Date.now();

    // Which kinds could the gateway serve for the layers that are switched on?
    const wantedKinds = enabledLayers
      .map((l) => GATEWAY_KIND_FOR_LAYER[l])
      .filter((k): k is MapObjectKind => k != null);

    try {
      // ── 1. Try the gateway ────────────────────────────────────────────────
      let gatewayObjects: MapObject[] | null = null;
      let enrichment: UseMapEntitiesResult['liveEnrichment'] = null;

      if (wantedKinds.length > 0 && lat != null && lng != null) {
        const res = await fetchMapProjection({
          bbox: bboxFromCenter(lat, lng, radiusKm),
          zoom,
          kinds: wantedKinds,
          limit: 200,
        });
        // `enabled: false` means the flag is off — fall back, do NOT treat it
        // as an empty world.
        if (res.ok && res.data.enabled) {
          gatewayObjects = res.data.objects;
          enrichment = res.data.liveEnrichment;
        }
      }

      // ── 2. Fetch whatever the gateway did not supply ──────────────────────
      const usedGateway = gatewayObjects !== null;
      const fetches: Promise<MapObject[]>[] = [];

      if (!usedGateway && enabledLayers.includes('events') && lat != null && lng != null) {
        fetches.push(fetchEvents(lat, lng, now).catch(() => []));
      }
      if (!usedGateway && enabledLayers.includes('gems') && city) {
        fetches.push(fetchGems(city).catch(() => []));
      }
      // These three never come from the gateway yet — see the header.
      if (enabledLayers.includes('buddies') && city) {
        fetches.push(fetchBuddies(city, lat, lng).catch(() => []));
      }
      if (enabledLayers.includes('trips')) {
        fetches.push(fetchTrips().catch(() => []));
      }
      if (enabledLayers.includes('friends')) {
        fetches.push(fetchFriends().catch(() => []));
      }

      const perLayer = await Promise.all(fetches);
      const merged = (gatewayObjects ?? []).concat(...perLayer);

      // §31: one ranking over the whole stream, so a gateway object and a
      // per-layer object compete on the same ladder rather than by arrival order.
      merged.sort(compareByRenderingPriority);

      setObjects(merged);
      setEntities(mapObjectsToEntities(merged));
      setSource(usedGateway ? (perLayer.length > 0 ? 'mixed' : 'gateway') : 'legacy');
      setLiveEnrichment(enrichment);
      setError(null);
      hasLoaded.current = true;

      // Network data is current, so the cache banner must go away.
      setStaleness(null);
      // §33 ladder: canonical objects have arrived, and live state too when the
      // gateway actually enriched something. Never claim a stage the data does
      // not support — advanceStage is monotonic so it cannot regress either.
      setStage((prev) => {
        const withCanonical = advanceStage(prev, 'canonical');
        return (enrichment?.enriched ?? 0) > 0
          ? advanceStage(withCanonical, 'live_state')
          : withCanonical;
      });

      // §28 write-through. Fire-and-forget: a cache write must never delay or
      // fail a render.
      if (city && merged.length > 0) {
        void mapCache.write('place_intel', city, merged).catch(() => {});
      }
    } catch (err: any) {
      if (!hasLoaded.current) setError(err?.message ?? 'Failed to load map entities');
    } finally {
      inFlight.current = false;
      setLoading(false);
      if (pendingRefetch.current) {
        pendingRefetch.current = false;
        void doFetch();
      }
    }
  }, [enabledLayers, city, lat, lng, zoom, radiusKm]);

  const refresh = useCallback(() => {
    void doFetch();
  }, [doFetch]);

  useEffect(() => {
    void doFetch();
  }, [doFetch]);

  return {
    entities,
    objects,
    loading: loading && !hasLoaded.current,
    error,
    refresh,
    source,
    liveEnrichment,
    stage,
    staleness,
  };
}
