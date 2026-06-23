"use strict";
/**
 * Nearby venues helper — OpenStreetMap Nominatim + Overpass API.
 *
 * Free, no API key required. Uses:
 *   - Nominatim for geocoding a location name → lat/lng
 *   - Overpass API for nearby restaurant/cafe/food POIs
 *
 * Results are cached in-memory with a 30-minute TTL (restaurant data
 * changes slowly; caching avoids hammering OSM on repeated commands).
 *
 * Privacy: only the location name is sent to Nominatim; only lat/lng
 * is sent to Overpass. No user identifiers leave this server.
 *
 * Graceful degradation: any error, timeout, or empty result returns [].
 * Callers must treat the result as optional and fall back to templates.
 */
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
exports.getNearbyVenues = getNearbyVenues;
exports.formatDistance = formatDistance;
var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
var FETCH_TIMEOUT_MS = 6000;
var CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
var DEFAULT_RADIUS_M = 600;
var MAX_RESULTS = 5;
var cache = new Map();
function cacheKey(location) {
    return location.toLowerCase().trim();
}
function isFresh(entry) {
    return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}
function fetchWithTimeout(url, init) {
    return __awaiter(this, void 0, void 0, function () {
        var ctrl, t;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    ctrl = new AbortController();
                    t = setTimeout(function () { return ctrl.abort(); }, FETCH_TIMEOUT_MS);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, fetch(url, __assign(__assign({}, init), { signal: ctrl.signal }))];
                case 2: return [2 /*return*/, _a.sent()];
                case 3:
                    clearTimeout(t);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function geocode(location) {
    return __awaiter(this, void 0, void 0, function () {
        var url, res, data, r;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    url = "".concat(NOMINATIM_URL, "?q=").concat(encodeURIComponent(location), "&format=json&limit=1");
                    return [4 /*yield*/, fetchWithTimeout(url, {
                            headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy app)" },
                        })];
                case 1:
                    res = _a.sent();
                    if (!res.ok)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = (_a.sent());
                    r = data === null || data === void 0 ? void 0 : data[0];
                    if (!r)
                        return [2 /*return*/, null];
                    return [2 /*return*/, { lat: parseFloat(r.lat), lng: parseFloat(r.lon) }];
            }
        });
    });
}
/**
 * Convert a cuisine tag from OSM ("italian;pizza" → "Italian")
 * or return a friendly fallback.
 */
function formatCuisine(raw) {
    var _a, _b;
    if (!raw)
        return null;
    var first = (_b = (_a = raw.split(/[;,]/)[0]) === null || _a === void 0 ? void 0 : _a.trim()) !== null && _b !== void 0 ? _b : "";
    if (!first)
        return null;
    return first.charAt(0).toUpperCase() + first.slice(1).replace(/_/g, " ");
}
/**
 * Estimate distance in metres between two lat/lng points (Haversine).
 */
function haversineM(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var dLat = ((lat2 - lat1) * Math.PI) / 180;
    var dLng = ((lng2 - lng1) * Math.PI) / 180;
    var a = Math.pow(Math.sin(dLat / 2), 2) +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.pow(Math.sin(dLng / 2), 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
/**
 * Map distance to a rough price level (OSM rarely carries price data;
 * we use amenity type as a proxy instead).
 */
function guessPriceLevel(amenity) {
    if (amenity === "fast_food")
        return "$";
    if (amenity === "cafe")
        return "$";
    if (amenity === "food_court")
        return "$";
    return "$$";
}
function queryOverpass(lat, lng, radiusM) {
    return __awaiter(this, void 0, void 0, function () {
        var query, res, data, venues;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    query = "\n[out:json][timeout:5];\n(\n  node[\"amenity\"~\"^(restaurant|cafe|fast_food|bistro|bar|pub)$\"](around:".concat(radiusM, ",").concat(lat, ",").concat(lng, ");\n  way[\"amenity\"~\"^(restaurant|cafe|fast_food|bistro|bar|pub)$\"](around:").concat(radiusM, ",").concat(lat, ",").concat(lng, ");\n);\nout body center qt ").concat(MAX_RESULTS * 3, ";").trim();
                    return [4 /*yield*/, fetchWithTimeout(OVERPASS_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/x-www-form-urlencoded" },
                            body: "data=".concat(encodeURIComponent(query)),
                        })];
                case 1:
                    res = _b.sent();
                    if (!res.ok)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = (_b.sent());
                    if (!((_a = data === null || data === void 0 ? void 0 : data.elements) === null || _a === void 0 ? void 0 : _a.length))
                        return [2 /*return*/, []];
                    venues = data.elements
                        .filter(function (el) { var _a; return (_a = el.tags) === null || _a === void 0 ? void 0 : _a.name; })
                        .map(function (el) {
                        var _a, _b, _c, _d, _e, _f, _g, _h, _j;
                        var elLat = (_c = (_a = el.lat) !== null && _a !== void 0 ? _a : (_b = el.center) === null || _b === void 0 ? void 0 : _b.lat) !== null && _c !== void 0 ? _c : lat;
                        var elLng = (_f = (_d = el.lon) !== null && _d !== void 0 ? _d : (_e = el.center) === null || _e === void 0 ? void 0 : _e.lon) !== null && _f !== void 0 ? _f : lng;
                        return {
                            name: el.tags.name,
                            cuisine: formatCuisine((_g = el.tags) === null || _g === void 0 ? void 0 : _g.cuisine),
                            distanceM: Math.round(haversineM(lat, lng, elLat, elLng)),
                            priceLevel: guessPriceLevel((_j = (_h = el.tags) === null || _h === void 0 ? void 0 : _h.amenity) !== null && _j !== void 0 ? _j : "restaurant"),
                        };
                    })
                        .sort(function (a, b) { return a.distanceM - b.distanceM; })
                        .slice(0, MAX_RESULTS);
                    return [2 /*return*/, venues];
            }
        });
    });
}
/* ── Public API ───────────────────────────────────────────────────────────── */
/**
 * Returns up to 5 real nearby food venues for the given location string.
 * Returns [] on any error or when no named venues are found.
 */
function getNearbyVenues(location_1) {
    return __awaiter(this, arguments, void 0, function (location, radiusM) {
        var key, cached, coords, venues, _a;
        if (radiusM === void 0) { radiusM = DEFAULT_RADIUS_M; }
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    key = cacheKey(location);
                    cached = cache.get(key);
                    if (cached && isFresh(cached))
                        return [2 /*return*/, cached.venues];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, geocode(location)];
                case 2:
                    coords = _b.sent();
                    if (!coords)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, queryOverpass(coords.lat, coords.lng, radiusM)];
                case 3:
                    venues = _b.sent();
                    cache.set(key, { venues: venues, cachedAt: Date.now() });
                    return [2 /*return*/, venues];
                case 4:
                    _a = _b.sent();
                    return [2 /*return*/, []];
                case 5: return [2 /*return*/];
            }
        });
    });
}
/**
 * Format a distance in metres to a human-readable string.
 */
function formatDistance(distanceM) {
    if (distanceM < 100)
        return "< 100m away";
    if (distanceM < 1000)
        return "".concat(Math.round(distanceM / 50) * 50, "m away");
    return "".concat((distanceM / 1000).toFixed(1), "km away");
}
