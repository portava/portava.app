/**
 * Discovery service — fetches place data from /api/discovery.
 * Destination-scoped, category-filtered, no auth required.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import type { DiscoveryEventPost } from '../types/discovery.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  try {
    return freshApiToken();
  } catch {
    return null;
  }
}

export type DiscoveryCategory =
  | 'for_you'
  | 'places'
  | 'food'
  | 'nightlife'
  | 'activities'
  | 'events'
  | 'beaches'
  | 'transport';

export interface DiscoveryPlace {
  id: string;
  /** Bare public.places uuid for canonical rows — opens /place/<uuid> (living page + Quick Signal). */
  canonicalPlaceId?: string | null;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  lat: number | null;
  lng: number | null;
  tags: string[];
  address: string | null;
  /** Neighborhood label (when available from the provider). */
  neighborhood?: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
  /** Community "Worth It" vote count — populated by the discovery listing API. */
  worthItCount?: number | null;
  /** Average community review rating — populated by the discovery listing API. */
  avgRating?: number | null;
  /** Number of community reviews — populated by the discovery listing API. */
  reviewCount?: number | null;
  /**
   * Primary cover image URL. Null / absent means no image is available;
   * UI falls back to category artwork via PlaceCategoryFallback.
   */
  headerImageUrl?: string | null;
  /**
   * How the header image was sourced. Drives the resolver priority ladder and
   * the "AI-generated representation" disclosure label in the UI.
   *   'ai_generated'  — image was produced by the AI visuals pipeline
   *   'provider'      — FSQ / OSM / other third-party photo
   *   'user_upload'   — uploaded directly by the place owner or a traveler
   *   'official'      — official venue photography
   *   'portava_media' — Portava curated media library
   */
  headerImageSource?: 'ai_generated' | 'provider' | 'user_upload' | 'official' | 'portava_media' | null;
  /** Data-source attribution text for the venue detail view. When present,
   *  replaces the default OSM attribution footer. */
  attribution?: string | null;
  /** Nine-category image source classification from the accuracy pipeline
   *  (mirrors ImageSourceType from api-server/src/lib/visuals/types.ts). */
  imageSourceType?: string | null;
  /** Image accuracy assessment from the verification pipeline. */
  accuracyStatus?: string | null;
  /** When true the UI must render a disclaimer alongside the image. */
  disclaimerRequired?: boolean | null;
  /** Disclaimer copy to show when disclaimerRequired is true. */
  disclaimerText?: string | null;
  /**
   * Wikidata entity id (`Q…`) when OSM carries one. Used to surface a
   * structured-data "More info" link in the detail sheet.
   */
  wikidataId?: string | null;
  /**
   * Raw OSM `image` tag value, kept only when it is an absolute http(s) URL.
   * Used as the lowest-priority header image candidate — only shown when no
   * headerImageUrl or FSQ photo is available. May be a Wikimedia page URL
   * rather than a direct image, so it is placed after all other candidates.
   */
  osmImageUrl?: string | null;
  /**
   * True when this card represents a hosted Compass event (an activity/idea
   * with a real start time and RSVP flow), not a resolved venue. Detail UI
   * must never show venue-only affordances (Directions/phone/hours/website)
   * for these unless real coordinates are present, and should frame it as
   * an event rather than a place.
   */
  isCompassEvent?: boolean;
}

export interface DiscoveryFilters {
  radiusKm: number;
  openNow: boolean;
  minRating: number | null;
  sortBy?: string | null;
}

export interface DiscoveryResult {
  places: DiscoveryPlace[];
  total: number;
  destination: string;
  cached: boolean;
}

// ── Live venue status (Phase 8 live intelligence) ─────────────────────────────
//
// Confidence-labeled live open-now status from /api/places/live-status.
// available=false means the live source couldn't verify — callers must
// degrade honestly (no pill / "last known hours"), never invent a status.

export interface PlaceLiveConfidence {
  sourceClass: 'verified_live' | 'community_reported' | 'historical' | 'ai_inference';
  label: string;
  checkedAt: string;
  dataNote?: string;
}

export interface PlaceLiveStatus {
  available: boolean;
  openNow: boolean | null;
  source?: string;
  checkedAt?: string;
  dataNote?: string;
  confidence: PlaceLiveConfidence;
}

