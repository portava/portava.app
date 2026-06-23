"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeNominatimResult = normalizeNominatimResult;
exports.normalizeReverseResult = normalizeReverseResult;
/** Map Nominatim type/class strings to our PlaceType enum */
function mapNominatimType(type, cls) {
    if (type === 'country')
        return 'country';
    if (type === 'state' || type === 'province' || type === 'region')
        return 'region';
    if (type === 'city' || type === 'town')
        return 'city';
    if (type === 'village' || type === 'hamlet' || type === 'municipality')
        return 'town';
    if (type === 'suburb' || type === 'neighbourhood' || type === 'quarter')
        return 'neighborhood';
    if (type === 'district' || type === 'borough')
        return 'district';
    if (type === 'aeroway' || type === 'aerodrome')
        return 'airport';
    if (cls === 'natural' || cls === 'tourism')
        return 'landmark';
    return 'place';
}
/** Normalize a Nominatim search result into a Place */
function normalizeNominatimResult(raw) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
    var addr = (_a = raw.address) !== null && _a !== void 0 ? _a : {};
    var city = (_f = (_e = (_d = (_c = (_b = addr.city) !== null && _b !== void 0 ? _b : addr.town) !== null && _c !== void 0 ? _c : addr.village) !== null && _d !== void 0 ? _d : addr.municipality) !== null && _e !== void 0 ? _e : addr.county) !== null && _f !== void 0 ? _f : null;
    var district = (_j = (_h = (_g = addr.suburb) !== null && _g !== void 0 ? _g : addr.neighbourhood) !== null && _h !== void 0 ? _h : addr.quarter) !== null && _j !== void 0 ? _j : null;
    var country = (_k = addr.country) !== null && _k !== void 0 ? _k : null;
    var countryCode = (_m = (_l = addr.country_code) === null || _l === void 0 ? void 0 : _l.toUpperCase()) !== null && _m !== void 0 ? _m : null;
    var region = (_p = (_o = addr.state) !== null && _o !== void 0 ? _o : addr.province) !== null && _p !== void 0 ? _p : null;
    var type = mapNominatimType((_q = raw.type) !== null && _q !== void 0 ? _q : '', (_r = raw.class) !== null && _r !== void 0 ? _r : '');
    var name = (_z = (_x = (_w = (_v = (_u = (_t = (_s = raw.namedetails) === null || _s === void 0 ? void 0 : _s.name) !== null && _t !== void 0 ? _t : addr.city) !== null && _u !== void 0 ? _u : addr.town) !== null && _v !== void 0 ? _v : addr.village) !== null && _w !== void 0 ? _w : addr.municipality) !== null && _x !== void 0 ? _x : (_y = raw.display_name) === null || _y === void 0 ? void 0 : _y.split(',')[0]) !== null && _z !== void 0 ? _z : 'Unknown';
    var displayParts = [name];
    if (district && district !== name)
        displayParts.push(district);
    if (city && city !== name)
        displayParts.push(city);
    if (country)
        displayParts.push(country);
    return {
        id: "nominatim-".concat(raw.place_id),
        type: type,
        name: name,
        displayName: displayParts.join(', '),
        country: country,
        countryCode: countryCode,
        region: region,
        city: city,
        district: district,
        lat: raw.lat != null ? parseFloat(raw.lat) : null,
        lng: raw.lon != null ? parseFloat(raw.lon) : null,
        timezone: null,
        source: 'nominatim',
        confidence: (_0 = raw.importance) !== null && _0 !== void 0 ? _0 : undefined,
    };
}
/** Normalize a reverse geocode result */
function normalizeReverseResult(raw) {
    var _a, _b;
    if (!raw || raw.error)
        return null;
    return normalizeNominatimResult(__assign(__assign({}, raw), { type: (_a = raw.type) !== null && _a !== void 0 ? _a : 'city', class: (_b = raw.class) !== null && _b !== void 0 ? _b : 'place' }));
}
