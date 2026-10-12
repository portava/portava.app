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

// ── OD-1012-STAMP-1..3: which stamps are presence, enforced in the ENGINE ─────
//
// Owner, 2026-10-12 (docs/ops/owner-decisions-20261012.md OD-1012-STAMP-1..3):
// planning or contribution stamps "must not imply verified physical presence or
// earn verified-travel trust credit", enforced "including generic/admin award
// paths", with notification wording "describing the actual achievement".
//
// `placelessAward` above covers the three route writers that build the input
// themselves. POST /admin/stamps/award, the internal POST /stamps/award, the
// criteria engine and any future caller reach StampAwardEngine with whatever
// slug and place they were given, so the engine itself asks this registry.
//
// WHY A CODE REGISTRY AND NOT A READ OF `stamp_definitions.evidences_presence`:
// 2970 adds that column, but as of docs/ops/deployment-backlog-20261004.md it is
// not applied to production. The engine's definition read is on the award's
// critical path; selecting a column that is absent would fail EVERY award
// (`definition_not_found`), presence stamps included. This set is 2970's
// presence-TRUE block verbatim (PRESENCE-TRUE-SLUGS-BEGIN/END) and
// stampPresenceAwardGate.test.ts fails if the two ever differ, so there is one
// classification with two readers that cannot drift.
//
// FAIL CLOSED: exact, case-sensitive membership. A slug not listed here —
// unknown, newly seeded, mis-cased, padded — is NOT presence: its award keeps
// the achievement, drops the place, and earns no verified-travel trust credit.
// Under-crediting a real visit is visible to the person and asserts nothing
// false; over-crediting a plan is a false statement about a person (2970's
// header, "THE DEFAULT FAILS SAFE").
export const PRESENCE_STAMP_SLUGS: ReadonlySet<string> = new Set([
  // (a) trip COMPLETION — routes/trips.ts#awardTripCompletionStamps
  "first_trip_completed",
  "long_haul",
  "weekend_wanderer",
  "international_voyager",
  "solo_traveler",
  "group_tripper",
  "good_host",
  "road_warrior",
  "frequent_flyer",
  // (b) GPS-verified postcard — routes/posts.ts inside `verdict.stampEligible`
  "city_explorer",
  "world_citizen",
  "globe_trotter_5",
  "globe_trotter_10",
]);

/** True only for a slug 2970 classifies as evidence of presence. Fail closed. */
export function isPresenceStamp(slug: string): boolean {
  return typeof slug === "string" && PRESENCE_STAMP_SLUGS.has(slug);
}

/** Achievement copy for the known planning / contribution slugs (OD-1012-STAMP-3). */
const NON_PRESENCE_ACHIEVEMENT_TEXT: Readonly<Record<string, string>> = {
  first_trip_created:  TRIP_CREATION_STAMP_LOCATION_TEXT,
  trip_planner:        TRIP_CREATION_STAMP_LOCATION_TEXT,
  hidden_gem_explorer: GEM_APPROVAL_STAMP_LOCATION_TEXT,
  first_postcard:      FIRST_POSTCARD_STAMP_LOCATION_TEXT,
};

/**
 * The `location` param of a passport.stamp_earned notification ("You earned a
 * stamp for <location>") for a generic award path that knows only the slug,
 * the place it was handed and the definition's name.
 *
 *   presence     → city, else country, else the definition name (unchanged).
 *   non-presence → the achievement copy above, else the definition name, else
 *                  "a new achievement". NEVER the passed city/country: naming
 *                  a place there reads as having been there.
 */
export function stampEarnedLocationText(
  slug: string,
  place: { city?: string | null; country?: string | null },
  definitionName?: string | null,
): string {
  const name = typeof definitionName === "string" && definitionName.trim() ? definitionName : null;
  if (isPresenceStamp(slug)) return place.city || place.country || name || slug;
  return NON_PRESENCE_ACHIEVEMENT_TEXT[slug] ?? name ?? "a new achievement";
}
