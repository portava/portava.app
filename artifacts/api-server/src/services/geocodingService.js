"use strict";
/**
 * geocodingService — server-side reverse geocoding via OpenStreetMap Nominatim.
 *
 * Nominatim policy: max 1 request/second, User-Agent required.
 * We enforce a 1.1-second gap between calls with a simple in-process mutex.
 * Falls back gracefully — never throws, never crashes the app.
 *
 * Provider priority:
 *   1. Mapbox if MAPBOX_TOKEN env var is set
 *   2. Nominatim (OSM) — free, no key, rate-limited
 *   3. Null fallback (coordinates saved, city name unavailable)
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reverseGeocode = reverseGeocode;
var NULL_RESULT = {
    city: null,
    district: null,
    country: null,
    countryCode: null,
    formatted: null,
};
// ── Rate-limit mutex (Nominatim: 1 req/sec) ─────────────────────────────────
var lastNominatimAt = 0;
var NOMINATIM_MIN_MS = 1100;
function nominatimThrottle() {
    return __awaiter(this, void 0, void 0, function () {
        var wait;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    wait = NOMINATIM_MIN_MS - (Date.now() - lastNominatimAt);
                    if (!(wait > 0)) return [3 /*break*/, 2];
                    return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, wait); })];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2:
                    lastNominatimAt = Date.now();
                    return [2 /*return*/];
            }
        });
    });
}
// ── Mapbox ───────────────────────────────────────────────────────────────────
function reverseGeocodeMapbox(lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var token, url, res, data, features, get, city, district, country, cc, formatted;
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        return __generator(this, function (_o) {
            switch (_o.label) {
                case 0:
                    token = process.env.MAPBOX_TOKEN;
                    if (!token)
                        throw new Error("no_token");
                    url = "https://api.mapbox.com/geocoding/v5/mapbox.places/".concat(lng, ",").concat(lat, ".json?types=neighborhood,locality,place,district,region&access_token=").concat(token);
                    return [4 /*yield*/, fetch(url, { signal: AbortSignal.timeout(8000) })];
                case 1:
                    res = _o.sent();
                    if (!res.ok)
                        throw new Error("mapbox_".concat(res.status));
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _o.sent();
                    features = (_a = data.features) !== null && _a !== void 0 ? _a : [];
                    get = function (type) { var _a, _b; return (_b = (_a = features.find(function (f) { return f.place_type.includes(type); })) === null || _a === void 0 ? void 0 : _a.text) !== null && _b !== void 0 ? _b : null; };
                    city = (_c = (_b = get("locality")) !== null && _b !== void 0 ? _b : get("place")) !== null && _c !== void 0 ? _c : null;
                    district = (_d = get("neighborhood")) !== null && _d !== void 0 ? _d : null;
                    country = (_e = get("country")) !== null && _e !== void 0 ? _e : null;
                    cc = (_j = (_h = (_g = (_f = features
                        .find(function (f) { return f.place_type.includes("country"); })) === null || _f === void 0 ? void 0 : _f.properties) === null || _g === void 0 ? void 0 : _g.short_code) === null || _h === void 0 ? void 0 : _h.toUpperCase()) !== null && _j !== void 0 ? _j : null;
                    formatted = (_m = (_l = (_k = features[0]) === null || _k === void 0 ? void 0 : _k.place_name) === null || _l === void 0 ? void 0 : _l.split(",").slice(0, 3).join(",").trim()) !== null && _m !== void 0 ? _m : null;
                    return [2 /*return*/, { city: city, district: district, country: country, countryCode: cc, formatted: formatted }];
            }
        });
    });
}
// ── Nominatim ────────────────────────────────────────────────────────────────
function reverseGeocodeNominatim(lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var url, res, data, addr, city, district, country, countryCode, formatted;
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p;
        return __generator(this, function (_q) {
            switch (_q.label) {
                case 0: return [4 /*yield*/, nominatimThrottle()];
                case 1:
                    _q.sent();
                    url = "https://nominatim.openstreetmap.org/reverse?lat=".concat(lat, "&lon=").concat(lng, "&format=json&zoom=14&addressdetails=1");
                    return [4 /*yield*/, fetch(url, {
                            headers: { "User-Agent": "TravelBuddyApp/1.0 (contact via app)" },
                            signal: AbortSignal.timeout(10000),
                        })];
                case 2:
                    res = _q.sent();
                    if (!res.ok)
                        return [2 /*return*/, NULL_RESULT];
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _q.sent();
                    addr = (_a = data.address) !== null && _a !== void 0 ? _a : {};
                    city = (_f = (_e = (_d = (_c = (_b = addr.city) !== null && _b !== void 0 ? _b : addr.town) !== null && _c !== void 0 ? _c : addr.village) !== null && _d !== void 0 ? _d : addr.municipality) !== null && _e !== void 0 ? _e : addr.county) !== null && _f !== void 0 ? _f : null;
                    district = (_j = (_h = (_g = addr.suburb) !== null && _g !== void 0 ? _g : addr.neighbourhood) !== null && _h !== void 0 ? _h : addr.quarter) !== null && _j !== void 0 ? _j : null;
                    country = (_k = addr.country) !== null && _k !== void 0 ? _k : null;
                    countryCode = (_m = (_l = addr.country_code) === null || _l === void 0 ? void 0 : _l.toUpperCase()) !== null && _m !== void 0 ? _m : null;
                    formatted = (_p = (_o = data.display_name) === null || _o === void 0 ? void 0 : _o.split(",").slice(0, 3).join(",").trim()) !== null && _p !== void 0 ? _p : null;
                    return [2 /*return*/, { city: city, district: district, country: country, countryCode: countryCode, formatted: formatted }];
            }
        });
    });
}
// ── Public API ────────────────────────────────────────────────────────────────
function reverseGeocode(lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    if (!process.env.MAPBOX_TOKEN) return [3 /*break*/, 4];
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, reverseGeocodeMapbox(lat, lng)];
                case 2: return [2 /*return*/, _c.sent()];
                case 3:
                    _a = _c.sent();
                    return [3 /*break*/, 4];
                case 4:
                    _c.trys.push([4, 6, , 7]);
                    return [4 /*yield*/, reverseGeocodeNominatim(lat, lng)];
                case 5: return [2 /*return*/, _c.sent()];
                case 6:
                    _b = _c.sent();
                    return [2 /*return*/, NULL_RESULT];
                case 7: return [2 /*return*/];
            }
        });
    });
}
