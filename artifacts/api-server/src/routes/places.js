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
/**
 * /api/places — place search, reverse geocode, and recent places.
 *
 * GET  /api/places/search?q=&type=&countryCode=&lat=&lng=
 * GET  /api/places/reverse?lat=&lng=
 * GET  /api/me/recent-places          (auth required)
 * POST /api/me/recent-places          (auth required)
 */
var express_1 = require("express");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var geocodingService_1 = require("../services/geocodingService");
var logger_1 = require("../lib/logger");
var router = (0, express_1.Router)();
var logger = logger_1.logger.child({ route: "places" });
/** In-process rate limiter for Nominatim (1 req/sec per TOS) */
var nominatimLastCall = 0;
function nominatimRateLimit() {
    return __awaiter(this, void 0, void 0, function () {
        var now, wait;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    now = Date.now();
                    wait = 1100 - (now - nominatimLastCall);
                    if (!(wait > 0)) return [3 /*break*/, 2];
                    return [4 /*yield*/, new Promise(function (r) { return setTimeout(r, wait); })];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2:
                    nominatimLastCall = Date.now();
                    return [2 /*return*/];
            }
        });
    });
}
function searchNominatim(q, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var params, res;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, nominatimRateLimit()];
                case 1:
                    _b.sent();
                    params = new URLSearchParams({
                        q: q,
                        format: "json",
                        addressdetails: "1",
                        namedetails: "1",
                        limit: String((_a = opts.limit) !== null && _a !== void 0 ? _a : 8),
                        dedupe: "1",
                    });
                    if (opts.countryCode)
                        params.set("countrycodes", opts.countryCode.toLowerCase());
                    return [4 /*yield*/, fetch("https://nominatim.openstreetmap.org/search?".concat(params), {
                            headers: {
                                "User-Agent": "TravelBuddyApp/1.0",
                                "Accept-Language": "en",
                            },
                            signal: AbortSignal.timeout(5000),
                        })];
                case 2:
                    res = _b.sent();
                    if (!res.ok)
                        throw new Error("Nominatim ".concat(res.status));
                    return [2 /*return*/, res.json()];
            }
        });
    });
}
function normalizeNominatim(raw) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
    var addr = (_a = raw.address) !== null && _a !== void 0 ? _a : {};
    var city = (_f = (_e = (_d = (_c = (_b = addr.city) !== null && _b !== void 0 ? _b : addr.town) !== null && _c !== void 0 ? _c : addr.village) !== null && _d !== void 0 ? _d : addr.municipality) !== null && _e !== void 0 ? _e : addr.county) !== null && _f !== void 0 ? _f : null;
    var district = (_j = (_h = (_g = addr.suburb) !== null && _g !== void 0 ? _g : addr.neighbourhood) !== null && _h !== void 0 ? _h : addr.quarter) !== null && _j !== void 0 ? _j : null;
    var country = (_k = addr.country) !== null && _k !== void 0 ? _k : null;
    var countryCode = (_m = (_l = addr.country_code) === null || _l === void 0 ? void 0 : _l.toUpperCase()) !== null && _m !== void 0 ? _m : null;
    var region = (_p = (_o = addr.state) !== null && _o !== void 0 ? _o : addr.province) !== null && _p !== void 0 ? _p : null;
    var name = (_x = (_v = (_u = (_t = (_s = (_r = (_q = raw.namedetails) === null || _q === void 0 ? void 0 : _q.name) !== null && _r !== void 0 ? _r : addr.city) !== null && _s !== void 0 ? _s : addr.town) !== null && _t !== void 0 ? _t : addr.village) !== null && _u !== void 0 ? _u : addr.municipality) !== null && _v !== void 0 ? _v : (_w = raw.display_name) === null || _w === void 0 ? void 0 : _w.split(",")[0]) !== null && _x !== void 0 ? _x : "Unknown";
    var displayParts = [name];
    if (district && district !== name)
        displayParts.push(district);
    if (city && city !== name)
        displayParts.push(city);
    if (country)
        displayParts.push(country);
    return {
        id: "nominatim-".concat(raw.place_id),
        type: "city",
        name: name,
        displayName: displayParts.join(", "),
        country: country,
        countryCode: countryCode,
        region: region,
        city: city,
        district: district,
        lat: raw.lat != null ? parseFloat(raw.lat) : null,
        lng: raw.lon != null ? parseFloat(raw.lon) : null,
        timezone: null,
        source: "nominatim",
    };
}
// ── GET /api/places/search ────────────────────────────────────────────────────
router.get("/places/search", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var q, countryCode, latStr, lngStr, lat, lng, raw, places, err_1;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                q = String((_a = req.query.q) !== null && _a !== void 0 ? _a : "").trim();
                if (!q || q.length > 200) {
                    res.status(400).json({ error: "invalid_payload", message: "q is required (max 200 chars)" });
                    return [2 /*return*/];
                }
                countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode : undefined;
                latStr = typeof req.query.lat === "string" ? req.query.lat : undefined;
                lngStr = typeof req.query.lng === "string" ? req.query.lng : undefined;
                lat = latStr != null ? parseFloat(latStr) : undefined;
                lng = lngStr != null ? parseFloat(lngStr) : undefined;
                if (lat != null && (isNaN(lat) || lat < -90 || lat > 90)) {
                    res.status(400).json({ error: "invalid_payload", message: "Invalid lat" });
                    return [2 /*return*/];
                }
                if (lng != null && (isNaN(lng) || lng < -180 || lng > 180)) {
                    res.status(400).json({ error: "invalid_payload", message: "Invalid lng" });
                    return [2 /*return*/];
                }
                _b.label = 1;
            case 1:
                _b.trys.push([1, 3, , 4]);
                return [4 /*yield*/, searchNominatim(q, { countryCode: countryCode, lat: lat, lng: lng })];
            case 2:
                raw = _b.sent();
                places = Array.isArray(raw) ? raw.map(normalizeNominatim) : [];
                res.json({ places: places });
                return [3 /*break*/, 4];
            case 3:
                err_1 = _b.sent();
                logger.warn({ err: err_1, q: q }, "place search failed — returning empty");
                res.json({ places: [] });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// ── GET /api/places/reverse ───────────────────────────────────────────────────
router.get("/places/reverse", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var lat, lng, result, place, err_2;
    var _a, _b, _c, _d, _e, _f, _g, _h;
    return __generator(this, function (_j) {
        switch (_j.label) {
            case 0:
                lat = parseFloat(String((_a = req.query.lat) !== null && _a !== void 0 ? _a : ""));
                lng = parseFloat(String((_b = req.query.lng) !== null && _b !== void 0 ? _b : ""));
                if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
                    res.status(400).json({ error: "invalid_payload", message: "Valid lat and lng are required" });
                    return [2 /*return*/];
                }
                _j.label = 1;
            case 1:
                _j.trys.push([1, 3, , 4]);
                return [4 /*yield*/, (0, geocodingService_1.reverseGeocode)(lat, lng)];
            case 2:
                result = _j.sent();
                if (!result) {
                    res.json({ place: null });
                    return [2 /*return*/];
                }
                place = {
                    id: "reverse-".concat(lat.toFixed(4), "-").concat(lng.toFixed(4)),
                    type: "city",
                    name: (_d = (_c = result.city) !== null && _c !== void 0 ? _c : result.country) !== null && _d !== void 0 ? _d : "Unknown",
                    displayName: [result.city, result.country].filter(Boolean).join(", "),
                    country: (_e = result.country) !== null && _e !== void 0 ? _e : null,
                    countryCode: (_f = result.countryCode) !== null && _f !== void 0 ? _f : null,
                    region: null,
                    city: (_g = result.city) !== null && _g !== void 0 ? _g : null,
                    district: (_h = result.district) !== null && _h !== void 0 ? _h : null,
                    lat: lat,
                    lng: lng,
                    timezone: null,
                    source: "nominatim",
                };
                res.json({ place: place });
                return [3 /*break*/, 4];
            case 3:
                err_2 = _j.sent();
                logger.warn({ err: err_2 }, "reverse geocode failed");
                res.json({ place: null });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/recent-places ─────────────────────────────────────────────────
router.get("/me/recent-places", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, db, _a, data, error, places, err_3;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                db = (0, supabase_1.getServiceClient)();
                if (!db) {
                    res.json({ places: [] });
                    return [2 /*return*/];
                }
                _b.label = 2;
            case 2:
                _b.trys.push([2, 4, , 5]);
                return [4 /*yield*/, db
                        .from("user_recent_places")
                        .select("id, place_snapshot, used_for, used_at")
                        .eq("user_id", user.id)
                        .order("used_at", { ascending: false })
                        .limit(10)];
            case 3:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error)
                    throw error;
                places = (data !== null && data !== void 0 ? data : []).map(function (row) { return row.place_snapshot; });
                res.json({ places: places });
                return [3 /*break*/, 5];
            case 4:
                err_3 = _b.sent();
                logger.warn({ err: err_3 }, "failed to fetch recent places");
                res.json({ places: [] });
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/recent-places ────────────────────────────────────────────────
router.post("/me/recent-places", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, db, _a, place, usedFor, all, toDelete, err_4;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                db = (0, supabase_1.getServiceClient)();
                if (!db) {
                    (0, http_1.sendError)(res, "server_not_configured");
                    return [2 /*return*/];
                }
                _a = ((_b = req.body) !== null && _b !== void 0 ? _b : {}), place = _a.place, usedFor = _a.usedFor;
                if (!place || typeof place !== "object" || !place.id || !place.name) {
                    (0, http_1.sendError)(res, "invalid_payload", "place.id and place.name are required");
                    return [2 /*return*/];
                }
                _c.label = 2;
            case 2:
                _c.trys.push([2, 8, , 9]);
                // Remove existing entry for this place_id, then insert fresh (keeps it sorted)
                return [4 /*yield*/, db
                        .from("user_recent_places")
                        .delete()
                        .eq("user_id", user.id)
                        .eq("place_snapshot->>id", place.id)];
            case 3:
                // Remove existing entry for this place_id, then insert fresh (keeps it sorted)
                _c.sent();
                return [4 /*yield*/, db.from("user_recent_places").insert({
                        user_id: user.id,
                        place_snapshot: place,
                        used_for: usedFor !== null && usedFor !== void 0 ? usedFor : null,
                        used_at: new Date().toISOString(),
                    })];
            case 4:
                _c.sent();
                return [4 /*yield*/, db
                        .from("user_recent_places")
                        .select("id")
                        .eq("user_id", user.id)
                        .order("used_at", { ascending: false })];
            case 5:
                all = (_c.sent()).data;
                if (!(all && all.length > 10)) return [3 /*break*/, 7];
                toDelete = all.slice(10).map(function (r) { return r.id; });
                return [4 /*yield*/, db.from("user_recent_places").delete().in("id", toDelete)];
            case 6:
                _c.sent();
                _c.label = 7;
            case 7:
                res.json({ ok: true });
                return [3 /*break*/, 9];
            case 8:
                err_4 = _c.sent();
                logger.warn({ err: err_4 }, "failed to save recent place");
                (0, http_1.sendError)(res, "db_error", "Failed to save recent place");
                return [3 /*break*/, 9];
            case 9: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
