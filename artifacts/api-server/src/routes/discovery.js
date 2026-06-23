"use strict";
/**
 * GET /api/discovery
 *
 * Destination-scoped place discovery backed by Nominatim + Overpass (OSM).
 * No auth required — returns only public place data.
 *
 * Query params:
 *   destination  string  (required) city / area name e.g. "Paris"
 *   category     string  for_you | places | food | nightlife | activities |
 *                        events | beaches | transport   (default: for_you)
 *   radiusKm     number  search radius 1–100 km  (default: 10)
 *   page         number  1-based page (default: 1); PAGE_SIZE=20
 *
 * Response: { places: DiscoveryPlace[], destination: string, total: number }
 *
 * Caches results per (destination, category, radiusKm) for 2 hours.
 * Graceful degradation: any network/parse error returns an empty list.
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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var supabase_1 = require("../lib/supabase");
var http_1 = require("../lib/http");
var DiscoveryLocationContext_1 = require("../services/location/DiscoveryLocationContext");
var LocationPermissionService_1 = require("../services/location/LocationPermissionService");
var router = (0, express_1.Router)();
var NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
var OVERPASS_URL = "https://overpass-api.de/api/interpreter";
var FETCH_TIMEOUT_MS = 9000;
var CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
var MAX_FETCH = 60;
var PAGE_SIZE = 20;
function toPublic(p) {
    var _lat = p.lat, _lng = p.lng, pub = __rest(p, ["lat", "lng"]);
    return pub;
}
// ── In-memory cache ───────────────────────────────────────────────────────────
var cache = new Map();
function cacheKey(dest, cat, radius) {
    return "".concat(dest.toLowerCase().trim(), ":").concat(cat, ":").concat(radius);
}
function isFresh(e) {
    return Date.now() - e.cachedAt < CACHE_TTL_MS;
}
// ── Fetch helpers ─────────────────────────────────────────────────────────────
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
                            headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
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
                    return [2 /*return*/, { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display: r.display_name }];
            }
        });
    });
}
// ── Category → Overpass filter ────────────────────────────────────────────────
function overpassFilter(cat, radius, lat, lng) {
    var r = radius;
    var c = "".concat(lat, ",").concat(lng);
    switch (cat) {
        case "places":
            return "(\n  node[\"tourism\"~\"^(attraction|museum|viewpoint|gallery|castle|ruins|artwork|monument|historic)$\"](around:".concat(r, ",").concat(c, ");\n  way[\"tourism\"~\"^(attraction|museum|viewpoint|gallery|castle|ruins|artwork|monument|historic)$\"](around:").concat(r, ",").concat(c, ");\n  node[\"historic\"~\"^(castle|monument|memorial|ruins|building|church|fort|palace)$\"](around:").concat(r, ",").concat(c, ");\n  way[\"historic\"~\"^(castle|monument|memorial|ruins|building|church|fort|palace)$\"](around:").concat(r, ",").concat(c, ");\n);");
        case "food":
            return "(\n  node[\"amenity\"~\"^(restaurant|cafe|fast_food|bistro|food_court|bakery|ice_cream)$\"](around:".concat(r, ",").concat(c, ");\n  way[\"amenity\"~\"^(restaurant|cafe|fast_food|bistro|food_court|bakery|ice_cream)$\"](around:").concat(r, ",").concat(c, ");\n);");
        case "nightlife":
            return "(\n  node[\"amenity\"~\"^(bar|pub|nightclub|casino|biergarten|cocktail_bar)$\"](around:".concat(r, ",").concat(c, ");\n  way[\"amenity\"~\"^(bar|pub|nightclub|casino|biergarten|cocktail_bar)$\"](around:").concat(r, ",").concat(c, ");\n);");
        case "activities":
            return "(\n  node[\"leisure\"~\"^(park|sports_centre|fitness_centre|swimming_pool|golf_course|marina|water_park|miniature_golf|bowling_alley|stadium)$\"](around:".concat(r, ",").concat(c, ");\n  way[\"leisure\"~\"^(park|sports_centre|fitness_centre|swimming_pool|golf_course|marina|water_park|miniature_golf|bowling_alley|stadium)$\"](around:").concat(r, ",").concat(c, ");\n  node[\"tourism\"~\"^(theme_park|zoo|aquarium)$\"](around:").concat(r, ",").concat(c, ");\n  way[\"tourism\"~\"^(theme_park|zoo|aquarium)$\"](around:").concat(r, ",").concat(c, ");\n);");
        case "events":
            return "(\n  node[\"amenity\"~\"^(marketplace|community_centre|events_venue|theatre|cinema|arts_centre)$\"](around:".concat(r, ",").concat(c, ");\n  way[\"amenity\"~\"^(marketplace|community_centre|events_venue|theatre|cinema|arts_centre)$\"](around:").concat(r, ",").concat(c, ");\n  node[\"tourism\"=\"gallery\"](around:").concat(r, ",").concat(c, ");\n  way[\"tourism\"=\"gallery\"](around:").concat(r, ",").concat(c, ");\n);");
        case "beaches":
            return "(\n  node[\"natural\"=\"beach\"](around:".concat(r, ",").concat(c, ");\n  way[\"natural\"=\"beach\"](around:").concat(r, ",").concat(c, ");\n  relation[\"natural\"=\"beach\"](around:").concat(r, ",").concat(c, ");\n  node[\"leisure\"=\"beach_resort\"](around:").concat(r, ",").concat(c, ");\n  way[\"leisure\"=\"beach_resort\"](around:").concat(r, ",").concat(c, ");\n);");
        case "transport":
            return "(\n  node[\"amenity\"~\"^(bus_station|ferry_terminal|taxi|car_rental|bicycle_rental)$\"](around:".concat(r, ",").concat(c, ");\n  node[\"railway\"~\"^(station|halt|tram_stop|subway_entrance)$\"](around:").concat(r, ",").concat(c, ");\n  node[\"aeroway\"~\"^(aerodrome|terminal)$\"](around:").concat(r, ",").concat(c, ");\n  way[\"aeroway\"~\"^(aerodrome|terminal)$\"](around:").concat(r, ",").concat(c, ");\n);");
        case "for_you":
        default:
            return "(\n  node[\"tourism\"~\"^(attraction|museum|viewpoint|gallery)$\"](around:".concat(r, ",").concat(c, ");\n  way[\"tourism\"~\"^(attraction|museum|viewpoint|gallery)$\"](around:").concat(r, ",").concat(c, ");\n  node[\"amenity\"~\"^(restaurant|cafe)$\"](around:").concat(r, ",").concat(c, ");\n  node[\"natural\"=\"beach\"](around:").concat(r, ",").concat(c, ");\n  way[\"natural\"=\"beach\"](around:").concat(r, ",").concat(c, ");\n  node[\"leisure\"~\"^(park|sports_centre)$\"](around:").concat(r, ",").concat(c, ");\n  way[\"leisure\"~\"^(park|sports_centre)$\"](around:").concat(r, ",").concat(c, ");\n);");
    }
}
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
// ── Tag extraction ────────────────────────────────────────────────────────────
function friendlyType(tags) {
    if (tags.tourism)
        return tags.tourism.replace(/_/g, " ");
    if (tags.amenity)
        return tags.amenity.replace(/_/g, " ");
    if (tags.leisure)
        return tags.leisure.replace(/_/g, " ");
    if (tags.natural)
        return tags.natural.replace(/_/g, " ");
    if (tags.historic)
        return tags.historic.replace(/_/g, " ");
    if (tags.railway)
        return "rail station";
    if (tags.aeroway)
        return "airport";
    return null;
}
function extractTags(tags) {
    var out = [];
    if (tags.cuisine)
        out.push(tags.cuisine.split(/[;,]/)[0].trim().replace(/_/g, " "));
    if (tags.tourism)
        out.push(tags.tourism.replace(/_/g, " "));
    if (tags.amenity)
        out.push(tags.amenity.replace(/_/g, " "));
    if (tags.leisure)
        out.push(tags.leisure.replace(/_/g, " "));
    if (tags.natural)
        out.push(tags.natural);
    if (tags.historic)
        out.push(tags.historic.replace(/_/g, " "));
    if (tags.sport)
        out.push(tags.sport.split(";")[0].trim());
    return __spreadArray([], new Set(out), true).filter(Boolean).slice(0, 3);
}
function parseRating(tags) {
    var _a, _b;
    var raw = (_b = (_a = tags["stars"]) !== null && _a !== void 0 ? _a : tags["rating"]) !== null && _b !== void 0 ? _b : null;
    if (!raw)
        return null;
    var n = parseFloat(raw);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}
