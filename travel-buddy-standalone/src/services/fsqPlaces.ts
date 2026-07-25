/**
 * fsqPlaces.ts — client for the FSQ provider POI layer (hotels + nightlife/food).
 * Fail-soft: null when the API is unconfigured or the feature flag is off / a
 * city hasn't been ingested, so surfaces simply omit the section.
 *
 * ATTRIBUTION: the FSQ license requires "Powered by Foursquare" to be shown on
 * any surface that displays these places — the response carries `attribution`;
 * always render it.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authedFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const token = await freshApiToken();
  return fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
}

export type FsqCategory = 'accommodation' | 'nightlife' | 'food' | 'culture' | 'shopping' | 'other';

export interface FsqPlace {
  fsqId: string;
  name: string;
  latitude: number;
  longitude: number;
  category: FsqCategory;
  label: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  confidence: string;
  datasetDate: string | null;
  // Contact
  phone: string | null;
  website: string | null;
  // Ratings & pricing
  rating: number | null;
  reviewCount: number | null;
  /** Numeric FSQ price tier (1=cheap … 4=expensive). */
  fsqPrice: number | null;
  // Media
  photoUrl: string | null;
  galleryImages: string[];
  // Hours
  isOpenNow: boolean | null;
  // Amenities
  amenities: string[];
}

export interface FsqPlacesResult {
  places: FsqPlace[];
  attribution: string;   // "Powered by Foursquare" — MUST be displayed
  datasetDate: string | null;
}

/**
 * Places for a city (ingestion slug, e.g. 'cebu-ph'), optionally by category.
 * Null when the feature is unavailable or no city data exists.
 */
export async function getCityPlaces(
  cityKey: string,
  category?: FsqCategory,
): Promise<FsqPlacesResult | null> {
  if (!isSupabaseConfigured || !apiBase() || !cityKey) return null;
  try {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await authedFetch(`${apiBase()}/api/cities/${encodeURIComponent(cityKey)}/places${qs}`);
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.enabled === false) return null;
    return {
      places: Array.isArray(body?.places) ? (body.places as FsqPlace[]) : [],
      attribution: String(body?.attribution ?? 'Powered by Foursquare'),
      datasetDate: body?.datasetDate ?? null,
    };
  } catch {
    return null;
  }
}
