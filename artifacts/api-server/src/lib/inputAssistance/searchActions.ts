/**
 * §21 search actions on the global search bar — "Open Map" (census G134).
 *
 * §21 names five search actions: Add to Trip, Save, Open Map, Ask Compass and
 * Start directions. Add to Trip (`semanticIntent.ts`, `add_to_trip`) and Ask
 * Compass (`open_compass`) are produced and dispatched by `app/search.tsx`.
 *
 * Lead ruling PR-D2-6 (2026-10-07): the spec's §43 list of eight action types
 * is NOT extended in this release. A search action is produced only where an
 * EXISTING type carries the same meaning:
 *   - Open Map  → `open_entity` — "open this entity" — whose `destination` is
 *     the map focused on that entity rather than its page. Built here.
 *   - Save      → no existing type means "save" (`set_structured_value`
 *     mutates the field; `share_entity` shares). NOT produced.
 *   - Start directions → no existing type hands off to navigation. NOT produced.
 *
 * WHAT THE ROW MAY CARRY. Census G187/G129 are structural: no suggestion
 * carries a coordinate. So the map route names the entity (`focusId`) and its
 * title, never a position; the map screen frames the entity when it is among
 * the objects it loads (`app/map/index.tsx`'s focusId snap) and otherwise opens
 * on its default framing — no crash, no invented position.
 *
 * WHICH ROW. At most one, for the FIRST served place or event whose position
 * this viewer may see exactly (the same refusal set as the §28 distance band:
 * no hidden gem, no person, no row the protection pass coarsened or withheld,
 * no event whose venue is withheld from this viewer). An entity with no position
 * the viewer may have cannot be "opened on the map" honestly.
 */
import type { SearchResult } from './searchCandidates';
import type { InputContext, InputFieldPolicy, InputSuggestion } from './types';
import { searchTypeToEntity, type DispatchSearchType } from './entityMap';

/** The contexts that are a SEARCH BAR (where §21's search actions live). */
const SEARCH_ACTION_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['global_search']);
/**
 * The search-bar FIELD that dispatches Open Map (`app/search.tsx`, field id
 * `SEARCH_FIELD_IDS.globalSearch`). Other `global_search` fields — the Wall's
 * steer bar above all — cannot open the map and turn an entity row into a feed
 * filter, so they are never sent the row (review finding, 2026-10-07). A field
 * id is a targeting hint, not a permission: the row grants nothing.
 */
export const OPEN_MAP_FIELD_IDS: ReadonlySet<string> = new Set(['discovery.search']);
/** The dispatch types that have a map object and a position this layer can vouch for. */
const MAPPABLE_RESULT_TYPES: ReadonlySet<string> = new Set(['places', 'events']);

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The "Open on map" action row for one served search row, or null whenever the
 * field is not a search bar, the policy permits no action rows, the row is not
 * a place or event, or its position is not one this viewer may see exactly.
 */
export function buildOpenOnMapRow(
  r: SearchResult,
  context: InputContext,
  policy: InputFieldPolicy,
  policyVersion: string,
): InputSuggestion | null {
  if (!SEARCH_ACTION_CONTEXTS.has(context)) return null;
  if (!OPEN_MAP_FIELD_IDS.has(policy.fieldId)) return null;
  if (!policy.allowedSuggestionTypes.includes('action')) return null;
  if (!MAPPABLE_RESULT_TYPES.has(r.type)) return null;
  const m = r.metadata;
  if (!m || typeof m !== 'object') return null;
  if ((m as Record<string, unknown>).coordsPrecision !== undefined) return null;
  if (!finite((m as Record<string, unknown>).lat) || !finite((m as Record<string, unknown>).lng)) return null;
  const title = (r.title ?? '').trim();
  if (!title || !r.id) return null;
  const entityType = searchTypeToEntity(r.type as DispatchSearchType);
  const route = `/map?focusId=${encodeURIComponent(r.id)}&title=${encodeURIComponent(title)}&entry=search`;
  return {
    id: `${context}:action:open-map:${r.type}:${r.id}`,
    type: 'action',
    context,
    label: 'Open on map',
    subtitle: title,
    entityType,
    entityId: r.id,
    action: { type: 'open_entity', entityType, entityId: r.id },
    destination: { route, entityType, entityId: r.id },
    confidence: 0.5,
    source: 'canonical',
    policyVersion,
  };
}
