"use strict";
/**
 * Pure composer logic — extracted so it's testable without React/RN. The
 * composer screen uses these to decide submit-ability and to build the
 * location payload. Keeping them pure lets node:test verify the rules:
 *   - media required before submit
 *   - passport default ON with media
 *   - location_source mapping (gps/manual/none)
 *   - frontend never sends a trusted location_verified
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FORBIDDEN_CLIENT_KEYS = void 0;
exports.canSubmit = canSubmit;
exports.defaultPassportToggle = defaultPassportToggle;
exports.buildLocationPayload = buildLocationPayload;
exports.payloadHasForbiddenKeys = payloadHasForbiddenKeys;
/** Submit allowed only with media and not already submitting. */
function canSubmit(s) {
    return s.hasMedia && !s.submitting;
}
/** Passport toggle default: ON when media exists. */
function defaultPassportToggle(hasMedia) {
    return hasMedia === true;
}
/**
 * Build the location portion of the create payload. Critically, this NEVER
 * includes location_verified / stamp_eligible — those are server-decided. For
 * GPS, the user's current coords are sent as BOTH tagged + userGps (the "use my
 * current location" case). For manual, only labels (no coords) so the backend
 * yields manual_location_only.
 */
function buildLocationPayload(sel) {
    var _a, _b, _c, _d, _e, _f;
    if (sel.source === 'gps' && sel.lat != null && sel.lng != null) {
        return {
            locationSource: 'gps',
            locationName: (_a = sel.name) !== null && _a !== void 0 ? _a : null,
            locationCity: (_b = sel.city) !== null && _b !== void 0 ? _b : null,
            locationCountry: (_c = sel.country) !== null && _c !== void 0 ? _c : null,
            locationLat: sel.lat,
            locationLng: sel.lng,
            userGpsLat: sel.lat,
            userGpsLng: sel.lng,
        };
    }
    if (sel.source === 'manual' && ((_d = sel.name) !== null && _d !== void 0 ? _d : '').trim().length > 0) {
        return {
            locationSource: 'manual',
            locationName: sel.name,
            locationCity: (_e = sel.city) !== null && _e !== void 0 ? _e : null,
            locationCountry: (_f = sel.country) !== null && _f !== void 0 ? _f : null,
        };
    }
    return { locationSource: 'none' };
}
/** Keys the frontend must NEVER send (server owns verification). */
exports.FORBIDDEN_CLIENT_KEYS = ['location_verified', 'stamp_eligible', 'locationVerified', 'stampEligible'];
function payloadHasForbiddenKeys(payload) {
    return exports.FORBIDDEN_CLIENT_KEYS.some(function (k) { return k in payload; });
}
