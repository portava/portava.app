/**
 * Discovery service — fetches place data from /api/discovery.
 * Destination-scoped, category-filtered, no auth required.
 */

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

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
  submittedBy: { id: string; name: string; avatarUrl: string | null } | null;
  savedCount: number;
  tag: string | null;
  note: string | null;
  rating: number | null;
  source: string;
  status: string;
  verified: boolean;
  createdAt: string;
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
): Promise<{ ok: true; data: CommunityDiscoveryResult } | { ok: false; error: string }> {
  const base = apiBase();
  if (!base) return { ok: false, error: 'API not configured' };

  const params = new URLSearchParams({ city, type, limit: String(limit) });

  try {
    const res = await fetch(`${base}/api/discovery/community?${params}`);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as CommunityDiscoveryResult;
    return { ok: true, data };
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
    ...(contextMode ? { context: contextMode } : {}),
    ...(ageFilter && ageFilter !== 'any' ? { ageFilter } : {}),
    ...(ageFilter === 'custom' && customMinAge != null ? { customMinAge: String(customMinAge) } : {}),
    ...(ageFilter === 'custom' && customMaxAge != null ? { customMaxAge: String(customMaxAge) } : {}),
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
