/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-129): the Discovery map's travelers layer carries the
 * server's "this layer is cut" marker from GET /map/travelers to the screen.
 *
 *   TC1  the service reads `truncated: true` off a 200 body
 *   TC2  the hook exposes `truncated` for a cut read, and a later whole read clears it
 *   TC3  a failed refresh after a cut read keeps the marker beside the kept rows
 *   TCc  CONTROL: a whole body (no `truncated` key) → the service says `truncated: false`, the hook too
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockGet = jest.fn();
// NOTE: exhaustive on purpose — the hook imports only getMapTravelers from here; TC1/TCc reach the real module
// through jest.requireActual, over the two mocks below.
jest.mock('../../services/mapTravelers.ts', () => ({ getMapTravelers: (...a: unknown[]) => mockGet(...a) }));
// NOTE: exhaustive on purpose — the real client pulls native storage; the service reads only these two names.
jest.mock('../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: exhaustive on purpose — the service reads only freshToken from here.
jest.mock('../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { useMapTravelers } from '../useMapTravelers.ts';

const T = (id: string) => ({ id, lat: 38.72, lng: -9.14, displayName: id, avatarUrl: null });
const realService = () => jest.requireActual('../../services/mapTravelers.ts') as typeof import('../../services/mapTravelers.ts');

describe('§113: the travelers layer over a cut scan (D-W11X2-129)', () => {
  const env = process.env.EXPO_PUBLIC_API_BASE_URL;
  const fetchBefore = global.fetch;
  beforeEach(() => { mockGet.mockReset(); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
  afterEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = env; global.fetch = fetchBefore; });

  it('TC1 the service reads `truncated: true` off a 200 body', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ travelers: [T('a')], generatedAt: 'x', truncated: true }) })) as any;
    const r = await realService().getMapTravelers(38.72, -9.14, 50);
    expect(r).toEqual({ ok: true, data: [T('a')], truncated: true });
  });

  it('TCc CONTROL: a whole body → truncated false, in the service and the hook', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ travelers: [T('a')], generatedAt: 'x' }) })) as any;
    const r: any = await realService().getMapTravelers(38.72, -9.14, 50);
    expect(r.ok).toBe(true); expect(r.data).toEqual([T('a')]); expect(r.truncated ?? false).toBe(false);
    mockGet.mockResolvedValue({ ok: true, data: [T('a')], truncated: false });
    const { result } = await renderHook(() => useMapTravelers({ lat: 38.72, lng: -9.14, enabled: true }));
    await waitFor(() => expect(result.current.travelers.length).toBe(1));
    expect((result.current as any).truncated ?? false).toBe(false);
  });

  it('TC2 the hook exposes a cut read, and a later whole read clears it', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, data: [], truncated: true }).mockResolvedValueOnce({ ok: true, data: [T('a')], truncated: false });
    const { result } = await renderHook(() => useMapTravelers({ lat: 38.72, lng: -9.14, enabled: true }));
    await waitFor(() => expect(result.current.truncated).toBe(true));
    expect(result.current.travelers).toEqual([]);
    await act(async () => { result.current.refresh(); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.truncated).toBe(false);
    expect(result.current.travelers.map((t: any) => t.id)).toEqual(['a']);
  });

  it('TC3 a failed refresh after a cut read keeps the marker beside the kept rows', async () => {
    mockGet.mockResolvedValueOnce({ ok: true, data: [T('a')], truncated: true }).mockResolvedValueOnce({ ok: false, error: 'offline' });
    const { result } = await renderHook(() => useMapTravelers({ lat: 38.72, lng: -9.14, enabled: true }));
    await waitFor(() => expect(result.current.truncated).toBe(true));
    await act(async () => { result.current.refresh(); await new Promise((r) => setTimeout(r, 10)); });
    expect(result.current.error).toBe('offline');
    expect(result.current.truncated).toBe(true);
    expect(result.current.travelers.map((t: any) => t.id)).toEqual(['a']);
  });
});
