/**
 * Award inputs for the stamps that are NOT evidence of presence — built here so
 * that a writer cannot attach a place to them.
 *
 * census-highlights-memories H4 ("Planned/saved/nearby never represented as
 * 'experienced' without occurrence evidence or user confirmation") and H239
 * ("planned activity without occurrence cannot earn a visit Memory/Stamp").
 * Migration 2970 classifies every slug below `evidences_presence = false`, and
 * its own seed comments name the defect each writer had:
 *
 *   first_trip_created, trip_planner — awarded at POST /api/trips, "destination
 *     attached, nothing occurred". A plan is not a visit.
 *   hidden_gem_explorer — awarded to the SUBMITTER on admin approval, "gem's
 *     city attached". An admin approving a gem vouches for the gem, not for
 *     where the submitter has been.
 *   first_postcard — "postcard city attached but NOT gated on stampEligible".
 *
 * §L.4 / §N.4 of that census: four readers filter these rows by the definition,
 * and "a prohibition whose violation is filtered out downstream is not
 * satisfied". So the writers stop: the achievement is kept, the place claim is
 * dropped. The place still lives where it is true — on the trip, the gem, the
 * postcard — and the definitions' own descriptions ("Create your first trip",
 * "Discovered and shared an approved hidden gem", "Share your first passport
 * postcard") name no place. With no city/country, StampAwardEngine resolves the
 * definition-scoped catalog entry, its designed path for a location-less stamp.
 *
 * `placelessAward` has NO city/country/lat/lng in its type and strips them at
 * runtime, so putting one back is a compile error rather than a review catch.
 */
import type { AwardInput } from "./StampAwardEngine.js";

/** An award that cannot carry a place. */
export type PlacelessAwardInput = Omit<AwardInput, "city" | "country" | "lat" | "lng">;

/**
 * Notification `location` text for these awards. The template renders
 * "You earned a stamp for <location>" — a destination there reads as a visit.
 */
export const TRIP_CREATION_STAMP_LOCATION_TEXT = "planning your trip";
export const GEM_APPROVAL_STAMP_LOCATION_TEXT = "sharing a hidden gem";
export const FIRST_POSTCARD_STAMP_LOCATION_TEXT = "your first postcard";

/**
 * The award input for a non-presence stamp, with any place removed. Typed so a
 * caller cannot pass one, and stripped at runtime as well so an `as any` or a
 * widened object cannot smuggle one through. The slug stays a literal at the
 * call site (stampTriggerAudit.test.ts audits route files for it).
 */
export function placelessAward(input: PlacelessAwardInput): PlacelessAwardInput {
  const { city: _c, country: _k, lat: _a, lng: _o, ...rest } = input as AwardInput;
  return rest;
}
