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
 * Location routes
 *
 * GET  /api/me/location-state              — current saved location state
 * POST /api/me/location-state              — upsert from client GPS or manual city
 * POST /api/location/reverse-geocode       — server-side reverse geocode
 * GET  /api/me/passport-stamps/gps         — GPS-earned stamps list
 * POST /api/me/passport-stamps/gps         — create/upsert GPS stamp
 */
var express_1 = require("express");
var http_1 = require("../lib/http");
var geocodingService_1 = require("../services/geocodingService");
var LocationSafetyService_1 = require("../services/location/LocationSafetyService");
var router = (0, express_1.Router)();
// ── Helpers ──────────────────────────────────────────────────────────────────
function isValidLat(v) {
    return typeof v === "number" && isFinite(v) && v >= -90 && v <= 90;
}
function isValidLng(v) {
    return typeof v === "number" && isFinite(v) && v >= -180 && v <= 180;
}
function sanitizeText(v, maxLen) {
    if (maxLen === void 0) { maxLen = 128; }
    if (typeof v !== "string")
        return null;
    return v.trim().slice(0, maxLen) || null;
}
// ── GET /api/me/location-state ───────────────────────────────────────────────
router.get("/me/location-state", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, _a, data, error;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    return __generator(this, function (_p) {
        switch (_p.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _p.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                return [4 /*yield*/, sc
                        .from("user_location_state")
                        .select("*")
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 2:
                _a = _p.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "location-state: read failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    res.status(200).json({ ok: true, locationState: null });
                    return [2 /*return*/];
                }
                res.status(200).json({
                    ok: true,
                    locationState: {
                        permissionStatus: (_b = data.permission_status) !== null && _b !== void 0 ? _b : null,
                        source: (_c = data.source) !== null && _c !== void 0 ? _c : null,
                        coords: data.lat != null && data.lng != null
                            ? { lat: Number(data.lat), lng: Number(data.lng), accuracyMeters: data.accuracy_meters != null ? Number(data.accuracy_meters) : null }
                            : null,
                        place: {
                            city: (_d = data.city) !== null && _d !== void 0 ? _d : null,
                            district: (_e = data.district) !== null && _e !== void 0 ? _e : null,
                            country: (_f = data.country) !== null && _f !== void 0 ? _f : null,
                            countryCode: (_g = data.country_code) !== null && _g !== void 0 ? _g : null,
                            formatted: (_h = data.formatted_location) !== null && _h !== void 0 ? _h : null,
                        },
                        lastKnownAt: (_j = data.last_known_at) !== null && _j !== void 0 ? _j : null,
                        manualCity: (_k = data.manual_city) !== null && _k !== void 0 ? _k : null,
                        manualCountry: (_l = data.manual_country) !== null && _l !== void 0 ? _l : null,
                        manualSelectedAt: (_m = data.manual_selected_at) !== null && _m !== void 0 ? _m : null,
                        updatedAt: (_o = data.updated_at) !== null && _o !== void 0 ? _o : null,
                    },
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/location-state ──────────────────────────────────────────────
router.post("/me/location-state", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, body, source, permissionStatus, manualCity, manualCountry, lat, lng, accuracyMeters, rawLat, rawLng, rawAcc, place, city, district, country, countryCode, formatted, now, patch, error, requestIp;
    var _a, _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                body = (_a = req.body) !== null && _a !== void 0 ? _a : {};
                source = sanitizeText(body.source, 32);
                permissionStatus = sanitizeText(body.permissionStatus, 32);
                manualCity = sanitizeText(body.manualCity);
                manualCountry = sanitizeText(body.manualCountry);
                lat = null;
                lng = null;
                accuracyMeters = null;
                if (body.coords) {
                    rawLat = Number(body.coords.lat);
                    rawLng = Number(body.coords.lng);
                    if (isValidLat(rawLat) && isValidLng(rawLng)) {
                        lat = rawLat;
                        lng = rawLng;
                        rawAcc = Number(body.coords.accuracyMeters);
                        if (isFinite(rawAcc) && rawAcc >= 0)
                            accuracyMeters = rawAcc;
                    }
                }
                place = (_b = body.place) !== null && _b !== void 0 ? _b : {};
                city = sanitizeText(place.city);
                district = sanitizeText(place.district);
                country = sanitizeText(place.country);
                countryCode = sanitizeText(place.countryCode, 8);
                formatted = sanitizeText(place.formatted, 256);
                now = new Date().toISOString();
                patch = {
                    user_id: user.id,
                    updated_at: now,
                };
                if (permissionStatus)
                    patch.permission_status = permissionStatus;
                if (source)
                    patch.source = source;
                if (lat != null) {
                    patch.lat = lat;
                    patch.lng = lng;
                    patch.accuracy_meters = accuracyMeters;
                    patch.last_known_at = now;
                }
                if (city !== undefined)
                    patch.city = city;
                if (district !== undefined)
                    patch.district = district;
                if (country !== undefined)
                    patch.country = country;
                if (countryCode !== undefined)
                    patch.country_code = countryCode;
                if (formatted !== undefined)
                    patch.formatted_location = formatted;
                if (manualCity !== undefined) {
                    patch.manual_city = manualCity;
                    patch.manual_country = manualCountry !== null && manualCountry !== void 0 ? manualCountry : null;
                    if (manualCity)
                        patch.manual_selected_at = now;
                }
                return [4 /*yield*/, sc
                        .from("user_location_state")
                        .upsert(patch, { onConflict: "user_id" })];
            case 2:
                error = (_f.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "location-state: upsert failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                // Anti-fake GPS: run safety checks asynchronously for GPS fixes — non-blocking
                if (source === "gps" && lat != null && lng != null) {
                    (0, LocationSafetyService_1.checkAndRecordSnapshot)(sc, user.id, lat, lng).catch(function (err) {
                        req.log.warn({ err: err }, "location-state: safety check failed (non-fatal)");
                    });
                }
                // IP–city mismatch: run asynchronously when a city is present — non-blocking
                if (city) {
                    requestIp = (_c = req.ip) !== null && _c !== void 0 ? _c : (_e = (_d = req.headers["x-forwarded-for"]) === null || _d === void 0 ? void 0 : _d.split(",")[0]) === null || _e === void 0 ? void 0 : _e.trim();
                    (0, LocationSafetyService_1.checkIpCityMismatch)(sc, user.id, city, requestIp).catch(function (err) {
                        req.log.warn({ err: err }, "location-state: IP mismatch check failed (non-fatal)");
                    });
                }
                res.status(200).json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/location/reverse-geocode ───────────────────────────────────────
router.post("/location/reverse-geocode", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, body, lat, lng, place, e_1;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                body = (_a = req.body) !== null && _a !== void 0 ? _a : {};
                lat = Number(body.lat);
                lng = Number(body.lng);
                if (!isValidLat(lat) || !isValidLng(lng)) {
                    (0, http_1.sendError)(res, "invalid_payload", "lat must be -90..90 and lng must be -180..180");
                    return [2 /*return*/];
                }
                _b.label = 2;
            case 2:
                _b.trys.push([2, 4, , 5]);
                return [4 /*yield*/, (0, geocodingService_1.reverseGeocode)(lat, lng)];
            case 3:
                place = _b.sent();
                res.status(200).json({ ok: true, place: place });
                return [3 /*break*/, 5];
            case 4:
                e_1 = _b.sent();
                req.log.error({ err: e_1 }, "reverse-geocode: failed");
                res.status(200).json({ ok: true, place: { city: null, district: null, country: null, countryCode: null, formatted: null } });
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/passport-stamps/gps ─────────────────────────────────────────
router.get("/me/passport-stamps/gps", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                return [4 /*yield*/, sc
                        .from("passport_stamps_gps")
                        .select("id, stamp_type, city, district, country, country_code, source, unlocked_at, related_postcard_id, related_trip_id, metadata")
                        .eq("user_id", user.id)
                        .order("unlocked_at", { ascending: false })];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "passport-stamps-gps: read failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, stamps: data !== null && data !== void 0 ? data : [] });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/passport-stamps/gps ────────────────────────────────────────
router.post("/me/passport-stamps/gps", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, body, VALID_TYPES, stampType, city, district, country, countryCode, source, relatedPostcardId, relatedTripId, lat, lng, rLat, rLng, trustLevel, userTrust, stampMetadata, _a, stamp, error;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                body = (_b = req.body) !== null && _b !== void 0 ? _b : {};
                VALID_TYPES = [
                    "city_visit", "postcard_created", "hidden_gem_shared",
                    "food_spot_shared", "trip_checkin", "highlight_shared",
                ];
                stampType = sanitizeText(body.stampType, 64);
                if (!stampType || !VALID_TYPES.includes(stampType)) {
                    (0, http_1.sendError)(res, "invalid_payload", "stampType must be one of: ".concat(VALID_TYPES.join(", ")));
                    return [2 /*return*/];
                }
                city = sanitizeText(body.city);
                district = sanitizeText(body.district);
                country = sanitizeText(body.country);
                countryCode = sanitizeText(body.countryCode, 8);
                source = (_c = sanitizeText(body.source, 32)) !== null && _c !== void 0 ? _c : "gps";
                relatedPostcardId = typeof body.relatedPostcardId === "string" ? body.relatedPostcardId : null;
                relatedTripId = typeof body.relatedTripId === "string" ? body.relatedTripId : null;
                lat = null;
                lng = null;
                if (body.lat != null && body.lng != null) {
                    rLat = Number(body.lat);
                    rLng = Number(body.lng);
                    if (isValidLat(rLat) && isValidLng(rLng)) {
                        lat = rLat;
                        lng = rLng;
                    }
                }
                trustLevel = "manual";
                if (!(source === "gps")) return [3 /*break*/, 3];
                return [4 /*yield*/, (0, LocationSafetyService_1.getUserTrustLevel)(sc, user.id)];
            case 2:
                userTrust = _d.sent();
                trustLevel = userTrust === "trusted" ? "gps_verified" : "pending_review";
                _d.label = 3;
            case 3:
                stampMetadata = __assign(__assign({}, (body.metadata && typeof body.metadata === "object" ? body.metadata : {})), { trust_level: trustLevel, trust_checked_at: new Date().toISOString() });
                return [4 /*yield*/, sc
                        .from("passport_stamps_gps")
                        .upsert({
                        user_id: user.id,
                        stamp_type: stampType,
                        city: city,
                        district: district,
                        country: country,
                        country_code: countryCode,
                        lat: lat,
                        lng: lng,
                        source: source,
                        related_postcard_id: relatedPostcardId,
                        related_trip_id: relatedTripId,
                        metadata: stampMetadata,
                    }, { onConflict: "user_id,stamp_type,country_code,city", ignoreDuplicates: false })
                        .select("id, stamp_type, city, country, country_code, unlocked_at, metadata")
                        .single()];
            case 4:
                _a = _d.sent(), stamp = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "passport-stamps-gps: upsert failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ ok: true, stamp: __assign(__assign({}, stamp), { trustLevel: trustLevel }) });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
