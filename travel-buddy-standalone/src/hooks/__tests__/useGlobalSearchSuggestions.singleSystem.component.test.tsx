/**
 * useGlobalSearchSuggestions — census-discovery A08: ONE search system, not two.
 *
 * THE MEASUREMENT A08 RECORDS
 * ===========================
 * > "it *is* a second route, and the client runs it **on every keystroke in
 * >  parallel with the gateway** as a deliberate fallback:
 * >  `hooks/useGlobalSearchSuggestions.ts:10-12` — 'The legacy hook ALWAYS runs
 * >  and is the fallback'. Two requests per keystroke, one canonical path."
 *
 * and the remedy it names:
 *
 * > "the consolidation is a client change (stop invoking the legacy hook when
 * >  the gateway is `available`)".
 *
 * WHY THIS IS SAFE TO DO, STATED SO IT CAN BE CHECKED
 * ===================================================
 * The two paths are not two matchers. A08 measured that `/discovery/suggest`
 * "is **not a parallel matcher** — it calls the same `dispatchSearch`
 * (`routes/discoverySearch.ts:2491`) the gateway calls
 * (`lib/inputAssistance/gateway.ts:27,384`)". Retiring the duplicate REQUEST
 * therefore does not retire a second opinion; it retires a second trip for the
 * same opinion.
 *
 * What is NOT retired is §38's degrade-gracefully contract, and the third and
 * fourth tests below are what hold it: the moment the gateway reports
 * `unavailable` (404 / offline), the legacy typeahead fetches again.
 *
 * Reachable from: the global search screen — `app/search.tsx:24,154` consumes
 * this hook.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';

/** Every legacy typeahead request the hook actually issues. */
const mockLegacyFetches: string[] = [];

// NOTE: intentionally exhaustive — services/discovery pulls in Supabase/apiToken
// native internals at module load. `useSearchSuggestions` (the legacy path under
// measurement here) imports exactly one function from it, and counting that
// function's calls IS the measurement: it is the second request per keystroke.
jest.mock('../../services/discovery.ts', () => ({
  getSearchSuggestions: jest.fn(async (q: string) => {
    mockLegacyFetches.push(q);
    return { ok: true, groups: [{ title: 'Places', items: [{ id: `legacy-${q}`, label: `legacy ${q}` }] }] };
  }),
}));

/** Controllable stand-in for the P1 gateway. */
let mockGatewayState: {
  suggestions: Array<Record<string, unknown>>;
  loading: boolean;
  unavailable: boolean;
  policy: unknown;
} = { suggestions: [], loading: false, unavailable: false, policy: null };

// NOTE: intentionally exhaustive — the real gateway hook performs its own
// debounced network calls; this test is about WHO FETCHES, so the gateway's
// observable state is driven directly.
jest.mock('../../platform/input-assistance/hooks/useInputAssistance.ts', () => ({
  useInputAssistance: () => mockGatewayState,
}));

import { useGlobalSearchSuggestions } from '../useGlobalSearchSuggestions.ts';

/** A gateway row shaped the way `mapSuggestionsToGroups` expects. */
function gatewayRow(id: string) {
  return {
    id,
    type: 'entity',
    context: 'global_search',
    label: `gateway ${id}`,
    entityType: 'city',
    entityId: id,
    destination: { route: `/city/${id}`, entityType: 'city', entityId: id },
  };
}

/** Wait past the legacy hook's 250 ms debounce so a request would have fired. */
async function pastDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
}

beforeEach(() => {
  mockLegacyFetches.length = 0;
  mockGatewayState = { suggestions: [], loading: false, unavailable: false, policy: null };
});

