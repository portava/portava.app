/**
 * mapTemporal service — the client half of §15 Time Machine.
 *
 * The NOW gateway (services/mapProjection) answers "what is here right now".
 * This one answers the same viewport at a DIFFERENT instant: GET
 * /api/map/projection/temporal, driven by the §15 control (NOW, +30m/+60m/+120m,
 * or a named calendar window). The server produces per-offset state — forecast
 * `prediction` objects for the future, observed history for the past — so the
 * client no longer has to relabel the NOW map. What arrives is already the right
 * per-offset payload; the caller runs it through `buildTemporalView` (which
 * consumes it with `toTemporalObjects`) and hands the result to
 * TimeMachineControl / CityTimeline.
 *
 * WHO OWNS THE CALENDAR. The client does. A relative offset goes over the wire
 * as `offsetMinutes`; a NAMED offset (Yesterday / Tonight / Tomorrow / Last
 * Friday) is resolved HERE via `resolveOffset` — which owns the timezone and the
 * DST-safe calendar arithmetic — and sent as an explicit [windowStartsAt,
 * windowEndsAt] plus `at`, so the server never re-derives "Last Friday" in a
 * second, possibly-divergent place.
 *
 * FAIL-SOFT, exactly like mapProjection. `map_projection_enabled` gates the
 * endpoint and is off by default; it answers `{ enabled: false }` rather than an
 * error. `enabled: false` means "the temporal source is unreachable" — the
 * caller keeps Time Machine closed (see deriveMapCapabilities), it is NOT "there
 * is no history here".
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';
import type { MapObject, MapObjectKind } from '../types/mapObjects.ts';
import { temporalQueryParams, type TimeOffset, type TemporalMode } from '../features/map/time/timeMachine.ts';
import type { MapBbox } from './mapProjection.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** What the temporal endpoint's `target` block reports back. */
export interface TemporalTargetInfo {
  at: string;
  windowStartsAt?: string;
  windowEndsAt?: string;
  mode: TemporalMode;
}

/** The forecast report — counts + the accepted_plan refusal, never ambiguous. */
export interface TemporalForecastReport {
  events: number;
  itinerary: number;
  plan: {
    published: number;
    withheld: number;
    refusal: string | null;
    refusals: Record<string, string>;
  };
}

/** The history report — `available:false` is the honest "no history yet". */
export interface TemporalHistoryReport {
  available: boolean;
  covering: number;
}

export interface MapTemporalEnvelope {
  enabled: boolean;
  objects: MapObject[];
  viewport: { bbox: MapBbox; zoom: number; center?: { lat: number; lng: number }; radiusKm?: number } | null;
  target: TemporalTargetInfo | null;
  total: number;
  nextCursor: string | null;
  sources: string[];
  /** Present only for a forecast request. */
  forecast: TemporalForecastReport | null;
  /** Present only for a historical request. */
  history: TemporalHistoryReport | null;
  generatedAt: string;
}

export type MapTemporalResult =
  | { ok: true; data: MapTemporalEnvelope }
  | { ok: false; error: string };

function disabledEnvelope(): MapTemporalEnvelope {
  return {
    enabled: false,
    objects: [],
    viewport: null,
    target: null,
    total: 0,
    nextCursor: null,
    sources: [],
    forecast: null,
    history: null,
    generatedAt: new Date().toISOString(),
  };
}

export interface FetchTemporalOptions {
  bbox: MapBbox;
  zoom: number;
  /** The §15 control position. */
  offset: TimeOffset;
  /** Injected clock — keeps the calendar resolution deterministic/testable. */
  now?: Date;
  /** IANA zone the named offsets resolve in. Omit for device-local. */
  tz?: string;
  kinds?: MapObjectKind[];
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export async function fetchMapTemporal(opts: FetchTemporalOptions): Promise<MapTemporalResult> {
  if (!isSupabaseConfigured || !apiBase()) {
    // Unavailable here — the caller falls back / keeps Time Machine closed.
    return { ok: true, data: disabledEnvelope() };
  }
  const token = await freshApiToken();
  if (!token) return { ok: false, error: 'Not authenticated' };

  const { west, south, east, north } = opts.bbox;
  const params = new URLSearchParams({
    // Wire order is w,s,e,n — the server's parseBbox reads it positionally.
    bbox: `${west},${south},${east},${north}`,
    zoom: String(opts.zoom),
    ...temporalQueryParams(opts.offset, opts.now ?? new Date(), opts.tz),
  });
  if (opts.kinds && opts.kinds.length > 0) params.set('kinds', opts.kinds.join(','));
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', opts.cursor);

  try {
    const res = await fetch(`${apiBase()}/api/map/projection/temporal?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: (body as { message?: string }).message ?? `Request failed (${res.status})` };
    }
    const body = (await res.json()) as Partial<MapTemporalEnvelope>;
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
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return { ok: false, error: 'aborted' };
    return { ok: false, error: (err as { message?: string })?.message ?? 'Network error' };
  }
}
