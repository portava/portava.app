/**
 * Compass → Map command handler — TM-social, MAP-F04.
 *
 * The map's Ask-Compass bar used to geocode every query on the device and fly
 * (`geocodeAndFly`); POST /api/map/compass-command — the server channel built
 * to replace exactly that heuristic — had no caller. These tests pin the
 * handler the map now uses:
 *   - flag off, or the request cannot be made → the legacy fly runs unchanged;
 *   - flag on with a valid set-viewport → the camera moves THERE and the
 *     legacy geocoder is not consulted;
 *   - flag on with no resolvable place → the map stays put (no confident,
 *     wrong fly), and the device geocoder is not used as a second guess;
 *   - every command is re-validated on the client; malformed ones are dropped.
 * And that app/map/index.tsx routes both Compass flies through the handler.
 *
 * Run with: pnpm test:component
 */
// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo; the token is injected per call.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateClientMapCommands, zoomForRadiusKm, requestMapCommands, flyToCompassQuery,
  type MapCommandResult,
} from '../mapCompassCommands.ts';

function res(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('validateClientMapCommands', () => {
  it('keeps in-range commands and drops malformed or unknown ones', () => {
    const out = validateClientMapCommands([
      { type: 'set-viewport', lat: 45.8, lng: 15.97, radiusKm: 25, label: 'Zagreb' },
      { type: 'set-viewport', lat: 95, lng: 0, radiusKm: 25 },
      { type: 'search-area', lat: 1, lng: 2, radiusKm: 500 },
      { type: 'select-entity', entityId: '' },
      { type: 'teleport', lat: 1, lng: 2 },
      { type: 'clear-filters' },
      null,
    ]);
    expect(out).toEqual([
      { type: 'set-viewport', lat: 45.8, lng: 15.97, radiusKm: 25, label: 'Zagreb' },
      { type: 'clear-filters' },
    ]);
  });
  it('a non-array is no commands', () => {
    expect(validateClientMapCommands({ type: 'clear-filters' })).toEqual([]);
  });
});

describe('zoomForRadiusKm', () => {
  it('frames the server default (25 km) at the legacy fly zoom, and clamps', () => {
    expect(zoomForRadiusKm(25)).toBe(11);
    expect(zoomForRadiusKm(1)).toBeLessThanOrEqual(17);
    expect(zoomForRadiusKm(200)).toBeGreaterThanOrEqual(2);
    expect(zoomForRadiusKm(Number.NaN)).toBe(11);
  });
});

describe('requestMapCommands', () => {
  it('POSTs the intent with the bearer token to /api/map/compass-command', async () => {
    const fetchImpl = jest.fn(async () => res(200, { enabled: false, commands: [], explanation: '' }));
    const out = await requestMapCommands({ kind: 'go_to', query: 'Split' }, { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'http://api', token: 't1' });
    expect(out).toEqual({ ok: true, data: { enabled: false } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/api/map/compass-command');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t1');
    expect(JSON.parse(String(init.body))).toEqual({ intent: { kind: 'go_to', query: 'Split' } });
  });
  it('an enabled answer is re-validated', async () => {
    const fetchImpl = async () => res(200, { enabled: true, commands: [{ type: 'set-viewport', lat: 999, lng: 0, radiusKm: 5 }], explanation: 'x' });
    const out = await requestMapCommands({ kind: 'go_to', query: 'x' }, { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'http://api', token: 't' });
    expect(out).toEqual({ ok: true, data: { enabled: true, commands: [], explanation: 'x' } });
  });
  it('a refused request is an error, not "disabled"', async () => {
    const fetchImpl = async () => res(400, { error: 'invalid_payload', message: 'bad intent' });
    const out = await requestMapCommands({ kind: 'go_to' }, { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'http://api', token: 't' });
    expect(out).toEqual({ ok: false, message: 'bad intent' });
  });
  it('no token → no request', async () => {
    const fetchImpl = jest.fn();
    const out = await requestMapCommands({ kind: 'go_to' }, { fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'http://api', token: null });
    expect(out.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('flyToCompassQuery', () => {
  function cam() { return { current: { easeTo: jest.fn() } }; }
  const req = (r: MapCommandResult) => ({ request: async () => r });

  it('flag off → the legacy fly runs, the camera is not driven by the handler', async () => {
    const c = cam(); const legacy = jest.fn();
    const out = await flyToCompassQuery('Split', c, legacy, req({ ok: true, data: { enabled: false } }));
    expect(out).toEqual({ via: 'legacy', reason: 'disabled' });
    expect(legacy).toHaveBeenCalledWith('Split');
    expect(c.current.easeTo).not.toHaveBeenCalled();
  });

  it('request failed → the legacy fly runs (an outage costs nothing that worked before)', async () => {
    const legacy = jest.fn();
    const out = await flyToCompassQuery('Split', cam(), legacy, req({ ok: false, message: 'Network error' }));
    expect(out).toEqual({ via: 'legacy', reason: 'request_failed' });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it('flag on + set-viewport → the camera moves to the server coordinates, no device geocode', async () => {
    const c = cam(); const legacy = jest.fn();
    const out = await flyToCompassQuery('Split', c, legacy, req({
      ok: true, data: { enabled: true, explanation: 'Showing Split', commands: [{ type: 'set-viewport', lat: 43.5, lng: 16.44, radiusKm: 25, label: 'Split' }] },
    }));
    expect(c.current.easeTo).toHaveBeenCalledWith({ center: [16.44, 43.5], zoom: 11, duration: 700 });
    expect(legacy).not.toHaveBeenCalled();
    expect(out).toEqual({ via: 'server', moved: true, label: 'Split', explanation: 'Showing Split' });
  });

  it('flag on + nothing resolvable → the map stays put and the device geocoder is NOT a second guess', async () => {
    const c = cam(); const legacy = jest.fn();
    const out = await flyToCompassQuery('asdfgh', c, legacy, req({ ok: true, data: { enabled: true, explanation: 'No place found', commands: [] } }));
    expect(c.current.easeTo).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
    expect(out).toEqual({ via: 'server', moved: false, explanation: 'No place found' });
  });
});

describe('app/map/index.tsx routes both Compass flies through the handler', () => {
  const src = readFileSync(join(__dirname, '../../../app/map/index.tsx'), 'utf8');
  it('no Compass fly calls the device geocoder directly', () => {
    expect(src).not.toMatch(/void geocodeAndFly\((query|compassQuery)\)/);
    expect(src.match(/flyToCompassQuery\((query|compassQuery), cameraRef, geocodeAndFly\)/g)?.length).toBe(2);
  });
});