export async function getPlaceLiveStatus(
  name: string,
  city?: string | null,
): Promise<PlaceLiveStatus | null> {
  const base = apiBase();
  if (!base || !name.trim()) return null;
  const params = new URLSearchParams({ name: name.trim() });
  if (city?.trim()) params.set('city', city.trim());
  try {
    const res = await fetch(`${base}/api/places/live-status?${params}`);
    if (!res.ok) return null;
    const body = await res.json();
    return (body?.liveStatus as PlaceLiveStatus | undefined) ?? null;
  } catch {
    return null;
  }
}

// ── Cached live-status for list cards ─────────────────────────────────────────
//
// Explore/Discover cards fetch live status lazily as they mount. To avoid a
// request storm while scrolling:
//  - results (including "unavailable") are cached in-memory for 10 minutes,
//    mirroring the server-side cache TTL;
//  - failed lookups (network error → null) are cached for 60 s so a flaky
//    connection doesn't retry on every re-mount;
//  - identical concurrent lookups share one in-flight promise;
//  - at most 3 lookups run concurrently — the rest queue.

const LIVE_STATUS_TTL_MS = 10 * 60 * 1_000;
const LIVE_STATUS_FAIL_TTL_MS = 60 * 1_000;
const LIVE_STATUS_MAX_CONCURRENT = 3;

const _liveStatusCache = new Map<string, { value: PlaceLiveStatus | null; at: number }>();
const _liveStatusInFlight = new Map<string, Promise<PlaceLiveStatus | null>>();
let _liveStatusActive = 0;
const _liveStatusQueue: (() => void)[] = [];

function _liveStatusKey(name: string, city?: string | null): string {
  return `${name.trim().toLowerCase()}|${(city ?? '').trim().toLowerCase()}`;
}

function _acquireLiveStatusSlot(): Promise<void> {
  if (_liveStatusActive < LIVE_STATUS_MAX_CONCURRENT) {
    _liveStatusActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _liveStatusQueue.push(() => { _liveStatusActive++; resolve(); });
  });
}

function _releaseLiveStatusSlot(): void {
  _liveStatusActive--;
  const next = _liveStatusQueue.shift();
  if (next) next();
}

/**
 * Deduped, cached, concurrency-limited variant of getPlaceLiveStatus for
 * list surfaces (Explore cards). Never invents a status — a null return or
 * `available: false` means the caller should render nothing.
 */
export async function getPlaceLiveStatusCached(
  name: string,
  city?: string | null,
): Promise<PlaceLiveStatus | null> {
  if (!name.trim()) return null;
  const key = _liveStatusKey(name, city);

  const cached = _liveStatusCache.get(key);
  if (cached) {
    const ttl = cached.value ? LIVE_STATUS_TTL_MS : LIVE_STATUS_FAIL_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
    _liveStatusCache.delete(key);
  }

  const inFlight = _liveStatusInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    await _acquireLiveStatusSlot();
    try {
      const value = await getPlaceLiveStatus(name, city);
      _liveStatusCache.set(key, { value, at: Date.now() });
      return value;
    } finally {
      _releaseLiveStatusSlot();
      _liveStatusInFlight.delete(key);
    }
  })();
  _liveStatusInFlight.set(key, promise);
  return promise;
}

// ── Community discovery ────────────────────────────────────────────────────────

export interface CommunityPlaceItem {
  id: string;
  city: string;
  name: string;
  placeType: 'hidden_gem' | 'traveler_pick';
  category: string;
  neighborhood: string | null;
  blurb: string | null;
  imageUrl: string | null;
  submittedBy: { id: string; name: string; avatarUrl: string | null; handle: string | null } | null;
  savedCount: number;
  tag: string | null;
  note: string | null;
  rating: number | null;
  source: string;
  status: string;
  verified: boolean;
  createdAt: string;
  lat: number | null;
  lng: number | null;
  /** Community "Worth It" vote count — populated by the listing API. */
  worthItCount?: number | null;
  /** Average community review rating — populated by the listing API. */
  avgRating?: number | null;
  /** Number of community reviews — populated by the listing API. */
  reviewCount?: number | null;
}

