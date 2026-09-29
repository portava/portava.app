/**
 * useSearchSuggestions — a suggest read that FAILED in transport is not "no
 * quick matches" (census-discovery §100, lane W11-X2 round 4; DV-83, the
 * round's adversarial sweep; register D-W11X2-26).
 *
 * The hook's transport-error arm kept whatever groups were on screen and set
 * `loading` false — and nothing else. So with nothing on screen the panel drew
 * its empty sentence, "No quick matches yet — keep typing, or search
 * everything", about a read that never happened; and with the PREVIOUS query's
 * groups on screen it presented them as this query's answer. Its refusal arm,
 * one branch up, says it handles a refusal "identically to the transport-error
 * arm below" and raises `refused`, which the panel renders as "Suggestions are
 * unavailable right now — the full search above still works." The transport
 * arm now raises the same flag: to the panel both are a read with no answer.
 *
 *   S1  transport failure with nothing on screen: refused (the panel's unavailable line), no groups
 *   S2  transport failure over the previous query's groups: refused, and the groups dropped — RESTATED
 *       by census-discovery §102 (D-W11X2-42): they were the previous query's answer, not this one's
 *   S3  a good read after a failure clears it
 *   S4  the failure is not cached: returning to the query asks again
 *   C1  CONTROL: an ABORTED read (a newer keystroke) is not a failure
 *   C2  CONTROL: a genuinely empty answer is not refused
 *
 * Run with: npx jest src/hooks/__tests__/useSearchSuggestions.failedRead.component.test.tsx
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

function group(id: string) {
  return { title: `Group ${id}`, items: [{ id, label: `Item ${id}`, type: 'place' }] };
}
const NET_FAIL = { ok: false, aborted: false, error: 'Network error' };
const PAST_DEBOUNCE = { timeout: 3000 };

beforeEach(() => { jest.clearAllMocks(); });

describe('useSearchSuggestions — a transport failure is said, never "no quick matches" (§100, D-W11X2-26)', () => {
  it('S1 transport failure with nothing on screen: refused, no groups', async () => {
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    const { result } = await renderHook(() => useSearchSuggestions('ramen', {}));
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.groups).toEqual([]);
    expect(result.current.refused).toBe(true);
  });

  it('S2 transport failure over the previous query\'s groups: refused, groups dropped (restated, §102)', async () => {
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [group('g1')] });
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearchSuggestions(q, {}), { initialProps: { q: 'sushi' } });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    await act(async () => { rerender({ q: 'sushii' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.groups).toHaveLength(0);  // §102 (D-W11X2-42): was toHaveLength(1) — 'sushi''s groups are not 'sushii''s answer
    expect(result.current.refused).toBe(true);
  });

  it('S3 a good read after a failure clears it', async () => {
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    const { result, rerender } = await renderHook(({ q }: { q: string }) => useSearchSuggestions(q, {}), { initialProps: { q: 'tacos' } });
    await waitFor(() => expect(result.current.refused).toBe(true), PAST_DEBOUNCE);
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [group('g2')] });
    await act(async () => { rerender({ q: 'tacoss' }); });
    await waitFor(() => expect(result.current.groups).toHaveLength(1), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(false);
  });

  it('S4 the failure is not cached: returning to the query asks again', async () => {
    mockGetSearchSuggestions.mockResolvedValue(NET_FAIL);
    const { rerender } = await renderHook(({ q }: { q: string }) => useSearchSuggestions(q, {}), { initialProps: { q: 'pho' } });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);
    await act(async () => { rerender({ q: 'phoo' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(2), PAST_DEBOUNCE);
    await act(async () => { rerender({ q: 'pho' }); });
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(3), PAST_DEBOUNCE);
  });

  it('C1 CONTROL: an ABORTED read (a newer keystroke) is not a failure', async () => {
    mockGetSearchSuggestions.mockResolvedValue({ ok: false, aborted: true, error: 'Network error' });
    const { result } = await renderHook(() => useSearchSuggestions('bao', {}));
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(result.current.refused).toBe(false);
  });

  it('C2 CONTROL: a genuinely empty answer is not refused', async () => {
    mockGetSearchSuggestions.mockResolvedValue({ ok: true, groups: [] });
    const { result } = await renderHook(() => useSearchSuggestions('zzzz', {}));
    await waitFor(() => expect(mockGetSearchSuggestions).toHaveBeenCalledTimes(1), PAST_DEBOUNCE);
    await waitFor(() => expect(result.current.loading).toBe(false), PAST_DEBOUNCE);
    expect(result.current.refused).toBe(false);
    expect(result.current.groups).toEqual([]);
  });
});
