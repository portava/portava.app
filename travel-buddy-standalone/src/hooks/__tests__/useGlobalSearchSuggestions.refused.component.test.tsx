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

let mockGatewayState: { suggestions: Array<Record<string, unknown>>; loading: boolean; unavailable: boolean; policy: unknown } =
  { suggestions: [], loading: false, unavailable: true, policy: null };

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
  mockGatewayState = { suggestions: [], loading: false, unavailable: true, policy: null };
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
});
