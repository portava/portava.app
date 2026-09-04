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
 *   1. THE GATEWAY — GET /api/map/projection returns EVERY layer this hook can
 *      show (events, hidden gems, buddies, trips and friends/circle) already
 *      shaped, ranked, privacy-classed and (where the intel pipeline has
 *      anything to say) carrying freshness, a confidence band and provenance.
 *      Nothing about them is re-derived here.
 *
 *   2. PER-LAYER FETCHERS — the ROLLBACK path only, used when the gateway did
 *      not answer at all. They are normalized into the SAME MapObject contract
 *      by features/map/projection/clientProjection.ts, so the renderer cannot
 *      tell which path produced an object.
 *
 * WHY EVERY LAYER MOVED, AND WHY IT HAD NOT
 * =========================================
 * The gateway has served all six kinds since buddies were extracted into
 * lib/buddyMapRead. `GATEWAY_KIND_FOR_LAYER` listed only two of them, so
 * `projectBuddy`, `projectCircleMember` and `projectTrip` on the server — and
 * their privacy extractions, and their gateway-bypass guard entries — had no
 * production caller: the client kept re-deriving those three layers itself,
 * which is precisely what §19 forbids. A server half without a client half is
 * not a delivered layer, and nothing failed while it was missing. The
 * asymmetry is now a test (see useMapEntities.gatewayAsymmetry.test.ts).
 *
 * Travelers are deliberately NOT requested even though the gateway serves them
 * as `social_zone`: `enabledLayers` is `ToggleableEntityType[]`, which excludes
 * 'travelers' by type, and they render through their own
 * useMapTravelers/TravelerMapLayer path on the Discovery map. Asking here would
 * double-draw them. Retiring that path is its own change, on screens this hook
 * does not own.
 *
 * FAIL-SOFT (this is the important part)
 * ======================================
 * `map_projection_enabled` is OFF by default, and the endpoint answers
 * `{ enabled: false, objects: [] }` rather than an error. When the gateway is
 * disabled OR the call fails, the hook falls back to the ORIGINAL per-layer
 * fetchers for every layer — so behaviour with the flag off is exactly what it
 * was before this change, and switching the flag off is a real rollback rather
 * than a blank map.
 *
 * THE FALLBACK IS ALL-OR-NOTHING, ON PURPOSE
 * ==========================================
 * When the gateway ANSWERS, it owns every layer, even the ones it returned
 * nothing for. It is tempting to read `sources` and re-fetch just the layers it
 * did not name — but the gateway's empty answers are frequently fail-CLOSED
 * decisions (an unreadable block set returns `sources: []` and no objects at
 * all), while some legacy transports are fail-OPEN on the same input:
 * POST /api/rent-a-buddy/search skips block filtering entirely when the block
 * set cannot be read. Re-fetching a layer the gateway declined would therefore
 * route around a fail-closed decision through a weaker path, and put blocked
 * people back on the map precisely when the server could not tell who was
 * blocked. So a partial gateway answer is REPORTED (`unreadLayers`) and never
 * re-fetched.
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
// Typed so the projector call sites are checked too: an untyped row is how
// `buddy.headline`, `trip.destination` and `loc.displayName` — three fields that
// do not exist — reached the projectors without a compile error.
import type { CircleMemberLocation } from '../services/map.ts';
import type { HiddenGem } from '../services/hiddenGems.ts';
import type { TripRow } from '../services/trips.ts';
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

/**
 * Which contract kind the gateway is asked for, per legacy layer toggle.
 *
 * TOTAL over `ToggleableEntityType`, not `Partial`, and that is the point: a
 * layer added to the toggle set without a gateway kind is now a COMPILE error
 * rather than a layer that quietly keeps re-deriving itself on the device. The
 * previous `Partial` is how buddies, trips and friends stayed on the client
 * path for so long without anything noticing.
 */
export const GATEWAY_KIND_FOR_LAYER: Record<ToggleableEntityType, MapObjectKind> = {
  events: 'event',
  gems: 'hidden_gem',
  buddies: 'buddy_zone',
  trips: 'trip_stop',
  friends: 'crew_member',
};

/**
 * The name the gateway uses for each layer in its `sources` report.
 *
 * Mostly the layer name, EXCEPT `friends`, which the server calls "circle" —
 * the one entry that can silently rot into a permanently-"unread" layer, so the
 * asymmetry guard checks every value against the `sources.push(...)` calls in
 * the route itself rather than trusting this copy.
 */
