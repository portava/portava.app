/**
 * Shared, platform-agnostic pieces of the Compass mini-map:
 * the pin point shape and the haversine distance helper used for
 * comparison-block distance deltas. Keeping these out of the .tsx files
 * means both the native and web siblings (and tests) import identical logic.
 */

export interface CompassMiniMapPoint {
  id: string;
  label: string;
  lat: number;
  lng: number;
}

/** Great-circle distance in kilometres (haversine). */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** "850 m" under 1 km, otherwise "1.2 km" (one decimal under 10, whole above). */
export function formatDistanceKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