/** Best-effort open-now check from an OSM opening_hours string. */
function determineOpenNow(hours) {
    if (!hours)
        return null;
    var now = new Date();
    var dayAbbr = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][now.getDay()];
    if (dayAbbr && !hours.includes(dayAbbr))
        return false;
    var match = hours.match(/(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
    if (!match)
        return null; // present but unparseable — unknown
    var hh = now.getHours() * 100 + now.getMinutes();
    var open = parseInt(match[1]) * 100 + parseInt(match[2]);
    var close = parseInt(match[3]) * 100 + parseInt(match[4]);
    return hh >= open && hh <= close;
}
function buildAddress(tags) {
    var parts = [];
    if (tags["addr:housenumber"] && tags["addr:street"]) {
        parts.push("".concat(tags["addr:housenumber"], " ").concat(tags["addr:street"]));
    }
    else if (tags["addr:street"]) {
        parts.push(tags["addr:street"]);
    }
    if (tags["addr:city"])
        parts.push(tags["addr:city"]);
    return parts.length ? parts.join(", ") : null;
}
function queryOverpass(lat, lng, radiusM, category) {
    return __awaiter(this, void 0, void 0, function () {
        var filter, query, url, res, data;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    filter = overpassFilter(category, radiusM, lat, lng);
                    query = "[out:json][timeout:8];\n".concat(filter, "\nout body center qt ").concat(MAX_FETCH, ";");
                    url = "".concat(OVERPASS_URL, "?data=").concat(encodeURIComponent(query));
                    return [4 /*yield*/, fetchWithTimeout(url, {
                            headers: { "User-Agent": "TravelBuddy/1.0 (travel-buddy-app; discovery)" },
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
                    return [2 /*return*/, data.elements
                            .filter(function (el) { var _a; return ((_a = el.tags) === null || _a === void 0 ? void 0 : _a.name) && el.tags.name.trim(); })
                            .map(function (el) {
                            var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
                            var elLat = (_c = (_a = el.lat) !== null && _a !== void 0 ? _a : (_b = el.center) === null || _b === void 0 ? void 0 : _b.lat) !== null && _c !== void 0 ? _c : null;
                            var elLng = (_f = (_d = el.lon) !== null && _d !== void 0 ? _d : (_e = el.center) === null || _e === void 0 ? void 0 : _e.lon) !== null && _f !== void 0 ? _f : null;
                            var tags = (_g = el.tags) !== null && _g !== void 0 ? _g : {};
                            return {
                                id: "".concat(el.type, "/").concat(el.id),
                                name: tags.name,
                                category: category,
                                type: friendlyType(tags),
                                description: (_j = (_h = tags.description) !== null && _h !== void 0 ? _h : tags["note"]) !== null && _j !== void 0 ? _j : null,
                                distanceKm: elLat != null && elLng != null
                                    ? Math.round(haversineKm(lat, lng, elLat, elLng) * 10) / 10
                                    : null,
                                lat: elLat,
                                lng: elLng,
                                tags: extractTags(tags),
                                address: buildAddress(tags),
                                website: (_l = (_k = tags.website) !== null && _k !== void 0 ? _k : tags.url) !== null && _l !== void 0 ? _l : null,
                                phone: (_o = (_m = tags.phone) !== null && _m !== void 0 ? _m : tags["contact:phone"]) !== null && _o !== void 0 ? _o : null,
                                openingHours: (_p = tags.opening_hours) !== null && _p !== void 0 ? _p : null,
                                rating: parseRating(tags),
                                isOpenNow: determineOpenNow((_q = tags.opening_hours) !== null && _q !== void 0 ? _q : null),
                            };
                        })
                            .sort(function (a, b) { var _a, _b; return ((_a = a.distanceKm) !== null && _a !== void 0 ? _a : 999) - ((_b = b.distanceKm) !== null && _b !== void 0 ? _b : 999); })
                            .slice(0, MAX_FETCH)];
            }
        });
    });
}
// ── Composite ranking ─────────────────────────────────────────────────────────
//
// When a DiscoveryContext is present (authenticated caller), re-sort places
// using a weighted composite score so that:
//   - Verified/trusted places (from GeoZoneService) are boosted
//   - Distance weight is dialled per mode (near_me → high, in_city → low)
//   - Trip/vibe context elevates relevant categories
//   - Safety-score weight lifts well-tagged places for safe_nearby mode
//
// PRIVACY: no exact coords are used in scoring. Distance is expressed in km
// from the OSM element centre (already computed by queryOverpass).
var MAX_DISTANCE_KM = 20; // distance normalisation ceiling
function scoreWithContext(places, ctx) {
    var w = ctx.weights;
    var verifiedSet = new Set(ctx.verifiedPlaceIds);
    function score(p) {
        var s = 0;
        // Distance factor (inverted — closer = higher score)
        if (w.distance > 0 && p.distanceKm != null) {
            var distFactor = Math.max(0, 1 - p.distanceKm / MAX_DISTANCE_KM);
            s += w.distance * distFactor;
        }
        // Verified places boost — from GeoZoneService (curated, trust-reviewed)
        if (w.verifiedPlaces > 0 && verifiedSet.has(p.id)) {
            s += w.verifiedPlaces;
        }
        // Rating signal — boosts well-reviewed places slightly (consistent across modes)
        if (p.rating != null && p.rating > 0) {
            s += 0.15 * (p.rating / 5);
        }
        // City match — all results are already in the city, constant contribution
        s += w.cityMatch * 0.4;
        // Trip match boost — adds lift when going_soon context is active
        if (w.tripMatch > 0) {
            s += w.tripMatch * 0.3;
        }
        // Safety signal — prefer places with structured opening hours (proxy for legitimacy)
        if (w.safetyScore > 0 && p.openingHours) {
            s += w.safetyScore * 0.2;
        }
        // Vibe match — currently a constant lift per mode (trip / vibe data not local)
        if (w.vibeMatch > 0) {
            s += w.vibeMatch * 0.2;
        }
        return s;
    }
    return __spreadArray([], places, true).sort(function (a, b) { return score(b) - score(a); });
}
// ── Route ─────────────────────────────────────────────────────────────────────
var VALID_CATEGORIES = ["for_you", "places", "food", "nightlife", "activities", "events", "beaches", "transport"];
var VALID_CONTEXT_MODES = ["near_me", "in_city", "going_soon", "around_crew", "safe_nearby"];
/**
 * Context mode labels returned to the client. Never includes exact coords.
 */
function contextModeLabel(mode, city) {
    switch (mode) {
        case "near_me": return "Near me";
        case "in_city": return city ? "In ".concat(city) : "In this city";
        case "going_soon": return city ? "Going to ".concat(city) : "Going soon";
        case "around_crew": return "Around my crew";
        case "safe_nearby": return "Safe nearby";
        default: return city ? "In ".concat(city) : "Discovery";
    }
}
router.get("/discovery", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    /** Apply openNow / minRating filters to a set of places */
    function applyFilters(raw) {
        var list = raw;
        if (openNow) {
            list = list.filter(function (p) {
                if (p.isOpenNow === null)
                    return true; // no data → optimistic include
                return p.isOpenNow === true;
            });
        }
        if (minRating !== null && Number.isFinite(minRating)) {
            list = list.filter(function (p) {
                if (p.rating === null)
                    return true; // no rating data → include
                return p.rating >= minRating;
            });
        }
        return list;
    }
    var destinationParam, discoveryCtx, authHeader, token, sc, authData, rawMode, mode, _a, prefs, locState, currentCity, currentCountry, _b, destination, contextMode, defaultRadius, category, radiusKm, page, radiusM, openNow, minRating, key, cached, cityLabel, ctxLabel, filtered, slice, coords, places, ranked, filtered, slice, err_1;
    var _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    return __generator(this, function (_p) {
        switch (_p.label) {
            case 0:
                destinationParam = ((_c = req.query.destination) === null || _c === void 0 ? void 0 : _c.trim()) || undefined;
                discoveryCtx = null;
                authHeader = req.headers.authorization;
                if (!((authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer ")) && supabase_1.isServiceClientReady)) return [3 /*break*/, 7];
                _p.label = 1;
            case 1:
                _p.trys.push([1, 6, , 7]);
                token = authHeader.slice(7).trim();
                sc = (0, supabase_1.getServiceClient)();
                return [4 /*yield*/, sc.auth.getUser(token)];
            case 2:
                authData = (_p.sent()).data;
                if (!(authData === null || authData === void 0 ? void 0 : authData.user)) return [3 /*break*/, 5];
                rawMode = (_d = req.query.context) !== null && _d !== void 0 ? _d : "";
                mode = VALID_CONTEXT_MODES.includes(rawMode)
                    ? rawMode
                    : "in_city";
                return [4 /*yield*/, Promise.all([
                        (0, LocationPermissionService_1.loadPreferences)(sc, authData.user.id),
                        sc.from("user_location_state")
                            .select("city, country, lat, lng")
                            .eq("user_id", authData.user.id)
                            .maybeSingle(),
                    ])];
            case 3:
                _a = _p.sent(), prefs = _a[0], locState = _a[1];
                currentCity = (_f = (_e = locState.data) === null || _e === void 0 ? void 0 : _e.city) !== null && _f !== void 0 ? _f : null;
                currentCountry = (_h = (_g = locState.data) === null || _g === void 0 ? void 0 : _g.country) !== null && _h !== void 0 ? _h : null;
                return [4 /*yield*/, (0, DiscoveryLocationContext_1.buildDiscoveryContext)({
                        db: sc, userId: authData.user.id,
                        prefs: prefs,
                        mode: mode,
                        currentCity: currentCity,
                        currentCountry: currentCountry,
                    })];
            case 4:
                discoveryCtx = _p.sent();
                _p.label = 5;
            case 5: return [3 /*break*/, 7];
            case 6:
                _b = _p.sent();
                return [3 /*break*/, 7];
            case 7:
                destination = (_j = destinationParam !== null && destinationParam !== void 0 ? destinationParam : discoveryCtx === null || discoveryCtx === void 0 ? void 0 : discoveryCtx.targetCity) !== null && _j !== void 0 ? _j : undefined;
                if (!destination) {
                    res.status(400).json({ error: "invalid_payload", message: "destination is required" });
                    return [2 /*return*/];
                }
                contextMode = VALID_CONTEXT_MODES.includes(req.query.context)
                    ? req.query.context
                    : null;
                defaultRadius = (_k = discoveryCtx === null || discoveryCtx === void 0 ? void 0 : discoveryCtx.radiusKm) !== null && _k !== void 0 ? _k : (contextMode === "near_me" ? 5
                    : contextMode === "safe_nearby" ? 3
                        : contextMode === "going_soon" ? 15
                            : 10);
                category = VALID_CATEGORIES.includes(req.query.category)
                    ? req.query.category
                    : "for_you";
                radiusKm = Math.max(1, Math.min(100, parseFloat(req.query.radiusKm) || defaultRadius));
                page = Math.max(1, parseInt(req.query.page) || 1);
                radiusM = Math.round(radiusKm * 1000);
                openNow = req.query.openNow === "1";
                minRating = req.query.minRating ? parseFloat(req.query.minRating) : null;
                key = cacheKey(destination, category, radiusKm);
                cached = cache.get(key);
                cityLabel = (_m = (_l = destination.split(",")[0]) === null || _l === void 0 ? void 0 : _l.trim()) !== null && _m !== void 0 ? _m : null;
                ctxLabel = (_o = discoveryCtx === null || discoveryCtx === void 0 ? void 0 : discoveryCtx.label) !== null && _o !== void 0 ? _o : (contextMode ? contextModeLabel(contextMode, cityLabel) : null);
                if (cached && isFresh(cached)) {
                    filtered = applyFilters(cached.places);
                    slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
                    res.json({ places: slice, total: filtered.length, destination: destination, context: ctxLabel, cached: true });
                    return [2 /*return*/];
                }
                _p.label = 8;
            case 8:
                _p.trys.push([8, 11, , 12]);
                return [4 /*yield*/, geocode(destination)];
            case 9:
                coords = _p.sent();
                if (!coords) {
                    res.json({ places: [], total: 0, destination: destination, context: ctxLabel, cached: false });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, queryOverpass(coords.lat, coords.lng, radiusM, category)];
            case 10:
                places = _p.sent();
                // Only cache when we have results — avoids locking out a destination for
                // 2 hours if Overpass timed out or returned nothing transiently.
                if (places.length > 0) {
                    cache.set(key, { places: places, cachedAt: Date.now() });
                }
                ranked = discoveryCtx ? scoreWithContext(places, discoveryCtx) : places;
                filtered = applyFilters(ranked);
                slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(toPublic);
                res.json({ places: slice, total: filtered.length, destination: destination, context: ctxLabel, cached: false });
                return [3 /*break*/, 12];
            case 11:
                err_1 = _p.sent();
                req.log.error({ err: err_1 }, "discovery route failed");
                res.json({ places: [], total: 0, destination: destination, context: ctxLabel !== null && ctxLabel !== void 0 ? ctxLabel : null, cached: false });
                return [3 /*break*/, 12];
            case 12: return [2 /*return*/];
        }
    });
}); });
var VALID_PLACE_TYPES = new Set(["hidden_gem", "traveler_pick", "all"]);
router.get("/discovery/community", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var city, rawType, typeFilter, limit, sc, query, _a, data, error, items, err_2;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                city = (_b = req.query.city) === null || _b === void 0 ? void 0 : _b.trim();
                if (!city) {
                    (0, http_1.sendError)(res, "invalid_payload", "city is required");
                    return [2 /*return*/];
                }
                if (!supabase_1.isServiceClientReady) {
                    res.json({ items: [], city: city, total: 0 });
                    return [2 /*return*/];
                }
                rawType = req.query.type;
                typeFilter = VALID_PLACE_TYPES.has(rawType !== null && rawType !== void 0 ? rawType : "") ? rawType : "all";
                limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
                _c.label = 1;
            case 1:
                _c.trys.push([1, 3, , 4]);
                sc = (0, supabase_1.getServiceClient)();
                query = sc
                    .from("discovery_places")
                    .select("\n        id,\n        city,\n        name,\n        place_type,\n        category,\n        neighborhood,\n        blurb,\n        image_url,\n        submitted_by,\n        saved_count,\n        tag,\n        note,\n        rating,\n        source,\n        status,\n        verified,\n        created_at,\n        profiles:submitted_by ( id, display_name, name, avatar_url )\n      ")
                    .ilike("city", city.trim())
                    .order("created_at", { ascending: false })
                    .limit(limit);
                if (typeFilter !== "all") {
                    query = query.eq("place_type", typeFilter);
                }
                return [4 /*yield*/, query];
            case 2:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "discovery/community query failed");
                    res.json({ items: [], city: city, total: 0 });
                    return [2 /*return*/];
                }
                items = (data !== null && data !== void 0 ? data : []).map(function (row) {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
                    var profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
                    return {
                        id: row.id,
                        city: row.city,
                        name: row.name,
                        placeType: ((_a = row.place_type) !== null && _a !== void 0 ? _a : "hidden_gem"),
                        category: (_b = row.category) !== null && _b !== void 0 ? _b : "hidden_gem",
                        neighborhood: (_c = row.neighborhood) !== null && _c !== void 0 ? _c : null,
                        blurb: (_d = row.blurb) !== null && _d !== void 0 ? _d : null,
                        imageUrl: (_e = row.image_url) !== null && _e !== void 0 ? _e : null,
                        submittedBy: profile
                            ? {
                                id: profile.id,
                                name: ((_g = (_f = profile.display_name) !== null && _f !== void 0 ? _f : profile.name) !== null && _g !== void 0 ? _g : "Traveler"),
                                avatarUrl: ((_h = profile.avatar_url) !== null && _h !== void 0 ? _h : null),
                            }
                            : null,
                        savedCount: (_j = row.saved_count) !== null && _j !== void 0 ? _j : 0,
                        tag: (_k = row.tag) !== null && _k !== void 0 ? _k : null,
                        note: (_l = row.note) !== null && _l !== void 0 ? _l : null,
                        rating: row.rating != null ? parseFloat(row.rating) : null,
                        source: (_m = row.source) !== null && _m !== void 0 ? _m : "traveler",
                        status: (_o = row.status) !== null && _o !== void 0 ? _o : "provisional",
                        verified: Boolean(row.verified),
                        createdAt: row.created_at,
                    };
                });
                res.json({ items: items, city: city, total: items.length });
                return [3 /*break*/, 4];
            case 3:
                err_2 = _c.sent();
                req.log.error({ err: err_2 }, "discovery/community route failed");
                res.json({ items: [], city: city, total: 0 });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
