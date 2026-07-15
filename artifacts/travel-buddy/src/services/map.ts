/**
 * Map + location services.
 *
 * Location privacy reads/writes go through the API server
 * (GET/PATCH /api/me/location-preferences) because the `location_preferences`
 * table is managed server-side (migration 0032 renamed user_location_privacy
 * to location_preferences).
 *
 * map_pins and user_locations tables do not exist in the DB; those functions
 * have been removed pending proper migrations.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function authToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/* ---------- Location privacy ------------------------------------------------ */

export type LocationMode =
  | 'off'
  | 'city_only'
  | 'nearby'
  | 'live_during_activity'
  | 'trusted_circle_live';

export type LocationVisibility =
  | 'city_only'
  | 'neighborhood'
  | 'venue_tagged'
  | 'exact_hidden'
  | 'no_location';

export interface LocationPrivacy {
  locationMode: LocationMode;
  sharingPaused: boolean;
  pulseVisibility: LocationVisibility | null;
  discoveryVisibility: LocationVisibility | null;
  safeReturnEnabled: boolean;
  trustedCircleShare: boolean;
  hotelBlurEnabled: boolean;
}

const LOCATION_PRIVACY_FALLBACK: LocationPrivacy = {
  locationMode: 'city_only',
  sharingPaused: false,
  pulseVisibility: null,
  discoveryVisibility: null,
  safeReturnEnabled: true,
  trustedCircleShare: false,
  hotelBlurEnabled: true,
};

/** Loads the viewer's location-privacy settings from the API. */
export async function getMyLocationPrivacy(): Promise<LocationPrivacy> {
  if (!isSupabaseConfigured) return LOCATION_PRIVACY_FALLBACK;
  const token = await authToken();
  if (!token) return LOCATION_PRIVACY_FALLBACK;

  try {
    const res = await fetch(`${apiBase()}/api/me/location-preferences`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return LOCATION_PRIVACY_FALLBACK;
    const json = await res.json();
    return {
      locationMode:        json.locationMode        ?? LOCATION_PRIVACY_FALLBACK.locationMode,
      sharingPaused:       Boolean(json.sharingPaused),
      pulseVisibility:     json.pulseVisibility     ?? null,
      discoveryVisibility: json.discoveryVisibility ?? null,
      safeReturnEnabled:   json.safeReturnEnabled   !== false,
      trustedCircleShare:  Boolean(json.trustedCircleShare),
      hotelBlurEnabled:    json.hotelBlurEnabled    !== false,
    };
  } catch {
    return LOCATION_PRIVACY_FALLBACK;
  }
}

/** Partially updates the viewer's location-privacy settings via the API. */
export async function updateMyLocationPrivacy(
  patch: Partial<LocationPrivacy>,
): Promise<boolean> {
  if (!isSupabaseConfigured) return false;
  const token = await authToken();
  if (!token) return false;

  try {
    const res = await fetch(`${apiBase()}/api/me/location-preferences`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ---------- Nearby users --------------------------------------------------- */

export interface NearbyUser {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Profiles of other non-private users who have `current_city` matching the
 * given city string (case-insensitive). Excludes the requesting user and
 * private profiles. Returns up to 20 results; empty array on any error.
 */
export async function listNearbyUsers(city: string, excludeUserId: string): Promise<NearbyUser[]> {
  if (!isSupabaseConfigured || !city.trim()) return [];
  // Universal display-name rule: this is a direct-Supabase read, so other
  // users' opt-in flags aren't checkable here (RLS). Never select real names —
  // render @handle only.
  const { data, error } = await supabase
    .from('profiles')
    .select('id, handle, avatar_url')
    .ilike('current_city', city.trim())
    .eq('is_private', false)
    .neq('id', excludeUserId)
    .limit(20);
  if (error || !data) return [];
  return (data as any[]).map((r) => ({
    id: r.id as string,
    name: r.handle ? `@${r.handle as string}` : 'Traveler',
    avatarUrl: (r.avatar_url as string | null) ?? null,
  }));
}

/* ---------- Circle member locations ---------------------------------------- */

export interface CircleMemberLocation {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  country: string | null;
  updatedAt: string | null;
}

/**
 * Returns location data for the caller's trusted circle members who have not
 * opted out of circle sharing (schema default = true, so a missing prefs row
 * means consented). Reads are done server-side to bypass the user_location_state
 * RLS policy which restricts each user to their own row.
 * Returns an empty array on any error.
 */
export async function listVisibleCircleLocations(): Promise<CircleMemberLocation[]> {
  if (!isSupabaseConfigured) return [];
  const token = await authToken();
  if (!token) return [];

  try {
    const res = await fetch(`${apiBase()}/api/me/circle-locations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.locations) ? json.locations : [];
  } catch {
    return [];
  }
}
