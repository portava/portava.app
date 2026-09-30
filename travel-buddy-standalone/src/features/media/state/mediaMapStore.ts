/**
 * features/media — mediaMapStore (spec §21 Media Map · §40 `state/mediaMapStore.ts`
 * · §46 "Geographic context and Map integration" · §46.1 approximate zones).
 *
 * THE ONE RULE §21 STATES: "Media Map consumes the canonical Map projection
 * system; it does not own a second location engine." So this module OWNS NO
 * GEOMETRY. It joins two answers the client already receives:
 *
 *   • `GET /media/map` — perspective COUNTS per canonical place, deliberately
 *     carrying no geometry (MediaProjectionService.buildMediaMapProjection);
 *   • `GET /map/projection` — the canonical Map gateway's objects for the
 *     current viewport, whose `place:<uuid>` points and `gem:<id>` points were
 *     already privacy-rung'd server-side (`privacyClass`).
 *
 * A cluster whose place the Map did not position in this viewport is reported
 * as UNPOSITIONED and listed as such — it is never given an invented point, a
 * city centroid, or a guess. When the gateway is off (`enabled:false`) or the
 * viewer has no location, nothing is positioned and the screen says so.
 *
 * HIDDEN GEMS (§46.1 "Map discovery contour / approximate zone treatment").
 * A gem the Map served at the `approximate` rung is drawn as an AREA — a
 * contoured zone — never as a pin, because a pin on an approximate centroid
 * would claim a precision the server deliberately withheld. A gem at
 * `place_level` is a contoured marker. A gem at `none` / `aggregate_only` is
 * not drawn at all.
 *
 * Pure, framework-free (no react-native, no network) — safe for node:test.
 */
import type { FreshnessClass, MediaProjection, ProjectionResult } from '../types/media.ts';
import type { MapObject, PrivacyClass } from '../../../types/mapObjects.ts';
import { centroidOf } from '../../../types/mapObjects.ts';

// ── Projection shapes ─────────────────────────────────────────────────────────

/** One `GET /media/map` cluster: a count per canonical place. No geometry. */
export interface MediaMapCluster {
  placeId: string;
  label: string;
  perspectiveCount: number;
  /** Null when the server reported `none`. */
  freshness: FreshnessClass | null;
}

export interface MediaMapProjection {
  clusters: MediaMapCluster[];
  totalPerspectives: number;
  generatedAt: string | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function freshness(v: unknown): FreshnessClass | null {
  // Server FreshnessState is fresh|recent|historical|none. `live` is not a value
  // media freshness can take (lib/media/mediaFreshness.ts), and is NOT accepted
  // here either — a map cluster is never rendered as live.
  return v === 'fresh' || v === 'recent' || v === 'historical' ? v : null;
}

/**
 * Map the `GET /media/map` body. A cluster without a canonical place id is
 * dropped: the server already omits label-only clusters because they cannot be
 * positioned, and the client does not re-admit one.
 */
export function mapMediaMapProjection(raw: unknown): MediaMapProjection {
  const o = isObj(raw) ? raw : {};
  const clusters: MediaMapCluster[] = [];
  for (const c of Array.isArray(o.clusters) ? o.clusters : []) {
    if (!isObj(c)) continue;
    const placeId = str(c.placeId);
    const label = str(c.label);
    const count = num(c.perspectiveCount);
    if (!placeId || !label || count == null || count <= 0) continue;
    clusters.push({ placeId, label, perspectiveCount: Math.floor(count), freshness: freshness(c.freshness) });
  }
  return {
    clusters,
    totalPerspectives: num(o.totalPerspectives) ?? clusters.reduce((s, c) => s + c.perspectiveCount, 0),
    generatedAt: str(o.generatedAt),
  };
}

/**
 * My World's map: the OWNER's own media grouped by the canonical place each
 * projection already names. Same cluster shape as `GET /media/map`, so the one
 * join below positions both. Media with no canonical place is not clustered.
 */
export function clustersFromOwnMedia(media: readonly MediaProjection[]): MediaMapCluster[] {
  const byPlace = new Map<string, MediaMapCluster>();
  const seen = new Set<string>();
  for (const m of media) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const placeId = m.place?.id ?? null;
    if (!placeId) continue;
    const label = m.place?.name ?? 'A place you captured';
    const existing = byPlace.get(placeId);
    if (existing) existing.perspectiveCount += 1;
    else byPlace.set(placeId, { placeId, label, perspectiveCount: 1, freshness: m.freshness === 'live' ? 'fresh' : m.freshness });
  }
  return [...byPlace.values()].sort((a, b) => b.perspectiveCount - a.perspectiveCount);
}

