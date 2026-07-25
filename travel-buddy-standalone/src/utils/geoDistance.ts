/**
 * Shared geographic distance utilities.
 *
 * Keep the Haversine formula in one place so every location-aware screen
 * uses an identical implementation and the maths stay testable in isolation.
 */

/** Returns the great-circle distance in kilometres between two WGS-84 points. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
    Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns a human-readable travel-time label for a given distance.
 *
 * < 2 km  → walking only (~5 km/h)
 * 2–6 km  → walking + driving (~30 km/h city)
 * > 6 km  → driving only
 */
export function travelTimeLabel(distKm: number): string {
  if (distKm < 2) {
    const walkMin = Math.max(1, Math.round(distKm * 12)); // ~5 km/h
    return `${walkMin} min walk`;
  }
  if (distKm < 6) {
    const walkMin = Math.round(distKm * 12);
    const driveMin = Math.max(1, Math.round(distKm * 2)); // ~30 km/h city
    return `${walkMin} min walk · ${driveMin} min drive`;
  }
  const driveMin = Math.max(1, Math.round(distKm * 2));
  return `~${driveMin} min drive`;
}
