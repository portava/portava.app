/**
 * placeLiveAnchor — the identity anchor the live open-now lookup carries.
 *
 * Lead ruling D-67 (2026-10-06): a place may be labelled "verified live" only
 * when the provider record is confirmed to BE that place — names equal after
 * normalisation AND the record within 150 m of the place's own coordinates.
 * The server decides that (`artifacts/api-server/src/lib/liveIntelligence.ts`);
 * the client's only job is to send the place's own coordinates with its name,
 * and to key its cache on them so two same-named places never share an entry.
 *
 * Kept out of `services/discovery.ts` on purpose: list cards import it beside
 * that service, and component tests mock the service exhaustively, so a pure
 * helper living there would vanish under every one of those mocks.
 */

/** The place's own stored coordinates, as a card or sheet holds them. */
export interface PlaceLiveAnchor {
  lat: number | null | undefined;
  lng: number | null | undefined;
}

/** Both coordinates as finite, in-range numbers — or null (nothing to anchor on). */
export function placeLiveAnchorOf(anchor: PlaceLiveAnchor | null | undefined): { lat: number; lng: number } | null {
  const lat = anchor?.lat;
  const lng = anchor?.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}
