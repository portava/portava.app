/**
 * Global Input Intelligence §48 — what THIS client can do, declared to the
 * server (census G341, G343).
 *
 * WHY A DECLARATION AT ALL
 * ------------------------
 * Census G343: *"No handshake in either direction: the request carries no
 * client capability list and the response carries no capability declaration.
 * What exists instead is silent client-side dropping (`search/smartActions.ts`,
 * the grouped-row bridge), which is graceful degradation, not negotiation — the
 * server keeps spending work on rows it will never see used."*
 *
 * The dropping is real and it is correct: a chip the screen cannot dispatch
 * must not be rendered. What was missing is that the server was never told, so
 * it kept building, ranking, projecting and serialising those rows on every
 * keystroke.
 *
 * TWO LEVELS, AND THE DIFFERENCE MATTERS
 * --------------------------------------
 * {@link SDK_CAPABILITIES} is what the SHARED overlay can do. It is honestly
 * wide: `SuggestionList` dispatches `action` rows to `ActionSuggestionRow`,
 * `ai_suggestion` rows to `AiSuggestionRow` and everything else to
 * `EntitySuggestionRow`, so there is no assistance type it fails to draw, and
 * saying otherwise to save a row would be a lie that costs a user a suggestion.
 *
 * {@link GLOBAL_SEARCH_CAPABILITIES} is what the SEARCH BAR can do, and it is
 * genuinely narrower — which is the whole point. That surface does not render
 * the shared overlay; it maps rows through `search/globalSearch.ts` and
 * `search/smartActions.ts`, and those two between them resolve exactly three
 * action types. The rest are dropped on arrival today. Declaring the three is
 * what turns that drop into a negotiation.
 *
 * DERIVED, NOT RESTATED. The action list is built from
 * `DISPATCHABLE_ACTION_TYPES` — the same set the chip lane tests — plus the two
 * the grouped-row bridge resolves itself. A capability list maintained by hand
 * beside the code it describes is a list that drifts, and a client that claims
 * a capability it lost is worse off than one that claimed nothing.
 */
import type { AssistanceType } from '../types/inputContext.ts';
import type { SuggestionActionType } from '../types/suggestionAction.ts';
import { DISPATCHABLE_ACTION_TYPES } from '../search/smartActions.ts';

/**
 * §48 — the response SHAPE version this client was built against.
 *
 * MAJOR only. It is compared against the server's `schemaVersion` in
 * `services/suggestResponse.ts#isSchemaCompatible`; a server major ABOVE this
 * one means the envelope may have changed in a way this build cannot read, and
 * the client degrades to "assistance unavailable" (§38) rather than rendering
 * a shape it does not understand. Additive server changes do not bump it —
 * that is what keeps older clients working (§48 "preserve backward
 * compatibility for active mobile versions").
 */
export const CLIENT_SCHEMA_VERSION = 1;

/** What a request's `client` block carries. */
export interface ClientCapabilities {
  schemaVersion: number;
  suggestionTypes?: AssistanceType[];
  actionTypes?: SuggestionActionType[];
}

/**
 * Every assistance type the shared overlay renders — which is all of them, via
 * the three-way dispatch in `components/SuggestionList.tsx`. Stated explicitly
 * so that a future row primitive REMOVED from that dispatch has somewhere to be
 * removed from too.
 */
export const SDK_RENDERABLE_SUGGESTION_TYPES: readonly AssistanceType[] = [
  'entity',
  'completion',
  'recent',
  'personalized',
  'structured_value',
  'action',
  'correction',
  'validation',
  'disambiguation',
  'ai_suggestion',
];

/** The shared overlay's declaration. Narrows nothing today, and says so. */
export const SDK_CAPABILITIES: ClientCapabilities = {
  schemaVersion: CLIENT_SCHEMA_VERSION,
  suggestionTypes: [...SDK_RENDERABLE_SUGGESTION_TYPES],
};

/**
 * The action types the GLOBAL SEARCH BAR resolves.
 *
 * `open_entity` and `submit_search` are resolved by the grouped-row bridge
 * (`search/globalSearch.ts` routes the first and submits the second);
 * `DISPATCHABLE_ACTION_TYPES` is the chip lane's own set. Everything else —
 * `share_entity`, `drop_pin`, `open_compass`, `replace_text`,
 * `set_structured_value` — has no target on that screen and is dropped there
 * today, which is exactly what this list now says out loud.
 *
 * Adding a target is: extend the screen's dispatcher AND the set it is derived
 * from, in lock-step. That is the same rule `smartActions.ts` already states,
 * and this list inherits it rather than forking it.
 */
export const GLOBAL_SEARCH_ACTION_TYPES: readonly SuggestionActionType[] = [
  'open_entity',
  'submit_search',
  ...DISPATCHABLE_ACTION_TYPES,
];

/** The global search bar's declaration. */
export const GLOBAL_SEARCH_CAPABILITIES: ClientCapabilities = {
  schemaVersion: CLIENT_SCHEMA_VERSION,
  actionTypes: [...GLOBAL_SEARCH_ACTION_TYPES],
};

/**
 * A stable, short signature of a capability declaration.
 *
 * The shared suggestion cache is keyed by (fieldId, text, coarse coords) and
 * knows nothing about capabilities. Two surfaces that share a fieldId but
 * declare different capabilities would otherwise serve each other's rows out of
 * that cache — the narrower surface would poison the wider one with a list the
 * server had already thinned. This goes into the key.
 */
export function capabilitySignature(caps: ClientCapabilities | null | undefined): string {
  if (!caps) return '';
  const s = (caps.suggestionTypes ?? []).slice().sort().join('.');
  const a = (caps.actionTypes ?? []).slice().sort().join('.');
  return `${caps.schemaVersion}|${s}|${a}`;
}
