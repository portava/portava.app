/**
 * wallSessionIntent — resolving a Global Input Intelligence suggestion into the
 * Wall's session-intent submission (Wall spec §17).
 *
 * §17: "Canonical entities selected from typeahead should become structured
 * filters, not raw strings." When the viewer picks a canonical entity from the
 * steer bar's typeahead, the Wall submits a STRUCTURED filter (the resolved
 * entity), not the raw keystrokes; when they pick a query completion or submit
 * free text, the Wall submits the resolved query string. Either way what is
 * steered is the RESOLVED intent, never the half-typed input.
 *
 * Pure module — no React, no network — unit-testable. Imports are type-only, so
 * this never drags the input-assistance runtime into a unit test.
 */
import type { InputSuggestion } from '../../../platform/input-assistance/types/inputSuggestion.ts';
import type { EntityType } from '../../../platform/input-assistance/types/inputContext.ts';
import type { StructuredIntentFilter, StructuredIntentFilterKind } from '../types/wallProjection.ts';

/** A resolved steer: the text to send plus, when an entity was chosen, its filter. */
export interface ResolvedWallIntent {
  /** The resolved steer text sent as the per-request `session_intent` (§17). */
  text: string;
  /**
   * The structured filter for a canonical entity chosen from typeahead (§17).
   * Absent for a free-text / query-completion steer.
   */
  filter?: StructuredIntentFilter;
}

/**
 * Map an Input Intelligence canonical `EntityType` to the Wall's own
 * `StructuredIntentFilterKind`. The Wall kinds are coarser than the input
 * entity set, so several entity types fold onto one filter kind. Exhaustive over
 * the input entity union with a safe `category` default.
 */
export function entityTypeToFilterKind(entityType: EntityType | undefined): StructuredIntentFilterKind {
  switch (entityType) {
    case 'city':
    case 'country':
      return 'city';
    case 'place':
    case 'neighborhood':
    case 'hidden_gem':
      return 'place';
    case 'user':
    case 'buddy':
      return 'person';
    case 'interest':
      return 'interest';
    case 'hashtag':
    case 'trip':
    case 'event':
    case 'plan':
    case 'language':
    case undefined:
    default:
      return 'category';
  }
}

/**
 * Resolve a chosen suggestion into a Wall session-intent submission.
 *
 * A suggestion carrying a canonical `entityId` becomes a STRUCTURED filter (§17)
 * whose text is the entity's canonical label — never the raw typed fragment.
 * A query completion / recent / free-text suggestion becomes the resolved query
 * string with no filter.
 */
export function resolveWallIntent(suggestion: InputSuggestion): ResolvedWallIntent {
  if (suggestion.entityId) {
    const label = (suggestion.label ?? '').trim();
    return {
      text: label,
      filter: {
        kind: entityTypeToFilterKind(suggestion.entityType),
        entityId: suggestion.entityId,
        label,
        value: suggestion.entityType ?? null,
      },
    };
  }
  const text = (suggestion.replacementText ?? suggestion.label ?? '').trim();
  return { text };
}
