/**
 * Canonical Place service client
 *
 * Wraps GET /api/places/canonical/:id, GET /api/places/nearby-venue,
 * GET /api/places/:id/living, and GET /api/places/:id/living/timeline.
 *
 * The canonical route is gated behind the `external_places_enabled` feature
 * flag. When the flag is OFF the server returns 403; this client returns null
 * so callers never need to handle the flag explicitly.
 *
 * All failures (flag off, 404, network error, parse error) resolve to null —
 * this function never throws.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import type { CanonicalPlace, NormalizedOpeningHours } from '../types/canonicalPlace.ts';
import type {
  PlaceLivingResponse,
  PlaceTimelineResponse,
  TimelineSlice,
} from '../types/placeLiving.ts';

// ── Venue contact info (nearby-venue endpoint) ────────────────────────────────

export interface VenueContactInfo {
  name: string;
  phone: string | null;
  website: string | null;
  openingHours: NormalizedOpeningHours | null;
}

// ── Venue info cache ─────────────────────────────────────────────────────────

/** How long a cached venue result is considered fresh (5 minutes). */
const VENUE_CACHE_TTL_MS = 5 * 60 * 1000;

interface VenueCacheEntry {
  value: VenueContactInfo | null;
  expiresAt: number;
}

/** Module-level cache — persists across screen mounts for the app's lifetime. */
const venueCache = new Map<string, VenueCacheEntry>();

function venueInfoCacheKey(lat: number, lng: number, name?: string | null): string {
  return `${lat},${lng}:${name ?? ''}`;
}

/**
 * Invalidate the in-memory cache entry for the given coordinates (and optional
 * venue name). Call this when an event's location changes so the next
 * `getVenueInfoByCoords` call fetches fresh data rather than serving stale
 * contact info for the old location.
 *
 * Silently does nothing when no entry for those coordinates exists.
 */
export function clearVenueInfoCache(lat: number, lng: number, name?: string | null): void {
  venueCache.delete(venueInfoCacheKey(lat, lng, name));
}

/**
 * Fetch contact info (phone, website, opening hours) for a venue near the
 * given coordinates via GET /api/places/nearby-venue.
 *
 * Pass the venue name as `name` when available — it is used as a search hint
 * to improve match accuracy. Returns null on any failure (no key, timeout,
 * not found, unauthenticated).
 *
 * Results (including null/not-found) are cached in memory for
 * VENUE_CACHE_TTL_MS to avoid redundant FSQ hits when the user navigates
 * away and back to the same event.
 */
export async function getVenueInfoByCoords(
  lat: number,
  lng: number,
  name?: string | null,
): Promise<VenueContactInfo | null> {
  const cacheKey = venueInfoCacheKey(lat, lng, name);
  const cached = venueCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  if (!isSupabaseConfigured || !apiBase()) return null;

  const token = await freshToken();
  if (!token) return null;

  /** Store value in cache and return it — convenience so every exit path is one line. */
  const cacheAndReturn = (value: VenueContactInfo | null): VenueContactInfo | null => {
    venueCache.set(cacheKey, { value, expiresAt: Date.now() + VENUE_CACHE_TTL_MS });
    return value;
  };

  try {
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    if (name) params.set('name', name);

    const res = await fetch(
      `${apiBase()}/api/places/nearby-venue?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return cacheAndReturn(null);

    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') return cacheAndReturn(null);

    const venue = (json as any).venue;
    if (!venue || typeof venue !== 'object' || typeof venue.name !== 'string') return cacheAndReturn(null);

    return cacheAndReturn({
      name:    venue.name,
      phone:   typeof venue.phone === 'string' && venue.phone ? venue.phone : null,
      website: typeof venue.website === 'string' && venue.website ? venue.website : null,
      openingHours: Array.isArray(venue.openingHours) && venue.openingHours.length > 0
        ? venue.openingHours as NormalizedOpeningHours
        : null,
    });
  } catch {
    return null;
  }
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

/**
 * Fetch the canonical place envelope for the given place ID.
 *
 * Server route: GET /api/places/canonical/:id
 * Flag:         `external_places_enabled` must be ON.
 *
 * @returns Parsed CanonicalPlace on success, null otherwise.
 *          Null cases: flag OFF (403), not found (404), network error,
 *          parse failure, unauthenticated, or API not configured.
 */
export async function getCanonicalPlace(id: string): Promise<CanonicalPlace | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;

  const token = await freshToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `${apiBase()}/api/places/canonical/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    // Server returns { place: CanonicalPlace } envelope — extract the nested object.
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') return null;
    const place = (json as any).place;
    return isValidCanonicalPlace(place) ? place : null;
  } catch {
    return null;
  }
}

// ── Living Destination Page ───────────────────────────────────────────────────

/**
 * Fetch the Living Destination Page payload for a place.
 *
 * Server route: GET /api/places/:id/living
 *
 * Returns the full page payload on success, null on any failure.
 */
export async function getPlaceLiving(placeId: string): Promise<PlaceLivingResponse | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const token = await freshToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `${apiBase()}/api/places/${encodeURIComponent(placeId)}/living`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') return null;
    // Minimal guard — server always returns placeId
    if (typeof (json as any).placeId !== 'string') return null;
    return json as PlaceLivingResponse;
  } catch {
    return null;
  }
}

