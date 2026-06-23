"use strict";
/**
 * Shared Place type definitions for GlobalPlacePicker, GPSPlaceLibrary,
 * and all location fields across the app.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.legacyToPlace = legacyToPlace;
/** Convert a raw city/country string pair into a minimal Place snapshot (legacy compat). */
function legacyToPlace(city, country) {
    return {
        id: "legacy-".concat(city.toLowerCase().replace(/\s+/g, '-')),
        type: 'city',
        name: city,
        displayName: country ? "".concat(city, ", ").concat(country) : city,
        country: country !== null && country !== void 0 ? country : null,
        countryCode: null,
        region: null,
        city: city,
        district: null,
        lat: null,
        lng: null,
        timezone: null,
        source: 'legacy',
    };
}
