/**
 * mapProjection service — the client half of the Map Intelligence Gateway
 * (Map spec §19).
 *
 * ONE call replaces the five-way per-layer fan-out (events, gems, buddies,
 * trips, circle). The server does all the privacy work (opt-in filtering, block
 * filtering, coordinate coarsening, show_exact_location redaction) and all the
 * intelligence work (freshness, confidence band, rendering priority,
 * provenance). Everything received here is already safe to render as-is, and —
 * per §19 — the client must NOT re-derive any of it.
 *
 * The endpoint also serves `social_zone` (travelers) and `crowd_flow`, which
 * this app does not request: travelers render through the Discovery map's own
 * useMapTravelers path, and crowd flow has no client renderer yet.
 * src/hooks/__tests__/useMapEntities.gatewayAsymmetry.test.ts holds those two
 * to a stated reason, so a kind cannot go unrequested silently again.
 *
 * FAIL-SOFT BY DESIGN. `map_projection_enabled` is off by default, and the
 * endpoint answers `{ enabled: false, objects: [] }` rather than an error. The
 * caller must treat `enabled: false` as "use the legacy per-layer path", never
 * as "there is nothing here" — otherwise switching the flag off would blank the
 * map instead of reverting it.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import type { MapObject, MapObjectKind } from '../types/mapObjects.ts';
// The wire encoding lives in a PURE module (no react-native import) so
// node:test can reach it — see features/map/journey/projectionQuery.
import { buildProjectionParams } from '../features/map/journey/projectionQuery.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/**
 * Viewport bounds in degrees. Field names are spelled out to match the server's
 * `BBox` exactly — `w`/`e` next to each other is how a west/east transposition
 * survives review and silently mirrors a viewport.
 */
export interface MapBbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapProjectionEnvelope {
  enabled: boolean;
  objects: MapObject[];
  viewport: {
    bbox: MapBbox;
    zoom: number;
    center?: { lat: number; lng: number };
    radiusKm?: number;
  } | null;
  total: number;
  nextCursor: string | null;
  /** Which sources actually came through the gateway this call. */
  sources: string[];
  /**
   * How the bounded live-claim enrichment went. `skipped > 0` means some
   * eligible objects were not checked for live claims — the client should not
   * present the result as a complete live picture.
   */
  liveEnrichment: { considered: number; enriched: number; skipped: number } | null;
  /**
   * §36 Phase 6 "Along My Way". Null when no corridor was requested. A
   * `refusal` of 'flag_off' means `map_journey_intelligence_enabled` is off and
   * the server IGNORED the corridor — so `objects` is the whole bbox, not the
   * corridor, and the caller must not present it as "along your way".
   */
  corridor: MapCorridorReport | null;
  /**
   * Detour estimates for the objects on THIS page, in page order. An
   * aggregated cell has no entry: a cell is not a place you can step off your
   * route to reach.
   */
  corridorMatches: MapCorridorMatch[] | null;
  generatedAt: string;
}

/** What the server's corridor filter did. Counts only, by construction. */
export interface MapCorridorReport {
  refusal: 'flag_off' | 'invalid_corridor' | null;
  meters: number | null;
  points: number | null;
  considered: number;
  kept: number;
  droppedOffRoute: number;
  droppedNoGeometry: number;
}

/**
 * One object's detour cost. `basis` is the machine-readable half of the §37
 * promise: this is straight-line geometry, never a measured travel time, and
 * `line` already carries the "Est." the UI must not strip.
 */
export interface MapCorridorMatch {
  objectId: string;
  detour: {
    offsetMeters: number;
    extraMeters: number;
    extraMinutes: number;
    alongMeters: number;
    basis: 'straight_line_estimate';
  };
  line: string;
}

export type MapProjectionResult =
  | { ok: true; data: MapProjectionEnvelope }
  | { ok: false; error: string };

/** The empty, disabled envelope — used for both "not configured" and parse failures. */
function disabledEnvelope(): MapProjectionEnvelope {
  return {
    enabled: false,
    objects: [],
    viewport: null,
    total: 0,
    nextCursor: null,
    sources: [],
    liveEnrichment: null,
    corridor: null,
    corridorMatches: null,
    generatedAt: new Date().toISOString(),
  };
}

export interface FetchProjectionOptions {
  bbox: MapBbox;
  zoom: number;
  /** Restrict to these object kinds; omit for all. */
  kinds?: MapObjectKind[];
  limit?: number;
  cursor?: string | null;
  /**
   * §36 Phase 6 "Along My Way": the VIEWER'S OWN route polyline, in order. The
   * server keeps only the objects within `corridorMeters` of it and attaches a
   * detour estimate to each. Two or more DISTINCT points, or the server refuses
   * with `corridor.refusal = 'invalid_corridor'` — a single point is a location,
   * not a route, and would silently become a radius search.
   *
   * The corridor can only ever REMOVE objects from the answer the same bbox
   * would give, so requesting one never widens what this client can see.
   */
  corridor?: Array<{ lat: number; lng: number }>;
  /** Corridor half-width in metres. The server clamps it to [50, 5000]. */
  corridorMeters?: number;
  signal?: AbortSignal;
}

export async function fetchMapProjection(
  opts: FetchProjectionOptions,
): Promise<MapProjectionResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    // Not an error the UI should surface — it just means the gateway is
    // unavailable here, so the caller falls back.
    return { ok: true, data: disabledEnvelope() };
  }
  const token = await freshApiToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  const params = buildProjectionParams(opts);

  try {
    const res = await fetch(`${apiBase()}/api/map/projection?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as any).message ?? `Request failed (${res.status})` };
    }
    const body = (await res.json()) as Partial<MapProjectionEnvelope>;
    return {
      ok: true,
      data: {
        ...disabledEnvelope(),
        ...body,
        // Defensive: a malformed body must not crash the renderer, and must not
        // masquerade as an enabled-but-empty result.
        enabled: body.enabled === true,
        objects: Array.isArray(body.objects) ? body.objects : [],
        sources: Array.isArray(body.sources) ? body.sources : [],
        // A malformed corridor block must read as "no corridor ran", never as
        // a corridor that kept everything.
        corridor: body.corridor ?? null,
        corridorMatches: Array.isArray(body.corridorMatches) ? body.corridorMatches : null,
      },
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: err?.message ?? 'Network error' };
  }
}

/**
 * The bbox for a centre + radius, for callers that only know a centre (the map
 * screen's deep-link entry points pass lat/lng/zoom, not bounds).
 */
export function bboxFromCenter(lat: number, lng: number, radiusKm: number): MapBbox {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    west: clampLng(lng - lngDelta),
    south: clampLat(lat - latDelta),
    east: clampLng(lng + lngDelta),
    north: clampLat(lat + latDelta),
  };
}

function clampLat(v: number): number {
  return Math.max(-89.9, Math.min(89.9, v));
}

/**
 * Clamp rather than wrap: the endpoint rejects antimeridian-crossing viewports
 * (the radius-based sources beneath it cannot express one), so a wrapped
 * longitude would produce a 400 instead of a slightly-clipped viewport.
 */
function clampLng(v: number): number {
  return Math.max(-179.9, Math.min(179.9, v));
}
