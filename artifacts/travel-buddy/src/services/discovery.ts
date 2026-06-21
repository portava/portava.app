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

export async function getDiscoveryPlaces(
  destination: string,
  category: DiscoveryCategory,
  filters: DiscoveryFilters,
  page = 1,
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
