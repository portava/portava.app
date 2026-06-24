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
exports.findZonesAt = findZonesAt;
exports.findZonesByCity = findZonesByCity;
exports.getVerifiedPlaces = getVerifiedPlaces;
exports.isNearPrivateStay = isNearPrivateStay;
// ── Haversine ─────────────────────────────────────────────────────────────────
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
// ── Public API ────────────────────────────────────────────────────────────────
/** Find neighborhood zones containing a given coordinate. */
function findZonesAt(db_1, lat_1, lng_1) {
    return __awaiter(this, arguments, void 0, function (db, lat, lng, maxResults) {
        var _a, data, error, _b;
        if (maxResults === void 0) { maxResults = 5; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("geo_zones")
                            .select("id, zone_type, name, city, country_code, center_lat, center_lng, radius_meters, safety_rating, featured")
                            .in("zone_type", ["neighborhood", "district"])
                            .limit(100)];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    // Client-side radius check — no PostGIS required
                    return [2 /*return*/, data
                            .filter(function (z) {
                            if (!z.center_lat || !z.center_lng || !z.radius_meters)
                                return false;
                            var km = haversineKm(lat, lng, z.center_lat, z.center_lng);
                            return km * 1000 <= z.radius_meters;
                        })
                            .slice(0, maxResults)
                            .map(mapZone)];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Find zones by city name. */
function findZonesByCity(db, city) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("geo_zones")
                            .select("id, zone_type, name, city, country_code, center_lat, center_lng, radius_meters, safety_rating, featured")
                            .ilike("city", city.trim())
                            .order("featured", { ascending: false })];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data.map(mapZone)];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Get verified/featured place profiles for a city. */
function getVerifiedPlaces(db_1, city_1) {
    return __awaiter(this, arguments, void 0, function (db, city, limit) {
        var _a, data, error, _b;
        if (limit === void 0) { limit = 20; }
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("place_profiles")
                            .select("id, osm_id, name, place_type, city, lat, lng, status, safety_note")
                            .ilike("city", city.trim())
                            .in("status", ["verified", "featured"])
                            .limit(limit)];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data.map(mapProfile)];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Is this coordinate within ~200 m of a known private stay? */
function isNearPrivateStay(db, userId, lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("location_sessions")
                            .select("lat, lng")
                            .eq("user_id", userId)
                            .eq("session_type", "private_stay")
                            .is("ended_at", null)
                            .limit(10)];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, false];
                    return [2 /*return*/, data.some(function (row) {
                            if (!row.lat || !row.lng)
                                return false;
                            return haversineKm(lat, lng, row.lat, row.lng) * 1000 < 200;
                        })];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
// ── Mappers ───────────────────────────────────────────────────────────────────
function mapZone(r) {
    var _a, _b, _c;
    return {
        id: r.id,
        zoneType: r.zone_type,
        name: r.name,
        city: (_a = r.city) !== null && _a !== void 0 ? _a : null,
        countryCode: (_b = r.country_code) !== null && _b !== void 0 ? _b : null,
        centerLat: r.center_lat != null ? Number(r.center_lat) : null,
        centerLng: r.center_lng != null ? Number(r.center_lng) : null,
        radiusMeters: r.radius_meters != null ? Number(r.radius_meters) : null,
        safetyRating: (_c = r.safety_rating) !== null && _c !== void 0 ? _c : null,
        featured: Boolean(r.featured),
    };
}
function mapProfile(r) {
    var _a, _b, _c, _d, _e;
    return {
        id: r.id,
        osmId: (_a = r.osm_id) !== null && _a !== void 0 ? _a : null,
        name: r.name,
        placeType: (_b = r.place_type) !== null && _b !== void 0 ? _b : "other",
        city: (_c = r.city) !== null && _c !== void 0 ? _c : null,
        lat: r.lat != null ? Number(r.lat) : null,
        lng: r.lng != null ? Number(r.lng) : null,
        status: (_d = r.status) !== null && _d !== void 0 ? _d : "none",
        safetyNote: (_e = r.safety_note) !== null && _e !== void 0 ? _e : null,
    };
}
