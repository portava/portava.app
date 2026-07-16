/**
 * Extracted GPS → city fill logic for the identity edit screen.
 *
 * Kept in its own module so the error-handling path (GPS or geocode failure
 * → city-picker alert) can be unit-tested without mounting React components
 * or loading any native modules.
 *
 * Used by app/profile/edit/identity.tsx for both the home-city and the
 * current-city GPS buttons.
 *
 * Run tests with:
 *   node --import tsx/esm --test src/services/__tests__/passportSettings.gpsError.test.ts
 */

export interface IdentityGpsFillDeps {
  getCurrentGps(): Promise<{ granted: boolean; lat: number | null; lng: number | null }>;
  reverseGeocode(lat: number, lng: number): Promise<{ city?: string | null; country?: string | null }>;
  /**
   * Called when the user has denied location permission. The caller wires
   * this to an Alert that offers "Open Settings", "Choose from list", and "Cancel".
   */
  onPermissionDenied(): void;
  /**
   * Called when GPS acquisition or reverse-geocoding throws an unexpected
   * error. The caller must show an alert with a "Choose from list" button so
   * the user can fall back to the city picker.
   */
  onGpsOrGeocodeFailed(): void;
  /** Called with the resolved city/country values on success. */
  onSuccess(city: string | null, country: string | null): void;
  setLoading(loading: boolean): void;
}

/**
 * Core GPS → city fill logic for the identity edit screen.
 *
 * 1. Sets loading = true.
 * 2. Requests GPS; if denied, calls onPermissionDenied and returns.
 * 3. If coordinates are null, returns silently.
 * 4. Reverse-geocodes the coordinates.
 * 5. Calls onSuccess with the resolved city and country.
 * 6. On any unexpected error, calls onGpsOrGeocodeFailed so the caller can
 *    surface a "Choose from list" prompt to the user.
 * 7. Always clears loading in the finally block.
 */
export async function runIdentityGpsFill(deps: IdentityGpsFillDeps): Promise<void> {
  deps.setLoading(true);
  try {
    const gps = await deps.getCurrentGps();
    if (!gps.granted) {
      deps.onPermissionDenied();
      return;
    }
    if (gps.lat == null || gps.lng == null) return;
    const place = await deps.reverseGeocode(gps.lat, gps.lng);
    deps.onSuccess(place.city ?? null, place.country ?? null);
  } catch {
    // Any unexpected error (hardware fault, network failure, geocode rejection)
    // surfaces to the caller so it can offer the city picker as a fallback.
    deps.onGpsOrGeocodeFailed();
  } finally {
    deps.setLoading(false);
  }
}
