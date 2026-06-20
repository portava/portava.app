/**
 * Location verification — the SERVER owns this. Never trust client-supplied
 * location_verified / stamp_eligible. Pure functions so they're exhaustively
 * testable (node:test).
 */

export const DEFAULT_THRESHOLD_METERS = 1609; // ~1 mile, configurable

export type StampReason =
  | 'gps_within_radius'
  | 'manual_location_only'
  | 'gps_permission_denied'
  | 'gps_location_mismatch'
  | 'tagged_location_missing_coordinates'
  | 'verification_unavailable'
  | 'stamp_revoked';

export type VerificationMethod =
  | 'gps_current_location'
  | 'manual_only'
  | 'gps_mismatch'
  | 'unavailable';

export interface VerificationInput {
  /** tagged place coordinates (where the user says the post is) */
  locationLat?: number | null;
  locationLng?: number | null;
  /** the user's current GPS at posting time (private) */
  userGpsLat?: number | null;
  userGpsLng?: number | null;
  /** how the location was chosen */
  locationSource: 'gps' | 'manual' | 'none';
  thresholdMeters?: number;
}

export interface VerificationResult {
  locationVerified: boolean;
  stampEligible: boolean;
  stampReason: StampReason;
  verificationMethod: VerificationMethod;
  distanceMeters: number | null;
}

/** Great-circle distance in meters (haversine). */
export function calculateDistanceMeters(
  lat1: number, lng1: number, lat2: number, lng2: number,
): number {
  const R = 6371000; // earth radius, meters
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Decide verification. The ONLY path to a verified stamp:
 *   - locationSource is 'gps'
 *   - both tagged coords AND user GPS coords exist
 *   - distance <= threshold
 * Everything else -> not verified, with a precise reason.
 */
export function verifyLocation(input: VerificationInput): VerificationResult {
  const threshold = input.thresholdMeters ?? DEFAULT_THRESHOLD_METERS;
  const hasTagged = isNum(input.locationLat) && isNum(input.locationLng);
  const hasGps = isNum(input.userGpsLat) && isNum(input.userGpsLng);

  // No location at all.
  if (input.locationSource === 'none' && !hasTagged) {
    return notVerified('verification_unavailable', 'unavailable', null);
  }

  // Manual selection (user chose a place without GPS verification).
  if (input.locationSource === 'manual') {
    return notVerified('manual_location_only', 'manual_only', null);
  }

  // GPS path.
  if (input.locationSource === 'gps') {
    if (!hasGps) {
      // claimed gps but no coords provided -> treat as permission denied/unavailable
      return notVerified('gps_permission_denied', 'unavailable', null);
    }
    if (!hasTagged) {
      return notVerified('tagged_location_missing_coordinates', 'unavailable', null);
    }
    const distance = calculateDistanceMeters(
      input.userGpsLat as number, input.userGpsLng as number,
      input.locationLat as number, input.locationLng as number,
    );
    if (distance <= threshold) {
      return {
        locationVerified: true,
        stampEligible: true,
        stampReason: 'gps_within_radius',
        verificationMethod: 'gps_current_location',
        distanceMeters: Math.round(distance),
      };
    }
    // GPS exists but tagged place is too far -> mismatch, no stamp.
    return {
      locationVerified: false,
      stampEligible: false,
      stampReason: 'gps_location_mismatch',
      verificationMethod: 'gps_mismatch',
      distanceMeters: Math.round(distance),
    };
  }

  // Fallback.
  return notVerified('verification_unavailable', 'unavailable', null);
}

function notVerified(
  reason: StampReason, method: VerificationMethod, distance: number | null,
): VerificationResult {
  return {
    locationVerified: false,
    stampEligible: false,
    stampReason: reason,
    verificationMethod: method,
    distanceMeters: distance,
  };
}

/**
 * Should a post create a passport postcard?
 * Requires: at least one media URL, add_to_passport true, status active.
 */
export function shouldCreatePostcard(input: {
  mediaUrls: string[];
  addToPassport: boolean;
  status: string;
}): boolean {
  return (
    Array.isArray(input.mediaUrls) &&
    input.mediaUrls.length > 0 &&
    input.addToPassport === true &&
    input.status === 'active'
  );
}
