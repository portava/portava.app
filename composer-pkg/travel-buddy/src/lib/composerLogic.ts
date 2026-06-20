/**
 * Pure composer logic — extracted so it's testable without React/RN. The
 * composer screen uses these to decide submit-ability and to build the
 * location payload. Keeping them pure lets node:test verify the rules:
 *   - media required before submit
 *   - passport default ON with media
 *   - location_source mapping (gps/manual/none)
 *   - frontend never sends a trusted location_verified
 */

export type LocSource = 'gps' | 'manual' | 'none';

export interface ComposerState {
  hasMedia: boolean;
  submitting: boolean;
}

/** Submit allowed only with media and not already submitting. */
export function canSubmit(s: ComposerState): boolean {
  return s.hasMedia && !s.submitting;
}

/** Passport toggle default: ON when media exists. */
export function defaultPassportToggle(hasMedia: boolean): boolean {
  return hasMedia === true;
}

export interface LocationSelection {
  source: LocSource;
  lat?: number | null;
  lng?: number | null;
  name?: string | null;
  city?: string | null;
  country?: string | null;
}

/**
 * Build the location portion of the create payload. Critically, this NEVER
 * includes location_verified / stamp_eligible — those are server-decided. For
 * GPS, the user's current coords are sent as BOTH tagged + userGps (the "use my
 * current location" case). For manual, only labels (no coords) so the backend
 * yields manual_location_only.
 */
export function buildLocationPayload(sel: LocationSelection): Record<string, unknown> {
  if (sel.source === 'gps' && sel.lat != null && sel.lng != null) {
    return {
      locationSource: 'gps',
      locationName: sel.name ?? null,
      locationCity: sel.city ?? null,
      locationCountry: sel.country ?? null,
      locationLat: sel.lat,
      locationLng: sel.lng,
      userGpsLat: sel.lat,
      userGpsLng: sel.lng,
    };
  }
  if (sel.source === 'manual' && (sel.name ?? '').trim().length > 0) {
    return {
      locationSource: 'manual',
      locationName: sel.name,
      locationCity: sel.city ?? null,
      locationCountry: sel.country ?? null,
    };
  }
  return { locationSource: 'none' };
}

/** Keys the frontend must NEVER send (server owns verification). */
export const FORBIDDEN_CLIENT_KEYS = ['location_verified', 'stamp_eligible', 'locationVerified', 'stampEligible'];

export function payloadHasForbiddenKeys(payload: Record<string, unknown>): boolean {
  return FORBIDDEN_CLIENT_KEYS.some((k) => k in payload);
}
