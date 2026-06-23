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
exports.checkAndRecordSnapshot = checkAndRecordSnapshot;
exports.getUserTrustLevel = getUserTrustLevel;
exports.checkIpCityMismatch = checkIpCityMismatch;
exports.purgeExpiredSnapshots = purgeExpiredSnapshots;
var logger_1 = require("../../lib/logger");
var logger = logger_1.logger.child({ service: "LocationSafetyService" });
var MAX_REALISTIC_SPEED_KMH = 900; // approx commercial flight speed
var JUMP_THRESHOLD_KM = 500; // flag if user jumps > 500 km instantly
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
/** Write a trust event (no auto-ban). */
function writeTrustEvent(db, userId, eventType, confidence, details) {
    return __awaiter(this, void 0, void 0, function () {
        var error, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db.from("location_trust_events").insert({
                            user_id: userId,
                            event_type: eventType,
                            confidence: confidence,
                            details: details,
                        })];
                case 1:
                    error = (_a.sent()).error;
                    if (error)
                        logger.warn({ err: error }, "writeTrustEvent DB error");
                    return [3 /*break*/, 3];
                case 2:
                    err_1 = _a.sent();
                    logger.warn({ err: err_1 }, "writeTrustEvent threw");
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * Check a new GPS coordinate against the user's previous snapshot.
 * If suspicious, writes a trust event and returns false.
 * If clean, optionally stores a fresh snapshot and returns true.
 */
function checkAndRecordSnapshot(db, userId, lat, lng) {
    return __awaiter(this, void 0, void 0, function () {
        var prev, km, elapsedMs, elapsedHours, err_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, db
                        .from("location_snapshots")
                        .select("lat, lng, captured_at")
                        .eq("user_id", userId)
                        .gt("expires_at", new Date().toISOString())
                        .order("captured_at", { ascending: false })
                        .limit(1)
                        .maybeSingle()];
                case 1:
                    prev = (_a.sent()).data;
                    if (!(prev && prev.lat != null && prev.lng != null)) return [3 /*break*/, 5];
                    km = haversineKm(prev.lat, prev.lng, lat, lng);
                    elapsedMs = Date.now() - new Date(prev.captured_at).getTime();
                    elapsedHours = elapsedMs / (1000 * 60 * 60);
                    if (!(km > JUMP_THRESHOLD_KM && elapsedHours < 0.5)) return [3 /*break*/, 3];
                    return [4 /*yield*/, writeTrustEvent(db, userId, "coordinate_jump", "medium", {
                            distanceKm: Math.round(km),
                            elapsedMinutes: Math.round(elapsedMs / 60000),
                            prevLat: prev.lat,
                            prevLng: prev.lng,
                        })];
                case 2:
                    _a.sent();
                    return [2 /*return*/, { trusted: false, suspicionReason: "coordinate_jump" }];
                case 3:
                    if (!(elapsedHours > 0 && km / elapsedHours > MAX_REALISTIC_SPEED_KMH)) return [3 /*break*/, 5];
                    return [4 /*yield*/, writeTrustEvent(db, userId, "impossible_speed", "high", {
                            distanceKm: Math.round(km),
                            speedKmh: Math.round(km / elapsedHours),
                            elapsedMinutes: Math.round(elapsedMs / 60000),
                        })];
                case 4:
                    _a.sent();
                    return [2 /*return*/, { trusted: false, suspicionReason: "impossible_speed" }];
                case 5:
                    _a.trys.push([5, 7, , 8]);
                    return [4 /*yield*/, db.from("location_snapshots").insert({
                            user_id: userId,
                            lat: lat,
                            lng: lng,
                            source: "gps",
                            captured_at: new Date().toISOString(),
                        })];
                case 6:
                    _a.sent();
                    return [3 /*break*/, 8];
                case 7:
                    err_2 = _a.sent();
                    logger.warn({ err: err_2 }, "snapshot insert failed — non-fatal");
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/, { trusted: true }];
            }
        });
    });
}
/**
 * Check recent trust events for a user.
 * Returns confidence level to inform stamp eligibility decisions.
 */
