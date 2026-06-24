"use strict";
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
exports.buildPublicContext = buildPublicContext;
exports.buildCityContext = buildCityContext;
/**
 * LocationIntelligenceEngine
 *
 * Converts raw coordinates into a public-safe context object.
 * Exact lat/lng NEVER leaves this module in any public-facing form.
 *
 * Public context contains only:
 *   - city, district, country (text labels)
 *   - approximate distance bucket (< 1 km / nearby / same city / etc.)
 *   - freshness label
 */
var geocodingService_1 = require("../geocodingService");
// ── Haversine (internal only) ─────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var dLat = ((lat2 - lat1) * Math.PI) / 180;
    var dLng = ((lng2 - lng1) * Math.PI) / 180;
    var a = Math.pow(Math.sin(dLat / 2), 2) +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.pow(Math.sin(dLng / 2), 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toBucket(km) {
    if (km < 0.1)
        return "same_venue";
    if (km < 0.5)
        return "same_neighborhood";
    if (km < 2)
        return "nearby";
    if (km < 50)
        return "within_x_km";
    return "distant";
}
function toProximityLabel(bucket, km) {
    switch (bucket) {
        case "same_venue": return "Same venue";
        case "same_neighborhood": return "Same neighborhood";
        case "nearby": return "Nearby";
        case "same_city": return "In this city";
        case "within_x_km": return km != null ? "~".concat(Math.round(km), " km away") : "In the area";
        case "distant": return "Far away";
        default: return "In the area";
    }
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Build a public-safe context from a user's exact coords + optional viewer coords.
 * Viewer coords are used only to compute an approximate distance bucket — they
 * are never included in the returned object.
 */
function buildPublicContext(opts) {
    return __awaiter(this, void 0, void 0, function () {
        var place, _a, distanceKm, bucket, freshness;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    if (!((_b = opts.cachedPlace) !== null && _b !== void 0)) return [3 /*break*/, 1];
                    _a = _b;
                    return [3 /*break*/, 3];
                case 1: return [4 /*yield*/, (0, geocodingService_1.reverseGeocode)(opts.userLat, opts.userLng)];
                case 2:
                    _a = _d.sent();
                    _d.label = 3;
                case 3:
                    place = _a;
                    distanceKm = null;
                    bucket = "unknown";
                    if (opts.viewerLat != null && opts.viewerLng != null) {
                        distanceKm = Math.round(haversineKm(opts.viewerLat, opts.viewerLng, opts.userLat, opts.userLng) * 10) / 10;
                        bucket = toBucket(distanceKm);
                    }
                    freshness = computeFreshness((_c = opts.lastUpdatedAt) !== null && _c !== void 0 ? _c : null);
                    return [2 /*return*/, {
                            city: place.city,
                            district: place.district,
                            country: place.country,
                            countryCode: place.countryCode,
                            distanceBucket: bucket,
                            distanceKm: distanceKm,
                            proximityLabel: toProximityLabel(bucket, distanceKm),
                            freshness: freshness,
                        }];
            }
        });
    });
}
/** City-level context only (no coords needed). */
function buildCityContext(place, lastUpdatedAt) {
    return {
        city: place.city,
        district: place.district,
        country: place.country,
        countryCode: place.countryCode,
        distanceBucket: "unknown",
        distanceKm: null,
        proximityLabel: place.city ? "In ".concat(place.city) : "In this city",
        freshness: computeFreshness(lastUpdatedAt !== null && lastUpdatedAt !== void 0 ? lastUpdatedAt : null),
    };
}
function computeFreshness(lastUpdatedAt) {
    if (!lastUpdatedAt)
        return "unavailable";
    var age = Date.now() - new Date(lastUpdatedAt).getTime();
    var RECENT = 15 * 60 * 1000;
    var STALE = 60 * 60 * 1000;
    if (age < RECENT)
        return "live";
    if (age < STALE)
        return "recent";
    return "stale";
}
