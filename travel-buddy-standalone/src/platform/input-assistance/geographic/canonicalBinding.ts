/**
 * Global Input Intelligence — Phase 2 (Geographic Core): canonical binding capture.
 *
 * Implements the §17 cross-field dependency graph + §53 trip-destination context
 * carryover for the CLIENT. When a geographic field resolves to a canonical
 * Place (via the existing `resolveCanonical` runtime), this module captures the
 * bounded identity — city id, country, timezone, coordinates — that dependent
 * fields may inherit (§17) and that the task/session may carry (§53, §16).
 *
 * "Autofilled fields must remain visible, attributable, and editable. No
 * invisible field mutation." (§17). This module only CAPTURES the binding; the
 * screen decides what to prefill and keeps every value editable.
 *
 * Pure module — no React, no network, no supabase — so it is unit-testable under
 * the node:test runner. It depends only on the pure `Place` type + the pure
 * `InputSessionContext` type.
 */
import type { Place, PlaceType } from '../../../lib/location/placeTypes.ts';
import type { InputSessionContext } from '../types/inputSuggestion.ts';
import type { EntityType } from '../types/inputContext.ts';

/**
 * §17 / §53 — the canonical identity captured when a geographic selection
 * resolves. `resolved` is true only when the Place carries a `canonicalId` (the
 * universal location registry echoed a find-or-create row); an unresolved
 * selection still yields a binding so its raw fields stay usable (§2 preserve
 * input on low confidence).
 */
export interface CanonicalPlaceBinding {
  entityType: EntityType;
  /** Canonical entity id — the registry `canonicalId` when present, else the
   *  provider place id, else null for a hand-typed value with no id. */
  entityId: string | null;
  canonicalId: string | null;
  displayName: string;
  city: string | null;
  country: string | null;
  countryCode: string | null;
  neighborhood: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string | null;
  /** True when the selection is bound to a canonical registry row. */
  resolved: boolean;
}

/** Map a Place's provider `type` to the Input Intelligence canonical EntityType. */
export function entityTypeForPlace(type: PlaceType): EntityType {
  switch (type) {
    case 'country':
      return 'country';
    case 'region':
    case 'city':
    case 'town':
      return 'city';
    case 'district':
    case 'neighborhood':
      return 'neighborhood';
    default:
      return 'place';
  }
}

/** A finite number, or null. Preserves a genuine 0 coordinate (Null Island). */
function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

/**
 * §17 / §53 — capture the canonical binding of a resolved (or unresolved) Place.
 *
 * Never throws and never mutates the input. The `city` value falls back to the
 * place name so picking a region/island/district still yields a usable city
 * (mirrors `resolvePickedPlace`'s `city ?? name` rule, and deliberately does NOT
 * use `displayName`, which carries the country suffix).
 */
export function captureCanonicalBinding(place: Place): CanonicalPlaceBinding {
  const canonicalId = trimOrNull(place.canonicalId ?? null);
  const rawId = trimOrNull(place.id);
  return {
    entityType: entityTypeForPlace(place.type),
    entityId: canonicalId ?? rawId,
    canonicalId,
    displayName: (place.displayName ?? place.name ?? '').trim(),
    city: trimOrNull(place.city) ?? trimOrNull(place.name),
    country: trimOrNull(place.country),
    countryCode: trimOrNull(place.countryCode),
    neighborhood: trimOrNull(place.district),
    lat: finiteOrNull(place.lat),
    lng: finiteOrNull(place.lng),
    timezone: trimOrNull(place.timezone),
    resolved: canonicalId != null,
  };
}

/**
 * §53 / §16 — project a captured binding into the bounded task/session context
 * that dependent fields forward to the gateway. Deliberately narrow: only the
 * ids/coords the server may use to bias ranking. Never carries persistent
 * preferences. Returns only the keys the binding actually has, so a partial
 * binding never overwrites a sibling field's context with nulls.
 */
export function bindingToSessionContext(
  binding: CanonicalPlaceBinding | null | undefined,
): Partial<InputSessionContext> {
  if (!binding) return {};
  const ctx: Partial<InputSessionContext> = {};
  // Only a city-class binding contributes a cityId anchor (§15/§53).
  if (binding.entityId && (binding.entityType === 'city' || binding.entityType === 'place')) {
    ctx.cityId = binding.entityId;
  }
  if (binding.lat != null) ctx.lat = binding.lat;
  if (binding.lng != null) ctx.lng = binding.lng;
  if (binding.timezone) ctx.tz = binding.timezone;
  return ctx;
}

/**
 * True when a Place has NOT been bound to a canonical registry row and therefore
 * should be sent through `resolveCanonical` before it is persisted. This is the
 * exact condition behind the trip-edit defect: a destination hand-built from
 * `destinationCity/Country` carries no `canonicalId`, so saving without
 * re-picking would persist an unresolved, non-canonical destination.
 */
export function placeNeedsCanonicalResolution(place: Place | null | undefined): boolean {
  if (!place) return false;
  return !trimOrNull(place.canonicalId ?? null);
}
