/**
 * projectionQuery — the wire encoding for a Map Intelligence Gateway call
 * (Map spec §19, and §36 Phase 6's `corridor=`).
 *
 * WHY IT IS NOT IN services/mapProjection. That module imports lib/supabase,
 * which pulls in react-native and cannot be loaded by `node:test` — the same
 * transform wall features/map/trip/tripMapSources was split out to stay behind.
 * Two coordinate orders meet in one query string here (bbox is w,s,e,n,
 * longitude first at each end; a corridor vertex is lat,lng), and a
 * transposition in either produces a perfectly well-formed request that
 * silently answers about the wrong part of the world. That is exactly the kind
 * of encoding that needs a test, so it lives where a test can reach it.
 *
 * Pure: no React, no network, no storage.
 */
import type { MapObjectKind } from '../../../types/mapObjects.ts';

/** Viewport bounds in degrees, spelled out to match the server's `BBox`. */
export interface ProjectionBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ProjectionQueryInput {
  bbox: ProjectionBbox;
  zoom: number;
  kinds?: MapObjectKind[];
  limit?: number;
  cursor?: string | null;
  /** §36 Phase 6: the viewer's own route polyline, in order. */
  corridor?: Array<{ lat: number; lng: number }>;
  /** Corridor half-width in metres. The server clamps it to [50, 5000]. */
  corridorMeters?: number;
}

/** The query string for one projection call. */
export function buildProjectionParams(opts: ProjectionQueryInput): URLSearchParams {
  const { west, south, east, north } = opts.bbox;
  const params = new URLSearchParams({
    // Wire order is w,s,e,n — the server's parseBbox reads it positionally.
    bbox: `${west},${south},${east},${north}`,
    zoom: String(opts.zoom),
  });
  if (opts.kinds && opts.kinds.length > 0) params.set('kinds', opts.kinds.join(','));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);
  // `lat,lng;lat,lng;…` — the server's parseCorridorPath reads it positionally.
  // Note the order DIFFERS from bbox's: a corridor vertex is lat FIRST,
  // matching how the app carries a position everywhere else.
  //
  // Below two points nothing is sent at all, rather than a corridor the server
  // would refuse: a one-point "route" is a location, and a client that sent one
  // would be asking for a radius search under another name.
  if (opts.corridor && opts.corridor.length >= 2) {
    params.set('corridor', opts.corridor.map((p) => `${p.lat},${p.lng}`).join(';'));
    if (opts.corridorMeters != null) params.set('corridorMeters', String(opts.corridorMeters));
  }
  return params;
}
