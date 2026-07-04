/**
 * Discovery service — fetches place data from /api/discovery.
 * Destination-scoped, category-filtered, no auth required.
 */
import { supabase } from '../lib/supabase';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return session?.access_token ?? null;
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
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  distanceKm: number | null;
  lat: number | null;
  lng: number | null;
  tags: string[];
  address: string | null;
  website: string | null;
  phone: string | null;
  openingHours: string | null;
  rating: number | null;
  isOpenNow: boolean | null;
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
  opts?: { lat?: number; lng?: number; tz?: string; city?: string },
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

  try {
    const res = await fetch(`${base}/api/discovery/search?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { ok: false, error: (body.message as string) ?? `HTTP ${res.status}` };
    }
    const data = (await res.json()) as UnifiedSearchResponse;
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'Network error — check your connection' };
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