// ── Canonical Map objects → positions ─────────────────────────────────────────

/** `place:<uuid>` → `<uuid>`; any other kind → null. */
export function placeIdOfMapObject(obj: Pick<MapObject, 'id' | 'kind'>): string | null {
  if (obj.kind !== 'place' || typeof obj.id !== 'string') return null;
  return obj.id.startsWith('place:') ? obj.id.slice('place:'.length) || null : null;
}

/** `gem:<id>` → `<id>`; any other kind → null. */
export function gemIdOfMapObject(obj: Pick<MapObject, 'id' | 'kind'>): string | null {
  if (obj.kind !== 'hidden_gem' || typeof obj.id !== 'string') return null;
  return obj.id.startsWith('gem:') ? obj.id.slice('gem:'.length) || null : null;
}

export interface PositionedCluster extends MediaMapCluster {
  lat: number;
  lng: number;
}

export interface ClusterJoin {
  positioned: PositionedCluster[];
  /** Clusters the canonical Map did not position in this viewport. Listed, never placed. */
  unpositioned: MediaMapCluster[];
}

export function joinClustersToPositions(
  clusters: readonly MediaMapCluster[],
  mapObjects: readonly MapObject[],
): ClusterJoin {
  const positions = new Map<string, { lat: number; lng: number }>();
  for (const o of mapObjects) {
    const pid = placeIdOfMapObject(o);
    if (!pid || o.privacyClass === 'none') continue;
    const c = centroidOf(o.geometry);
    if (c) positions.set(pid, c);
  }
  const positioned: PositionedCluster[] = [];
  const unpositioned: MediaMapCluster[] = [];
  for (const cl of clusters) {
    const p = positions.get(cl.placeId);
    if (p) positioned.push({ ...cl, lat: p.lat, lng: p.lng });
    else unpositioned.push(cl);
  }
  return { positioned, unpositioned };
}

// ── §46.1 gem zones ───────────────────────────────────────────────────────────

export type GemMapTreatment = 'approximate_zone' | 'contour_marker';

/**
 * The §46.1 treatment for a gem at a given privacy rung, or null for a rung that
 * must not be drawn. Decided on the RUNG alone — nothing about the gem's state
 * or popularity can sharpen an approximate area into a point.
 */
export function gemMapTreatment(privacyClass: PrivacyClass): GemMapTreatment | null {
  switch (privacyClass) {
    case 'approximate':
      return 'approximate_zone';
    case 'place_level':
    case 'precise_temporary':
      return 'contour_marker';
    default:
      return null; // 'none' and 'aggregate_only' are never drawn as a gem
  }
}

/**
 * The drawn radius of an approximate gem zone. HiddenGemPrivacyGuard's
 * `approximate` rung is a neighbourhood-level centroid, so the contour is drawn
 * at neighbourhood scale — an area a visitor cannot mistake for a doorstep.
 */
export const APPROXIMATE_GEM_ZONE_RADIUS_M = 800;

export interface GemZone {
  gemId: string;
  label: string;
  lat: number;
  lng: number;
  treatment: GemMapTreatment;
  /** Only meaningful for an approximate zone; 0 for a marker. */
  radiusMeters: number;
}

/**
 * Gem zones from the canonical Map's `hidden_gem` objects. `allowGemIds`, when
 * given, restricts to gems the §16 lens itself disclosed — the lens decides
 * MEMBERSHIP, the Map decides GEOMETRY, and a gem must pass both.
 */
