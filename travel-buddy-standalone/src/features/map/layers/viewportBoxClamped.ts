/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW14): a map read whose viewport box was cut to fit.
 *
 * `bboxFromCenter` (services/mapProjection.ts) builds the box the NOW map, the Time Machine and the media map ask the
 * gateway for: lat ± r/111 and lng ± r/(111·max(0.2, cos lat)), clamped to ±89.9° and ±179.9°. The gateway takes one
 * box that cannot cross the antimeridian ("a slightly-clipped viewport"), and above ~78.5° the 0.2 floor narrows the
 * longitudes below what the camera shows — so near the line or a pole the answer covers only part of the area asked
 * about, and no layer said so. This mirrors `bboxFromCenter`'s arithmetic: true exactly when it cut the box, and the
 * caller then says the map is not whole (the NOW map's `truncated`, the Time Machine's `pageCut`, the media map's
 * `partial`).
 */
export function viewportBoxClamped(lat: number, lng: number, radiusKm: number): boolean {
  const latDelta = radiusKm / 111;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusKm / (111 * Math.max(0.2, cos));
  return cos < 0.2 || lat - latDelta < -89.9 || lat + latDelta > 89.9 || lng - lngDelta < -179.9 || lng + lngDelta > 179.9;
}
