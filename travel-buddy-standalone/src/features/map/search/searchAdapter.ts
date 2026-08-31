/**
 * searchAdapter — the app's unified search results, shaped for the map (§27).
 *
 * `searchUnified` (services/discovery.ts) returns `UnifiedSearchResult`, which
 * is built for a LIST: title, subtitle, avatar, a destination route. It carries
 * no coordinates of its own — anything geographic sits inside the untyped
 * `metadata` bag, and only for some result types.
 *
 * §27 says "Geographic results should center or frame the relevant map object",
 * so the map needs `MapSearchResult`, which `frameFor` can turn into a camera
 * move. This module is that translation, and nothing else.
 *
 * THE RULE THAT SHAPES IT
 * =======================
 * A result with no usable coordinates gets NO `center` and NO `bounds`.
 * `frameFor` then returns `{ kind: 'none' }` and the camera does not move —
 * which is the honest outcome. The tempting alternatives are both wrong:
 * falling back to the viewport centre pretends we located something, and
 * falling back to the user's position pretends the result is where they are.
 * A result can still be listed and tapped through to its detail route without
 * being placeable on a map.
 *
 * Pure: no network, no storage, no clock.
 */
import type {
  AreaSearchResult,
  MapSearchResult,
  MapSearchResultType,
} from './mapSearchModel.ts';

/** The subset of `UnifiedSearchResult` this adapter reads. */
export interface UnifiedSearchResultLike {
  id: string;
  type: string;
  title: string;
  subtitle?: string | null;
  locationPreview?: string | null;
  destinationRoute?: string | null;
  metadata?: Record<string, unknown> | null;
  startsAt?: string | null;
}

/**
 * The server's `type` strings mapped onto §27's nine result types.
 *
 * Anything unrecognised is DROPPED rather than coerced to 'place': a result
 * rendered under the wrong heading, with the wrong zoom and the wrong camera
 * state, is worse than one that simply is not on the map.
 */
export const SERVER_TYPE_TO_MAP_TYPE: Record<string, MapSearchResultType> = {
  place: 'place',
  places: 'place',
  venue: 'place',
  event: 'event',
  events: 'event',
  trip: 'trip',
  trips: 'trip',
  user: 'user',
  users: 'user',
  profile: 'user',
  buddy: 'buddy',
  buddies: 'buddy',
  gem: 'hidden_gem',
  gems: 'hidden_gem',
  hidden_gem: 'hidden_gem',
  area: 'area',
  areas: 'area',
  neighborhood: 'area',
  city: 'area',
  hashtag: 'hashtag',
  hashtags: 'hashtag',
  tag: 'hashtag',
  saved: 'saved',
  wishlist: 'saved',
};

export function mapSearchTypeFor(serverType: string): MapSearchResultType | null {
  return SERVER_TYPE_TO_MAP_TYPE[String(serverType).toLowerCase()] ?? null;
}

/** A finite lat/lng pair, or null. Never partially populated. */
function coordFrom(v: unknown): { lat: number; lng: number } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const lat = Number(o.lat ?? o.latitude);
  const lng = Number(o.lng ?? o.lon ?? o.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Coordinates from a metadata bag, checked at the two shapes the API uses. */
export function centerFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): { lat: number; lng: number } | null {
  if (!metadata) return null;
  return (
    coordFrom(metadata) ??
    coordFrom(metadata.center) ??
    coordFrom(metadata.location) ??
    coordFrom(metadata.coordinates) ??
    null
  );
}

/** A bounds object from metadata, when the subject is a region rather than a point. */
export function boundsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): AreaSearchResult['bounds'] | null {
  if (!metadata) return null;
  const b = (metadata.bounds ?? metadata.bbox) as Record<string, unknown> | undefined;
  if (!b || typeof b !== 'object') return null;
  const north = Number(b.north ?? b.n ?? b.maxLat);
  const south = Number(b.south ?? b.s ?? b.minLat);
  const east = Number(b.east ?? b.e ?? b.maxLng);
  const west = Number(b.west ?? b.w ?? b.minLng);
  if (![north, south, east, west].every(Number.isFinite)) return null;
  if (south >= north || west >= east) return null;
  if (Math.abs(north) > 90 || Math.abs(south) > 90) return null;
  if (Math.abs(east) > 180 || Math.abs(west) > 180) return null;
  return { north, south, east, west };
}

/**
 * Translate one unified result. Returns null when the type is unrecognised —
 * see SERVER_TYPE_TO_MAP_TYPE.
 */
export function toMapSearchResult(r: UnifiedSearchResultLike): MapSearchResult | null {
  const type = mapSearchTypeFor(r.type);
  if (!type) return null;

  const base = {
    id: r.id,
    title: r.title,
    subtitle: r.subtitle ?? r.locationPreview ?? undefined,
    detailRoute: r.destinationRoute ?? undefined,
  };
  const center = centerFromMetadata(r.metadata);
  const bounds = boundsFromMetadata(r.metadata);

  switch (type) {
    case 'area':
      // An Area FRAMES; it does not centre. Without bounds it is not an area
      // result at all, so it degrades to a saved-style point rather than
      // pretending a centroid is a region.
      if (!bounds) return center ? { ...base, type: 'saved', center, savedKind: 'area' } : null;
      return { ...base, type: 'area', bounds, center: center ?? null };
    case 'hashtag':
      return { ...base, type: 'hashtag', tag: r.title, bounds: bounds ?? null, points: null };
    case 'hidden_gem':
      // The model requires a point for a gem; without one it cannot be framed.
      return center ? { ...base, type: 'hidden_gem', center } : null;
    case 'place':
      return center ? { ...base, type: 'place', center } : null;
    case 'event':
      return center
        ? { ...base, type: 'event', center, startsAt: r.startsAt ?? undefined }
        : null;
    case 'trip':
      return { ...base, type: 'trip', center: center ?? null, bounds: bounds ?? null, stops: null };
    case 'saved':
      return { ...base, type: 'saved', center: center ?? null, bounds: bounds ?? null, savedKind: 'place' };
    case 'user':
      return { ...base, type: 'user', center: center ?? null };
    case 'buddy':
      return { ...base, type: 'buddy', center: center ?? null };
    default:
      return null;
  }
}

/** Translate a list, dropping what cannot be represented. Order is preserved. */
export function toMapSearchResults(
  results: readonly UnifiedSearchResultLike[],
): MapSearchResult[] {
  const out: MapSearchResult[] = [];
  for (const r of results ?? []) {
    const m = toMapSearchResult(r);
    if (m) out.push(m);
  }
  return out;
}
