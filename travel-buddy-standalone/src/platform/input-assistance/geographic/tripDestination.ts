/**
 * Global Input Intelligence — Phase 2 (Geographic Core): trip destination binding.
 *
 * Fixes the audited trip-edit defect (client audit §"Consolidated headline bugs"
 * item 3): the edit screen hydrated its destination as a hand-built object
 *   `{ name, city, country, displayName } as Place`
 * with null `lat/lng/id` and no `canonicalId`. Saving without re-picking then
 * persisted an unresolved, non-canonical destination — bypassing the universal
 * location registry that every picker selection normally goes through.
 *
 * This module supplies the two PURE, testable halves of the fix:
 *   1. `hydrateTripDestination` — build a well-formed `Place` (real id + fields)
 *      from the trip's stored `destinationCity/Country`, so the value can be
 *      resolved and cached like any other selection.
 *   2. `prepareTripDestinationForSave` — decide whether the current destination
 *      must be sent through canonical resolution before persistence.
 *
 * The async resolution itself stays in `resolveCanonical` (which imports
 * network/token code and is therefore not test-safe); the SCREEN wires the two
 * together. Keeping the decision here means it can be unit-tested without React.
 */
import type { Place } from '../../../lib/location/placeTypes.ts';
import { legacyToPlace } from '../../../lib/location/placeTypes.ts';
import { placeNeedsCanonicalResolution } from './canonicalBinding.ts';

/**
 * Build a well-formed `Place` from a trip's stored destination city/country.
 *
 * Returns null when there is no city — an empty destination is not a Place, and
 * the caller's "Destination is required" guard handles it. Unlike the old
 * hand-built object, the result has a stable `id` (so `resolveCanonical` can
 * cache it) and a proper `displayName`/`formattedAddress`, while carrying no
 * `canonicalId` — which correctly marks it as still-needing resolution.
 */
export function hydrateTripDestination(
  city: string | null | undefined,
  country?: string | null,
): Place | null {
  const c = (city ?? '').trim();
  if (!c) return null;
  const co = (country ?? '').trim();
  return legacyToPlace(c, co.length > 0 ? co : undefined);
}

export interface TripDestinationSavePrep {
  /** The place to persist (unchanged — resolution is the caller's async step). */
  place: Place;
  /** True when the place must be sent through `resolveCanonical` before saving. */
  needsResolution: boolean;
}

/**
 * Decide whether a trip destination must be canonically resolved before it is
 * saved. A place already bound to a registry row (`canonicalId` set) is ready;
 * anything else — including the hydrated placeholder above and any provider
 * place that was never resolved — needs the resolve step so the persisted
 * destination is canonical (§11).
 */
export function prepareTripDestinationForSave(place: Place): TripDestinationSavePrep {
  return { place, needsResolution: placeNeedsCanonicalResolution(place) };
}
