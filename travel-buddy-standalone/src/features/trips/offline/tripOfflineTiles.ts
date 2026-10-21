/**
 * Trips §18.1 — "cached map tiles where permitted" (census-trips TR340).
 *
 * The server's bundle says what it cannot carry: `notCarried.mapTiles` reads
 * "a client permission the server does not hold". Tiles are bytes the DEVICE
 * keeps in MapLibre's native pack store, so this half of §18.1 is the client's:
 * when the traveller refreshes the offline copy, the trip's own area is packed
 * through the Map programme's §28 "cache current base-map region" mechanism
 * (`src/features/map/cache/offlineBaseMap.ts`) — the same style, the same class
 * retention (TTL and region cap) — under the scope `trip:<id>`, so a refresh
 * replaces the trip's pack rather than adding one.
 *
 * WHERE PERMITTED, decided here and stated on the card, never assumed:
 *   - the device can hold a pack at all (the native OfflineManager exists —
 *     absent under web, Jest and stripped builds);
 *   - the traveller has not asked the app to save data: tiles are bulk media
 *     on the degradation ladder (`mayLoad('media', level)`), so the device's
 *     data-saver setting refuses them;
 *   - there is an area to pack: the trip's destination and the bundle's
 *     meeting points, and only when that area is a city's worth, not a
 *     continent's (`MAX_TILE_SPAN_DEG`).
 * The provider's own terms are the Map programme's §28 decision, inherited
 * here rather than re-made: the pack uses the style and the cache class that
 * module already packs.
 */
import {
  createBaseMapRegionPack,
  getBaseMapRegionStatus,
  type BaseMapRegionBounds,
  type OfflineBaseMapDeps,
} from '../../map/cache/offlineBaseMap.ts';

/** A trip's pack is one region, replaced on every refresh. */
export function tripTileScope(tripId: string): string {
  return `trip:${tripId}`;
}

/** Padding around the trip's points, in degrees (about 5 km at the equator). */
export const TILE_PAD_DEG = 0.05;
/** A destination alone is packed as a box this far either side of it (about 10 km). */
export const DESTINATION_HALF_SPAN_DEG = 0.09;
/** Larger than this in either direction is not a city's worth of tiles; nothing is packed. */
export const MAX_TILE_SPAN_DEG = 0.6;
/** §17's street level; packing deeper multiplies the tile count for a whole-city box. */
export const TRIP_TILE_MIN_ZOOM = 11;
export const TRIP_TILE_MAX_ZOOM = 16;

export interface TripTilePoint { lat: number; lng: number }

export type TripTileArea =
  | { ok: true; bounds: BaseMapRegionBounds }
  | { ok: false; reason: 'no_area' | 'area_too_large' };

function valid(p: Partial<TripTilePoint> | null | undefined): p is TripTilePoint {
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    && Math.abs(p.lat) <= 85 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0);
}

/** The area to pack: the destination and the bundle's meeting points, padded and bounded. */
export function tripTileArea(destination: Partial<TripTilePoint> | null | undefined, meetingPoints: ReadonlyArray<Partial<TripTilePoint>>): TripTileArea {
  const points = [...(valid(destination) ? [destination] : []), ...meetingPoints.filter(valid)];
  if (points.length === 0) return { ok: false, reason: 'no_area' };
  let south = Math.min(...points.map((p) => p.lat));
  let north = Math.max(...points.map((p) => p.lat));
  let west = Math.min(...points.map((p) => p.lng));
  let east = Math.max(...points.map((p) => p.lng));
  if (north - south > MAX_TILE_SPAN_DEG || east - west > MAX_TILE_SPAN_DEG) return { ok: false, reason: 'area_too_large' };
  const pad = points.length === 1 ? DESTINATION_HALF_SPAN_DEG : TILE_PAD_DEG;
  south = Math.max(-85, south - pad); north = Math.min(85, north + pad);
  west = Math.max(-180, west - pad); east = Math.min(180, east + pad);
  return { ok: true, bounds: { west, south, east, north } };
}

export type TripTileOutcome =
  | { state: 'cached'; scope: string }
  | { state: 'not_permitted'; reason: 'data_saver' | 'no_area' | 'area_too_large' | 'offline_unavailable' }
  | { state: 'failed'; detail: string };

export interface TripTileDeps {
  /**
   * The degradation ladder's answer for bulk media on this device — false while
   * the traveller's data-saver is on (useDataSaver.ts `mayLoad('media', …)`).
   * Passed in, so this module stays free of the React Native storage it is read from.
   */
  mediaAllowed: boolean;
  /** The pack store; omitted resolves the native OfflineManager (null under web / Jest). */
  offline?: OfflineBaseMapDeps;
}

/**
 * Pack the trip's area, where permitted. Never throws: tiles are an
 * enhancement of the offline copy, never a condition of keeping it.
 */
export async function cacheTripTiles(
  tripId: string,
  area: { destination: Partial<TripTilePoint> | null | undefined; meetingPoints: ReadonlyArray<Partial<TripTilePoint>> },
  deps: TripTileDeps,
): Promise<TripTileOutcome> {
  if (deps.mediaAllowed !== true) return { state: 'not_permitted', reason: 'data_saver' };
  const a = tripTileArea(area.destination, area.meetingPoints);
  if (!a.ok) return { state: 'not_permitted', reason: a.reason };
  const r = await createBaseMapRegionPack(
    { scope: tripTileScope(tripId), bounds: a.bounds, minZoom: TRIP_TILE_MIN_ZOOM, maxZoom: TRIP_TILE_MAX_ZOOM },
    deps.offline ?? {},
  );
  if (r.ok) return { state: 'cached', scope: r.value.scope };
  if (r.reason === 'offline_unavailable') return { state: 'not_permitted', reason: 'offline_unavailable' };
  return { state: 'failed', detail: r.message ?? r.reason };
}

export type TripTileStatus =
  | { state: 'none' }
  | { state: 'downloading'; percentage: number }
  | { state: 'complete' }
  | { state: 'unavailable' };

/** How far the trip's pack has got, for the card. */
export async function tripTileStatus(tripId: string, offline: OfflineBaseMapDeps = {}): Promise<TripTileStatus> {
  const r = await getBaseMapRegionStatus(tripTileScope(tripId), offline);
  if (!r.ok) return r.reason === 'not_found' ? { state: 'none' } : { state: 'unavailable' };
  if (r.value.state === 'complete') return { state: 'complete' };
  return { state: 'downloading', percentage: Math.max(0, Math.min(100, Math.round(r.value.percentage))) };
}

/** The card's one line about tiles, in the traveller's words. */
export function describeTripTiles(outcome: TripTileOutcome | null, status: TripTileStatus | null): string | null {
  if (outcome?.state === 'not_permitted') {
    switch (outcome.reason) {
      case 'data_saver': return 'Map not saved offline: data saver is on.';
      case 'no_area': return 'Map not saved offline: this trip has no location to save a map around.';
      case 'area_too_large': return 'Map not saved offline: the trip covers too wide an area for one offline map.';
      case 'offline_unavailable': return 'Map not saved offline: offline maps are not available on this device.';
    }
  }
  if (outcome?.state === 'failed') return `Map not saved offline: ${outcome.detail}.`;
  if (status?.state === 'complete') return 'Map of the trip area saved for offline use.';
  if (status?.state === 'downloading') return `Saving the map of the trip area for offline use: ${status.percentage}%.`;
  if (outcome?.state === 'cached') return 'Saving the map of the trip area for offline use.';
  return null;
}
