/**
 * census-discovery §112 (DV-83 round 15, lane W11-X2, D-W11X2-127): the Discovery map's travelers layer never says
 * "no travelers" over a failed read, never keeps a failed refresh silent, and never lets an older centre's answer
 * land over a newer one.
 *
 *   TR1  a failed first read → `error` is set and nothing is claimed
 *   TR2  a failed refresh after a good read → the rows stay AND `error` says the refresh failed (was: kept silently)
 *   TR3  the centre moves while the old read is in flight → the new centre is read, and the old answer is dropped
 *   TRc  CONTROL: a healthy read → the rows, no error
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockGet = jest.fn();
// NOTE: exhaustive on purpose — the hook imports only getMapTravelers from here, and the real module pulls in the app's auth client.
jest.mock('../../services/mapTravelers.ts', () => ({ getMapTravelers: (...a: unknown[]) => mockGet(...a) }));

import { useMapTravelers } from '../useMapTravelers.ts';

const T = (id: string, lat = 38.72, lng = -9.14) => ({ id, lat, lng, displayName: id, avatarUrl: null });
const deferred = () => { let resolve: (v: any) => void = () => {}; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

describe('§112: the travelers layer over a failed or stale read (D-W11X2-127)', () => {
  beforeEach(() => { mockGet.mockReset(); });

  it('TR1 a failed first read → error, no rows', async () => {
    mockGet.mockResolvedValue({ ok: false, error: 'Request failed (503)' });
    const { result } = await renderHook(() => useMapTravelers({ lat: 38.72, lng: -9.14, enabled: true }));
    await waitFor(() => expect(result.current.error).toBe('Request failed (503)'));
    expect(result.current.travelers).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('TR2 a failed refresh after a good read → the rows stay and the failure is said', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, data: [T('a')] }).mockResolvedValueOnce({ ok: false, error: 'offline' });
    const { result } = await renderHook(() => useMapTravelers({ lat: 38.72, lng: -9.14, enabled: true }));
    await waitFor(() => expect(result.current.travelers.map((t: any) => t.id)).toEqual(['a']));
    await act(async () => { result.current.refresh(); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.error).toBe('offline');
    expect(result.current.travelers.map((t: any) => t.id)).toEqual(['a']);
  });

  it("TR3 the centre moves while the old read is in flight → the new centre is read and the old answer dropped", async () => {
    const lisbon = deferred();
    mockGet.mockImplementation((lat: number) => (lat > 40 ? Promise.resolve({ ok: true, data: [T('porto', 41.15, -8.61)] }) : lisbon.promise));
    const { result, rerender } = await renderHook((p: { lat: number; lng: number }) => useMapTravelers({ lat: p.lat, lng: p.lng, enabled: true }), { initialProps: { lat: 38.72, lng: -9.14 } });
    await rerender({ lat: 41.15, lng: -8.61 });
    await waitFor(() => expect(result.current.travelers.map((t: any) => t.id)).toEqual(['porto']));
    await act(async () => { lisbon.resolve({ ok: true, data: [T('lisbon')] }); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.travelers.map((t: any) => t.id)).toEqual(['porto']);
  });

  it('TRc CONTROL: a healthy read → the rows, no error', async () => {
    mockGet.mockResolvedValue({ ok: true, data: [T('a'), T('b')] });
    const { result } = await renderHook(() => useMapTravelers({ lat: 38.72, lng: -9.14, enabled: true }));
    await waitFor(() => expect(result.current.travelers.length).toBe(2));
    expect(result.current.error).toBeNull();
  });
});