function getUserTrustLevel(db, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var since, _a, data, error, highConfidence, mediumConfidence, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                    return [4 /*yield*/, db
                            .from("location_trust_events")
                            .select("event_type, confidence")
                            .eq("user_id", userId)
                            .gt("created_at", since)
                            .is("reviewed_at", null) // only unreviewed events
                            .limit(10)];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, "trusted"];
                    highConfidence = data.filter(function (r) { return r.confidence === "high"; });
                    mediumConfidence = data.filter(function (r) { return r.confidence === "medium"; });
                    if (highConfidence.length >= 1)
                        return [2 /*return*/, "suspicious"];
                    if (mediumConfidence.length >= 2)
                        return [2 /*return*/, "review"];
                    return [2 /*return*/, "trusted"];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, "trusted"];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * IP–city mismatch detection.
 *
 * Queries ip-api.com (free, no auth) to resolve the request IP to a city.
 * If the city doesn't match the user-reported city, writes a medium-confidence
 * ip_city_mismatch trust event. Falls back gracefully on network error or when
 * the IP is private/unresolvable (loopback, RFC 1918, IPv6 localhost).
 *
 * Call fire-and-forget from the location-state write path.
 */
function checkIpCityMismatch(db, userId, reportedCity, requestIp) {
    return __awaiter(this, void 0, void 0, function () {
        var skip, ctrl_1, timeout, ipCity, response, data, normalise, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!requestIp)
                        return [2 /*return*/];
                    skip = ["127.", "10.", "172.16.", "172.17.", "172.18.", "172.19.",
                        "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
                        "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
                        "192.168.", "::1", "localhost"];
                    if (skip.some(function (prefix) { return requestIp.startsWith(prefix); }))
                        return [2 /*return*/];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 9, , 10]);
                    ctrl_1 = new AbortController();
                    timeout = setTimeout(function () { return ctrl_1.abort(); }, 3000);
                    ipCity = null;
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, , 6, 7]);
                    return [4 /*yield*/, fetch("https://ip-api.com/json/".concat(encodeURIComponent(requestIp), "?fields=status,city"), { signal: ctrl_1.signal })];
                case 3:
                    response = _b.sent();
                    if (!response.ok) return [3 /*break*/, 5];
                    return [4 /*yield*/, response.json()];
                case 4:
                    data = (_b.sent());
                    if (data.status === "success" && data.city)
                        ipCity = data.city;
                    _b.label = 5;
                case 5: return [3 /*break*/, 7];
                case 6:
                    clearTimeout(timeout);
                    return [7 /*endfinally*/];
                case 7:
                    if (!ipCity)
                        return [2 /*return*/];
                    normalise = function (s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ""); };
                    if (normalise(ipCity) === normalise(reportedCity))
                        return [2 /*return*/];
                    return [4 /*yield*/, writeTrustEvent(db, userId, "ip_city_mismatch", "medium", {
                            reportedCity: reportedCity,
                            ipCity: ipCity,
                            requestIp: requestIp.slice(0, 8) + "...", // partial IP only — no full IP in DB
                        })];
                case 8:
                    _b.sent();
                    return [3 /*break*/, 10];
                case 9:
                    _a = _b.sent();
                    return [3 /*break*/, 10];
                case 10: return [2 /*return*/];
            }
        });
    });
}
/** Purge expired snapshots (call from cleanup job). */
function purgeExpiredSnapshots(db) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, count, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("location_snapshots")
                            .delete({ count: "exact" })
                            .lt("expires_at", new Date().toISOString())];
                case 1:
                    _a = _c.sent(), count = _a.count, error = _a.error;
                    if (error)
                        return [2 /*return*/, 0];
                    return [2 /*return*/, count !== null && count !== void 0 ? count : 0];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, 0];
                case 3: return [2 /*return*/];
            }
        });
    });
}
