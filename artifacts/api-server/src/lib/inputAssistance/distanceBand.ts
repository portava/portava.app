/**
 * §28 "Distance where permitted" — a COARSE distance band on a suggestion row
 * (census G176; precision ruling by the lead, 2026-10-07).
 *
 * The ruling, verbatim in substance: coarse distance only, rounded to the same
 * buckets the app already uses for approximate distance, and none when precision
 * is unknown. Those buckets are the client's
 * `travel-buddy-standalone/src/features/map/telemetry/mapTelemetry.ts#distanceBucket`
 * — `<0.5km | 0.5-1km | 1-3km | 3-10km | 10-50km | 50km+` — and a parity test
 * holds this copy to that function over a sweep of distances.
 *
 * WHAT IS BANDED, AND WHAT IS NEVER BANDED:
 *   - PLACES and EVENTS only, and only from the position the row already carries
 *     on the wire for this viewer (`metadata.lat/lng`): an event whose venue is
 *     withheld has none, so it gets no band;
 *   - never a PERSON (no row carries a person's position, and none may);
 *   - never a HIDDEN GEM: a distance from the viewer constrains a gem to a ring,
 *     and its approximate centroid is not a precision this can stand behind;
 *   - never a row the protection pass touched. `discoverySearchProtection`
 *     marks a coarsened or withheld position with `metadata.coordsPrecision`;
 *     any value there means the exact position is not this viewer's to measure
 *     from, so the band is withheld (precision unknown → none);
 *   - nothing at all without the viewer's own position on the request.
 *
 * Only the BAND leaves the server. No distance number and no coordinate is
 * projected; the band is a label over the viewer's own position and a position
 * the row already shows them.
 */
import { haversineKm } from './searchQueryHelpers';

export type DistanceBand = '<0.5km' | '0.5-1km' | '1-3km' | '3-10km' | '10-50km' | '50km+';

/** The app's approximate-distance buckets (`mapTelemetry.distanceBucket`), or null for an unusable distance. */
export function coarseDistanceBand(km: number | null | undefined): DistanceBand | null {
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0) return null;
  if (km < 0.5) return '<0.5km';
  if (km < 1) return '0.5-1km';
  if (km < 3) return '1-3km';
  if (km < 10) return '3-10km';
  if (km < 50) return '10-50km';
  return '50km+';
}

/** The dispatch types a band may ever be computed for. */
const BANDED_RESULT_TYPES: ReadonlySet<string> = new Set(['places', 'events']);

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The band for one internal search row, measured from the viewer's own
 * position, or null whenever any input is missing, unexact or not permitted.
 */
export function rowDistanceBand(
  r: { type: string; metadata?: Record<string, unknown> | null },
  origin: { lat: number | null; lng: number | null } | null | undefined,
): DistanceBand | null {
  if (!BANDED_RESULT_TYPES.has(r.type)) return null;
  if (!origin || !finite(origin.lat) || !finite(origin.lng)) return null;
  const m = r.metadata;
  if (!m || typeof m !== 'object') return null;
  if (m.coordsPrecision !== undefined) return null; // coarsened or withheld: precision not exact
  if (!finite(m.lat) || !finite(m.lng)) return null;
  return coarseDistanceBand(haversineKm(origin.lat, origin.lng, m.lat, m.lng));
}
