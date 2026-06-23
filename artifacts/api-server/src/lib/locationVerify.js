"use strict";
/**
 * Location verification — the SERVER owns this. Never trust client-supplied
 * location_verified / stamp_eligible. Pure functions so they're exhaustively
 * testable (node:test).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_THRESHOLD_METERS = void 0;
exports.calculateDistanceMeters = calculateDistanceMeters;
exports.verifyLocation = verifyLocation;
exports.shouldCreatePostcard = shouldCreatePostcard;
exports.DEFAULT_THRESHOLD_METERS = 1609; // ~1 mile, configurable
/** Great-circle distance in meters (haversine). */
function calculateDistanceMeters(lat1, lng1, lat2, lng2) {
    var R = 6371000; // earth radius, meters
    var toRad = function (d) { return (d * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.pow(Math.sin(dLat / 2), 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLng / 2), 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
/**
 * Decide verification. The ONLY path to a verified stamp:
 *   - locationSource is 'gps'
 *   - both tagged coords AND user GPS coords exist
 *   - distance <= threshold
 * Everything else -> not verified, with a precise reason.
 */
function verifyLocation(input) {
    var _a;
    var threshold = (_a = input.thresholdMeters) !== null && _a !== void 0 ? _a : exports.DEFAULT_THRESHOLD_METERS;
    var hasTagged = isNum(input.locationLat) && isNum(input.locationLng);
    var hasGps = isNum(input.userGpsLat) && isNum(input.userGpsLng);
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
        var distance = calculateDistanceMeters(input.userGpsLat, input.userGpsLng, input.locationLat, input.locationLng);
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
function notVerified(reason, method, distance) {
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
function shouldCreatePostcard(input) {
    return (Array.isArray(input.mediaUrls) &&
        input.mediaUrls.length > 0 &&
        input.addToPassport === true &&
        input.status === 'active');
}
