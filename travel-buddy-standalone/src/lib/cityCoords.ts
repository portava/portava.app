/**
 * City-coordinate privacy helpers.
 *
 * City-level coordinates (from place-picker results) are used only for
 * proximity ranking on the server — they are never exact GPS positions.
 *
 * Privacy contract:
 *  - Both-or-null: if either coordinate is absent, neither is sent to the API.
 *    A half-pair (lat without lng or vice versa) must never reach the server.
 *  - The API fields use exactly the keys `lat` / `lng`.
 *  - Values are forwarded unchanged — place-picker results are already
 *    city-centre level and the server owns any further precision decisions.
 */

/**
 * Return a well-typed `{ lat, lng }` pair from a place-picker result,
 * or `null` when either coordinate is missing.
 *
 * Use this wherever a screen captures city coords from a place picker and
 * needs to store them in local state or forward them to a search payload.
 */
export function buildCityCoords(
  lat: number | null | undefined,
  lng: number | null | undefined,
): { lat: number; lng: number } | null {
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

/**
 * Spread helper for `searchBuddies` / `createRequest` payloads.
 * Returns `{ lat, lng }` when both are present, or `{}` otherwise.
 *
 * Guarantees the both-or-null contract at the call site:
 *   `{ city, ...cityCoordSpread(cityLat, cityLng), ... }`
 */
export function cityCoordSpread(
  lat: number | null | undefined,
  lng: number | null | undefined,
): { lat: number; lng: number } | Record<never, never> {
  const c = buildCityCoords(lat, lng);
  return c ?? {};
}
