/**
 * census-discovery §114 (DV-83 round 17, lane W11-X2; the round-16 verifier's B5): the NOW map hook reports EVERY
 * requested layer the gateway did not read — the §16 optional layers too — and says an answer that is one page of a
 * longer list.
 *
 * The gateway names a layer in `sources` only over a read that succeeded and was not cut (§108–§113: a failed read,
 * `snapshots_capped`, `items_capped`, `zone_model_capped`, a cut city geography). The hook read `sources` for the
 * five toggleable layers only, so a failed or cut SAFETY-NOTICE read reached the screen as a whole, empty layer — "no
 * hazards here" — and it asked for `limit: 200` and dropped `nextCursor`, so page one of several was drawn as whole.
 *
 *   V16-NU0 CONTROL: a toggleable layer the gateway did not name → unreadLayers names it (unchanged)
 *   V16-NU1 safety requested, its read cut (not named; snapshots_capped) → unreadLayers names `safety`
 *   V16-NU2 meeting points requested, not named (items_capped) → `meeting_point`
 *   V16-NU3 crowd flow requested, not named (zone_model_capped) → `crowd_flow`
 *   V16-NU4 the answer is page one of a longer list (nextCursor "200") → `truncated: true`
 *   NU5  the Phase 7 layers, places, saved and memories: each requested and not named → each named, by its layer
 *   NU6  safety is listed first, whatever order the layers were requested in
 *   NU7  a later whole answer clears the signal (a stale unread list is never kept)
 *   NU8  the gateway's read FAILED (a transport failure) or was REFUSED (`enabled: false` with `protection_unreadable`):
 *        the legacy fetchers cannot serve the optional layers, so each requested one is named — never an absent hazard
 *   NU8c CONTROL: the flag is off (`enabled: false`, no refusal) → the optional layers are off, not unread
 *   NU9  every layer switched off after a cut answer → the signal is cleared
 *   NUc  CONTROL: every requested layer named and no nextCursor → nothing unread, not truncated; a layer NOT requested
 *        is never reported unread
 */
import { renderHook, waitFor } from '@testing-library/react-native';
import { useMapEntities } from '../useMapEntities.ts';

