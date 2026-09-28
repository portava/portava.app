/**
 * useCompassFeed — a Compass feed is shown only for the section and city it
 * was read for (census-discovery §101, lane W11-X2 round 5; DV-83, the round's
 * adversarial sweep; register D-W11X2-34).
 *
 * With `discovery_for_you_pde_enabled` FALSE (3455, production's state) the For
 * You tab of a signed-in viewer is upgraded to this hook's feed. The hook kept
 * ONE feed per viewer: the AsyncStorage entry was keyed by user alone (not by
 * section, not by city) and seeded `data` on mount, and a failed read kept
 * whatever `data` held. So after a city switch whose Compass read failed — or on
 * a mount whose cached feed was another city's, or another section's
 * (CompassPicksSection reads a different section through the same hook) — the
 * For You tab drew another city's recommendations as this city's, with no word
 * that this city's read failed. The feed now carries the scope it was read for,
 * the cache is only replayed into the same scope, and `data` / `error` are only
 * returned for the scope asked.
 *
 *   H1  a cached feed is asked for under this section and city, and written under it
 *   H2  city A answered, switch to B: A's feed is never returned for B, even before B's read settles
 *   H3  B's read fails: no data, and B's error — never A's feed
 *   H4  the same scope, a failed refresh: the feed is kept, and the error is said
 *   H5  another section's feed (same viewer, same city) is not returned
 *   H6  A's read failed, switch to B (in flight): A's error is not returned for B
 *   C1  CONTROL: a good read for B returns B's feed, no error
 *
 * Run with: npx jest src/hooks/compass/__tests__/useCompassFeed.scope.component.test.tsx
 */
import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockFetchCompassSection = jest.fn();
const mockGetCachedFeed = jest.fn();
const mockSetCachedFeed = jest.fn();

// NOTE: intentionally exhaustive — the real module reaches the network and
// AsyncStorage at call time; the hook imports only these three functions.
jest.mock('../../../services/compass.ts', () => ({
  fetchCompassSection: (...a: unknown[]) => mockFetchCompassSection(...a),
  getCachedFeed: (...a: unknown[]) => mockGetCachedFeed(...a),
  setCachedFeed: (...a: unknown[]) => mockSetCachedFeed(...a),
}));
// NOTE: intentionally exhaustive — SessionContext initialises Supabase.
jest.mock('../../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: 'viewer-1', isAuthed: true }),
}));

import { useCompassFeed } from '../useCompassFeed.ts';

const feed = (tag: string) => ({ sections: [{ name: 'for_you', items: [{ id: tag }] }], nextCursor: null, fallback: false, compassEnabled: true, safeItems: [] });
const firstId = (d: unknown) => (d as { sections: Array<{ items: Array<{ id: string }> }> } | null)?.sections[0]?.items[0]?.id ?? null;

beforeEach(() => {
  mockFetchCompassSection.mockReset(); mockFetchCompassSection.mockReturnValue(new Promise(() => {}));
  mockGetCachedFeed.mockReset(); mockGetCachedFeed.mockResolvedValue(null);
  mockSetCachedFeed.mockReset(); mockSetCachedFeed.mockResolvedValue(undefined);
});

describe('useCompassFeed — a feed is shown only for the scope it was read for (DV-83, §101)', () => {
  it('H1 a cached feed is asked for under this section and city, and written under it', async () => {
    mockFetchCompassSection.mockResolvedValueOnce({ ok: true, data: feed('a') });
    const { result } = await renderHook(() => useCompassFeed({ section: 'for_you', city: 'Lisbon' }));
    await waitFor(() => expect(firstId(result.current.data)).toBe('a'));
    expect(mockGetCachedFeed).toHaveBeenCalledWith('viewer-1', 'for_you:lisbon');
    expect(mockSetCachedFeed).toHaveBeenCalledWith('viewer-1', feed('a'), 'for_you:lisbon');
  });

  it('H2 city A answered, switch to B: A\'s feed is never returned for B, even before B\'s read settles', async () => {
    mockFetchCompassSection.mockResolvedValueOnce({ ok: true, data: feed('a') });
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCompassFeed({ section: 'for_you', city: c }), { initialProps: { c: 'Lisbon' } });
    await waitFor(() => expect(firstId(result.current.data)).toBe('a'));
    await act(async () => { rerender({ c: 'Porto' }); });
    expect(result.current.data).toBeNull();
  });

  it('H3 B\'s read fails: no data, and B\'s error — never A\'s feed', async () => {
    mockFetchCompassSection.mockResolvedValueOnce({ ok: true, data: feed('a') });
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCompassFeed({ section: 'for_you', city: c }), { initialProps: { c: 'Lisbon' } });
    await waitFor(() => expect(firstId(result.current.data)).toBe('a'));
    mockFetchCompassSection.mockResolvedValueOnce({ ok: false, error: 'network_error' });
    await act(async () => { rerender({ c: 'Porto' }); });
    await waitFor(() => expect(result.current.error).toBe('network_error'));
    expect(result.current.data).toBeNull();
  });

  it('H4 the same scope, a failed refresh: the feed is kept, and the error is said', async () => {
    mockFetchCompassSection.mockResolvedValueOnce({ ok: true, data: feed('a') });
    const { result } = await renderHook(() => useCompassFeed({ section: 'for_you', city: 'Lisbon' }));
    await waitFor(() => expect(firstId(result.current.data)).toBe('a'));
    mockFetchCompassSection.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await act(async () => { result.current.refresh(); });
    await waitFor(() => expect(result.current.error).toBe('timeout'));
    expect(firstId(result.current.data)).toBe('a');
  });

  it('H5 another section\'s feed (same viewer, same city) is not returned', async () => {
    mockFetchCompassSection.mockResolvedValueOnce({ ok: true, data: feed('picks') });
    const { result, rerender } = await renderHook(({ s }: { s: string }) => useCompassFeed({ section: s, city: 'Lisbon' }), { initialProps: { s: 'picks' } });
    await waitFor(() => expect(firstId(result.current.data)).toBe('picks'));
    await act(async () => { rerender({ s: 'for_you' }); });
    expect(result.current.data).toBeNull();
  });

  it('C1 CONTROL a good read for B returns B\'s feed, no error', async () => {
    mockFetchCompassSection.mockResolvedValueOnce({ ok: true, data: feed('a') });
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCompassFeed({ section: 'for_you', city: c }), { initialProps: { c: 'Lisbon' } });
    await waitFor(() => expect(firstId(result.current.data)).toBe('a'));
    mockFetchCompassSection.mockResolvedValueOnce({ ok: true, data: feed('b') });
    await act(async () => { rerender({ c: 'Porto' }); });
    await waitFor(() => expect(firstId(result.current.data)).toBe('b'));
    expect(result.current.error).toBeNull();
  });

  it('H6 A\'s read failed, switch to B (in flight): A\'s error is not returned for B', async () => {
    mockFetchCompassSection.mockResolvedValueOnce({ ok: false, error: 'a_failed' });
    const { result, rerender } = await renderHook(({ c }: { c: string }) => useCompassFeed({ section: 'for_you', city: c }), { initialProps: { c: 'Lisbon' } });
    await waitFor(() => expect(result.current.error).toBe('a_failed'));
    await act(async () => { rerender({ c: 'Porto' }); });
    expect(result.current.error).toBeNull();
  });
});
