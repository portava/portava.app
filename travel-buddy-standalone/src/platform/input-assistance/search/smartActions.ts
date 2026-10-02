/**
 * Global Input Intelligence — Phase 6 (Semantic Intent): §21 smart-action lane.
 *
 * The Phase-6 gateway projects a §21 smart action ("add Bangkok to my trip") as
 * an `action`-type `InputSuggestion` carrying a genuine `SuggestionAction` (e.g.
 * `add_to_trip`). Such a row is NOT a search submit and NOT an entity to open —
 * it is a tappable ACTION the user dispatches into an existing propose-only flow
 * (§21/§47: the row proposes, the user confirms, and the target endpoint keeps
 * its own authorization gate).
 *
 * The Phase-3 grouped-row bridge (`globalSearch.ts`) speaks only entity rows +
 * "SEARCH FOR …" query rows, so it must NOT render these — an `add_to_trip` row
 * also carries a `destination.route` (`/city/<slug>`), which would otherwise make
 * `mapSuggestionsToGroups` mis-render it as a plain city entity row that navigates
 * to the city page instead of adding to a trip. This module is the single source
 * of truth for "is this a dispatchable smart action?", used BOTH here (to lift the
 * row into the action lane) and by `globalSearch.ts` (to skip it from the search
 * groups) so a smart action lands in exactly one lane, never both.
 *
 * Conservative by design (§13 "no dead rows", §38 degrade): only actions this
 * client can actually dispatch are lifted into chips. An unknown or unhandled
 * action type is dropped here AND dropped by the grouped-row bridge — it never
 * becomes a dead chip and never throws.
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { SuggestionActionType } from '../types/suggestionAction.ts';

/**
 * The closed set of `SuggestionAction` types this client renders as a tappable
 * smart-action chip AND can dispatch. Kept deliberately narrow: `open_entity`
 * and `submit_search` are handled by the grouped-row bridge (entity / query
 * rows), and text actions (`replace_text`, `set_structured_value`) mutate the
 * field, not the suggestion list. `share_entity` and `drop_pin` have no dispatch
 * target in the global search bar, so they are NOT here and are therefore
 * dropped (no dead chip). Adding one is: extend this set AND the screen's
 * dispatcher switch in lock-step.
 *
 * `open_compass` was in that dropped set until now, and it was the only member
 * the SERVER actually emits into this surface: `semanticIntent.ts`
 * `buildCompassStructuredRow` projects the parsed interpretation of the typed
 * query as an `open_compass` row, the grouped-row bridge cannot render it
 * (no entity id, no route, not a submit) and this set refused it, so every one
 * of them was discarded silently — a produced action no client could act on.
 * It is here now because the dispatch target exists and is used: the Compass
 * screen already accepts a ready-made prompt via its `prefillMessage` param
 * (the same handoff Layover's "Ask locals" uses), and `app/search.tsx` routes
 * to it in `handleSuggestionAction`. The pair moved in lock-step, which is what
 * the paragraph above asks for.
 */
export const DISPATCHABLE_ACTION_TYPES: ReadonlySet<SuggestionActionType> = new Set<SuggestionActionType>([
  'add_to_trip',
  'open_compass',
]);

/**
 * True when a suggestion is a genuine smart action this client dispatches — i.e.
 * it carries a `SuggestionAction` whose type is in {@link DISPATCHABLE_ACTION_TYPES}.
 * Both the action lane (below) and the grouped-row bridge test this so a row is
 * rendered in exactly one lane.
 */
export function isDispatchableActionSuggestion(s: InputSuggestion): boolean {
  const a = s?.action;
  return !!a && DISPATCHABLE_ACTION_TYPES.has(a.type);
}

/**
 * Lift the dispatchable smart-action rows out of a flat, already-ranked gateway
 * suggestion list, preserving order. Everything else (entities, completions,
 * unknown/unhandled actions) is left for the grouped-row bridge — which drops
 * what it cannot resolve. Never throws; tolerant of a nullish list.
 */
export function extractActionSuggestions(suggestions: InputSuggestion[] | null | undefined): InputSuggestion[] {
  return (suggestions ?? []).filter(isDispatchableActionSuggestion);
}

/**
 * SDK-neutral target for an `add_to_trip` action, resolved from the suggestion.
 * The screen adapts this to its `AddToTripPayload` and opens the existing
 * propose-only trip picker — this module stays free of any app-component
 * coupling so it remains pure + unit-testable.
 */
export interface AddToTripActionTarget {
  /** Canonical city id the action proposes adding (§21 resolved entity). */
  entityId: string;
  /** Human city name for the picker header. */
  city: string;
  /** Country (or null) for the picker subtitle. */
  country: string | null;
}

interface AddToTripStructuredValue {
  kind?: string;
  entityId?: string;
  city?: string;
}

/**
 * Resolve an `add_to_trip` suggestion to its canonical target, or null when the
 * suggestion is not an add-to-trip action or lacks a resolvable entity id (in
 * which case the caller drops it — no dead chip). The city name is drawn from
 * the structured value first (clean "Bangkok"), falling back to the row label.
 */
export function getAddToTripTarget(s: InputSuggestion): AddToTripActionTarget | null {
  const a = s?.action;
  if (!a || a.type !== 'add_to_trip') return null;

  const sv = (s.structuredValue ?? {}) as AddToTripStructuredValue;
  const entityId = a.entityId || sv.entityId || s.entityId || '';
  if (!entityId) return null;

  const city = (sv.city || s.label || '').trim() || 'Destination';
  const country = s.subtitle?.trim() || null;
  return { entityId, city, country };
}

/**
 * SDK-neutral target for an `open_compass` action (§43): the prompt text the
 * Compass screen should receive.
 *
 * The prompt is the user's OWN words — `replacementText` carries the raw typed
 * query that the server's parse was built from, and the row's `label` (the
 * structured restatement, e.g. "rooftop bars · near your hotel · tonight") is
 * only a fallback. Handing Compass the restatement rather than the query would
 * be the layer putting words in the user's mouth, which §2 forbids for AI rows
 * and is no better here.
 *
 * Returns null when the row is not an open_compass action or carries nothing to
 * ask — the caller then drops it rather than opening an empty chat.
 */
export interface OpenCompassActionTarget {
  /** The prompt handed to Compass. Never empty. */
  prompt: string;
  /** The parsed structured context the server attached, when it attached one. */
  structuredContext: unknown;
}

export function getOpenCompassTarget(s: InputSuggestion): OpenCompassActionTarget | null {
  const a = s?.action;
  if (!a || a.type !== 'open_compass') return null;
  const prompt = (s.replacementText ?? s.label ?? '').trim();
  if (!prompt) return null;
  return { prompt, structuredContext: (a as { context?: unknown }).context ?? s.structuredValue ?? null };
}
