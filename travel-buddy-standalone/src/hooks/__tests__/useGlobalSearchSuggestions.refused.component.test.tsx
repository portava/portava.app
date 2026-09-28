/**
 * useGlobalSearchSuggestions — a refused legacy suggest read stays REFUSED on
 * its way to the screen.
 *
 * census-discovery DV-83 (`11` §9 / owner ruling D11, the consumer leg):
 * "A distinguishable response body alone is insufficient if consumers still
 * treat it as successful empty data."
 *
 * The chain is four links long: `getSearchSuggestions` parses the refusal,
 * `useSearchSuggestions` turns `coverage: "nothing"` into `refused` (its own
 * suite proves that), THIS hook passes it through while the legacy typeahead is
 * the source, and `app/search.tsx` hands it to `SearchSuggestionsPanel`, whose
 * own suite proves the panel does not print "no quick matches" for it. The
 * third link had no test: `app/search.tsx`'s suite stubs `useSearchSuggestions`
 * to `refused: false`, so a pass-through that dropped the flag was invisible to
 * every suite in the tree. The real `useSearchSuggestions` runs here; only the
 * service and the gateway hook are stood in for.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { renderHook, waitFor, act } from '@testing-library/react-native';

/** What the legacy suggest read answers next. */
let mockSuggest: { ok: true; groups: unknown[]; refusal?: Record<string, unknown> } = { ok: true, groups: [] };

// NOTE: intentionally exhaustive — services/discovery pulls in the Supabase
// client through apiToken; the legacy hook imports exactly this one function.
jest.mock('../../services/discovery.ts', () => ({
  getSearchSuggestions: jest.fn(async () => mockSuggest),
}));

let mockGatewayState: { suggestions: Array<Record<string, unknown>>; loading: boolean; unavailable: boolean; policy: unknown; policyAuthoritative: boolean; refusal?: unknown } =
  { suggestions: [], loading: false, unavailable: true, policy: null, policyAuthoritative: true };

// NOTE: intentionally exhaustive — the real gateway hook performs its own
// network calls; its observable state is driven directly.
jest.mock('../../platform/input-assistance/hooks/useInputAssistance.ts', () => ({
  useInputAssistance: () => mockGatewayState,
}));

import { useGlobalSearchSuggestions } from '../useGlobalSearchSuggestions.ts';

const REFUSED = { class: 'transient_db', code: 'visibility_state_unreadable', route: 'GET /discovery/suggest', coverage: 'nothing' };

async function pastDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
}

beforeEach(() => {
  mockSuggest = { ok: true, groups: [] };
  mockGatewayState = { suggestions: [], loading: false, unavailable: true, policy: null, policyAuthoritative: true };
});

describe('DV-83 — the suggest refusal survives the global-search hook', () => {
  it('legacy source + a refused read: the hook reports refused, not an empty list', async () => {
    mockSuggest = { ok: true, groups: [], refusal: REFUSED };
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();
    await waitFor(() => expect(result.current.source).toBe('legacy'));
    expect(result.current.refused).toBe(true);
    expect(result.current.groups).toEqual([]);
  });

  it('CONTROL: a genuinely empty legacy read is not refused', async () => {
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();
    await waitFor(() => expect(result.current.source).toBe('legacy'));
    expect(result.current.refused).toBe(false);
  });

  it('CONTROL: a PARTIAL legacy read is not refused — its groups are real', async () => {
    mockSuggest = {
      ok: true,
      groups: [{ type: 'places', label: 'Places', items: [{ id: 'p1', type: 'place', title: 'Senso-ji' }] }],
      refusal: { ...REFUSED, coverage: 'partial', failedSources: ['travelers'] },
    };
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();
    await waitFor(() => expect(result.current.groups.length).toBe(1));
    expect(result.current.refused).toBe(false);
  });

  // ── census-discovery §80 (DV-83, D-W10-S1-2; E-9, D-W10-S1-4) ──────────────
  // After E-9 the gateway is the typeahead whenever it is available, so its
  // coverage has to reach the panel too — before §80 `refused` was hard-wired
  // `false` on the gateway path and a partial answer was simply "the answer".

  it('§80: a PARTIAL legacy read is reported incomplete (and still not refused)', async () => {
    mockSuggest = {
      ok: true,
      groups: [{ type: 'places', label: 'Places', items: [{ id: 'p1', type: 'place', title: 'Senso-ji' }] }],
      refusal: { ...REFUSED, coverage: 'partial', failedSources: ['travelers'] },
    };
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();
    await waitFor(() => expect(result.current.groups.length).toBe(1));
    expect(result.current.incomplete).toBe(true);
    expect(result.current.refused).toBe(false);
  });

  it('§80: a gateway serve that refused is reported refused — not an empty typeahead', async () => {
    mockGatewayState = {
      suggestions: [], loading: false, unavailable: false, policy: null, policyAuthoritative: true,
      refusal: { class: 'transient_db', code: 'visibility_state_unreadable', route: 'POST /input-assistance/suggest', coverage: 'nothing' },
    } as typeof mockGatewayState;
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();
    expect(result.current.source).toBe('gateway');
    expect(result.current.refused).toBe(true);
    expect(result.current.incomplete).toBe(false);
  });

  it('§80: a PARTIAL gateway serve is reported incomplete, its rows kept', async () => {
    mockGatewayState = {
      suggestions: [{ id: 'g1', type: 'entity', context: 'global_search', label: 'gateway g1', entityType: 'city', entityId: 'g1',
        destination: { route: '/city/g1', entityType: 'city', entityId: 'g1' } }],
      loading: false, unavailable: false, policy: null, policyAuthoritative: true,
      refusal: { class: 'transient_db', code: 'suggest_sources_unreadable', route: 'POST /input-assistance/suggest', coverage: 'partial', failedSources: ['circles'] },
    } as typeof mockGatewayState;
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await waitFor(() => expect(result.current.source).toBe('gateway'));
    expect(result.current.groups.some((g) => g.items.length > 0)).toBe(true);
    expect(result.current.incomplete).toBe(true);
    expect(result.current.refused).toBe(false);
  });

  it('§80 CONTROL: a complete gateway serve is neither refused nor incomplete', async () => {
    mockGatewayState = { suggestions: [], loading: false, unavailable: false, policy: null, policyAuthoritative: true };
    const { result } = await renderHook(() => useGlobalSearchSuggestions('tokyo'));
    await pastDebounce();
    expect(result.current.refused).toBe(false);
    expect(result.current.incomplete).toBe(false);
  });
});
