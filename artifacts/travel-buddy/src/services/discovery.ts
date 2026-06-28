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
    ...(lat != null ? { lat: String(lat) } : {}),
    ...(lng != null ? { lng: String(lng) } : {}),
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
