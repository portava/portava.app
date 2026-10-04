/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B45, probe MV1): the Discovery map's
 * travelers layer never draws ANOTHER centre's travelers over a failed read.
 *
 * §112 (D-W11X2-127) keeps the last good rows when a refresh fails and says the refresh failed beside them. That rule
 * is about one place: the rows are still that centre's travelers, a poll older. When the map has MOVED to a centre far
 * from the one the rows were read for and the read for the new centre fails, the kept rows are another city's people,
 * drawn on this one with "couldn't refresh" beside them. §122 (D-W11X2-185) ruled the same for the Live rail and the
 * For You feed and claimed it of every hook; this one was missed. The hook now remembers the centre its rows were read
 * for, and a failed read for a centre far from it (the hook's own "moved significantly" test, a third of the radius)
 * clears them: the layer says it could not load travelers.
 *
 *   MV1  Lisbon read, the map moves to Porto, the Porto read FAILS → no rows, the failure said
 *   MV2  CONTROL: Lisbon read, a refresh of Lisbon FAILS → the rows stay and the failure is said (§112, unchanged)
 *   MV3  CONTROL: Lisbon read, a small pan inside the city, that read FAILS → the rows stay (the same place)
 *   MV4  after MV1, the next Porto read answers → Porto's rows, no error
 *   MV5  Lisbon read cut by the server (`truncated`), then MV1 → `truncated` is cleared with the rows
 *   MV6  while the Porto read is still in flight the Lisbon rows are kept; they go when that read fails
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockGet = jest.fn();
// NOTE: exhaustive on purpose — the hook imports only getMapTravelers from here, and the real module pulls in the app's auth client.
jest.mock('../../services/mapTravelers.ts', () => ({ getMapTravelers: (...a: unknown[]) => mockGet(...a) }));

import { useMapTravelers } from '../useMapTravelers.ts';

const LISBON = { lat: 38.72, lng: -9.14 };
const PORTO = { lat: 41.15, lng: -8.61 };          // ~275 km away: far past a third of the 50 km radius
const ALFAMA = { lat: 38.75, lng: -9.12 };         // ~4 km away: inside it
const T = (id: string, at = LISBON) => ({ id, lat: at.lat, lng: at.lng, displayName: id, avatarUrl: null });
const ids = (r: { current: { travelers: Array<{ id: string }> } }) => r.current.travelers.map((t) => t.id);
const deferred = () => { let resolve: (v: any) => void = () => {}; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const hook = () => renderHook((p: { lat: number; lng: number }) => useMapTravelers({ lat: p.lat, lng: p.lng, enabled: true }), { initialProps: LISBON });

describe("§123 (B45): the travelers layer keeps no other centre's travelers over a failed read", () => {
  beforeEach(() => { mockGet.mockReset(); });

  it('MV1 Lisbon read, the map moves to Porto, the Porto read FAILS → no rows, the failure said', async () => {
    mockGet.mockImplementation((lat: number) => Promise.resolve(lat > 40 ? { ok: false, error: 'Request failed (503)' } : { ok: true, data: [T('lisbon-a'), T('lisbon-b')] }));
    const { result, rerender } = await hook();
    await waitFor(() => expect(ids(result)).toEqual(['lisbon-a', 'lisbon-b']));
    await rerender(PORTO);
    await waitFor(() => expect(result.current.error).toBe('Request failed (503)'));
    expect(ids(result)).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('MV2 CONTROL: a refresh of the same centre FAILS → the rows stay and the failure is said', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, data: [T('lisbon-a')] }).mockResolvedValue({ ok: false, error: 'offline' });
    const { result } = await hook();
    await waitFor(() => expect(ids(result)).toEqual(['lisbon-a']));
    await act(async () => { result.current.refresh(); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.error).toBe('offline');
    expect(ids(result)).toEqual(['lisbon-a']);
  });

  it('MV3 CONTROL: a small pan inside the city, that read FAILS → the rows stay', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, data: [T('lisbon-a')] }).mockResolvedValue({ ok: false, error: 'offline' });
    const { result, rerender } = await hook();
    await waitFor(() => expect(ids(result)).toEqual(['lisbon-a']));
    await rerender(ALFAMA);
    await act(async () => { result.current.refresh(); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.error).toBe('offline');
    expect(ids(result)).toEqual(['lisbon-a']);
  });

  it("MV4 after a failed Porto read, the next Porto read answers → Porto's rows, no error", async () => {
    let portoReads = 0;
    mockGet.mockImplementation((lat: number) => {
      if (lat <= 40) return Promise.resolve({ ok: true, data: [T('lisbon-a')] });
      portoReads += 1;
      return Promise.resolve(portoReads === 1 ? { ok: false, error: 'offline' } : { ok: true, data: [T('porto-a', PORTO)] });
    });
    const { result, rerender } = await hook();
    await waitFor(() => expect(ids(result)).toEqual(['lisbon-a']));
    await rerender(PORTO);
    await waitFor(() => expect(result.current.error).toBe('offline'));
    expect(ids(result)).toEqual([]);
    await act(async () => { result.current.refresh(); await new Promise((r) => setTimeout(r, 10)); });
    expect(ids(result)).toEqual(['porto-a']);
    expect(result.current.error).toBeNull();
  });

  it('MV5 a cut Lisbon read, then a failed Porto read → truncated is cleared with the rows', async () => {
    mockGet.mockImplementation((lat: number) => Promise.resolve(lat > 40 ? { ok: false, error: 'offline' } : { ok: true, data: [T('lisbon-a')], truncated: true }));
    const { result, rerender } = await hook();
    await waitFor(() => expect(result.current.truncated).toBe(true));
    await rerender(PORTO);
    await waitFor(() => expect(result.current.error).toBe('offline'));
    expect(ids(result)).toEqual([]);
    expect(result.current.truncated).toBe(false);
  });

  it('MV6 the Lisbon rows are kept while the Porto read is in flight, and go when it fails', async () => {
    const porto = deferred();
    mockGet.mockImplementation((lat: number) => (lat > 40 ? porto.promise : Promise.resolve({ ok: true, data: [T('lisbon-a')] })));
    const { result, rerender } = await hook();
    await waitFor(() => expect(ids(result)).toEqual(['lisbon-a']));
    await rerender(PORTO);
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(ids(result)).toEqual(['lisbon-a']);
    await act(async () => { porto.resolve({ ok: false, error: 'offline' }); await new Promise((r) => setTimeout(r, 10)); });
    expect(ids(result)).toEqual([]);
    expect(result.current.error).toBe('offline');
  });
});
