/**
 * useGlobalSearchSuggestions — census-discovery §80 round 3, A08 clause 2:
 * with a MISSING policy the search screen still searches.
 *
 * THE DEFECT THIS PINS
 * ====================
 * The verifier's words: "with a missing policy, neither the gateway nor the
 * fallback runs." `useInputAssistance` resolves the field policy from the
 * policy store. When the store holds no authoritative snapshot (never fetched,
 * the fetch failed, another account's table, past the 12 h expiry, or a newer
 * `policyVersion` noted) that policy is the CONSERVATIVE one, whose `minChars`
 * is unreachable, so the gateway hook returns before any request with
 * `unavailable = false`. The legacy typeahead ran only while the gateway was
 * `unavailable`, so it never started either: the search bar was dead until the
 * app was restarted or the viewer signed in again.
 *
 * Every other test of this hook mocks `useInputAssistance`, which is exactly
 * why none of them could see this. These run the REAL gateway hook inside the
 * REAL search hook and mock only the network edges: the legacy request, the
 * gateway request and the policy fetch.
 *
 * The decision (register D-W10-S1-4, "The missing policy"): a non-authoritative
 * `global_search` policy counts as the gateway being unavailable, so the legacy
 * typeahead runs; a stale or failed policy is refetched on use (at most once per
 * `POLICY_RETRY_MIN_GAP_MS`), and a mounted screen picks the new table up.
 *
 * Reachable from: the global search screen — `app/search.tsx` consumes this hook.
 *
 * Run with: pnpm test:component
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

/** Every legacy typeahead request the hook actually issues. */
const mockLegacyFetches: string[] = [];

// NOTE: intentionally exhaustive — services/discovery pulls in Supabase/apiToken
// native internals at module load, and the legacy hook imports exactly this one
// function from it.
jest.mock('../../services/discovery.ts', () => ({
  getSearchSuggestions: jest.fn(async (q: string) => {
    mockLegacyFetches.push(q);
    return { ok: true, groups: [{ title: 'Places', items: [{ id: `legacy-${q}`, label: `legacy ${q}` }] }] };
  }),
}));

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper at module load. `requestSuggestions` is its only
// export. This is the GATEWAY's network edge; the gateway hook itself is real.
jest.mock('../../platform/input-assistance/services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));

import { requestSuggestions } from '../../platform/input-assistance/services/inputAssistance.ts';
import {
  sharedPolicyStore,
  _seedPolicyForTests,
  _PERMISSIVE_TEST_POLICY,
  _TEST_ACCOUNT,
} from '../../platform/input-assistance/services/policyStore.ts';
import { bindPolicyRefreshOnUse, _resetPolicyRefreshOnUseForTests } from '../../platform/input-assistance/services/policyRefreshOnUse.ts';
import { sharedSuggestionCache } from '../../platform/input-assistance/services/suggestionCache.ts';
import { useGlobalSearchSuggestions } from '../useGlobalSearchSuggestions.ts';

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
// The policy endpoint's network edge, bound the way `installInputPolicySync`
// binds the real fetcher at the app root.
const mockFetchPolicies = jest.fn();

const SEEDED_VERSION = 'test-policy-v1';

function gatewayRow(id: string) {
  return {
    id,
    type: 'entity',
    context: 'global_search',
    label: `gateway ${id}`,
    entityType: 'city',
    entityId: id,
    source: 'canonical',
    policyVersion: SEEDED_VERSION,
    destination: { route: `/city/${id}`, entityType: 'city', entityId: id },
  } as never;
}

/** Wait past both debounces (legacy 250 ms, gateway ≤ 120 ms) so any request would have fired. */
async function pastDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
}

beforeEach(() => {
  mockLegacyFetches.length = 0;
  mockRequest.mockReset();
  mockFetchPolicies.mockReset();
  mockRequest.mockResolvedValue({ ok: true, requestId: 'req-1', policyVersion: SEEDED_VERSION, suggestions: [gatewayRow('tokyo')] });
  sharedSuggestionCache.clear();
  sharedPolicyStore.setActiveAccount(null);
  sharedPolicyStore.clear();
  _resetPolicyRefreshOnUseForTests();
  bindPolicyRefreshOnUse(sharedPolicyStore, mockFetchPolicies);
});

describe('A08 clause 2 — a missing policy does not leave the search bar dead', () => {
  it('NO POLICY SEEDED (never fetched, signed out): the legacy typeahead runs and its groups are shown', async () => {
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();

    expect(mockLegacyFetches).toEqual(['tokyo']);
    await waitFor(() => expect(result.current.groups[0]?.items[0]?.id).toBe('legacy-tokyo'));
    expect(result.current.source).toBe('legacy');
    // The gateway itself still does nothing: the conservative policy is obeyed.
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('A SUPERSEDED policy (a newer policyVersion was noted) also falls back to the legacy typeahead', async () => {
    _seedPolicyForTests(['global_search']);
    sharedPolicyStore.noteServedVersion('test-policy-v2');
    mockFetchPolicies.mockResolvedValue({ ok: false, unavailable: true, error: 'offline' });

    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();

    expect(mockLegacyFetches).toEqual(['tokyo']);
    expect(result.current.source).toBe('legacy');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('CONTROL — an AUTHORITATIVE policy: the gateway serves and no legacy request is made', async () => {
    _seedPolicyForTests(['global_search']);

    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();

    expect(mockRequest).toHaveBeenCalled();
    await waitFor(() => expect(result.current.source).toBe('gateway'));
    expect(mockLegacyFetches).toEqual([]);
  });

  it('A FAILED policy fetch is retried on use, and a MOUNTED screen moves to the gateway when the table lands', async () => {
    // Signed in, nothing held: the state after a failed startup fetch.
    sharedPolicyStore.setActiveAccount(_TEST_ACCOUNT);
    mockFetchPolicies.mockResolvedValue({
      ok: true,
      policyVersion: SEEDED_VERSION,
      contexts: { global_search: { context: 'global_search', ..._PERMISSIVE_TEST_POLICY } },
    });

    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'toky' } },
    );
    await pastDebounce();

    // The use asked for the table once.
    expect(mockFetchPolicies).toHaveBeenCalledTimes(1);
    // The same mount — no remount, no sign-in event — now reads it.
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    await waitFor(() => expect(result.current.source).toBe('gateway'));

    const legacyBefore = mockLegacyFetches.length;
    await rerender({ q: 'tokyo' });
    await pastDebounce();
    expect(mockLegacyFetches.length).toBe(legacyBefore);
  });

  it('A policy fetch that keeps FAILING is not retried on every keystroke', async () => {
    sharedPolicyStore.setActiveAccount(_TEST_ACCOUNT);
    mockFetchPolicies.mockResolvedValue({ ok: false, unavailable: true, error: 'offline' });

    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'to' } },
    );
    await pastDebounce();
    for (const q of ['tok', 'toky', 'tokyo']) {
      await rerender({ q });
      await pastDebounce();
    }

    expect(mockFetchPolicies).toHaveBeenCalledTimes(1);
    // …and the screen kept searching the whole time.
    expect(mockLegacyFetches).toEqual(['to', 'tok', 'toky', 'tokyo']);
    expect(result.current.source).toBe('legacy');
  });
});
