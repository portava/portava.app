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

// ── Round 4 (census-discovery §80.15) ───────────────────────────────────────
//
// THE JEST/ACT CAVEAT these cases are written around. The policy table lands on
// a PROMISE, and a state update a promise makes lands at the next `act`
// boundary. So each case resolves the deferred fetch INSIDE `act`, and then
// makes no further keystroke: anything that moves the screen afterwards was
// caused by the table landing, not by a rerender the harness happened to do.
// The earlier "retried on use" case could not tell the two apart, because the
// legacy request was still settling when the table landed and its own state
// update re-rendered the hook — which is why removing the re-render survived it.

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const TABLE = {
  ok: true as const,
  policyVersion: SEEDED_VERSION,
  contexts: { global_search: { context: 'global_search', ..._PERMISSIVE_TEST_POLICY } },
};

describe('A08 round 4 — the table landing moves a mounted screen, once, without a gap', () => {
  it('a table that lands AFTER the legacy rows settled moves the screen to the gateway with no keystroke', async () => {
    sharedPolicyStore.setActiveAccount(_TEST_ACCOUNT);
    const table = deferred<typeof TABLE>();
    mockFetchPolicies.mockReturnValue(table.promise);

    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();
    // Settled: legacy rows on screen, nothing pending that would re-render.
    expect(result.current.groups[0]?.items[0]?.id).toBe('legacy-tokyo');
    expect(mockRequest).not.toHaveBeenCalled();

    await act(async () => { table.resolve(TABLE); await table.promise; });
    await pastDebounce();

    expect(mockRequest).toHaveBeenCalled();
    await waitFor(() => expect(result.current.source).toBe('gateway'));
  });

  it('TWO mounted fields share the one refresh, and BOTH move when it lands', async () => {
    sharedPolicyStore.setActiveAccount(_TEST_ACCOUNT);
    const table = deferred<typeof TABLE>();
    mockFetchPolicies.mockReturnValue(table.promise);

    const a = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    const b = await renderHook(() => useGlobalSearchSuggestions('kyoto'));
    await pastDebounce();
    expect(mockFetchPolicies).toHaveBeenCalledTimes(1);

    await act(async () => { table.resolve(TABLE); await table.promise; });
    await pastDebounce();

    await waitFor(() => expect(a.result.current.source).toBe('gateway'));
    await waitFor(() => expect(b.result.current.source).toBe('gateway'));
  });

  it('the handoff never shows an EMPTY gateway list: legacy rows stay until the gateway answers the current query', async () => {
    sharedPolicyStore.setActiveAccount(_TEST_ACCOUNT);
    const table = deferred<typeof TABLE>();
    mockFetchPolicies.mockReturnValue(table.promise);
    const serve = deferred<Awaited<ReturnType<typeof requestSuggestions>>>();
    mockRequest.mockReset();
    mockRequest.mockReturnValue(serve.promise);

    const shown: string[] = [];
    const { result } = await renderHook(() => {
      const r = useGlobalSearchSuggestions('tokyo');
      shown.push(`${r.source}:${r.groups.reduce((n, g) => n + g.items.length, 0)}`);
      return r;
    });
    await pastDebounce();
    expect(result.current.groups[0]?.items[0]?.id).toBe('legacy-tokyo');
    const legacySettledAt = shown.length;

    await act(async () => { table.resolve(TABLE); await table.promise; });
    await pastDebounce();
    // The gateway has been asked and has not answered: the legacy rows hold.
    expect(mockRequest).toHaveBeenCalled();
    expect(result.current.source).toBe('legacy');
    expect(result.current.groups[0]?.items[0]?.id).toBe('legacy-tokyo');

    await act(async () => {
      serve.resolve({ ok: true, requestId: 'req-2', policyVersion: SEEDED_VERSION, suggestions: [gatewayRow('tokyo')] } as never);
      await serve.promise;
    });
    await waitFor(() => expect(result.current.source).toBe('gateway'));
    expect(result.current.groups.some((g) => g.items.length > 0)).toBe(true);

    // Never an empty list from either source once rows were on screen, and never
    // back to legacy once the gateway took over (no mixing).
    const after = shown.slice(legacySettledAt);
    expect(after.filter((s) => s.endsWith(':0'))).toEqual([]);
    const firstGateway = after.findIndex((s) => s.startsWith('gateway'));
    expect(after.slice(firstGateway).every((s) => s.startsWith('gateway'))).toBe(true);
  });
});
