/**
 * spatialBucket — the ON-DEVICE spatial reduction. §4.1's first normalised
 * feature ("spatial bucket / canonical-place candidate") and the whole of the
 * privacy claim in §3 ("Raw precise location should be reduced on-device or
 * inside a narrow trusted boundary as early as practical").
 *
 * ── WHY THIS FILE IS THE BOUNDARY ────────────────────────────────────────────
 * Everything upstream of it holds a coordinate; nothing downstream of it does.
 * `encodeSpatialBucket` is the ONLY function in the sensing path that takes a
 * latitude and a longitude, and it returns a string. A reviewer checking
 * "no coordinate leaves the handset" (census S21) has exactly one function to
 * read, and `contributionPayload.ts` proves the property for the payload as a
 * whole.
 *
 * ── WHY A GEOHASH, AND WHY TRUNCATED ─────────────────────────────────────────
 * The server's anonymous store (artifacts/api-server/src/lib/sensingAnonStore.ts)
 * takes a `zone_id` that is "a coarse zone label. Never a coordinate", and
 * `sensingContributionPolicy.admitSensingContribution` refuses a label that
 * parses as a decimal pair. A geohash prefix is the cheapest label that is
 * (a) not a coordinate pair, (b) derivable with no network and no zone
 * vocabulary, and (c) MANY-TO-ONE: at the ceiling precision every point inside
 * a cell produces the identical string, so the original fix is not recoverable
 * from what is sent. That last property is the one the tests pin.
 *
 * The precision CEILING is a policy, not a parameter a caller may raise: a
 * request for finer precision is clamped, never honoured. Precision 6 is a cell
 * of roughly 1.2 km × 0.6 km — venue-scale is deliberately NOT available from
 * this path, because a venue-scale bucket plus a timestamp is a location
 * history.
 */

/** Geohash base-32 alphabet (Niemeyer). */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * The finest precision this path may ever emit. Raising this number widens the
 * privacy surface of every contribution; it is a policy change, not a tuning
 * knob, and `encodeSpatialBucket` clamps to it rather than trusting a caller.
 */
export const SENSING_SPATIAL_PRECISION_CEILING = 6;

/** The precision the capture path uses by default. */
export const SENSING_SPATIAL_PRECISION = 6;

/** Approximate cell dimensions (metres) at the ceiling precision, for tests and docs. */
export const SENSING_SPATIAL_CELL_METRES = { width: 1_222, height: 610 } as const;

/**
 * Reduce a coordinate to a coarse zone label.
 *
 * Returns `null` for a coordinate that is not finite or not on the globe —
 * absent is a fact, never a (0,0) bucket, which is a real place in the Gulf of
 * Guinea and would collect every device with a broken GPS into one cohort.
 */
export function encodeSpatialBucket(
  lat: number,
  lng: number,
  precision: number = SENSING_SPATIAL_PRECISION,
): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  // Clamp, never trust. A caller asking for precision 12 gets the ceiling.
  const p = Math.max(1, Math.min(SENSING_SPATIAL_PRECISION_CEILING, Math.floor(precision)));

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = '';
  let bits = 0;
  let bit = 0;
  let even = true;

  while (hash.length < p) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        bit = (bit << 1) + 1;
        lngMin = mid;
      } else {
        bit = bit << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bit = (bit << 1) + 1;
        latMin = mid;
      } else {
        bit = bit << 1;
        latMax = mid;
      }
    }
    even = !even;
    if (bits < 4) {
      bits += 1;
    } else {
      hash += BASE32[bit];
      bits = 0;
      bit = 0;
    }
  }
  return hash;
}

/**
 * Metres between two coordinates (haversine). DEVICE-LOCAL ONLY — the result
 * feeds `movement_state` / `bounded_movement` / `dwell_bucket` and is never
 * itself emitted, because a displacement plus a previous bucket narrows a
 * position far below the bucket the policy allows.
 */
export function metresBetween(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