/**
 * Gateway kinds that are NOT keyed by a legacy pin toggle.
 *
 * `crowd_flow` is a §16 layer, not a `ToggleableEntityType`: that union is the
 * five legacy PIN toggles, every member seeded ON, and a flow is a LineString
 * aggregate. Requesting it from there would contradict §16's `contextual`
 * default and its rule "do not turn every layer on simultaneously".
 *
 * It lives in its own map rather than in an inline push so the asymmetry guard
 * can still PARSE what this hook requests. A request buried in a conditional
 * would be invisible to it, and that guard is the only thing standing between
 * us and a third repeat of "the server serves it and nobody asks".
 */
export const GATEWAY_KIND_FOR_OPTIONAL_LAYER: Record<string, MapObjectKind> = {
  crowd_flow: 'crowd_flow',
  // §16 Relevant Places — canonical `public.places` rows, requested on the
  // `places` option. Not a legacy pin toggle either: the legacy 'places' layer
  // was a per-screen Discovery fetch (app/map/index.tsx), never a member of
  // `ToggleableEntityType`, and it is the shell's §16 preference that decides
  // whether the kind is asked for.
  relevant_places: 'place',
};

/** The `sources` name the route pushes for each optional kind. */
export const GATEWAY_SOURCE_FOR_OPTIONAL_LAYER: Record<string, string> = {
  crowd_flow: 'crowd_flow',
  relevant_places: 'places',
};

export const GATEWAY_SOURCE_FOR_LAYER: Record<ToggleableEntityType, string> = {
  events: 'events',
  gems: 'gems',
  buddies: 'buddies',
  trips: 'trips',
  friends: 'circle',
};

/** The radius the gateway viewport covers when the caller only knows a centre. */
const DEFAULT_VIEWPORT_RADIUS_KM = 50;

/**
 * §34 settle debounce, ms. Sits inside §34's stated 500–800 ms target band:
 * long enough that a continuous pinch/pan produces ONE re-query when the finger
 * lifts, short enough that the new viewport's intelligence arrives promptly.
 */
export const DEFAULT_SETTLE_DEBOUNCE_MS = 600;

/**
 * The live camera, reduced to the coarse key the fetch actually depends on.
 *
 * Two reductions, each so a movement that does not change what the gateway
 * would return does not re-query it (§34: "never re-query on every pixel
 * movement"):
 *
 *   ZOOM → a whole-number band. The gateway aggregates by zoom, so a 0.2-level
 *   pinch that leaves the band unchanged asks it for the same thing.
 *
 *   CENTRE → snapped to a grid a fifth of the covered radius. The fetched
 *   viewport already extends `radiusKm` in every direction, so a pan well
 *   inside it is already covered; only a pan that crosses a grid cell — a
 *   genuinely new slice of the world — moves the key.
 *
 * Returns primitives, and the caller keys the fetch on those primitives (not on
 * the camera object), so an unchanged quantised camera is a no-op even though a
 * fresh camera object arrives on every frame.
 */
