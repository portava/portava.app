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
 *   - The legacy hook is the FALLBACK, and it runs exactly while it is needed:
 *     until the gateway has answered once on this mount, and again from the
 *     moment the gateway reports itself `unavailable`. See A08 below.
 *   - The gateway hook and, when the legacy hook is running, the legacy hook
 *     both produce grouped rows; the gateway's are shown whenever it actually
 *     has rows (mapped to the same `SuggestGroup` shape the panel renders).
 *   - DEGRADE GRACEFULLY (§38): if `/input-assistance/suggest` is absent
 *     (404/offline → `unavailable`) or returns nothing, we keep the legacy
 *     groups. We NEVER show an empty gateway list over a live legacy list — the
 *     switch to the gateway only happens when it has rows, and both hooks keep
 *     their previous groups visible while a newer request is in flight.
 *
 * A08 — ONE SEARCH SYSTEM, NOT TWO
 * ================================
 * census-discovery A08 measured what this file used to do: *"the client runs
 * it on every keystroke in parallel with the gateway … Two requests per
 * keystroke, one canonical path"*, and named the remedy — *"stop invoking the
 * legacy hook when the gateway is `available`"*.
 *
 * The legacy typeahead is now gated on `legacyEnabled` rather than left
 * permanently on. It runs:
 *   - before the gateway has produced a single suggestion on this mount (the
 *     PROVING window — a gateway that has never answered is not yet a
 *     fallback-free path), and
 *   - whenever the gateway reports `unavailable` (§38's own signal: 404 or
 *     offline), at which point the latch releases and the proven typeahead is
 *     back on the very next keystroke.
 *
 * Why retiring the duplicate request is not retiring a second opinion: A08
 * measured that `/discovery/suggest` *"is not a parallel matcher — it calls the
 * same `dispatchSearch` (`routes/discoverySearch.ts:2491`)"* the gateway calls
 * (`lib/inputAssistance/gateway.ts:27,384`). The two paths return the same
 * matcher's answer; only the trip is duplicated.
 *
 * Note the ONE behaviour that changes beyond request count: while the legacy
 * hook is off it holds no groups, so `preferGateway` must not fall back to an
 * empty legacy list. It is therefore true unconditionally when the legacy hook
 * is not running — the gateway is then the only source, and its loading state,
 * not a blank list, is what the panel shows.
 *
 * This hook is the reversible seam: to disable the gateway wiring, the search
 * screen imports `useSearchSuggestions` again — nothing else changes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchSuggestions, type UseSearchSuggestionsOpts } from './useSearchSuggestions.ts';
import type { SuggestGroup } from '../services/discovery.ts';
import { useInputAssistance } from '../platform/input-assistance/hooks/useInputAssistance.ts';
import { mapSuggestionsToGroups, findSuggestionForRow } from '../platform/input-assistance/search/globalSearch.ts';
import { recordSuggestionSelection } from '../platform/input-assistance/services/selectionRecorder.ts';
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
  /**
   * §35 — record an EXPLICIT pick of a shown row as selection memory. Call it
   * from the screen's suggestion-pick handler. Fire-and-forget, fail-soft, and a
   * no-op for a legacy-typeahead row or a non-recordable one, so a caller may
   * invoke it unconditionally and must never gate navigation on it.
   */
  recordPick: (row: { id?: string | null } | null | undefined) => void;
}

export function useGlobalSearchSuggestions(
  query: string,
  opts: UseGlobalSearchSuggestionsOpts = {},
): GlobalSearchSuggestionsResult {
  const { lat, lng, city, tz, surface = 'search', enabled = true } = opts;

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

  // A08 — has the gateway ever answered on this mount? A latch, not a snapshot:
  // one answer retires the duplicate request, and `unavailable` releases it
  // again so §38's fallback is one keystroke away, not a reload away.
  const [gatewayProven, setGatewayProven] = useState(false);
  useEffect(() => {
    if (gateway.unavailable) { setGatewayProven(false); return; }
    if (gateway.suggestions.length > 0) setGatewayProven(true);
  }, [gateway.unavailable, gateway.suggestions]);

  // The fallback runs exactly while it is the fallback for something.
  const legacyEnabled = enabled && (!gatewayProven || gateway.unavailable);

  // Proven path — the fallback. `enabled: false` stops its fetching entirely
  // (useSearchSuggestions.ts:49), which is the whole of the A08 consolidation.
  const legacy = useSearchSuggestions(query, { lat, lng, city, enabled: legacyEnabled });

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
  // Prefer the gateway when it is enabled, available, and either
  //   - it actually has content — grouped rows OR a smart-action chip (an "add
  //     to trip" parse can yield an action with no search rows; it must still
  //     surface) — so it never replaces a live legacy list with an empty one; or
  //   - the legacy hook is not running (A08), in which case the gateway is the
  //     only source and falling back would mean falling back to nothing.
  const preferGateway =
    enabled && !gateway.unavailable && (!legacyEnabled || gatewayHasRows || gatewayActions.length > 0);

  // §35 — the write half of Phase 8 personalization for this surface. Before
  // this existed, `global_search` selection memory had exactly one writer in the
  // whole app (SmartInput, mounted only on the Wall header pill), so the search
  // SCREEN read a memory it could never contribute to. Only fires for rows this
  // hook actually served from the gateway; a legacy row maps to no suggestion
  // and is silently skipped.
  const recordPick = useCallback(
    (row: { id?: string | null } | null | undefined) => {
      if (!preferGateway) return;
      const suggestion = findSuggestionForRow(gateway.suggestions, row);
      if (!suggestion) return;
      recordSuggestionSelection(suggestion, { policy: gateway.policy, query });
    },
    [preferGateway, gateway.suggestions, gateway.policy, query],
  );

  return {
    groups: preferGateway ? gatewayGroups : legacy.groups,
    actionSuggestions: preferGateway ? gatewayActions : [],
    loading: preferGateway ? gateway.loading : legacy.loading,
    source: preferGateway ? 'gateway' : 'legacy',
    recordPick,
  };
}
