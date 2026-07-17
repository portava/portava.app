/**
 * GpsLocationCapture — pure state-machine logic.
 *
 * Extracted so the async capture flow and form-coordinate mapping can be
 * exercised with node:test or jest without mounting a React Native component
 * and without importing expo-location directly.
 *
 * The component (`GpsLocationCapture.tsx`) receives these functions as
 * injectable deps and delegates all state-transition decisions here.
 *
 * ## State-transition contract (tested in location.gps.component.test.ts)
 *
 *   getCurrentGps() → { granted: false, error: 'permission_denied' }
 *     → CaptureOutcome { nextState: 'denied' }
 *
 *   getCurrentGps() → { granted: false, error: 'gps_failed' }
 *     → CaptureOutcome { nextState: 'error' }
 *
 *   getCurrentGps() → { granted: true, lat: null }
 *     → CaptureOutcome { nextState: 'error' }
 *
 *   getCurrentGps() → { granted: true, lat: number, lng: number }
 *     + reverseGeocode or API fetch succeeds
 *     → CaptureOutcome { nextState: 'success', result: { lat, lng, label } }
 *
 * ## Retry contract
 *
 *   Retry is modelled as a second invocation of runGpsCapture(). If the
 *   first call returned { nextState: 'error' } and a second call is made
 *   (user taps "Try again"), the outcome is determined by the fresh
 *   getCurrentGps() result — the machine is stateless.
 *
 * ## Form-coordinate contract (tested in location.gps.component.test.ts)
 *
 *   mapCaptureToFormCoords(result)  — always produces number | undefined,
 *   never string, never null, matching the FormState type in submit.tsx.
 */

// ── Shared types ───────────────────────────────────────────────────────────────

/** Coordinates + display label returned on a successful GPS capture. */
export interface GpsCaptureResult {
  lat: number;
  lng: number;
  label: string;
}

/** Discriminated union of possible outcomes from runGpsCapture(). */
export type CaptureOutcome =
  | { nextState: 'denied' }
  | { nextState: 'error' }
  | { nextState: 'success'; result: GpsCaptureResult };

// ── Dependency shapes (no expo/RN imports) ─────────────────────────────────────

export interface GpsResultShape {
  granted: boolean;
  lat: number | null;
  lng: number | null;
  error?: string;
}

export interface PlaceResultShape {
  city: string | null;
  district?: string | null;
  country: string | null;
}

export interface FetchLike {
  (url: string): Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

// ── runGpsCapture ──────────────────────────────────────────────────────────────

/**
 * Pure async state-transition function.
 *
 * Calls getCurrentGps() and routes to the correct outcome based on the
 * permission/fix result. On success, attempts reverse geocoding via the
 * backend API first (passed as fetchFn) then falls back to the expo geocoder
 * (reverseGeocodeDetailed) so the label is always a human-readable string.
 *
 * Usage in GpsLocationCapture.tsx:
 *   const outcome = await runGpsCapture({
 *     getCurrentGps,
 *     reverseGeocodeDetailed,
 *     apiBase: API_BASE,
 *   });
 *   if (outcome.nextState === 'success') { ... }
 */
export async function runGpsCapture(opts: {
  getCurrentGps: () => Promise<GpsResultShape>;
  reverseGeocodeDetailed: (lat: number, lng: number) => Promise<PlaceResultShape>;
  apiBase: string;
  fetchFn?: FetchLike;
}): Promise<CaptureOutcome> {
  const {
    getCurrentGps,
    reverseGeocodeDetailed,
    apiBase,
    fetchFn = fetch as unknown as FetchLike,
  } = opts;

  const gps = await getCurrentGps();

  if (!gps.granted) {
    return { nextState: gps.error === 'permission_denied' ? 'denied' : 'error' };
  }

  if (gps.lat === null || gps.lng === null) {
    return { nextState: 'error' };
  }

  const lat = gps.lat;
  const lng = gps.lng;

  let resolvedLabel: string | null = null;

  try {
    const res = await fetchFn(`${apiBase}/api/places/reverse?lat=${lat}&lng=${lng}`);
    if (res.ok) {
      const body = await res.json() as any;
      const p = body?.place;
      if (p) {
        const city = p.city ?? p.displayName ?? null;
        const country = p.country ?? null;
        resolvedLabel = [city, country].filter(Boolean).join(', ') || null;
      }
    }
  } catch {
    // Backend call failed — fall through to expo geocoder.
  }

  if (!resolvedLabel) {
    const place = await reverseGeocodeDetailed(lat, lng);
    const city = place.city ?? place.district ?? null;
    const country = place.country ?? null;
    resolvedLabel = [city, country].filter(Boolean).join(', ') || null;
  }

  const finalLabel = resolvedLabel ?? 'Location detected';
  return { nextState: 'success', result: { lat, lng, label: finalLabel } };
}

// ── mapCaptureToFormCoords ─────────────────────────────────────────────────────

/**
 * Maps an onCapture result to the GPS fields in FormState (gems/submit.tsx).
 *
 * Guarantees coordinates are always `number | undefined` — never string,
 * never null — matching the FormState type.
 *
 * Usage in gems/submit.tsx LocationStep.handleCapture:
 *   const { gpsLat, gpsLng, gpsLabel } = mapCaptureToFormCoords(result);
 *   update('gpsLat', gpsLat);
 *   update('gpsLng', gpsLng);
 *   update('gpsLabel', gpsLabel);
 */
export function mapCaptureToFormCoords(result: GpsCaptureResult | null): {
  gpsLat: number | undefined;
  gpsLng: number | undefined;
  gpsLabel: string | undefined;
} {
  return {
    gpsLat:   result != null ? result.lat   : undefined,
    gpsLng:   result != null ? result.lng   : undefined,
    gpsLabel: result != null ? result.label : undefined,
  };
}

// ── Place-based capture flow (universal location system) ──────────────────────

import type { Place } from '../../lib/location/placeTypes.ts';

/** Discriminated union of outcomes from runPlaceCapture(). */
export type PlaceCaptureOutcome =
  | { nextState: 'denied' }
  | { nextState: 'error' }
  | { nextState: 'success'; place: Place };

/**
 * Pure async flow behind GpsLocationCapture's capture() handler.
 *
 * Mirrors the component contract exactly:
 *   - permission denied            → { nextState: 'denied' }, onCapture NOT called
 *   - GPS failed / null coords     → { nextState: 'error' },  onCapture NOT called
 *   - reverseGeocodeToPlace throws → { nextState: 'error' },  onCapture NOT called
 *   - success                      → { nextState: 'success', place }, onCapture(place)
 *
 * onCapture is only ever invoked with a full Place (never null/partial) —
 * tested in src/components/location/__tests__/locationCaptureFlow.test.ts.
 */
export async function runPlaceCapture(opts: {
  getCurrentGps: () => Promise<GpsResultShape>;
  reverseGeocodeToPlace: (lat: number, lng: number) => Promise<Place>;
  onCapture: (place: Place) => void;
}): Promise<PlaceCaptureOutcome> {
  try {
    const gps = await opts.getCurrentGps();

    if (!gps.granted) {
      return { nextState: gps.error === 'permission_denied' ? 'denied' : 'error' };
    }
    if (gps.lat === null || gps.lng === null) {
      return { nextState: 'error' };
    }

    const place = await opts.reverseGeocodeToPlace(gps.lat, gps.lng);
    opts.onCapture(place);
    return { nextState: 'success', place };
  } catch {
    return { nextState: 'error' };
  }
}
