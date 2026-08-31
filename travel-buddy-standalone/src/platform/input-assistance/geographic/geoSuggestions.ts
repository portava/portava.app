/**
 * Global Input Intelligence — Phase 2 (Geographic Core): the gateway ⇄ Place bridge.
 *
 * The existing `GlobalPlacePicker` is THE canonical picker across ~25 surfaces
 * and speaks the app's `Place` shape end-to-end (search → resolve → save). To
 * source suggestions from the P1 gateway (`POST /input-assistance/suggest`)
 * WITHOUT rewriting the picker, this module maps between the canonical
 * `InputSuggestion` projection (§8) and `Place`, additively:
 *
 *   - `suggestionToPlace`  — a gateway geographic suggestion → a `Place` the
 *     picker can render + resolve through its existing canonical pipeline.
 *   - `placeToSuggestion`  — a local `Place` (GPS / recent / popular / trip) →
 *     an `InputSuggestion`, so the SmartInput overlay can render local rows.
 *   - `assembleGeoZeroState` — the §14 zero-character default list (current
 *     location · recent · your trips · popular), deduped and ordered.
 *
 * Pure module — no React, no network — unit-testable under node:test.
 */
import type { Place, PlaceType } from '../../../lib/location/placeTypes.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { AssistanceType, EntityType, InputContext } from '../types/inputContext.ts';
import { INPUT_POLICY_VERSION } from '../contexts/inputContexts.ts';
import { foldForMatch } from '../services/queryNormalization.ts';
import { entityTypeForPlace } from './canonicalBinding.ts';

/** Map the Input Intelligence EntityType back to a Place `type` for the picker. */
function placeTypeForEntity(entityType: EntityType | undefined): PlaceType {
  switch (entityType) {
    case 'country':
      return 'country';
    case 'city':
      return 'city';
    case 'neighborhood':
      return 'neighborhood';
    default:
      return 'place';
  }
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

/** A stable, collision-resistant Place id for a gateway-sourced suggestion. */
function gatewayPlaceId(s: InputSuggestion): string {
  const basis = s.entityId ?? foldForMatch(s.label).replace(/\s+/g, '-') ?? s.id;
  return `gw-${basis || s.id}`;
}

/**
 * Map a gateway geographic `InputSuggestion` to a `Place`.
 *
 * If the suggestion carries a fully-formed Place in `structuredValue` (the
 * server may echo one), that is normalized and used directly. Otherwise a
 * minimal Place is built from the label/subtitle/entity fields. The canonical
 * id is carried onto `Place.canonicalId` when the suggestion is canonical, so a
 * subsequent `resolveCanonical` short-circuits. Returns null for a non-place
 * suggestion (no label, or an action/completion row).
 */
export function suggestionToPlace(s: InputSuggestion): Place | null {
  const sv = s.structuredValue as Partial<Place> | undefined;
  if (sv && typeof sv === 'object' && typeof sv.name === 'string' && sv.name.trim()) {
    // Trust an embedded Place but ensure the canonical id + a stable id survive.
    const canonicalId = clean(sv.canonicalId ?? null) ?? clean(s.entityId ?? null);
    return {
      ...(sv as Place),
      id: clean(sv.id) ?? gatewayPlaceId(s),
      canonicalId: canonicalId ?? null,
      source: sv.source ?? 'canonical',
    };
  }

  const label = clean(s.label);
  if (!label) return null;

  const type = placeTypeForEntity(s.entityType);
  const canonicalId = clean(s.entityId ?? null);
  const subtitle = clean(s.subtitle);
  // Only append the subtitle when it adds information (e.g. the country), never
  // when it already repeats the label.
  const displayName =
    subtitle && !foldForMatch(subtitle).includes(foldForMatch(label))
      ? `${label}, ${subtitle}`
      : label;

  return {
    id: gatewayPlaceId(s),
    type,
    name: label,
    displayName,
    country: null,
    countryCode: null,
    region: null,
    city: type === 'city' ? label : null,
    district: null,
    lat: null,
    lng: null,
    timezone: null,
    source: 'canonical',
    canonicalId,
    confidence: typeof s.confidence === 'number' ? s.confidence : undefined,
  };
}

export interface PlaceToSuggestionOptions {
  source?: InputSuggestion['source'];
  reason?: string;
  assistanceType?: AssistanceType;
  /** Prefix to keep ids unique across zero-state sections (recent vs popular). */
  idPrefix?: string;
}

/**
 * Map a local `Place` to an `InputSuggestion` (§8) so the shared overlay can
 * render it. The full Place rides along in `structuredValue`, so selecting the
 * suggestion re-hydrates the exact Place for the picker's resolve pipeline.
 */
export function placeToSuggestion(
  place: Place,
  context: InputContext,
  opts: PlaceToSuggestionOptions = {},
): InputSuggestion {
  const label = (place.name ?? place.displayName ?? '').trim();
  return {
    id: opts.idPrefix ? `${opts.idPrefix}-${place.id}` : place.id,
    type: opts.assistanceType ?? 'entity',
    context,
    label,
    subtitle: place.displayName && place.displayName !== label ? place.displayName : undefined,
    replacementText: label,
    entityType: entityTypeForPlace(place.type),
    entityId: place.canonicalId ?? place.id,
    canonicalUri: place.canonicalId ?? undefined,
    confidence: place.confidence,
    source: opts.source ?? 'canonical',
    reason: opts.reason,
    structuredValue: place,
    policyVersion: INPUT_POLICY_VERSION,
  };
}

export interface GeoZeroStateInputs {
  /** The current-location Place (already reverse-geocoded), if available. */
  currentPlace?: Place | null;
  /** Device/session recent selections, most-recent first. */
  recents?: Place[];
  /** Current/upcoming trip destinations (§53 context relevance). */
  tripPlaces?: { place: Place; label?: string }[];
  /** Popular-on-Portava fallback. */
  popular?: Place[];
  /** Cap on total rows (default 12). */
  limit?: number;
}

/**
 * §14 — assemble the zero-character default list for a geographic field, in
 * canonical order: current location → recents → your trips → popular. Deduped by
 * canonical id (or folded name) so a city that is both a recent and popular
 * appears once. Every row is a canonical `InputSuggestion` carrying its Place.
 */
export function assembleGeoZeroState(
  inputs: GeoZeroStateInputs,
  context: InputContext,
): InputSuggestion[] {
  const out: InputSuggestion[] = [];
  const seen = new Set<string>();

  const push = (
    place: Place | null | undefined,
    source: InputSuggestion['source'],
    reason: string,
    assistanceType: AssistanceType,
  ) => {
    if (!place) return;
    const key = foldForMatch(place.canonicalId ?? place.name ?? place.id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(placeToSuggestion(place, context, { source, reason, assistanceType, idPrefix: source }));
  };

  push(inputs.currentPlace, 'local', 'Current location', 'personalized');
  for (const r of inputs.recents ?? []) push(r, 'recent', 'Recent', 'recent');
  for (const t of inputs.tripPlaces ?? []) push(t.place, 'memory', t.label ?? 'Your trips', 'personalized');
  for (const p of inputs.popular ?? []) push(p, 'canonical', 'Popular on Portava', 'entity');

  const limit = inputs.limit ?? 12;
  return out.slice(0, limit);
}