export function gemZonesFrom(
  mapObjects: readonly MapObject[],
  allowGemIds?: ReadonlySet<string> | null,
): GemZone[] {
  const out: GemZone[] = [];
  for (const o of mapObjects) {
    const gemId = gemIdOfMapObject(o);
    if (!gemId) continue;
    if (allowGemIds && !allowGemIds.has(gemId)) continue;
    const treatment = gemMapTreatment(o.privacyClass);
    if (!treatment) continue;
    const c = centroidOf(o.geometry);
    if (!c) continue;
    out.push({
      gemId,
      label: typeof o.title === 'string' && o.title.trim() ? o.title : 'Hidden gem',
      lat: c.lat,
      lng: c.lng,
      treatment,
      radiusMeters: treatment === 'approximate_zone' ? APPROXIMATE_GEM_ZONE_RADIUS_M : 0,
    });
  }
  return out;
}

/**
 * A closed GeoJSON ring approximating a circle of `radiusMeters` — the contour
 * of an approximate zone. Pure spherical approximation; ample at 800 m.
 */
export function circleRing(lat: number, lng: number, radiusMeters: number, steps = 32): [number, number][] {
  const ring: [number, number][] = [];
  const dLat = radiusMeters / 111_320;
  const dLng = radiusMeters / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    ring.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  ring.push(ring[0]!);
  return ring;
}

/** The approximate-zone polygons as one GeoJSON FeatureCollection (fill + contour line). */
export function gemZoneFeatures(zones: readonly GemZone[]): {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    properties: { gemId: string; label: string };
    geometry: { type: 'Polygon'; coordinates: [number, number][][] };
  }>;
} {
  return {
    type: 'FeatureCollection',
    features: zones
      .filter((z) => z.treatment === 'approximate_zone')
      .map((z) => ({
        type: 'Feature' as const,
        id: `gem-zone-${z.gemId}`,
        properties: { gemId: z.gemId, label: z.label },
        geometry: { type: 'Polygon' as const, coordinates: [circleRing(z.lat, z.lng, z.radiusMeters)] },
      })),
  };
}

// ── The store: a pure reducer + selector ──────────────────────────────────────

export type MediaMapLayer = 'perspectives' | 'gems';

export type MediaMapStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/** Why nothing could be positioned — said to the viewer in words. */
export type PositionsUnavailableReason =
  | 'no_location' // the viewer's coarse location is unknown, so there is no viewport
  | 'map_disabled' // the canonical Map gateway answered enabled:false
  | 'map_failed' // the canonical Map call failed
  | null;

export interface MediaMapState {
  status: MediaMapStatus;
  clusters: MediaMapCluster[];
  mapObjects: MapObject[];
  positionsUnavailable: PositionsUnavailableReason; /** census-discovery §114 (sweep SW3) */ positionsPartial?: boolean;
  selectedPlaceId: string | null;
  layers: Record<MediaMapLayer, boolean>;
  totalPerspectives: number;
}

export const INITIAL_MEDIA_MAP_STATE: MediaMapState = {
  status: 'idle',
  clusters: [],
  mapObjects: [],
  positionsUnavailable: null,
  selectedPlaceId: null,
  layers: { perspectives: true, gems: true },
  totalPerspectives: 0,
};

/** The canonical-Map half of a load, in the shape the reducer needs. */
export type MapPositionsResult =
  | { ok: true; enabled: boolean; objects: MapObject[]; /** census-discovery §114 (sweep SW3): the gateway did not read a requested layer, or answered one page of several */ partial?: boolean }
  | { ok: false; reason: 'no_location' | 'map_failed' };

export type MediaMapAction =
  | { type: 'load_start' }
  | {
      type: 'load_result';
      clusters: ProjectionResult<MediaMapCluster[]>;
      positions: MapPositionsResult;
      /** Gem zones need no clusters; a gem-only map is not empty when it has zones. */
      expectGems?: boolean;
    }
  | { type: 'select_cluster'; placeId: string | null }
  | { type: 'toggle_layer'; layer: MediaMapLayer };

