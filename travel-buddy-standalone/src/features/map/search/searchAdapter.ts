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
 * Pure: no network, no storage, no clock. The single exception is a deduped
 * diagnostic for unknown server types — see `setUnknownServerTypeSink`.
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
 * THE WIRE VOCABULARY
 * ===================
 * The server's per-item `type` is a `SearchType` from the discovery search
 * route (artifacts/api-server/src/routes/discoverySearch.ts, `SEARCH_TYPES`).
 * Those are the PLURAL forms — "travelers", "hidden_gems", "cities" — and there
 * are SEVENTEEN of them, not nine. §27 lists what the MAP shows; the endpoint
 * is the app's one global search and also returns posts, circles, stamps,
 * plans and three static taxonomy facets.
 *
 * Every one of those seventeen must appear in exactly one of the two tables
 * below. `__tests__/serverSearchTypes.test.ts` reads `SEARCH_TYPES` out of the
 * server source itself and fails if any type is in neither — so the wire
 * growing an eighteenth type breaks a test here instead of silently losing
 * results, which is exactly what the singular keys this table used to hold did
 * to Travelers, Hidden Gems, Cities and Countries.
 */

/** Server types that have a §27 map representation. */
export const SERVER_TYPE_TO_MAP_TYPE: Record<string, MapSearchResultType> = {
  places: 'place',
  // `activities` is the SAME discovery_places table filtered to activity
  // categories, and routes to /place/:id. It is a Place under a filter, so it
  // belongs under the Places heading rather than nowhere.
  activities: 'place',
  events: 'event',
  trips: 'trip',
  travelers: 'user',
  buddies: 'buddy',
  hidden_gems: 'hidden_gem',
  hashtags: 'hashtag',
  // A city or a country is a REGION: it frames rather than centres. Given only
  // a centroid — the canonical-location rows /discovery/suggest returns carry
  // lat/lng — the 'area' branch degrades it to a point rather than inventing a
  // bounding box around it.
  cities: 'area',
  countries: 'area',

  // ── Tolerated aliases — NOT the wire vocabulary ───────────────────────
  // None of these is emitted by discoverySearch.ts. They are kept so a rename
  // or a second producer degrades gracefully, and they are segregated here so
  // no one mistakes them for the wire again. They earn no coverage: the
  // coverage test drives off the server's own list, never off this table.
  place: 'place',
  venue: 'place',
  event: 'event',
  trip: 'trip',
  user: 'user',
  users: 'user',
  profile: 'user',
  buddy: 'buddy',
  gem: 'hidden_gem',
  gems: 'hidden_gem',
  hidden_gem: 'hidden_gem',
  area: 'area',
  areas: 'area',
  neighborhood: 'area',
  city: 'area',
  country: 'area',
  hashtag: 'hashtag',
  tag: 'hashtag',
  // §27's ninth type. The server has NO `saved` SearchType and never emits one,
  // so this is reachable only from a local or future producer.
  saved: 'saved',
  wishlist: 'saved',
};

/**
 * Server types ruled OFF the map on purpose, each with its reason.
 *
 * This table is the whole difference between "we decided this has no place on
 * the map" and "we have never heard of this". Both drop the result; only the
 * second is a bug, and only the second warns.
 */
export const SERVER_TYPE_NOT_ON_MAP: Record<string, string> = {
  plans:
    'a plan is an item inside a trip, not a §27 heading; it carries only tripId/creatorId and has no geometry of its own — it reaches the map as its parent trip',
  posts: 'a post is content, not a location; §27 has no Posts heading',
  circles: 'a circle is a group of people, not a place',
  stamps:
    'a stamp is an earned award; its subject is a trip or a city, and it has no point of its own',
  languages: 'a static taxonomy facet, not a geographic object',
  interests: 'a static taxonomy facet, not a geographic object',
  vibes: 'a static taxonomy facet, not a geographic object',
};

