/**
 * activeLocation.homeProfile.ts
 *
 * Tier-3 location fallback: load the user's home city from their profile.
 *
 * Kept in a separate file so the pure async helper can be exercised in
 * node:test without pulling in React Native through useActiveLocation.ts.
 */
import type { Place } from '../lib/location/placeTypes.ts';
import type { ActiveLocationState, PermissionStatus } from './useActiveLocation.ts';

// ── Dependency injection surface (production defaults injected by callers) ──

export interface HomeProfileDeps {
  /** Override fetch (tests inject a fake; production omits this). */
  fetchFn?: typeof fetch;
  /** Whether Supabase is configured (production reads isSupabaseConfigured). */
  isConfigured?: boolean;
  /** Resolve the bearer token (production calls freshToken()). */
  getToken?: () => Promise<string | null>;
  /** Resolve the API base URL (production reads EXPO_PUBLIC_API_BASE_URL). */
  getBase?: () => Promise<string>;
}

const EMPTY_PLACE: Place = {
  id: '',
  type: 'city',
  name: '',
  displayName: '',
  country: null,
  countryCode: null,
  region: null,
  city: null,
  district: null,
  lat: null,
  lng: null,
  timezone: null,
  source: 'manual',
};

/**
 * _loadHomeFromProfile — testable core of the Tier-3 location cascade.
 *
 * Fetches `/api/me/profile` and, if the response contains a `homeCity`,
 * returns an `ActiveLocationState` with `source: 'home'`.  Returns null
 * when the profile is unreachable, the token is absent, or homeCity is
 * not set.
 */
export async function _loadHomeFromProfile(
  permissionStatus: PermissionStatus,
  deps: HomeProfileDeps = {},
): Promise<ActiveLocationState | null> {
  const {
    fetchFn = fetch,
    isConfigured = true,
    getToken,
    getBase,
  } = deps;

  if (!isConfigured) return null;

  try {
    const token = getToken ? await getToken() : null;
    if (!token) return null;

    const base = getBase ? await getBase() : '';

    const res = await fetchFn(`${base}/api/me/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;

    const profile = await res.json();
    const homeCity: string | null = profile.homeCity ?? null;
    if (!homeCity) return null;

    const place: Place = {
      ...EMPTY_PLACE,
      id: `home-${homeCity.toLowerCase().replace(/\s+/g, '-')}`,
      name: homeCity,
      displayName: profile.homeCountry ? `${homeCity}, ${profile.homeCountry}` : homeCity,
      country: profile.homeCountry ?? null,
      city: homeCity,
    };

    return {
      ok: true,
      permissionStatus,
      source: 'home',
      freshness: 'stale',
      coords: null,
      place,
      lastUpdatedAt: null,
      userMessage: null,
    };
  } catch {
    return null;
  }
}
