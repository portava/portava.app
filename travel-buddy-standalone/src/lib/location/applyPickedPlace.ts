/**
 * applyPickedPlace — what a picked Place does to typed location fields.
 *
 * ## Why this is one function rather than three copies
 *
 * Several composers let the user type a city, a country and a neighbourhood as
 * free text, and now also let them pick a canonical place. That raises one
 * question — what happens to text the user already typed — and it must have one
 * answer, because the wrong answer is a bug someone already fixed once.
 *
 * `EventComposerSheet.tsx:604` and `app/events/create/index.tsx:927` both carry
 * the same comment: "QA round 2, bug 6 … never overwrite a city/country the
 * user typed themselves. Picking a venue used to silently overwrite a manually
 * entered city with the picker's guess." Reversing that by accident, in a
 * commit whose stated purpose is to add pickers, is exactly how it comes back.
 *
 * ## The rule
 *
 * A blank field is filled silently — there is nothing to lose and the whole
 * point of picking is to save typing.
 *
 * A field the user has already typed into is never overwritten as a side
 * effect. It is reported as a CONFLICT, and the caller asks first.
 *
 * The distinction is between the user choosing to replace their text and the
 * app deciding to. Both end in the same state; only one of them is a surprise.
 *
 * Note this deliberately does NOT block a typed value that resolves to nothing.
 * A traveller in a small town whose village is not in a global place index must
 * still be able to save. The picker is available and preferred, not required.
 */
import type { Place } from './placeTypes.ts';

/** The free-text location fields a composer may hold. */
export interface LocationFields {
  city?: string;
  country?: string;
  neighborhood?: string;
}

export interface PickedPlaceOutcome {
  /** Canonical values for fields that were blank — apply these silently. */
  fill: LocationFields;
  /**
   * Canonical values that differ from non-empty text the user typed. Applying
   * these destroys their input, so the caller must confirm before doing so.
   */
  conflict: LocationFields;
  /** Coordinates from the picked place, when it carries them. */
  coords: { lat: number; lng: number } | null;
  /** True when any field would change — lets a caller skip a pointless prompt. */
  hasConflict: boolean;
}

/** Trimmed value, or undefined when the place does not carry one. */
function value(v: string | null | undefined): string | undefined {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : undefined;
}

function blank(v: string | undefined): boolean {
  return (v ?? '').trim().length === 0;
}

/**
 * Split a picked place into what can be applied silently and what needs asking.
 *
 * `current` is what the composer's inputs hold right now. Only fields the
 * composer actually has need to be passed; an absent key is treated as blank.
 */
export function resolvePickedPlace(
  place: Place,
  current: LocationFields,
): PickedPlaceOutcome {
  // `city` falls back to the place's own name so that picking a place the
  // index classifies as a region, island or district still fills the city
  // field rather than silently doing nothing. `displayName` is deliberately
  // NOT used: it carries the country suffix ("Ubud, Indonesia") and would put
  // a two-part string into a field the server matches with `city.ilike`.
  const incoming: LocationFields = {
    city: value(place.city) ?? value(place.name),
    country: value(place.country),
    neighborhood: value(place.district),
  };

  const fill: LocationFields = {};
  const conflict: LocationFields = {};

  for (const key of ['city', 'country', 'neighborhood'] as const) {
    const next = incoming[key];
    if (next === undefined) continue;          // place carries nothing for this field
    const held = current[key];
    if (blank(held)) { fill[key] = next; continue; }
    if (held!.trim() === next) continue;       // already agrees — not a conflict
    conflict[key] = next;
  }

  const lat = place.lat;
  const lng = place.lng;
  const coords =
    typeof lat === 'number' && Number.isFinite(lat) &&
    typeof lng === 'number' && Number.isFinite(lng)
      ? { lat, lng }
      : null;

  return { fill, conflict, coords, hasConflict: Object.keys(conflict).length > 0 };
}
