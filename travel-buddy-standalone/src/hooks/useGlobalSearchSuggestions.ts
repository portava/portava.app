/**
 * useGlobalSearchSuggestions — Phase 3 (Global Search) gateway wiring.
 *
 * Routes the global search bar's live typeahead through the P1 gateway
 * (`global_search` InputContext via `useInputAssistance`) ADDITIVELY, without
 * regressing the hard-won legacy path (`useSearchSuggestions`: 250ms debounce,
 * abort-on-newer-keystroke, sequence guard, 60s SWR cache, keep-previous-groups).
 *
 * Contract (identical return shape to `useSearchSuggestions`, so the search
 * screen swaps one hook for another):
 *   - The legacy hook ALWAYS runs and is the fallback — its proven behavior is
 *     never removed.
 *   - The gateway hook runs in parallel and, when it actually returns rows,
 *     those grouped rows are shown instead (mapped to the same `SuggestGroup`
 *     shape the panel renders).
 *   - DEGRADE GRACEFULLY (§38): if `/input-assistance/suggest` is absent
 *     (404/offline → `unavailable`) or returns nothing, we keep the legacy
 *     groups. We NEVER show an empty gateway list over a live legacy list — the
 *     switch to the gateway only happens when it has rows, and both hooks keep
 *     their previous groups visible while a newer request is in flight.
 *
 * This hook is the reversible seam: to disable the gateway wiring, the search
 * screen imports `useSearchSuggestions` again — nothing else changes.
 */
import { useMemo } from 'react';
import { useSearchSuggestions, type UseSearchSuggestionsOpts } from './useSearchSuggestions.ts';
import type { SuggestGroup } from '../services/discovery.ts';
import { useInputAssistance } from '../platform/input-assistance/hooks/useInputAssistance.ts';
import { mapSuggestionsToGroups } from '../platform/input-assistance/search/globalSearch.ts';
import { extractActionSuggestions } from '../platform/input-assistance/search/smartActions.ts';
import { registerSearchFields, SEARCH_FIELD_IDS } from '../platform/input-assistance/search/searchFields.ts';
import type { InputSessionContext, InputSuggestion } from '../platform/input-assistance/types/inputSuggestion.ts';

// Register the global-search field's policy once at module load (idempotent).
registerSearchFields();

export interface UseGlobalSearchSuggestionsOpts extends UseSearchSuggestionsOpts {
  /** IANA timezone for temporal intent parsing ("tonight" etc., §18) — forwarded to the gateway. */
  tz?: string;
  /** Current app surface, for context-aware ranking/zero-state (§14). */
  surface?: string;
}

export interface GlobalSearchSuggestionsResult {
  groups: SuggestGroup[];
  /** §21 smart-action chips (e.g. "Add Bangkok to your trip") the panel renders
   *  via ActionSuggestionRow and dispatches — distinct from search/entity rows.
   *  Only ever populated from the gateway; empty on the legacy fallback path. */
  actionSuggestions: InputSuggestion[];
  loading: boolean;
  /** Which source produced the shown groups — 'gateway' when P1 rows are live,
   *  'legacy' when the proven typeahead is (the default + fallback). */
  source: 'gateway' | 'legacy';
}

export function useGlobalSearchSuggestions(
  query: string,
  opts: UseGlobalSearchSuggestionsOpts = {},
): GlobalSearchSuggestionsResult {
  const { lat, lng, city, tz, surface = 'search', enabled = true } = opts;

  // Proven path — always active as the fallback. Never regresses.
  const legacy = useSearchSuggestions(query, { lat, lng, city, enabled });

  // Bounded session context forwarded to the gateway (§16/§41). Coarse coords +
  // timezone + surface only — never persistent preferences.
  const sessionContext = useMemo<InputSessionContext>(() => {
    const s: InputSessionContext = { surface };
    if (lat != null) s.lat = lat;
    if (lng != null) s.lng = lng;
    if (tz) s.tz = tz;
    return s;
  }, [lat, lng, tz, surface]);

  const gateway = useInputAssistance({
    fieldId: SEARCH_FIELD_IDS.globalSearch,
    context: 'global_search',
    text: query,
    sessionContext,
    enabled,
  });

  const gatewayGroups = useMemo(
    () => mapSuggestionsToGroups(gateway.suggestions, query),
    [gateway.suggestions, query],
  );

  // §21 smart-action chips lifted out of the same gateway rows (add_to_trip).
  const gatewayActions = useMemo(
    () => (gateway.unavailable ? [] : extractActionSuggestions(gateway.suggestions)),
    [gateway.suggestions, gateway.unavailable],
  );

  const gatewayHasRows = gatewayGroups.some((g) => g.items.length > 0);
  // Prefer the gateway ONLY when it is enabled, available, and actually has
  // content — grouped rows OR a smart-action chip (an "add to trip" parse can
  // yield an action with no search rows; it must still surface). Otherwise fall
  // back to the legacy list (never empty over a live list).
  const preferGateway = enabled && !gateway.unavailable && (gatewayHasRows || gatewayActions.length > 0);

  return {
    groups: preferGateway ? gatewayGroups : legacy.groups,
    actionSuggestions: preferGateway ? gatewayActions : [],
    loading: preferGateway ? gateway.loading : legacy.loading,
    source: preferGateway ? 'gateway' : 'legacy',
  };
}
