/**
 * fillHomeFromGps — pure, injectable state machine for GPS → homeCity/homeCountry.
 *
 * Both onboarding.tsx and PassportSettingsSheet.tsx share this logic.
 * Extracted here so it can be unit-tested without mounting React components
 * or loading any native modules.
 *
 * The caller is responsible for wiring onPermissionDenied to the platform
 * Alert (e.g. Alert.alert(…)) and supplying the correct GPS / geocode deps.
 *
 * Run tests with:
 *   node --import tsx/esm --test src/services/__tests__/fillHomeFromGps.test.ts
 */

export interface GpsFillResult {
  granted: boolean;
  lat: number | null;
  lng: number | null;
}

export interface PlaceFillResult {
  city: string | null;
  country: string | null;
}

export interface FillHomeDeps {
  getCurrentGps(): Promise<GpsFillResult>;
  reverseGeocodeDetailed(lat: number, lng: number): Promise<PlaceFillResult>;
  /**
   * Called instead of Alert.alert so the caller decides how to present the
   * denial prompt. Takes no arguments — the caller is responsible for wiring
   * its own "Open Settings" and "Choose from list" handlers via closures.
   */
  onPermissionDenied(): void;
  /**
   * Called when GPS acquisition or reverse-geocoding throws an unexpected error
   * (not an internal loading-timeout). The caller should show an alert with a
   * "Choose from list" button so the user can fall back to the city picker.
   * Not called when the internal maxLoadingMs timeout fires — that is a silent
   * abort, not a user-visible failure.
   */
  onGpsOrGeocodeFailed?(): void;
  /**
   * Maximum milliseconds to wait for `getCurrentGps()` before aborting and
   * clearing the loading state. Prevents the spinner from staying stuck when
   * the OS permission dialog is force-closed or the component unmounts.
   * Default: 12_000 ms.
   */
  maxLoadingMs?: number;
}

export interface FillHomeSetters {
  setHomeCity(city: string): void;
  setHomeCountry(country: string): void;
  setGpsLoading(loading: boolean): void;
}

/**
 * Core GPS → home-city fill logic.
 *
 * 1. Sets loading = true.
 * 2. Races `getCurrentGps()` against a `maxLoadingMs` timeout (default 12 s).
 *    If the timeout fires first the error is swallowed and loading is cleared.
 * 3. If GPS is granted and coordinates are valid, reverse-geocodes them.
 * 4. Sets homeCity if a city was found; sets homeCountry if a country was found.
 * 5. Clears loading in the finally block (always runs, even on error/timeout).
 *
 * Errors from geocoding and GPS timeouts are swallowed — the user can still
 * type or pick from the list manually.
 */
export async function runFillHomeFromGps(
  deps: FillHomeDeps,
  setters: FillHomeSetters,
): Promise<void> {
  const timeoutMs = deps.maxLoadingMs ?? 12_000;
  setters.setGpsLoading(true);
  try {
    const gps = await Promise.race([
      deps.getCurrentGps(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('gps_timeout')), timeoutMs),
      ),
    ]);
    if (!gps.granted) {
      deps.onPermissionDenied();
      return;
    }
    if (gps.lat == null || gps.lng == null) return;
    const place = await deps.reverseGeocodeDetailed(gps.lat, gps.lng);
    if (place.city) setters.setHomeCity(place.city);
    if (place.country) setters.setHomeCountry(place.country);
  } catch (err) {
    // The internal maxLoadingMs timeout rejects with 'gps_timeout' — that is a
    // silent abort (no alert, user just moves on). Every other error (permission
    // system crash, geocode failure, network error) surfaces to the caller so it
    // can show a "Choose from list" prompt.
    const isInternalTimeout = err instanceof Error && err.message === 'gps_timeout';
    if (!isInternalTimeout) {
      deps.onGpsOrGeocodeFailed?.();
    }
  } finally {
    setters.setGpsLoading(false);
  }
}