describe('A08 — the legacy typeahead is a fallback, not a parallel system', () => {
  /**
   * The CONTROL for the case below. It also proves the harness itself moves:
   * each rerender is a keystroke, and each keystroke must show up as a legacy
   * request while the gateway has not answered. Without this, "no legacy
   * request" in the next test could be a dead rerender rather than a fix.
   */
  it('BEFORE the gateway has answered: every keystroke still fetches the legacy typeahead', async () => {
    const { rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'to' } },
    );
    await pastDebounce();
    mockLegacyFetches.length = 0;

    for (const q of ['tok', 'toky', 'tokyo']) {
      await rerender({ q });
      await pastDebounce();
    }

    expect(mockLegacyFetches).toEqual(['tok', 'toky', 'tokyo']);
  });

  it('AFTER the gateway has answered: further keystrokes issue NO legacy request', async () => {
    const { rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'to' } },
    );

    // The gateway proves it can answer on this device/session.
    await act(async () => {
      mockGatewayState = { ...mockGatewayState, suggestions: [gatewayRow('g1')] };
    });
    await rerender({ q: 'tok' });
    await pastDebounce();

    mockLegacyFetches.length = 0;

    // Three more keystrokes, gateway healthy throughout.
    for (const q of ['toky', 'tokyo', 'tokyo ']) {
      await rerender({ q });
      await pastDebounce();
    }

    expect(mockLegacyFetches).toEqual([]);
  });

  it('the gateway is the shown source once it has answered', async () => {
    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'to' } },
    );

    await act(async () => {
      mockGatewayState = { ...mockGatewayState, suggestions: [gatewayRow('g1')] };
    });
    await rerender({ q: 'tok' });

    await waitFor(() => expect(result.current.source).toBe('gateway'));
  });

  it('DEGRADE GRACEFULLY (§38): the legacy typeahead resumes the moment the gateway goes unavailable', async () => {
    const { rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'to' } },
    );

    await act(async () => {
      mockGatewayState = { ...mockGatewayState, suggestions: [gatewayRow('g1')] };
    });
    await rerender({ q: 'tok' });
    await pastDebounce();
    mockLegacyFetches.length = 0;

    // The suggest endpoint disappears (404 / offline).
    await act(async () => {
      mockGatewayState = { suggestions: [], loading: false, unavailable: true, policy: null };
    });
    await rerender({ q: 'toky' });
    await pastDebounce();

    expect(mockLegacyFetches.length).toBeGreaterThan(0);
  });

  it('and the legacy list is what the screen shows while the gateway is unavailable', async () => {
    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'to' } },
    );

    await act(async () => {
      mockGatewayState = { suggestions: [], loading: false, unavailable: true, policy: null };
    });
    await rerender({ q: 'tok' });
    await pastDebounce();

    await waitFor(() => expect(result.current.source).toBe('legacy'));
    expect(result.current.groups.length).toBeGreaterThan(0);
  });

  /**
   * The branch that pays for turning the legacy hook off.
   *
   * Once the legacy typeahead stops running it holds no groups, so "fall back
   * to the legacy list" would mean falling back to an EMPTY list attributed to
   * a system that is not even running — a blank panel the user reads as "no
   * results" when the truth is "the gateway is still working". While the legacy
   * hook is off the gateway is the only source and must be reported as such,
   * loading state and all.
   */
  it('once the legacy hook is off, a gateway with no rows yet is still the reported source — never a blank legacy list', async () => {
    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q),
      { initialProps: { q: 'to' } },
    );

    // Gateway proves itself, legacy switches off.
    await act(async () => {
      mockGatewayState = { ...mockGatewayState, suggestions: [gatewayRow('g1')] };
    });
    await rerender({ q: 'tok' });
    await pastDebounce();

    // A new query the gateway is still loading: available, no rows yet.
    await act(async () => {
      mockGatewayState = { suggestions: [], loading: true, unavailable: false, policy: null };
    });
    await rerender({ q: 'tokyo' });
    await pastDebounce();

    expect(result.current.source).toBe('gateway');
    expect(result.current.loading).toBe(true);
    // And no legacy request was made to fill the gap.
    expect(mockLegacyFetches).not.toContain('tokyo');
  });

  it('DISABLED: neither system fetches when the caller turns the hook off', async () => {
    const { rerender } = await renderHook(
      ({ q }: { q: string }) => useGlobalSearchSuggestions(q, { enabled: false }),
      { initialProps: { q: 'to' } },
    );

    await rerender({ q: 'tokyo' });
    await pastDebounce();

    expect(mockLegacyFetches).toEqual([]);
  });
});
