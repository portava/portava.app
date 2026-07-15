/**
 * Pure async logic for loading and saving location-privacy preferences.
 *
 * Extracted from app/settings/location.tsx so it can be exercised in
 * node:test suites without React Native imports.
 *
 * Design notes:
 *  - loadLocationPrefs returns { ok: false } on any network or HTTP error so
 *    callers can show a visible error state instead of silently falling back to
 *    defaults.
 *  - saveLocationPrefs returns false on any failure so callers can roll back
 *    optimistic state and show feedback.
 */

export type LocationMode =
  | 'off'
  | 'city_only'
  | 'nearby'
  | 'live_during_activity'
  | 'trusted_circle_live';

export type VisibilityOption =
  | 'city_only'
  | 'neighborhood'
  | 'venue_tagged'
  | 'exact_hidden'
  | 'no_location';

export interface LocationPrefs {
  locationMode: LocationMode;
  sharingPaused: boolean;
  pulseVisibility: VisibilityOption | null;
  discoveryVisibility: VisibilityOption | null;
  safeReturnEnabled: boolean;
  trustedCircleShare: boolean;
  hotelBlurEnabled: boolean;
}

export type LoadResult =
  | { ok: true; data: LocationPrefs }
  | { ok: false; data: null };

function parsePrefs(json: Record<string, unknown>): LocationPrefs {
  return {
    locationMode:        (json.locationMode as LocationMode)        ?? 'city_only',
    sharingPaused:       Boolean(json.sharingPaused),
    pulseVisibility:     (json.pulseVisibility as VisibilityOption) ?? null,
    discoveryVisibility: (json.discoveryVisibility as VisibilityOption) ?? null,
    safeReturnEnabled:   json.safeReturnEnabled !== false,
    trustedCircleShare:  Boolean(json.trustedCircleShare),
    hotelBlurEnabled:    json.hotelBlurEnabled !== false,
  };
}

/**
 * Loads location-privacy preferences from the API.
 *
 * Returns `{ ok: false }` on any network error or non-2xx HTTP response so
 * the caller can surface an explicit error instead of silently using defaults.
 */
export async function loadLocationPrefs(
  apiBase: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoadResult> {
  try {
    const res = await fetchFn(`${apiBase}/api/me/location-preferences`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, data: null };
    const json = (await res.json()) as Record<string, unknown>;
    return { ok: true, data: parsePrefs(json) };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * Partially updates location-privacy preferences via the API.
 *
 * Returns `true` on success, `false` on any network error or non-2xx
 * response so callers can roll back optimistic state and show feedback.
 */
export async function saveLocationPrefs(
  apiBase: string,
  token: string,
  patch: Partial<LocationPrefs>,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`${apiBase}/api/me/location-preferences`, {
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