export function quantizeCameraForFetch(
  cam: { lat: number; lng: number; zoom: number },
  radiusKm: number,
): { lat: number; lng: number; zoom: number } {
  const zoom = Math.round(cam.zoom);
  const gridKm = Math.max(1, radiusKm / 5);
  const latStep = gridKm / 111;
  const lat = Math.round(cam.lat / latStep) * latStep;
  // Longitude degrees shrink toward the poles; widen the divisor's floor so the
  // grid step never blows up near a pole (mirrors bboxFromCenter's clamp).
  const cos = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const lngStep = gridKm / (111 * cos);
  const lng = Math.round(cam.lng / lngStep) * lngStep;
  return { lat, lng, zoom };
}

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
  let gems: HiddenGem[];
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
  let trips: TripRow[];
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
  let locs: CircleMemberLocation[];
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
  /**
   * Enabled layers the gateway did not name in its `sources` report — it tried
   * to read them and could not. NOT the same as "that layer is empty", and the
   * difference is the whole reason the server reports `sources` at all: an
   * unreadable circle is indistinguishable from a circle where nobody is
   * sharing unless something says so.
   *
   * Always empty on the legacy path, where each fetcher already swallows its
   * own failure into `[]` and the distinction is unrecoverable.
   */
  unreadLayers: ToggleableEntityType[];
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
  /**
   * §16 Crowd Flow, requested on the viewer's EXPLICIT choice only.
   *
   * It is not a member of `enabledLayers`: that union is the legacy pin-entity
   * set, every member of which is seeded ON, so putting a people-derived
   * aggregate there would request it on every map load — contradicting §16's
   * `contextual` default for this layer and its rule "do not turn every layer
   * on simultaneously".
   *
   * §16's two AUTOMATIC triggers for a contextual layer are both circular here:
   * `density` is measured by the projection layer, i.e. a property of the
   * response; and `mode === 'CROWD_FLOW'` is gated on a capability derived from
   * flows having already arrived. Explicit choice is the only non-circular
   * trigger, and §16 says it outranks automatic resolution.
   */
  crowdFlow?: boolean;
  /**
   * §16 Relevant Places — canonical places through the gateway (Map spec §19,
   * server lib/mapProjectPlace.ts), so a place on the map has been through §24
   * protection, §31 aggregation and §7 enrichment like every other kind.
   *
   * GATEWAY ONLY — there is NO rollback fetcher for this kind here, on purpose.
   * The rollback for places is the map shell's legacy Discovery path
   * (getDiscoveryPlaces in app/map/index.tsx), which owns its own loading,
   * error, retry and empty-state UI and renders through DiscoveryMapView's own
   * pin loop. A second transport in this hook would double-fetch and
   * double-draw every place on the rollback path. The shell reads `source` to
   * decide which of the two is live.
   */
  places?: boolean;
  /**
   * §34 camera-driven re-query. The LIVE camera the map has actually settled
   * on — reported by DiscoveryMapView's onCameraChange and held in the shell.
   *
   * WHY THIS IS SEPARATE FROM `lat`/`lng`/`zoom`. Those three are the COMMANDED
   * viewport: a deep-link's centre, the city fallback, the store's commanded
   * zoom — where the screen SENT the camera. They seed the very first fetch so
   * the map is never blank while the SDK is still reporting its opening frame.
   * `camera` is where the camera ENDED UP, and once it settles it supersedes
   * them: §31 viewport aggregation and §7 enrichment must run over what the
   * user is actually looking at, not over the last place the shell aimed.
   *
   * WHY IT COULD NOT BE FED IN BEFORE (app/map/index.tsx ~1291): a float that
   * changes on every pinch would re-query the gateway continuously, so the live
   * camera was deliberately kept out of the fetch key. This hook now makes that
   * safe — it QUANTIZES the camera to a zoom band and a coarse centre grid and
   * only re-queries after the §34 settle debounce, so a pan inside the fetched
   * viewport never re-queries and crossing into a new area does exactly once.
   *
   * Omitted (or null) ⇒ behaviour is byte-for-byte the pre-camera hook: the
   * fetch geometry is `lat`/`lng`/`zoom` and nothing debounces.
   */
  camera?: { lat: number; lng: number; zoom: number } | null;
  /**
   * §34: "Debounce after camera settles; never re-query on every pixel
   * movement." The window between the camera coming to rest and the re-query,
   * in ms. §34's target band is 500–800 ms; the default sits inside it. Only
   * consulted when `camera` is provided.
   */
  settleDebounceMs?: number;
}): UseMapEntitiesResult {
  const {
    enabledLayers, city, lat, lng, zoom = 12,
    radiusKm = DEFAULT_VIEWPORT_RADIUS_KM,
    crowdFlow = false,
    places = false,
    camera = null,
    settleDebounceMs = DEFAULT_SETTLE_DEBOUNCE_MS,
  } = opts;

  const [objects, setObjects] = useState<MapObject[]>([]);
  const [entities, setEntities] = useState<MapEntity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<MapEntitiesSource>('legacy');
  const [liveEnrichment, setLiveEnrichment] =
    useState<UseMapEntitiesResult['liveEnrichment']>(null);
  const [stage, setStage] = useState<LoadingStage>('cached_geography');
  const [staleness, setStaleness] = useState<Staleness | null>(null);
  const [unreadLayers, setUnreadLayers] = useState<ToggleableEntityType[]>([]);

  const hasLoaded = useRef(false);

  // ── §34 request supersession ─────────────────────────────────────────────────
  // A camera settle can start a new fetch while an older one is still in flight
  // (the network is slower than the finger). Two guards keep only the newest
  // answer:
  //
  //   `abortRef` cancels the superseded gateway request at the transport, so a
  //   fetch the user has already panned past stops consuming bandwidth.
  //
  //   `seqRef` is the discard: a stamp taken when a fetch starts and checked
  //   after every await, so a superseded response that resolves late (or an
  //   abort that lands as a rejection) can never overwrite the current one.
  //   §34 wants the map to reflect where the camera IS, not the order fetches
  //   happened to finish.
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);

  // ── §34 camera settle ────────────────────────────────────────────────────────
  // The live camera, quantised (see quantizeCameraForFetch) and committed only
  // after it has been still for `settleDebounceMs`. Held as state so a settle
  // moves the fetch key; null until the first settle, so the very first fetch
  // still runs off the COMMANDED lat/lng/zoom and the map is never blank waiting
  // for a gesture that may never come.
  const [settledCamera, setSettledCamera] =
    useState<{ lat: number; lng: number; zoom: number } | null>(null);
  // The last quantised key committed, so an equal one neither restarts the
  // debounce nor re-commits (which would churn the fetch key for a no-op move).
  const settledKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!camera) return;
    const q = quantizeCameraForFetch(camera, radiusKm);
    const key = `${q.lat.toFixed(4)},${q.lng.toFixed(4)},${q.zoom}`;
    // Already settled here: a pan within the same grid cell / zoom band is not
    // a re-query, so there is nothing to debounce.
    if (key === settledKeyRef.current) return;
    const timer = setTimeout(() => {
      settledKeyRef.current = key;
      setSettledCamera(q);
    }, Math.max(0, settleDebounceMs));
    // A further move before the window elapses clears this timer, so only the
    // camera's RESTING position ever commits — never the frames it passed
    // through (§34: "never re-query on every pixel movement").
    return () => clearTimeout(timer);
  }, [camera, camera?.lat, camera?.lng, camera?.zoom, radiusKm, settleDebounceMs]);

  // The geometry the fetch actually keys on: the settled live camera once it
  // exists, else the commanded viewport. Primitives, so an unchanged settle is
  // an unchanged fetch key even though `settledCamera` is a fresh object.
  const effectiveLat = settledCamera?.lat ?? lat;
  const effectiveLng = settledCamera?.lng ?? lng;
  const effectiveZoom = settledCamera?.zoom ?? zoom;

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
    // Crowd Flow and Relevant Places are requested independently of
    // `enabledLayers`, so this guard must consider both. A viewer who switches
    // every legacy pin layer OFF but either of those ON would otherwise be
    // swallowed here and see nothing — and the early return cannot simply be
    // deleted, because passport mode passes [] deliberately to mean "fetch
    // nothing".
    if (enabledLayers.length === 0 && !crowdFlow && !places) {
      // Abort any in-flight fetch and take the newest stamp so a fetch that
      // resolves after this "nothing enabled" state cannot repaint the map.
      abortRef.current?.abort();
      seqRef.current += 1;
      setObjects([]);
      setEntities([]);
      // No layer is enabled, so no layer went unread. Leaving a stale list here
      // would keep warning about a layer the user has since switched off.
      setUnreadLayers([]);
      return;
    }

    // §34: supersede. A camera settle can fire this while an earlier fetch is
    // still in flight — cancel that one at the transport and stamp this one so
    // a late/aborted response is discarded rather than allowed to repaint.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = (seqRef.current += 1);
    /** This fetch is still the newest one the hook cares about. */
    const current = () => seq === seqRef.current;

    if (!hasLoaded.current) setLoading(true);

    const now = Date.now();

    // Which kinds the gateway is asked for. Every enabled layer contributes
    // exactly one — the map is total — and a layer the viewer has switched OFF
    // contributes none, so a disabled layer is never requested and never
    // arrives to be filtered out on the device.
    const wantedKinds: MapObjectKind[] = enabledLayers.map((l) => GATEWAY_KIND_FOR_LAYER[l]);
    // §16 crowd_flow rides beside them rather than inside enabledLayers — see
    // the `crowdFlow` option. kindsForLayer is the §16 model's own mapping, so
    // this cannot drift from the layer definition.
    if (crowdFlow) wantedKinds.push(GATEWAY_KIND_FOR_OPTIONAL_LAYER.crowd_flow);
    // §16 Relevant Places ride the same way. Gateway only — see the option.
    if (places) wantedKinds.push(GATEWAY_KIND_FOR_OPTIONAL_LAYER.relevant_places);

    try {
      // ── 1. Try the gateway ────────────────────────────────────────────────
      let gatewayObjects: MapObject[] | null = null;
      let gatewaySources: string[] = [];
      let enrichment: UseMapEntitiesResult['liveEnrichment'] = null;

      if (wantedKinds.length > 0 && effectiveLat != null && effectiveLng != null) {
        const res = await fetchMapProjection({
          // §34: the viewport the camera has SETTLED on (effective*), not the
          // commanded one, once a settle has arrived.
          bbox: bboxFromCenter(effectiveLat, effectiveLng, radiusKm),
          zoom: effectiveZoom,
          kinds: wantedKinds,
          limit: 200,
          signal: controller.signal,
        });
        // A newer fetch superseded this one while the gateway was answering (or
        // it was aborted, which returns `ok:false`): discard silently. Falling
        // through would run the legacy path for a viewport the user has left.
        if (!current()) return;
        // `enabled: false` means the flag is off — fall back, do NOT treat it
        // as an empty world.
        if (res.ok && res.data.enabled) {
          gatewayObjects = res.data.objects;
          gatewaySources = res.data.sources;
          enrichment = res.data.liveEnrichment;
        }
      }

      // ── 2. Roll back to the per-layer fetchers, or not at all ─────────────
      // See the header: when the gateway answered it owns EVERY layer, because
      // re-fetching one it declined would route around a fail-closed decision
      // through a fail-open transport.
      const usedGateway = gatewayObjects !== null;
      const fetches: Promise<MapObject[]>[] = [];

      if (!usedGateway) {
        if (enabledLayers.includes('events') && effectiveLat != null && effectiveLng != null) {
          fetches.push(fetchEvents(effectiveLat, effectiveLng, now).catch(() => []));
        }
        if (enabledLayers.includes('gems') && city) {
          fetches.push(fetchGems(city).catch(() => []));
        }
        if (enabledLayers.includes('buddies') && city) {
          fetches.push(fetchBuddies(city, effectiveLat, effectiveLng).catch(() => []));
        }
        if (enabledLayers.includes('trips')) {
          fetches.push(fetchTrips().catch(() => []));
        }
        if (enabledLayers.includes('friends')) {
          fetches.push(fetchFriends().catch(() => []));
        }
      }

      // Which enabled layers the gateway did NOT name in `sources` — it read
      // them and failed, or never got to them. An empty layer for that reason
      // must never be presented as "nothing here"; it is surfaced, not refetched.
      const unread: ToggleableEntityType[] = usedGateway
        ? enabledLayers.filter((l) => !gatewaySources.includes(GATEWAY_SOURCE_FOR_LAYER[l]))
        : [];

      const perLayer = await Promise.all(fetches);
      // A settle superseded this fetch while the legacy transports were in
      // flight — discard so the newer viewport's answer is the one that paints.
      if (!current()) return;
      const merged = (gatewayObjects ?? []).concat(...perLayer);

      // §31: one ranking over the whole stream, so a gateway object and a
      // per-layer object compete on the same ladder rather than by arrival order.
      merged.sort(compareByRenderingPriority);

      setObjects(merged);
      setEntities(mapObjectsToEntities(merged));
      // 'mixed' is unreachable now that the gateway serves every layer this
      // hook can show: when it answers, no per-layer fetcher runs at all.
      setSource(usedGateway ? 'gateway' : 'legacy');
      setUnreadLayers(unread);
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
      // Only the newest fetch may surface an error; a superseded one's failure
      // (an abort included) is not the user's current view.
      if (current() && !hasLoaded.current) setError(err?.message ?? 'Failed to load map entities');
    } finally {
      // Only the newest fetch owns the loading flag — a superseded fetch's
      // finally must not clear the spinner an in-flight newer fetch still needs.
      if (current()) setLoading(false);
    }
    // `places` is a fetch-key input: the §16 preference it carries loads
    // asynchronously, and a change that did not refetch would leave the kind
    // permanently unrequested (or permanently requested) for the session.
    //
    // effective{Lat,Lng,Zoom} carry the §34 settled camera; when a settle moves
    // them the fetch re-keys and re-queries the new viewport.
  }, [enabledLayers, city, effectiveLat, effectiveLng, effectiveZoom, radiusKm, places]);

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
    unreadLayers,
  };
}
