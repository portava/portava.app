/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; the round-18 verifier's B18 and sweep SW13): the query box around
 * a point and a radius, never narrower than the circle it prefilters.
 *
 * Five reads built the box as `lat ± r/111.32`, `lng ± r/(111.32·max(0.2, cos lat))`: it did not wrap at the 180th
 * meridian, its longitude half-width was clamped narrower than the circle above ~78.5°, and 111.32 km per degree is a
 * smaller degree than the 6371 km sphere the distance filters measure on. Rows inside the radius were dropped by the
 * query, and nothing said so. `nearBox` is the circle's exact extent on that sphere (padded by NEAR_BOX_PAD_DEG):
 * every longitude when the circle holds a pole, and two longitude ranges when it crosses the antimeridian.
 */

/** The sphere every near filter in this server measures distance on. */
export const NEAR_EARTH_KM = 6371;
/** Outward padding, so a row on the circle itself is never lost to rounding (≈ 0.1 m). */
export const NEAR_BOX_PAD_DEG = 1e-6;

export interface NearBox {
  south: number;
  north: number;
  /** The longitude ranges the circle covers, each `[west, east]` with west ≤ east in [-180, 180]; null = every longitude. */
  lngRanges: Array<[number, number]> | null;
}

export function nearBox(lat: number, lng: number, radiusKm: number): NearBox {
  const ang = radiusKm / NEAR_EARTH_KM;
  const dLat = (ang * 180) / Math.PI + NEAR_BOX_PAD_DEG;
  const south = lat - dLat;
  const north = lat + dLat;
  const phi = (Math.abs(lat) * Math.PI) / 180;
  if (phi + ang >= Math.PI / 2) return { south, north, lngRanges: null };
  const dLng = (Math.asin(Math.min(1, Math.sin(ang) / Math.cos(phi))) * 180) / Math.PI + NEAR_BOX_PAD_DEG;
  if (dLng >= 180) return { south, north, lngRanges: null };
  const west = lng - dLng;
  const east = lng + dLng;
  if (west < -180) return { south, north, lngRanges: [[west + 360, 180], [-180, east]] };
  if (east > 180) return { south, north, lngRanges: [[west, 180], [-180, east - 360]] };
  return { south, north, lngRanges: [[west, east]] };
}

/**
 * The box as PostgREST `and(...)` terms over one coordinate pair, for a caller that combines several in one `.or()`:
 * one term per longitude range (the latitude band alone when every longitude is covered).
 */
export function nearBoxTerms(box: NearBox, latCol: string, lngCol: string): string[] {
  const band = `${latCol}.gte.${box.south},${latCol}.lte.${box.north}`;
  if (!box.lngRanges) return [`and(${band})`];
  return box.lngRanges.map(([w, e]) => `and(${band},${lngCol}.gte.${w},${lngCol}.lte.${e})`);
}

/** The three filters the box needs, on any PostgREST-shaped builder. */
interface NearBoxFilterable {
  gte(column: string, value: number): NearBoxFilterable;
  lte(column: string, value: number): NearBoxFilterable;
  or(filters: string): NearBoxFilterable;
}

/**
 * Apply the box to a query: the latitude band, then the longitude range — or both ranges as one `.or()` across the
 * antimeridian, or none over a pole. The builder is returned as the type it was handed (each filter returns the builder).
 */
export function applyNearBox<Q>(query: Q, box: NearBox, latCol: string, lngCol: string): Q {
  const q = (query as unknown as NearBoxFilterable).gte(latCol, box.south).lte(latCol, box.north);
  if (!box.lngRanges) return q as unknown as Q;
  if (box.lngRanges.length === 1) return q.gte(lngCol, box.lngRanges[0]![0]).lte(lngCol, box.lngRanges[0]![1]) as unknown as Q;
  return q.or(box.lngRanges.map(([w, e]) => `and(${lngCol}.gte.${w},${lngCol}.lte.${e})`).join(",")) as unknown as Q;
}