/**
 * Fetch the time-sliced post feed for a place's timeline.
 *
 * Server route: GET /api/places/:id/living/timeline?slice=...
 *
 * Returns the timeline payload on success, null on any failure.
 */
export async function getPlaceTimeline(
  placeId: string,
  slice: TimelineSlice,
): Promise<PlaceTimelineResponse | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const token = await freshToken();
  if (!token) return null;

  try {
    const params = new URLSearchParams({ slice });
    const res = await fetch(
      `${apiBase()}/api/places/${encodeURIComponent(placeId)}/living/timeline?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || typeof json !== 'object') return null;
    if (typeof (json as any).placeId !== 'string') return null;
    return json as PlaceTimelineResponse;
  } catch {
    return null;
  }
}

// ── Runtime shape validator ───────────────────────────────────────────────────

/** Allowed values for the PlaceStatus enum — validated at runtime. */
const VALID_PLACE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'closed',
  'temporarily_closed',
  'moved',
]);

/**
 * Returns true when `v` satisfies the minimum required shape of a CanonicalPlace.
 * Any missing or wrong-typed required field returns false → caller returns null.
 *
 * Required fields: id (string), name (string), category (string),
 * coordinates.lat/lng (finite numbers), status (PlaceStatus enum member),
 * detailRoute (string), attribution (string[]), sources (array),
 * fieldFreshness (object).
 */
function isValidCanonicalPlace(v: unknown): v is CanonicalPlace {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;

  if (typeof p.id !== 'string' || !p.id) return false;
  if (typeof p.name !== 'string' || !p.name) return false;
  if (typeof p.category !== 'string' || !p.category) return false;
  // status must be one of the known PlaceStatus values — prevents unknown enum
  // values from reaching PlaceCard where they would produce undefined badge colors.
  if (typeof p.status !== 'string' || !VALID_PLACE_STATUSES.has(p.status)) return false;
  if (typeof p.detailRoute !== 'string' || !p.detailRoute) return false;
  // attribution must be an array where every entry is a string.
  if (!Array.isArray(p.attribution)) return false;
  if ((p.attribution as unknown[]).some((a) => typeof a !== 'string')) return false;
  if (!Array.isArray(p.sources)) return false;
  if (!p.fieldFreshness || typeof p.fieldFreshness !== 'object') return false;

  // coordinates must be a plain object with finite lat/lng numbers.
  const coords = p.coordinates as Record<string, unknown> | null | undefined;
  if (!coords || typeof coords !== 'object') return false;
  if (typeof coords.lat !== 'number' || !Number.isFinite(coords.lat)) return false;
  if (typeof coords.lng !== 'number' || !Number.isFinite(coords.lng)) return false;

  return true;
}
