/**
 * useSearchSuggestions — held groups belong to the query they were read for
 * (census-discovery §102, lane W11-X2 round 6; DV-83; register D-W11X2-42).
 *
 * §100 made a failed suggest read say `refused` and keep whatever groups were
 * on screen. Those groups are the answer to the PREVIOUS query: under the
 * current query they were drawn as its suggestions, with "Suggestions are
 * unavailable right now" beneath them — a failure stated over the wrong rows
 * (the shape the verifier's V5-R4 found on the category tab). A failed read for
 * another query now holds nothing; the panel's "Search for …" row stays, and
 * the unavailable line says why there is nothing more.
 *
 *   Q1  transport failure for a new query: the previous query's groups are dropped, refused
 *   Q2  a `nothing` refusal for a new query: the same
 *   Q3  in flight for a new query: the previous groups stay (typing never flashes empty)
 *   C1  (restated §103, D-W11X2-52) the same text at ANOTHER location, failing: that location's groups were never read — dropped, refused
 *   C2  CONTROL: a partial answer carries its own groups
 *   C3  (restated §103) groups replayed from the cache are this query's: the same query re-asked after the cache expired, failing, keeps them;
 *       the same text at another location, failing, does not
 *   L1  §103: a city change (same coordinates) is another query — no cached groups of the other city, and a failure drops them
 *   L2  §103 CONTROL: back to the first city is a cache hit for ITS groups (the city is in the cache key, not only the held key)
 *
 * Run with: npx jest src/hooks/__tests__/useSearchSuggestions.heldQuery.component.test.tsx
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockGetSearchSuggestions = jest.fn();

// NOTE: exhaustive on purpose — spreading requireActual pulls in supabase/apiToken
// native deps at module load; the hook imports exactly one runtime binding.
jest.mock('../../services/discovery.ts', () => ({
  getSearchSuggestions: (...args: unknown[]) => mockGetSearchSuggestions(...args),
}));

import { useSearchSuggestions } from '../useSearchSuggestions.ts';

function group(id: string) {
  return { title: `Group ${id}`, items: [{ id, label: `Item ${id}`, type: 'place' }] };
}
const NET_FAIL = { ok: false, aborted: false, error: 'Network error' };
const REFUSAL_NOTHING = { class: 'transient_db', code: 'suggest_failed', route: 'GET /discovery/suggest', coverage: 'nothing' };
const PAST_DEBOUNCE = { timeout: 3000 };

beforeEach(() => { jest.clearAllMocks(); mockGetSearchSuggestions.mockReset(); });

describe('useSearchSuggestions — held groups belong to their query (DV-83, §102)', () => {
  it('Q1 transport failure for a new query: the previous query\'s groups are dropped, refused', async () => {
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearchSuggestions(q, {}), { initialProps: { q: 'lis' } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    await act(async () => { rerender({ q: 'lisb' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(true);
    expect(result.current.groups).toEqual([]);
  });

  it('Q2 a `nothing` refusal for a new query: the same', async () => {
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearchSuggestions(q, {}), { initialProps: { q: 'por' } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [], refusal: REFUSAL_NOTHING });
    await act(async () => { rerender({ q: 'port' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(true);
    expect(result.current.groups).toEqual([]);
  });

  it('Q3 in flight for a new query: the previous groups stay', async () => {
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearchSuggestions(q, {}), { initialProps: { q: 'fa' } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockReturnValue(new Promise(() => {}));
    await act(async () => { rerender({ q: 'far' }); });
    expect(result.current.loading).toBe(true);
    expect(result.current.groups).toHaveLength(1);
  });

  // §103 (D-W11X2-52) RESTATED. This case pinned §102's "same text ⇒ same query" rule: groups read at lat 38.7 were kept
  // under a failure at lat 40.2 (~170 km away). Those are another location's suggestions drawn under this location's
  // failure — the verifier's §102.11 possible — so the groups are now dropped. `refused` is asserted exactly as before.
  it('C1 (restated §103) the same text at ANOTHER location, failing: that location\'s groups are dropped, refused', async () => {
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(({ lat }: { lat: number }) => useSearchSuggestions('sintra', { lat, lng: -9.1 }), { initialProps: { lat: 38.7 } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    await act(async () => { rerender({ lat: 40.2 }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(true);
    expect(result.current.groups).toHaveLength(0);
  });

  it('C2 CONTROL a partial answer carries its own groups', async () => {
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearchSuggestions(q, {}), { initialProps: { q: 'ob' } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [group('g2')], refusal: { ...REFUSAL_NOTHING, coverage: 'partial' } });
    await act(async () => { rerender({ q: 'obi' }); });
    await waitFor(() => expect(result.current.incomplete).toBe(true), PAST_DEBOUNCE);
    expect(result.current.groups.map((g) => g.items[0]!.id)).toEqual(['g2']);
  });

  // §103 (D-W11X2-52) RESTATED. The cache-replay half is kept (G-M4's kill): a replayed page marks its query, so the
  // same query re-asked after the cache expired and failing keeps it. The location-change half now drops (as C1).
  it('C3 (restated §103) groups replayed from the cache are this query\'s: the same query, expired and failing, keeps them; another location does not', async () => {
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('m1')] });
      const { result, rerender } = await renderHook(({ q, lat }: { q: string; lat: number }) => useSearchSuggestions(q, { lat, lng: -9.1 }), { initialProps: { q: 'mafra', lat: 38.7 } });
      await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
      mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('m2')] });
      await act(async () => { rerender({ q: 'mafrax', lat: 38.7 }); });
      await waitFor(() => expect(result.current.groups[0]!.items[0]!.id).toBe('m2'), PAST_DEBOUNCE);
      await act(async () => { rerender({ q: 'mafra', lat: 38.7 }); });
      expect(result.current.groups[0]!.items[0]!.id).toBe('m1');  // replayed from the cache, no fetch
      expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2);
      clock += 61_000;  // the entry expires; the same rounded position re-asks
      mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
      await act(async () => { rerender({ q: 'mafra', lat: 38.701 }); });
      await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(3), PAST_DEBOUNCE);
      await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
      expect(result.current.refused).toBe(true);
      expect(result.current.groups[0]!.items[0]!.id).toBe('m1');
      await act(async () => { rerender({ q: 'mafra', lat: 40.2 }); });
      await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(4), PAST_DEBOUNCE);
      await waitFor(() => expect(result.current.groups).toHaveLength(0), PAST_DEBOUNCE);
      expect(result.current.refused).toBe(true);
    } finally { Date.now = realNow; }
  });

  it('L1 §103: a city change at the same coordinates is another query — the other city\'s cached groups are not replayed, and a failure drops them', async () => {
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('lis')] });
    const { result, rerender } = await renderHook(({ city }: { city: string }) => useSearchSuggestions('cafe', { lat: 38.7, lng: -9.1, city }), { initialProps: { city: 'Lisbon' } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    await act(async () => { rerender({ city: 'Porto' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    expect(mockGetSearchSuggestions.mock.calls[1]![1]).toEqual(expect.objectContaining({ city: 'Porto' }));
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(true);
    expect(result.current.groups).toHaveLength(0);
  });

  it('L2 §103 CONTROL: back to the first city is a cache hit for ITS groups (no fetch)', async () => {
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('lis')] });
    const { result, rerender } = await renderHook(({ city }: { city: string }) => useSearchSuggestions('cafe', { lat: 38.7, lng: -9.1, city }), { initialProps: { city: 'Lisbon' } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('opo')] });
    await act(async () => { rerender({ city: 'Porto' }); });
    await waitFor(() => expect(result.current.groups[0]!.items[0]!.id).toBe('opo'), PAST_DEBOUNCE);
    await act(async () => { rerender({ city: 'Lisbon' }); });
    expect(result.current.groups[0]!.items[0]!.id).toBe('lis');
    expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2);
  });
});