export interface CommunityDiscoveryResult {
  items: CommunityPlaceItem[];
  city: string;
  total: number;
}

export async function getCommunityPlaces(
  city: string,
  type: 'hidden_gem' | 'traveler_pick' | 'all' = 'all',
  limit = 20,
  sortBy?: string | null,
): Promise<{ ok: true; data: CommunityDiscoveryResult } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const params = new URLSearchParams({ city, type, limit: String(limit) });
  if (sortBy) params.set('sortBy', sortBy);

  try {
    const res = await fetch(`${base}/api/discovery/community?${params}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as CommunityDiscoveryResult;
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

export interface SubmitPlacePayload {
  city: string;
  name: string;
  place_type: 'hidden_gem' | 'traveler_pick';
  category?: string;
  neighborhood?: string;
  blurb?: string;
  tag?: string;
  note?: string;
  rating?: number | null;
  /** Optional coordinates — when present, the place appears as a pin on the For You map. */
  lat?: number | null;
  lng?: number | null;
  /** Optional photos attached to the place submission (up to 3 CDN URLs). */
  photos?: string[];
}

export interface SubmitPlaceResult {
  ok: true;
  place: { id: string; name: string; city: string; place_type: string; status: string; created_at: string };
  /** True when the server successfully geocoded the place name and stored coordinates. */
  geocoded?: boolean;
}

export async function submitCommunityPlace(
  payload: SubmitPlacePayload,
): Promise<SubmitPlaceResult | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/community`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as unknown;
    const obj = data as Record<string, unknown>;
    if (!res.ok || !obj.ok) {
      return { ok: false, error: (obj.message as string) ?? `HTTP ${res.status}` };
    }
    return obj as unknown as SubmitPlaceResult;
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

export async function saveCommunityPlace(
  placeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/community/${placeId}/save`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

/**
 * Returns the list of community place IDs saved by the current user.
 * Used to pre-populate the filled-bookmark state across app sessions.
 * Returns an empty array on any error — fail-open so a network hiccup
 * doesn't break the Discovery screen.
 */
export async function getSavedPlaceIds(): Promise<string[]> {
  const base = apiBase();
  if (!base) return [];

  const token = await freshToken();
  if (!token) return [];

  try {
    const res = await fetch(`${base}/api/discovery/community/saved-ids`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { ids?: string[] };
    return Array.isArray(data.ids) ? data.ids : [];
  } catch {
    return [];
  }
}

export type PlaceReportReason = 'spam' | 'offensive' | 'inaccurate' | 'unsafe' | 'duplicate' | 'other';

export async function reportCommunityPlace(
  placeId: string,
  reason: PlaceReportReason,
  notes?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/community/${placeId}/report`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, notes }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

// ── OSM places (existing) ─────────────────────────────────────────────────────

export type DiscoveryContextMode =
  | 'near_me'
  | 'in_city'
  | 'going_soon'
  | 'around_crew'
  | 'safe_nearby';

export type DiscoveryAgeFilter =
  | 'any'
  | 'open_to_me'
  | '18_plus'
  | '21_plus'
  | 'under_30'
  | '30_plus'
  | 'custom';

// ── Client-side stale-while-revalidate cache for discovery results ─────────────
// Keyed by destination:category:radiusKm:page. Serves previously-fetched data
// instantly when the user returns to the Explore tab, then lets the caller
// decide whether to refresh in the background.
const _CLIENT_CACHE = new Map<string, { data: DiscoveryResult; at: number }>();
const CLIENT_CACHE_TTL = 4 * 60 * 1_000; // 4 minutes

function _discoveryCacheKey(dest: string, cat: string, radiusKm: number, page: number): string {
  return `${dest.toLowerCase().trim()}:${cat}:${radiusKm}:${page}`;
}

/**
 * Synchronous cache read — returns the last-known result for this query (even
 * if stale) or `null` when there is no cached entry.  Use this to paint content
 * immediately before firing a fresh network request.
 */
export function getCachedDiscoveryPlaces(
  destination: string,
  category: DiscoveryCategory,
  radiusKm: number,
  page = 1,
): DiscoveryResult | null {
  return _CLIENT_CACHE.get(_discoveryCacheKey(destination, category, radiusKm, page))?.data ?? null;
}

/**
 * Returns true when a cached entry exists AND is still within the TTL window.
 */
export function isDiscoveryCacheFresh(
  destination: string,
  category: DiscoveryCategory,
  radiusKm: number,
  page = 1,
): boolean {
  const e = _CLIENT_CACHE.get(_discoveryCacheKey(destination, category, radiusKm, page));
  return !!e && Date.now() - e.at < CLIENT_CACHE_TTL;
}

export async function getDiscoveryPlaces(
  destination: string,
  category: DiscoveryCategory,
  filters: DiscoveryFilters,
  page = 1,
  contextMode?: DiscoveryContextMode | null,
  ageFilter?: DiscoveryAgeFilter | null,
  customMinAge?: number | null,
  customMaxAge?: number | null,
  lat?: number | null,
  lng?: number | null,
  /** User's actual GPS position — used by the backend only to recompute distances
   *  for nearest sort. Never used as the Overpass query centre or for geocoding. */
  userLat?: number | null,
  userLng?: number | null,
  /**
   * When true and page === 1, fires a fire-and-forget Compass search signal so
   * category_weights reflect the user's explicit browsing intent.
   *
   * Must be false (default) for background/count callers such as
   * getDiscoveryCategoryCounts — those enumerate all categories and would
   * corrupt personalization weights with non-intent traffic.
   */
  emitSignal = false,
): Promise<{ ok: true; data: DiscoveryResult } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const params = new URLSearchParams({
    destination,
    category,
    radiusKm: String(filters.radiusKm),
    page: String(page),
    ...(filters.openNow ? { openNow: '1' } : {}),
    ...(filters.minRating != null ? { minRating: String(filters.minRating) } : {}),
    ...(filters.sortBy ? { sortBy: filters.sortBy } : {}),
    ...(contextMode ? { context: contextMode } : {}),
    ...(ageFilter && ageFilter !== 'any' ? { ageFilter } : {}),
    ...(ageFilter === 'custom' && customMinAge != null ? { customMinAge: String(customMinAge) } : {}),
    ...(ageFilter === 'custom' && customMaxAge != null ? { customMaxAge: String(customMaxAge) } : {}),
    ...(lat != null ? { lat: String(lat) } : {}),
    ...(lng != null ? { lng: String(lng) } : {}),
    ...(userLat != null ? { userLat: String(userLat) } : {}),
    ...(userLng != null ? { userLng: String(userLng) } : {}),
  });

  try {
    const res = await fetch(`${base}/api/discovery?${params}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as DiscoveryResult;
    // Populate client cache so the next mount of the same tab is instant.
    _CLIENT_CACHE.set(_discoveryCacheKey(destination, category, filters.radiusKm, page), { data, at: Date.now() });
    // Signal search intent to Compass so category_weights reflect browsing.
    // Only fires when the caller opts in (emitSignal=true) AND this is page 1
    // (explicit category selection, not pagination). Background callers such as
    // getDiscoveryCategoryCounts must NOT pass emitSignal=true — they enumerate
    // all categories and would corrupt personalization weights with non-intent traffic.
    // 'for_you' is a personalised feed, not a category intent — never signal.
    if (emitSignal && page === 1 && category !== 'for_you') {
      postSearchSignal(destination, { city: destination, category });
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

/**
 * Fetch total result counts for every countable Discovery category in parallel.
 * Uses broad defaults (radius 25 km, no open-now, no min-rating) so the counts
 * reflect the full set of available places for the destination.
 * Skips `for_you` — the personalised feed has no stable total count.
 * Individual failures are silently dropped; only successful responses contribute
 * to the returned map.
 */
const COUNTABLE_CATEGORIES: DiscoveryCategory[] = [
  'places', 'food', 'nightlife', 'activities', 'events', 'beaches', 'transport',
];
/** Matches the default filters in DiscoveryCategoryTab so initial counts align with tab content. */
const DEFAULT_COUNT_FILTERS: DiscoveryFilters = { radiusKm: 10, openNow: false, minRating: null };

export async function getDiscoveryCategoryCounts(
  destination: string,
  filters: DiscoveryFilters = DEFAULT_COUNT_FILTERS,
  contextMode?: DiscoveryContextMode | null,
  ageFilter?: DiscoveryAgeFilter | null,
  customMinAge?: number | null,
  customMaxAge?: number | null,
): Promise<Partial<Record<DiscoveryCategory, number>>> {
  const results = await Promise.allSettled(
    COUNTABLE_CATEGORIES.map((cat) =>
      getDiscoveryPlaces(destination, cat, filters, 1, contextMode, ageFilter, customMinAge, customMaxAge),
    ),
  );
  const counts: Partial<Record<DiscoveryCategory, number>> = {};
  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.ok) {
      counts[COUNTABLE_CATEGORIES[i]] = result.value.data.total;
    }
  });
  return counts;
}

/**
 * Batch counts endpoint — fetches all 7 category counts in ONE HTTP request.
 *
 * The server geocodes the destination once (with its own dedup cache) and fans
 * out to all categories server-side, returning `{ counts: Record<cat, N> }`.
 * Use this as the default; fall back to `getDiscoveryCategoryCounts` only when
 * age-filter or other per-request personalisation is needed.
 */
export async function getDiscoveryCategoryCountsBatch(
  destination: string,
  radiusKm = 10,
  lat?: number | null,
  lng?: number | null,
): Promise<Partial<Record<DiscoveryCategory, number>>> {
  const base = apiBase();
  if (!base) return {};
  const params = new URLSearchParams({ destination, radiusKm: String(radiusKm) });
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  try {
    const res = await fetch(`${base}/api/discovery/counts?${params}`);
    if (!res.ok) return {};
    const body = (await res.json()) as { counts?: Record<string, number> };
    return (body.counts ?? {}) as Partial<Record<DiscoveryCategory, number>>;
  } catch {
    return {};
  }
}

// ── Unified discovery feed (serve point 7) ─────────────────────────────────────
//
// GET /api/discovery/feed — the server-side "unified feed" that merges OSM +
// discovery_places rows with the viewer's "Live from events" posts and returns
// one envelope. Unlike getDiscoveryPlaces (GET /discovery) this call is SENT
// WITH the auth token: the endpoint only resolves a viewer, fetches event posts,
// and writes its serve-point-7 rank_events impressions when a Bearer token is
// present (discovery.ts). It returns `sessionId` — the served rank context a
// caller threads back on POST /rank-events/outcome so a 'discovery' outcome
// upgrades the exact impression this load wrote.

export interface DiscoveryFeedResult {
  places: DiscoveryPlace[];
  posts: DiscoveryEventPost[];
  nextCursor: string | null;
  total: number;
  destination: string | null;
  sourceSummary: { seededDbCount: number; osmCount: number; userCreatedCount: number };
  /** Per-load session id from the server; thread it into rank-outcome reporting. */
  sessionId: string | null;
}

export interface DiscoveryFeedOptions {
  destination?: string | null;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number;
  /** Categories to fan out across; defaults to the server's for_you feed. */
  categories?: string[];
  limit?: number;
  cursor?: string | null;
  /** Set false to fetch only the event-posts side of the feed (no places). */
  includePlaces?: boolean;
  /** Set false to skip the events section. */
  includeEvents?: boolean;
}

export async function getDiscoveryFeed(
  opts: DiscoveryFeedOptions,
): Promise<{ ok: true; data: DiscoveryFeedResult } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const { destination, lat, lng, radiusKm, categories, limit, cursor, includePlaces, includeEvents } = opts;
  if (!destination && (lat == null || lng == null)) {
    return { ok: false, error: 'city or lat+lng is required' };
  }

  const params = new URLSearchParams();
  if (destination) params.set('city', destination);
  if (lat != null) params.set('lat', String(lat));
  if (lng != null) params.set('lng', String(lng));
  if (radiusKm != null) params.set('radiusKm', String(radiusKm));
  if (categories && categories.length > 0) params.set('categories', categories.join(','));
  if (limit != null) params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);
  if (includePlaces === false) params.set('includePlaces', '0');
  if (includeEvents === false) params.set('includeEvents', '0');

  // The token is optional server-side, but event posts and the serve-point-7
  // impression only exist when a viewer resolves — so send it whenever signed in.
  const token = await freshToken();

  try {
    const res = await fetch(`${base}/api/discovery/feed?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as Partial<DiscoveryFeedResult>;
    return {
      ok: true,
      data: {
        places:        Array.isArray(body.places) ? body.places : [],
        posts:         Array.isArray(body.posts) ? body.posts : [],
        nextCursor:    body.nextCursor ?? null,
        total:         typeof body.total === 'number' ? body.total : 0,
        destination:   body.destination ?? destination ?? null,
        sourceSummary: body.sourceSummary ?? { seededDbCount: 0, osmCount: 0, userCreatedCount: 0 },
        sessionId:     body.sessionId ?? null,
      },
    };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

// ── "Already know it" discovery feedback ────────────────────────────────────────
//
// POST /api/discovery/already-known — records an already_known memory-feedback
// signal for a Discovery-served place (the backend bridges the served id to the
// canonical discovery_places.id and dedupes). Ownership is enforced server-side
// from the auth token. Idempotent; a 201 or a repeat both count as recorded.

export async function recordAlreadyKnown(
  placeId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };
  if (!placeId) return { ok: false, error: 'placeId is required' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  try {
    const res = await fetch(`${base}/api/discovery/already-known`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ placeId }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

// ── Compass search-signal helper ──────────────────────────────────────────────
//
// Fire-and-forget: posts the search intent to the Compass signal endpoint so
// category_weights in compass_user_preferences are nudged for the For You feed.
// Never throws, never delays the search response.

export function postSearchSignal(
  query: string,
  opts?: { city?: string | null; category?: string | null },
): void {
  const base = apiBase();
  if (!base) return;
  freshToken()
    .then((token) => {
      if (!token) return;
      return fetch(`${base}/api/compass/signals/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          query,
          city: opts?.city ?? null,
          category: opts?.category ?? null,
        }),
      });
    })
    .catch(() => {
      // best-effort — signal failures must never surface to the user
    });
}

// ── Unified search ────────────────────────────────────────────────────────────

export interface UnifiedSearchResult {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  avatarUrl: string | null;
  imageUrl: string | null;
  fallbackInitials: string | null;
  locationPreview: string | null;
  matchedReason: string | null;
  actionState: Record<string, boolean | string | number> | null;
  privacyState: { isPrivate?: boolean; isPublic?: boolean } | null;
  accessState: { canAccess: boolean } | null;
  destinationRoute: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  startsAt: string | null;
  /** True when this result's subject holds a verified traveler status. */
  verified?: boolean;
}

export interface UnifiedSearchResponse {
  results: UnifiedSearchResult[];
  nextCursor: string | null;
  hasMore: boolean;
  query: string;
  type: string;
  timeLabel: string | null;
}

/**
 * Search across all content types via /api/discovery/search.
 * Requires authentication — returns `{ ok: false }` when not signed in.
 * Pass `cursor` from the previous response to load the next page.
 *
 * @param opts.lat  User latitude (only when location permission already granted)
 * @param opts.lng  User longitude (only when location permission already granted)
 * @param opts.tz   IANA timezone string for time-intent parsing ("tonight" etc.)
 */
export async function searchUnified(
  query: string,
  type = 'all',
  cursor?: string | null,
  opts?: {
    lat?: number;
    lng?: number;
    tz?: string;
    city?: string;
    /** Intent params forwarded from parseSearchIntent() — sent as URL query params */
    intentParams?: Record<string, string>;
  },
): Promise<{ ok: true; data: UnifiedSearchResponse } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const token = await freshToken();
  if (!token) return { ok: false, error: 'Not signed in' };

  const params = new URLSearchParams({ q: query, type });
  if (cursor)        params.set('cursor', cursor);
  if (opts?.lat != null) params.set('lat',  String(opts.lat));
  if (opts?.lng != null) params.set('lng',  String(opts.lng));
  if (opts?.tz)          params.set('tz',   opts.tz);
  if (opts?.city)        params.set('city', opts.city);
  if (opts?.intentParams) {
    for (const [k, v] of Object.entries(opts.intentParams)) {
      if (v) params.set(k, v);
    }
  }

  try {
    const res = await fetch(`${base}/api/discovery/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: (body.message as string) ?? `HTTP ${res.status}` };
    }
    const data = (await res.json()) as UnifiedSearchResponse;
    // Signal search intent to Compass for For You feed personalisation.
    postSearchSignal(query, { city: opts?.city ?? null });
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
  }
}

// ── Live search suggestions (typeahead) ────────────────────────────────────────

export interface SuggestGroup {
  type: string;
  label: string;
  items: UnifiedSearchResult[];
}

/**
 * Grouped typeahead suggestions for the global search bar.
 * Lighter than searchUnified — small per-type limits, single round trip,
 * same backend privacy filtering. Supports AbortSignal so the caller can
 * cancel superseded keystrokes.
 */
export async function getSearchSuggestions(
  query: string,
  opts?: { lat?: number; lng?: number; city?: string },
  signal?: AbortSignal,
): Promise<{ ok: true; groups: SuggestGroup[] } | { ok: false; aborted: boolean; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, aborted: false, error: 'API not configured' };
  const token = await freshToken();
  if (!token) return { ok: false, aborted: false, error: 'Not signed in' };

  const params = new URLSearchParams({ q: query });
  if (opts?.lat != null) params.set('lat', String(opts.lat));
  if (opts?.lng != null) params.set('lng', String(opts.lng));
  if (opts?.city) params.set('city', opts.city);

  try {
    const res = await fetch(`${base}/api/discovery/suggest?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) return { ok: false, aborted: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { groups?: SuggestGroup[] };
    return { ok: true, groups: Array.isArray(data.groups) ? data.groups : [] };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, aborted, error: 'Network error' };
  }
}

// ── Search history ─────────────────────────────────────────────────────────────

export interface SearchHistoryEntry {
  id: string;
  query: string;
  search_type: string;
  searched_at: string;
}

/**
 * Fetch the current user's recent search history (up to `limit` entries).
 * Returns an empty array on any error — fail-open so network hiccups don't break the UI.
 */
export async function getSearchHistory(limit = 20): Promise<SearchHistoryEntry[]> {
  const base = apiBase();
  if (!base) return [];
  const token = await freshToken();
  if (!token) return [];
  try {
    const res = await fetch(`${base}/api/me/search-history?limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { history?: SearchHistoryEntry[] };
    return Array.isArray(data.history) ? data.history : [];
  } catch {
    return [];
  }
}

/**
 * Save a search term to the user's history.
 * Returns the server-assigned UUID for the saved row so the UI can
 * replace its optimistic synthetic id before allowing per-item delete.
 * Returns null on error (save is non-fatal; deletion will fall back to ?q=).
 */
export async function saveSearchHistory(query: string, searchType = 'all'): Promise<string | null> {
  const base = apiBase();
  if (!base) return null;
  const token = await freshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${base}/api/me/search-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, search_type: searchType }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { ok: boolean; id?: string | null };
    return json.id ?? null;
  } catch {
    return null;
  }
}

// ── Wikidata enrichment ───────────────────────────────────────────────────────

export interface WikidataEnrichment {
  /** English short description from Wikidata. */
  description: string | null;
  /** English Wikipedia article URL, when available. */
  wikipediaUrl: string | null;
  /** Wikimedia Commons image URL (via Special:FilePath), when available. */
  commonsImageUrl: string | null;
}

/**
 * Fetch structured enrichment for a Wikidata entity (Qnnn).
 * No auth required. Returns null on any network/parse failure.
 */
export async function getWikidataEnrichment(wikidataId: string): Promise<WikidataEnrichment | null> {
  const base = apiBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/discovery/wikidata/${encodeURIComponent(wikidataId)}`);
    if (!res.ok) return null;
    return (await res.json()) as WikidataEnrichment;
  } catch {
    return null;
  }
}

/**
 * Clear the current user's search history.
 * Pass `id` (UUID) to remove a single entry by its row id; omit to clear all.
 */
export async function clearSearchHistory(id?: string): Promise<void> {
  const base = apiBase();
  if (!base) return;
  const token = await freshToken();
  if (!token) return;
  try {
    const url = id
      ? `${base}/api/me/search-history?id=${encodeURIComponent(id)}`
      : `${base}/api/me/search-history`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // non-fatal
  }
}