// NOTE: exhaustive by design — the hook forwards only to `fetchMapProjection` and `bboxFromCenter` from this module.
jest.mock('../../services/mapProjection.ts', () => ({
  fetchMapProjection: jest.fn(),
  bboxFromCenter: (lat: number, lng: number, r: number) => ({ west: lng - r / 111, south: lat - r / 111, east: lng + r / 111, north: lat + r / 111 }),
}));
// NOTE: exhaustive by design — the legacy fetchers are never reached while the gateway answers.
jest.mock('../../services/rentABuddy.ts', () => ({ searchBuddies: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listMyTrips` from here.
jest.mock('../../services/trips.ts', () => ({ listMyTrips: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listVisibleCircleLocations`.
jest.mock('../../services/map.ts', () => ({ listVisibleCircleLocations: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listEvents` from here.
jest.mock('../../services/events.ts', () => ({ listEvents: jest.fn() }));
// NOTE: exhaustive by design — the hook uses only `listGems` from here.
jest.mock('../../services/hiddenGems.ts', () => ({ listGems: jest.fn() }));
// NOTE: exhaustive by design — only read/write/purge are used, and the real cache reaches for AsyncStorage on import.
jest.mock('../../features/map/cache/mapCache.ts', () => ({ mapCache: { read: jest.fn(), write: jest.fn(), purgeSupersededVersions: jest.fn().mockResolvedValue(0) } }));

const { fetchMapProjection } = jest.requireMock('../../services/mapProjection.ts') as { fetchMapProjection: jest.Mock };
const { mapCache } = jest.requireMock('../../features/map/cache/mapCache.ts') as { mapCache: { read: jest.Mock; write: jest.Mock } };

const CENTER = { city: 'Bangkok', lat: 13.75, lng: 100.5 };
const env = (sources: string[], producers: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({ ok: true as const, data: { enabled: true, objects: [], viewport: null, total: 0, nextCursor: null, sources, liveEnrichment: { considered: 0, enriched: 0, skipped: 0 }, producers, generatedAt: '2026-09-30T12:00:00.000Z', ...over } });

async function load(enabledLayers: any[], extra: Record<string, unknown> = {}) {
  const hook = await renderHook((p: { extra: Record<string, unknown> }) => useMapEntities({ enabledLayers, ...CENTER, ...p.extra }), { initialProps: { extra } });
  await waitFor(() => expect(hook.result.current.stage).not.toBe('cached_geography'));
  return hook;
}

beforeEach(() => { jest.clearAllMocks(); mapCache.read.mockResolvedValue(null); mapCache.write.mockResolvedValue(undefined); });

describe('§114 B5: the NOW map hook names every requested layer the gateway did not read', () => {
  it('V16-NU0 CONTROL: events requested and not named → unreadLayers names events', async () => {
    fetchMapProjection.mockResolvedValue(env([]));
    const { result } = await load(['events']);
    await waitFor(() => expect(result.current.unreadLayers).toEqual(['events']));
    expect(result.current.truncated).toBeFalsy();
  });

  it('V16-NU1 safety requested, the safety read cut at its cap (not named; snapshots_capped) → unreadLayers names safety', async () => {
    fetchMapProjection.mockResolvedValue(env(['events'], { safety_notice: { refusal: 'snapshots_capped', collected: 0 } }));
    const { result } = await load(['events'], { safety: true });
    expect(fetchMapProjection.mock.calls[0][0].kinds).toContain('safety_notice');
    await waitFor(() => expect(result.current.unreadLayers).toEqual(['safety']));
  });

  it('V16-NU2 meeting points requested, not named (items_capped) → unreadLayers names meeting_point', async () => {
    fetchMapProjection.mockResolvedValue(env(['trips'], { meeting_point: { refusal: 'items_capped', collected: 0 } }));
    const { result } = await load(['trips'], { meetingPoints: true });
    await waitFor(() => expect(result.current.unreadLayers).toEqual(['meeting_point']));
  });

  it('V16-NU3 crowd flow requested, not named (zone_model_capped) → unreadLayers names crowd_flow', async () => {
    fetchMapProjection.mockResolvedValue(env(['events']));
    const { result } = await load(['events'], { crowdFlow: true });
    await waitFor(() => expect(result.current.unreadLayers).toEqual(['crowd_flow']));
  });

  it('V16-NU4 the answer is the first page of a longer list (nextCursor "200") → truncated', async () => {
    const objs = Array.from({ length: 200 }, (_, i) => ({ id: `event:e${i}`, kind: 'event', geometry: { type: 'Point', coordinates: [100.5 + i / 1000, 13.75] }, title: `E${i}`, subtitle: null, privacyClass: 'public', renderingPriority: 50, interaction: { actions: ['view'], opensSheet: true } }));
    fetchMapProjection.mockResolvedValue(env(['events'], {}, { objects: objs, total: 260, nextCursor: '200' }));
    const { result } = await load(['events']);
    await waitFor(() => expect(result.current.objects.length).toBe(200));
    expect(result.current.truncated).toBe(true);
    expect(result.current.unreadLayers).toEqual([]);
  });

  it('NU5 the Phase 7 layers, places, saved and memories: each requested and not named is named by its layer', async () => {
    fetchMapProjection.mockResolvedValue(env(['events', 'world_pulse', 'saved']));
    const { result } = await load(['events'], { worldIntelligence: true, myCities: true, places: true, saved: true, memories: true });
    await waitFor(() => expect(result.current.stage).not.toBe('cached_geography'));
    await waitFor(() => expect([...result.current.unreadLayers].sort()).toEqual(['city_model', 'memories', 'personal_city', 'relevant_places', 'traveler_flow']));
  });

  it('NU6 safety is listed first, whatever order the layers were requested in', async () => {
    fetchMapProjection.mockResolvedValue(env([]));
    const { result } = await load(['events', 'gems'], { safety: true, crowdFlow: true });
    await waitFor(() => expect(result.current.unreadLayers.length).toBe(4));
    expect(result.current.unreadLayers[0]).toBe('safety');
  });

  it('NU7 a later whole answer clears the signal: no stale unread list and no stale cut', async () => {
    fetchMapProjection.mockResolvedValueOnce(env(['events'], {}, { nextCursor: '200' }));
    const hook = await load(['events'], { safety: true });
    await waitFor(() => expect(hook.result.current.unreadLayers).toEqual(['safety']));
    expect(hook.result.current.truncated).toBe(true);
    fetchMapProjection.mockResolvedValue(env(['events', 'safety']));
    await hook.rerender({ extra: { safety: true, crowdFlow: false, radiusKm: 30 } });
    await waitFor(() => expect(fetchMapProjection).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.unreadLayers).toEqual([]));
    expect(hook.result.current.truncated).toBe(false);
  });

  it('NUc CONTROL: every requested layer named, no nextCursor → nothing unread, not truncated; an unrequested layer is never unread', async () => {
    fetchMapProjection.mockResolvedValue(env(['events', 'safety', 'meeting_points', 'crowd_flow']));
    const { result } = await load(['events'], { safety: true, meetingPoints: true, crowdFlow: true });
    await waitFor(() => expect(result.current.stage).not.toBe('cached_geography'));
    expect(result.current.unreadLayers).toEqual([]);
    expect(result.current.truncated).toBeFalsy();
    fetchMapProjection.mockResolvedValue(env(['events']));
    const other = await load(['events']);
    expect(other.result.current.unreadLayers).toEqual([]);
  });

  it('NU8 a failed or refused gateway read → each requested optional layer is named, safety first', async () => {
    fetchMapProjection.mockResolvedValue({ ok: false, error: 'Request failed (503)' });
    const failed = await load([], { safety: true, crowdFlow: true });
    await waitFor(() => expect(failed.result.current.unreadLayers).toEqual(['safety', 'crowd_flow']));
    fetchMapProjection.mockResolvedValue(env([], {}, { enabled: false, refusal: 'protection_unreadable' }));
    const refused = await load([], { safety: true });
    await waitFor(() => expect(refused.result.current.unreadLayers).toEqual(['safety']));
  });

  it('NU8c CONTROL: the flag is off (enabled: false, no refusal) → the optional layers are off, not unread', async () => {
    fetchMapProjection.mockResolvedValue(env([], {}, { enabled: false }));
    const { result } = await load([], { safety: true, crowdFlow: true });
    await waitFor(() => expect(result.current.stage).not.toBe('cached_geography'));
    expect(result.current.unreadLayers).toEqual([]);
  });

  it('NU9 every layer switched off after a cut answer → nothing unread and not truncated (no stale notice)', async () => {
    fetchMapProjection.mockResolvedValue(env(['events'], {}, { nextCursor: '200' }));
    const hook = await renderHook((p: { layers: any[]; safety: boolean }) => useMapEntities({ enabledLayers: p.layers, ...CENTER, safety: p.safety }), { initialProps: { layers: ['events'], safety: true } });
    await waitFor(() => expect(hook.result.current.truncated).toBe(true));
    expect(hook.result.current.unreadLayers).toEqual(['safety']);
    await hook.rerender({ layers: [], safety: false });
    await waitFor(() => expect(hook.result.current.truncated).toBe(false));
    expect(hook.result.current.unreadLayers).toEqual([]);
  });
});
