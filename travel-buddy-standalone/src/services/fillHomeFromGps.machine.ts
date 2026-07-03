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

/** Callbacks surfaced to the caller when the GPS permission alert fires. */
export interface PermissionDeniedOpts {
  /** Open the OS location-settings screen. */
  onOpenSettings(): void;
  /** Fall back to the manual city picker. */
  onPickFromList(): void;
}

export interface FillHomeDeps {
  getCurrentGps(): Promise<GpsFillResult>;
  reverseGeocodeDetailed(lat: number, lng: number): Promise<PlaceFillResult>;
  /** Called instead of Alert.alert so the caller decides how to present the denial prompt. */
  onPermissionDenied(opts: PermissionDeniedOpts): void;
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
 * 2. Requests GPS. If denied, calls onPermissionDenied and returns.
 * 3. Reverse-geocodes the coordinates.
 * 4. Sets homeCity if a city was found; sets homeCountry if a country was found.
 * 5. Clears loading in the finally block (always runs, even on error).
 *
 * Errors from geocoding are swallowed — the user can still type or pick from
 * the list manually.
 */
export async function runFillHomeFromGps(
  deps: FillHomeDeps,
  setters: FillHomeSetters,
): Promise<void> {
  setters.setGpsLoading(true);
  try {
    const gps = await deps.getCurrentGps();
    if (!gps.granted) {
      deps.onPermissionDenied({
        onOpenSettings: () => {},
        onPickFromList: () => {},
      });
      return;
    }
    if (gps.lat == null || gps.lng == null) return;
    const place = await deps.reverseGeocodeDetailed(gps.lat, gps.lng);
    if (place.city) setters.setHomeCity(place.city);
    if (place.country) setters.setHomeCountry(place.country);
  } catch {
    // silent — user can still type or choose from list
  } finally {
    setters.setGpsLoading(false);
  }
}