export function mediaMapReducer(state: MediaMapState, action: MediaMapAction): MediaMapState {
  switch (action.type) {
    case 'load_start':
      return { ...state, status: 'loading' };
    case 'load_result': {
      const positions = action.positions;
      const mapObjects = positions.ok && positions.enabled ? positions.objects : []; const positionsPartial = positions.ok && positions.enabled && positions.partial === true;  // §114 (SW3)
      const positionsUnavailable: PositionsUnavailableReason = positions.ok
        ? positions.enabled
          ? null
          : 'map_disabled'
        : positions.reason;
      if (!action.clusters.ok) {
        // The counts could not be read. That is an error, not an empty map —
        // unless the call is gem-only and the Map still answered.
        if (action.expectGems && mapObjects.length > 0) {
          return { ...state, status: 'ready', clusters: [], mapObjects, positionsUnavailable, positionsPartial, totalPerspectives: 0 };
        }
        return { ...state, status: 'error', clusters: [], mapObjects, positionsUnavailable, positionsPartial, totalPerspectives: 0 };
      }
      const clusters = action.clusters.data;
      const hasGems = !!action.expectGems && mapObjects.some((o) => gemIdOfMapObject(o) != null);
      const empty = clusters.length === 0 && !hasGems && !positionsPartial;  // §114 (SW3): a map that could not read its layers is not an empty one
      return {
        ...state,
        status: empty ? 'empty' : 'ready',
        clusters,
        mapObjects,
        positionsUnavailable, positionsPartial,
        totalPerspectives: clusters.reduce((s, c) => s + c.perspectiveCount, 0),
      };
    }
    case 'select_cluster':
      return { ...state, selectedPlaceId: action.placeId };
    case 'toggle_layer':
      return { ...state, layers: { ...state.layers, [action.layer]: !state.layers[action.layer] } };
    default:
      return state;
  }
}

export interface MediaMapModel {
  positioned: PositionedCluster[];
  unpositioned: MediaMapCluster[];
  gemZones: GemZone[];
  positionsUnavailable: PositionsUnavailableReason; /** census-discovery §114 (sweep SW3) */ positionsPartial: boolean;
  selected: MediaMapCluster | null;
}

/** Everything the screen draws, derived — never stored twice. */
export function selectMediaMapModel(
  state: MediaMapState,
  opts: { allowGemIds?: ReadonlySet<string> | null } = {},
): MediaMapModel {
  const clusters = state.layers.perspectives ? state.clusters : [];
  const join = joinClustersToPositions(clusters, state.mapObjects);
  const gemZones = state.layers.gems ? gemZonesFrom(state.mapObjects, opts.allowGemIds ?? null) : [];
  return {
    positioned: join.positioned,
    unpositioned: join.unpositioned,
    gemZones,
    positionsUnavailable: state.positionsUnavailable, positionsPartial: state.positionsPartial === true,
    selected: state.clusters.find((c) => c.placeId === state.selectedPlaceId) ?? null,
  };
}

/** Copy for an unpositioned map — the words, not a blank canvas. */
export function positionsUnavailableCopy(reason: PositionsUnavailableReason): string | null {
  switch (reason) {
    case 'no_location':
      return 'Turn on location to place these on the map. Your perspectives are listed below.';
    case 'map_disabled':
      return 'Map positions are not available right now. Places are listed below by perspective count.';
    case 'map_failed':
      return 'The map could not be reached. Places are listed below by perspective count.';
    default:
      return null;
  }
}

// ── census-discovery §114 (DV-83 round 17, lane W11-X2; sweep SW3): a gateway answer that is not whole ─────────────
//
// The NOW gateway names a layer in `sources` only over a read that succeeded and was not cut, and carries `nextCursor`
// when its answer is one page of several. The Media Map asks it for `place` (and `hidden_gem`) objects; a requested
// kind it did not name, or a page of several, means the positions (and gem zones) drawn are not all there are — said,
// never drawn as an empty or whole map. `sources` is always an array from the service; a missing one is not named.
const MEDIA_MAP_KIND_SOURCE: Record<string, string> = { place: 'places', hidden_gem: 'gems' };

export function mediaMapGatewayPartial(data: { sources?: string[]; nextCursor?: string | null }, kinds: readonly string[]): boolean {
  const named = data.sources ?? [];
  return data.nextCursor != null || kinds.some((k) => !named.includes(MEDIA_MAP_KIND_SOURCE[k] ?? k));
}

export const MEDIA_MAP_PARTIAL_COPY = 'Some of this map could not be read \u2014 places and gems here may be missing.';