/** What this adapter knows about one server `type` string. */
export type ServerTypeVerdict =
  | { kind: 'mapped'; mapType: MapSearchResultType }
  | { kind: 'not_on_map'; reason: string }
  | { kind: 'unknown' };

/**
 * Classify one server `type`. Unlike `mapSearchTypeFor`, this distinguishes a
 * deliberate omission from an unrecognised string.
 */
export function classifyServerType(serverType: string): ServerTypeVerdict {
  const key = String(serverType).toLowerCase();
  const mapType = SERVER_TYPE_TO_MAP_TYPE[key];
  if (mapType) return { kind: 'mapped', mapType };
  const reason = SERVER_TYPE_NOT_ON_MAP[key];
  if (reason) return { kind: 'not_on_map', reason };
  return { kind: 'unknown' };
}

export function mapSearchTypeFor(serverType: string): MapSearchResultType | null {
  const verdict = classifyServerType(serverType);
  return verdict.kind === 'mapped' ? verdict.mapType : null;
}

// ── The unknown-type signal ─────────────────────────────────────────
//
// SHOULD AN UNKNOWN TYPE BE SILENT? No — silence is how this survived. The map
// search sheet asks for type=all and kept 4 of the 17 types the server returns;
// nothing failed, nothing logged, and the missing results simply looked like a
// thin search.
//
// But only UNKNOWN types warn. A `not_on_map` type is a decision already
// written down above and reviewed, and posts/languages/interests/vibes appear
// in essentially every type=all response — warning on those would fire on every
// keystroke and teach everyone to ignore the channel. An unknown type is rare
// by construction: it means the wire grew something this client has never heard
// of, which is precisely the event worth interrupting someone for.
//
// Deduped per type so one page of results cannot emit twenty identical lines,
// and routed through a replaceable sink so tests can observe it and a host app
// can send it somewhere better than the console. This memo is the module's only
// state; everything else here is pure.

export type UnknownServerTypeSink = (serverType: string) => void;

const DEFAULT_UNKNOWN_SINK: UnknownServerTypeSink = (serverType) => {
  console.warn(
    `[map/search] dropped a result of unknown server type "${serverType}". ` +
      'Every SearchType in artifacts/api-server/src/routes/discoverySearch.ts must be listed ' +
      'in SERVER_TYPE_TO_MAP_TYPE or SERVER_TYPE_NOT_ON_MAP.',
  );
};

let unknownTypeSink: UnknownServerTypeSink = DEFAULT_UNKNOWN_SINK;
const warnedUnknownTypes = new Set<string>();

/**
 * Replace the unknown-type sink and reset the dedupe memo. Returns the sink
 * that was installed before, so a caller can restore it.
 */
export function setUnknownServerTypeSink(
  sink: UnknownServerTypeSink | null,
): UnknownServerTypeSink {
  const previous = unknownTypeSink;
  unknownTypeSink = sink ?? DEFAULT_UNKNOWN_SINK;
  warnedUnknownTypes.clear();
  return previous;
}

function reportUnknownType(serverType: string): void {
  const key = String(serverType).toLowerCase();
  if (warnedUnknownTypes.has(key)) return;
  warnedUnknownTypes.add(key);
  unknownTypeSink(serverType);
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
 * Translate one unified result. Returns null in three distinguishable cases:
 * the type has no map representation (deliberate, silent), the type is unknown
 * (a bug — warns once), or the result carries no usable geometry.
 */
export function toMapSearchResult(r: UnifiedSearchResultLike): MapSearchResult | null {
  const verdict = classifyServerType(r.type);
  if (verdict.kind === 'unknown') {
    reportUnknownType(r.type);
    return null;
  }
  if (verdict.kind === 'not_on_map') return null;
  const type = verdict.mapType;

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
    default: {
      // Exhaustiveness: a tenth MapSearchResultType with no branch here fails
      // typecheck instead of silently returning null at runtime.
      const unhandled: never = type;
      void unhandled;
      return null;
    }
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
