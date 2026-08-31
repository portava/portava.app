/**
 * Global Input Intelligence — Phase 2 (Geographic Core): field registration.
 *
 * §5/§52: a field joins the platform by registering a policy, not by building a
 * new engine. This module registers the canonical fieldIds for the geographic
 * surfaces so their policies resolve from the registry (mode, entity types,
 * privacy, offline, telemetry) rather than falling back to an ephemeral default.
 *
 * `registerGeographicFields()` is idempotent and safe to call from any screen's
 * mount. It is a pure registry operation (no React/network), so it is
 * unit-testable and cheap.
 */
import type { InputContext } from '../types/inputContext.ts';
import { registerField, isFieldRegistered } from '../contexts/fieldRegistry.ts';

/**
 * Canonical fieldIds for the geographic surfaces. These are the stable keys the
 * registry, cache, and telemetry share — screens reference these constants
 * rather than hand-typing strings, so a rename happens in one place.
 */
export const GEO_FIELD_IDS = {
  tripDestination: 'trip.destination',
  tripStopPlace: 'trip.stop.place',
  eventLocation: 'event.location',
  gemLocation: 'gem.location',
  passportHomebase: 'passport.homebase',
  meetupLocation: 'meetup.location',
  buddyServiceArea: 'buddy.service_area',
  cityPicker: 'geo.city',
  countryPicker: 'geo.country',
  neighborhoodPicker: 'geo.neighborhood',
  placePicker: 'geo.place',
  address: 'geo.address',
} as const;

export type GeoFieldId = (typeof GEO_FIELD_IDS)[keyof typeof GEO_FIELD_IDS];

/** fieldId → InputContext for every geographic field. */
export const GEO_FIELD_CONTEXTS: Record<GeoFieldId, InputContext> = {
  [GEO_FIELD_IDS.tripDestination]: 'trip_destination',
  [GEO_FIELD_IDS.tripStopPlace]: 'trip_stop_place',
  [GEO_FIELD_IDS.eventLocation]: 'event_location',
  [GEO_FIELD_IDS.gemLocation]: 'hidden_gem_location',
  [GEO_FIELD_IDS.passportHomebase]: 'passport_homebase',
  [GEO_FIELD_IDS.meetupLocation]: 'place_picker',
  [GEO_FIELD_IDS.buddyServiceArea]: 'buddy_service_area',
  [GEO_FIELD_IDS.cityPicker]: 'city_picker',
  [GEO_FIELD_IDS.countryPicker]: 'country_picker',
  [GEO_FIELD_IDS.neighborhoodPicker]: 'neighborhood_picker',
  [GEO_FIELD_IDS.placePicker]: 'place_picker',
  [GEO_FIELD_IDS.address]: 'address',
};

let done = false;

/**
 * Register every geographic field's policy. Idempotent — repeated calls are a
 * no-op after the first, and individual fields already registered (e.g. by a
 * test) are left untouched.
 */
export function registerGeographicFields(): void {
  if (done) return;
  for (const [fieldId, context] of Object.entries(GEO_FIELD_CONTEXTS)) {
    if (!isFieldRegistered(fieldId)) registerField(fieldId, context);
  }
  done = true;
}

/** Test-only: reset the idempotency latch so registration can be re-exercised. */
export function _resetGeographicRegistration(): void {
  done = false;
}
