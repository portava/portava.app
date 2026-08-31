/**
 * Global Input Intelligence — the pure suggestion-grouping logic (spec §12/§13
 * grouped results, §14/§35 zero-char recents).
 *
 * Extracted from SuggestionGroup.tsx (which imports react-native and so cannot be
 * loaded by the node:test runner) so the grouping — especially the §35 "Recent"
 * routing — is a PURE function that is unit-testable on its own. SuggestionGroup.tsx
 * imports + re-exports this, so every existing import site is unchanged.
 *
 * Pure module — no React, no RN — safe under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';

export interface SuggestionSection {
  /** Section label, e.g. "Cities", "People", "Recent". */
  label: string;
  suggestions: InputSuggestion[];
}

/**
 * Group a flat suggestion list into sections by entity type (falling back to
 * assistance type). Preserves the server's ordering within each section and the
 * order in which section keys first appear — so the server's ranking survives.
 *
 * §14/§35 — a zero-character RECENT (a prior EXPLICIT selection the gateway
 * returns on an empty field, `type === 'recent'`) is routed to its own "Recent"
 * group instead of folding into its entity-type group (e.g. Cities), so the
 * user's own recents read as recents. Everything else keys by entity type.
 */
export function groupSuggestions(
  suggestions: InputSuggestion[],
  labelFor: (key: string) => string = defaultLabelFor,
): SuggestionSection[] {
  const order: string[] = [];
  const byKey = new Map<string, InputSuggestion[]>();
  for (const s of suggestions) {
    const key = s.type === 'recent' ? 'recent' : (s.entityType ?? s.type);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(s);
  }
  return order.map((key) => ({ label: labelFor(key), suggestions: byKey.get(key)! }));
}

export function defaultLabelFor(key: string): string {
  const map: Record<string, string> = {
    city: 'Cities',
    country: 'Countries',
    neighborhood: 'Neighborhoods',
    place: 'Places',
    hidden_gem: 'Hidden Gems',
    user: 'People',
    buddy: 'Buddies',
    trip: 'Trips',
    event: 'Events',
    plan: 'Plans',
    hashtag: 'Hashtags',
    language: 'Languages',
    interest: 'Interests',
    action: 'Actions',
    completion: 'Search',
    recent: 'Recent',
  };
  return map[key] ?? key.replace(/_/g, ' ');
}
