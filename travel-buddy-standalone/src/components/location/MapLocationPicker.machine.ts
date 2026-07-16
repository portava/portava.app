/**
 * MapLocationPicker — pure logic extracted from MapLocationPicker.tsx.
 *
 * Extracted so the coordinate-order swap, label fallback chain, and form-
 * coordinate round-trip can be exercised with Jest/node:test without mounting
 * a React Native component or importing @maplibre/maplibre-react-native.
 *
 * The component stores the map center in MapLibre's native [lng, lat] order.
 * `resolveMapPickerResult` accepts that `[lng, lat]` pair, swaps to
 * `{ lat, lng }`, runs the same reverse-geocode fallback chain used by
 * `runGpsCapture`, and returns a `GpsCaptureResult` that is ready to pass
 * directly to `mapCaptureToFormCoords`.
 *
 * ## Coordinate-order contract
 *
 *   centerRef.current = [lng, lat]   ← MapLibre [lng, lat] convention
 *   resolveMapPickerResult({ center: [lng, lat], … })
 *     → GpsCaptureResult { lat, lng, label }   ← correct { lat, lng } order
 *
 * ## Label fallback chain (tested in mapLocationPicker.test.ts)
 *
 *   1. API  /api/places/reverse?lat=…&lng=…  (fetchFn, ok response with place)
 *   2. expo reverseGeocodeDetailed(lat, lng)
 *   3. "Selected location"   (both sources unavailable or return nothing)
 *
 * ## Usage in MapLocationPicker.tsx handleConfirm
 *
 *   const result = await resolveMapPickerResult({
 *     center: centerRef.current,
 *     apiBase: API_BASE,
 *     reverseGeocodeDetailed,
 *   });
 *   onConfirm(result);
 */

import type { GpsCaptureResult, PlaceResultShape, FetchLike } from './GpsLocationCapture.machine.ts';

export type { GpsCaptureResult, PlaceResultShape, FetchLike };

// ── resolveMapPickerResult ─────────────────────────────────────────────────────

/**
 * Converts a MapLibre [lng, lat] center coordinate into a `GpsCaptureResult`
 * by swapping to { lat, lng } order and resolving a human-readable label via
 * the same two-stage reverse-geocode fallback used by `runGpsCapture`.
 *
 * Never throws — if both geocode paths fail the label falls back to
 * "Selected location".
 */
export async function resolveMapPickerResult(opts: {
  /** Map-center in MapLibre [lng, lat] order as stored in centerRef.current. */
  center: [number, number];
  apiBase: string;
  reverseGeocodeDetailed: (lat: number, lng: number) => Promise<PlaceResultShape>;
  fetchFn?: FetchLike;
}): Promise<GpsCaptureResult> {
  const {
    center,
    apiBase,
    reverseGeocodeDetailed,
    fetchFn = fetch as unknown as FetchLike,
  } = opts;

  // MapLibre stores coordinates as [lng, lat]; swap to { lat, lng }.
  const [lng, lat] = center;

  let label: string | null = null;

  // Stage 1: backend reverse-geocode API.
  try {
    const res = await fetchFn(`${apiBase}/api/places/reverse?lat=${lat}&lng=${lng}`);
    if (res.ok) {
      const body = await res.json() as any;
      const p = body?.place;
      if (p) {
        const city = p.city ?? p.displayName ?? null;
        const country = p.country ?? null;
        label = [city, country].filter(Boolean).join(', ') || null;
      }
    }
  } catch {
    // Backend call failed — fall through to expo geocoder.
  }

  // Stage 2: expo reverse geocoder.
  if (!label) {
    try {
      const place = await reverseGeocodeDetailed(lat, lng);
      const city = place.city ?? place.district ?? null;
      const country = place.country ?? null;
      label = [city, country].filter(Boolean).join(', ') || null;
    } catch {
      // Geocoder failed — fall through to static fallback.
    }
  }

  // Stage 3: static fallback.
  return { lat, lng, label: label ?? 'Selected location' };
}

// ── Place-based confirm flow (universal location system) ──────────────────────

import type { Place } from '../../lib/location/placeTypes.ts';

/**
 * Pure async flow behind MapLocationPicker's handleConfirm.
 *
 * Accepts the MapLibre [lng, lat] map-center, swaps to (lat, lng), reverse
 * geocodes to a canonical Place, and invokes onConfirm(place). Throws if the
 * geocode function throws (the component surfaces this as geocodeError) —
 * onConfirm is never called with a partial/undefined place.
 *
 * Tested in src/components/location/__tests__/locationCaptureFlow.test.ts.
 */
export async function confirmMapCenterAsPlace(opts: {
  /** Map-center in MapLibre [lng, lat] order as stored in centerRef.current. */
  center: [number, number];
  reverseGeocodeToPlace: (lat: number, lng: number) => Promise<Place>;
  onConfirm: (place: Place) => void;
}): Promise<Place> {
  // MapLibre stores coordinates as [lng, lat]; swap to { lat, lng }.
  const [lng, lat] = opts.center;
  const place = await opts.reverseGeocodeToPlace(lat, lng);
  opts.onConfirm(place);
  return place;
}
