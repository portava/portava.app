/**
 * useSearchSuggestions — a refused suggest read is not an empty typeahead.
 *
 * OWNER RULING, 2026-09-14: "Do not cache rate limits or outages as 'this
 * location does not exist.'" and "A distinguishable response body alone is
 * insufficient if consumers still treat it as successful empty data."
 *
 * `getSearchSuggestions` already does its half: it PARSES the refusal off the
 * body and returns it (`services/discovery.ts:1120#parseRefusal`). This hook
 * branched on `res.ok` alone, and a refusal is `ok: true` with `groups: []` —
 * so it sailed through as a perfectly good empty answer and did two things the
 * ruling forbids:
 *
 *   1. CACHED it, for 60 seconds, keyed on the query. Backspacing to that query
 *      then replayed the outage from memory with no network call able to notice
 *      the server had recovered.
 *   2. FLASHED EMPTY, replacing whatever was on screen — against this file's own
 *      stated contract, "the panel never flashes empty mid-typing".
 *
 * `coverage: 'nothing'` means the server did not read the table; the empty
 * `groups` are padding, not a result. A `partial` refusal IS cached and IS
 * rendered, because the groups it carries are real — the same line
 * `useCommunityDiscovery` draws.
 *
 * Run with: pnpm test:component
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

const mockGetSearchSuggestions = jest.fn();

// NOTE: exhaustive on purpose — spreading requireActual pulls in
// supabase/apiToken native deps at module load. This hook imports exactly one
// runtime binding from the module; its other imports are types, erased.
jest.mock('../../services/discovery.ts', () => ({
  getSearchSuggestions: (...args: unknown[]) => mockGetSearchSuggestions(...args),
}));

import { useSearchSuggestions } from '../useSearchSuggestions.ts';

const REFUSAL_NOTHING = {
  class: 'transient_db',
  code: 'suggest_read_failed',
  route: 'GET /discovery/suggest',
  coverage: 'nothing' as const,
};

const REFUSAL_PARTIAL = {
  class: 'transient_db',
  code: 'suggest_one_source_failed',
  route: 'GET /discovery/suggest',
  coverage: 'partial' as const,
};

function group(id: string) {
  return { title: `Group ${id}`, items: [{ id, label: `Item ${id}`, type: 'place' }] };
}

/** The hook debounces 250ms; every assertion has to get past it. */
const PAST_DEBOUNCE = { timeout: 3000 };

beforeEach(() => { jest.clearAllMocks(); });

describe('useSearchSuggestions — a refusal is not a cacheable empty typeahead', () => {
  it('OUTAGE: does not CACHE a refused read as "this query has no suggestions"', async () => {
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [], refusal: REFUSAL_NOTHING });

    const { rerender } = await renderHook(
      ({ q }: { q: string }) => useSearchSuggestions(q, {}),
      { initialProps: { q: 'kopi' } },
    );
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);

    // Move away and back. The cache is keyed on the query and lives 60s, so if
    // the refusal entered it, the second visit is served from memory and the
    // call count STAYS AT ONE.
    await act(async () => { rerender({ q: 'kopitiam' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);

    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [group('g1')] });
    await act(async () => { rerender({ q: 'kopi' }); });

    await waitFor(
      () => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(3),
      PAST_DEBOUNCE,
    );
  });

  it('OUTAGE: does not FLASH EMPTY over groups already on screen', async () => {
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useSearchSuggestions(q, {}),
      { initialProps: { q: 'kopi' } },
    );
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);

    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [], refusal: REFUSAL_NOTHING });
    await act(async () => { rerender({ q: 'kopit' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);

    // The server did not look. Emptying the panel would state, on the server's
    // behalf, that there is nothing to find.
    expect(result.current.groups).toHaveLength(1);
    expect(result.current.refused).toBe(true);
  });

  it('CONTROL: a genuinely empty answer IS cached and IS rendered empty', async () => {
    // No refusal on the body: the server looked and found nothing. That is a
    // result, and treating it as one is the whole point of the distinction.
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [] });

    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useSearchSuggestions(q, {}),
      { initialProps: { q: 'zzzz' } },
    );
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.groups).toHaveLength(0);
    expect(result.current.refused).toBe(false);

    await act(async () => { rerender({ q: 'zzzzz' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await act(async () => { rerender({ q: 'zzzz' }); });

    // Served from cache — still 2, not 3.
    await new Promise((r) => setTimeout(r, 600));
    expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: a PARTIAL refusal carries real groups, so it is rendered and cached', async () => {
    mockGetSearchSuggestions.mockResolvedValue({
      ok: true, groups: [group('p1')], refusal: REFUSAL_PARTIAL,
    });

    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useSearchSuggestions(q, {}),
      { initialProps: { q: 'satay' } },
    );
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(false);

    await act(async () => { rerender({ q: 'satayy' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await act(async () => { rerender({ q: 'satay' }); });

    await new Promise((r) => setTimeout(r, 600));
    expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2);
  });
});
