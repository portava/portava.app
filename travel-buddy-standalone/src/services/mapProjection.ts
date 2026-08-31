/**
 * mapProjection service — the client half of the Map Intelligence Gateway
 * (Map spec §19).
 *
 * ONE call replaces the travelers/gems/events fan-out. The server does all the
 * privacy work (opt-in filtering, block filtering, coordinate coarsening,
 * show_exact_location redaction) and all the intelligence work (freshness,
 * confidence band, rendering priority, provenance). Everything received here is
 * already safe to render as-is, and — per §19 — the client must NOT
 * re-derive any of it.
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
  generatedAt: string;
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

  const { west, south, east, north } = opts.bbox;
  const params = new URLSearchParams({
    // Wire order is w,s,e,n — the server's parseBbox reads it positionally.
    bbox: `${west},${south},${east},${north}`,
    zoom: String(opts.zoom),
  });
  if (opts.kinds && opts.kinds.length > 0) params.set('kinds', opts.kinds.join(','));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);

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
