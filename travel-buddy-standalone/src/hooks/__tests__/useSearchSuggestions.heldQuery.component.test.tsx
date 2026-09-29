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
 *   C1  CONTROL: the same text re-asked (another location) and failing keeps its own groups, refused
 *   C2  CONTROL: a partial answer carries its own groups
 *   C3  CONTROL: groups replayed from the cache are this query's, and a failure re-asking the same text keeps them
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

  it('C1 CONTROL the same text re-asked (another location) and failing keeps its own groups, refused', async () => {
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(({ lat }: { lat: number }) => useSearchSuggestions('sintra', { lat, lng: -9.1 }), { initialProps: { lat: 38.7 } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    await act(async () => { rerender({ lat: 40.2 }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(true);
    expect(result.current.groups).toHaveLength(1);
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

  it('C3 CONTROL groups replayed from the cache are this query\'s: a failure re-asking the same text keeps them', async () => {
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('m1')] });
    const { result, rerender } = await renderHook(({ q, lat }: { q: string; lat: number }) => useSearchSuggestions(q, { lat, lng: -9.1 }), { initialProps: { q: 'mafra', lat: 38.7 } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValueOnce({ ok: true, groups: [group('m2')] });
    await act(async () => { rerender({ q: 'mafrax', lat: 38.7 }); });
    await waitFor(() => expect(result.current.groups[0]!.items[0]!.id).toBe('m2'), PAST_DEBOUNCE);
    await act(async () => { rerender({ q: 'mafra', lat: 38.7 }); });
    expect(result.current.groups[0]!.items[0]!.id).toBe('m1');
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    await act(async () => { rerender({ q: 'mafra', lat: 40.2 }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(3), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(true);
    expect(result.current.groups).toHaveLength(1);
  });
});
