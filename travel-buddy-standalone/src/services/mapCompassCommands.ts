/**
 * Compass → Map command channel, client half. TM-social, MAP-F04.
 *
 * POST /api/map/compass-command (artifacts/api-server/src/routes/mapSearch.ts,
 * protocol in lib/mapCommands.ts) turns a structured intent into a closed,
 * range-validated list of map commands. Its own header says what it is for:
 * "This is what lets us replace the old client-side 'geocode the query string
 * and fly' heuristic: the server resolves coordinates (via a real geocoder) and
 * emits a structured set-viewport, instead of the client guessing."
 *
 * Until this module the map still did exactly that heuristic — the Ask-Compass
 * bar on the map sent every query to Nominatim from the device
 * (`geocodeAndFly`, app/map/index.tsx) and nothing called the route. This is
 * the handler: the map asks the server, validates what comes back AGAIN
 * (defence in depth — the server already did), and moves the camera only on a
 * valid set-viewport.
 *
 * FLAG-OFF IS THE OLD BEHAVIOUR, BYTE FOR BYTE. With
 * `map_compass_commands_enabled` off the route answers `{ enabled: false }` and
 * the caller's legacy fly runs unchanged; the same happens when the request
 * cannot be made at all, so an API outage costs nothing that worked before.
 * With the flag ON and no resolvable place, the map is left where it is and
 * the server's explanation is returned — flying somewhere confident and wrong
 * is the failure this protocol exists to prevent, so it is not retried against
 * the device geocoder.
 *
 * `GET /api/map/search` stays without a client caller ON PURPOSE: the map's
 * search sheet already searches nine entity types through the input-assistance
 * gateway, and /map/search normalises three (see
 * docs/architecture/mobile-reachability-ledger.md, "The two map leads").
 */
import { freshToken } from './apiToken.ts';

export type MapCommand =
  | { type: 'set-viewport'; lat: number; lng: number; radiusKm: number; label?: string }
  | { type: 'search-area'; lat: number; lng: number; radiusKm: number; query?: string; types?: string[] }
  | { type: 'select-entity'; entityId: string }
  | { type: 'add-filter'; key: string; value: string | boolean }
  | { type: 'clear-filters' };

export interface MapIntent {
  kind: 'go_to' | 'search' | 'select' | 'filter' | 'clear';
  query?: string | null;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number | null;
  entityId?: string | null;
}

export type MapCommandResponse =
  | { enabled: false }
  | { enabled: true; commands: MapCommand[]; explanation: string };

export type MapCommandResult =
  | { ok: true; data: MapCommandResponse }
  | { ok: false; message: string };

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/**
 * Keep only commands this client can trust. Mirrors the server's
 * validateMapCommand ranges; an unknown or malformed command is dropped, never
 * half-applied.
 */
export function validateClientMapCommands(raw: unknown): MapCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: MapCommand[] = [];
  for (const c of raw as any[]) {
    if (!c || typeof c !== 'object') continue;
    if ((c.type === 'set-viewport' || c.type === 'search-area')
      && inRange(c.lat, -90, 90) && inRange(c.lng, -180, 180) && inRange(c.radiusKm, 1, 200)) {
      out.push(c.type === 'set-viewport'
        ? { type: 'set-viewport', lat: c.lat, lng: c.lng, radiusKm: c.radiusKm, ...(typeof c.label === 'string' ? { label: c.label } : {}) }
        : { type: 'search-area', lat: c.lat, lng: c.lng, radiusKm: c.radiusKm,
            ...(typeof c.query === 'string' ? { query: c.query } : {}),
            ...(Array.isArray(c.types) ? { types: c.types.filter((t: unknown) => typeof t === 'string') } : {}) });
    } else if (c.type === 'select-entity' && typeof c.entityId === 'string' && c.entityId) {
      out.push({ type: 'select-entity', entityId: c.entityId });
    } else if (c.type === 'add-filter' && typeof c.key === 'string' && (typeof c.value === 'string' || typeof c.value === 'boolean')) {
      out.push({ type: 'add-filter', key: c.key, value: c.value });
    } else if (c.type === 'clear-filters') {
      out.push({ type: 'clear-filters' });
    }
  }
  return out;
}

/** POST /api/map/compass-command. */
export async function requestMapCommands(
  intent: MapIntent,
  opts?: { fetchImpl?: typeof fetch; baseUrl?: string; token?: string | null },
): Promise<MapCommandResult> {
  const base = opts?.baseUrl ?? process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
  if (!base) return { ok: false, message: 'Not configured' };
  let token: string | null = opts?.token !== undefined ? opts.token : null;
  if (opts?.token === undefined) {
    try { token = await freshToken(); } catch { token = null; }
  }
  if (!token) return { ok: false, message: 'Not authenticated' };
  const doFetch = opts?.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${base}/api/map/compass-command`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent }),
    });
    const body = (await res.json().catch(() => null)) as any;
    if (!res.ok || !body) return { ok: false, message: body?.message ?? `API ${res.status}` };
    if (body.enabled !== true) return { ok: true, data: { enabled: false } };
    return {
      ok: true,
      data: {
        enabled: true,
        commands: validateClientMapCommands(body.commands),
        explanation: typeof body.explanation === 'string' ? body.explanation : '',
      },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Network error' };
  }
}

/**
 * A viewport radius (km) → a MapLibre zoom that frames it on a phone. 25 km
 * (the server's default) lands on 11, the zoom the legacy fly used, so the
 * common case looks the same either way.
 */
export function zoomForRadiusKm(radiusKm: number): number {
  const r = Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : 25;
  return Math.min(17, Math.max(2, Math.round(Math.log2(40075 / r))));
}

export interface CameraLike {
  easeTo?(opts: { center: [number, number]; zoom?: number; duration?: number }): void;
}

export type CompassFlyOutcome =
  | { via: 'legacy'; reason: 'disabled' | 'request_failed' }
  | { via: 'server'; moved: true; label: string | null; explanation: string }
  | { via: 'server'; moved: false; explanation: string };

/**
 * The map's Compass fly: ask the server, apply its set-viewport; fall back to
 * the caller's legacy fly only when the channel is off or unreachable.
 */
export async function flyToCompassQuery(
  query: string,
  cameraRef: { current: CameraLike | null },
  legacyFly: (q: string) => Promise<void> | void,
  deps?: { request?: (intent: MapIntent) => Promise<MapCommandResult> },
): Promise<CompassFlyOutcome> {
  const request = deps?.request ?? ((i: MapIntent) => requestMapCommands(i));
  const res = await request({ kind: 'go_to', query });
  if (!res.ok || !res.data.enabled) {
    await legacyFly(query);
    return { via: 'legacy', reason: res.ok ? 'disabled' : 'request_failed' };
  }
  const viewport = res.data.commands.find(
    (c): c is Extract<MapCommand, { type: 'set-viewport' }> => c.type === 'set-viewport',
  );
  const cam = cameraRef.current;
  if (!viewport || !cam || typeof cam.easeTo !== 'function') {
    return { via: 'server', moved: false, explanation: res.data.explanation };
  }
  cam.easeTo({ center: [viewport.lng, viewport.lat], zoom: zoomForRadiusKm(viewport.radiusKm), duration: 700 });
  return { via: 'server', moved: true, label: viewport.label ?? null, explanation: res.data.explanation };
}
