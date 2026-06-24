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
/**
 * Plan geofence routes (gated by plan_geofence_enabled flag)
 *
 * GET  /api/trips/:tripId/geofence              — load geofence (privacy-filtered by membership)
 * POST /api/trips/:tripId/geofence              — create/update geofence (owner only)
 * POST /api/trips/:tripId/geofence/check-in     — member check-in (radius + window validation)
 * GET  /api/trips/:tripId/geofence/attendance   — host attendance dashboard
 * POST /api/trips/:tripId/geofence/attendance/:userId/override  — host manual override
 *
 * PRIVACY: exact lat/lng stored server-side only. Public responses return
 * visibility labels, distance buckets, and status text — never raw coordinates.
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var locationVerify_js_1 = require("../lib/locationVerify.js");
var LocationSafetyService_js_1 = require("../services/location/LocationSafetyService.js");
var router = (0, express_1.Router)();
// ── Constants ─────────────────────────────────────────────────────────────────
var PUBLIC_PREVIEW_LEVELS = ["city_only", "neighborhood", "venue_tagged"];
var EXACT_VISIBILITY = ["exact_after_acceptance", "exact_private_host_reveal"];
var ATTENDANCE_STATUSES = ["not_checked_in", "on_the_way", "nearby", "arrived", "late", "no_show", "left"];
// ── Schema ────────────────────────────────────────────────────────────────────
var createSchema = zod_1.z.object({
    lat: zod_1.z.number().min(-90).max(90),
    lng: zod_1.z.number().min(-180).max(180),
    checkInRadiusM: zod_1.z.number().int().min(50).max(5000).default(150),
    publicPreviewLevel: zod_1.z.enum(PUBLIC_PREVIEW_LEVELS).default("neighborhood"),
    exactVisibility: zod_1.z.enum(EXACT_VISIBILITY).default("exact_after_acceptance"),
    checkInRequired: zod_1.z.boolean().default(false),
    checkInWindowStart: zod_1.z.string().datetime().optional().nullable(),
    checkInWindowEnd: zod_1.z.string().datetime().optional().nullable(),
    arrivalStatusVisible: zod_1.z.boolean().default(true),
    noShowAffectsReliability: zod_1.z.boolean().default(false),
    locationName: zod_1.z.string().max(300).optional().nullable(),
    city: zod_1.z.string().max(120).optional().nullable(),
    neighborhood: zod_1.z.string().max(120).optional().nullable(),
    venueName: zod_1.z.string().max(200).optional().nullable(),
    hostEnabled: zod_1.z.boolean().default(true),
});
var overrideSchema = zod_1.z.object({
    status: zod_1.z.enum(ATTENDANCE_STATUSES),
    note: zod_1.z.string().max(500).optional(),
});
// ── Helpers ───────────────────────────────────────────────────────────────────
function isFeatureEnabled(db) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!db)
                        return [2 /*return*/, false];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, db
                            .from("feature_flags")
                            .select("enabled")
                            .eq("key", "plan_geofence_enabled")
                            .maybeSingle()];
                case 2:
                    data = (_b.sent()).data;
                    return [2 /*return*/, Boolean(data === null || data === void 0 ? void 0 : data.enabled)];
                case 3:
                    _a = _b.sent();
                    return [2 /*return*/, false];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/** Returns 'owner' | 'member' | null (non-accepted / not found). */
function getMemberRole(db, tripId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var trip, member, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!db)
                        return [2 /*return*/, null];
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, db
                            .from("trips")
                            .select("owner_id")
                            .eq("id", tripId)
                            .maybeSingle()];
                case 2:
                    trip = (_b.sent()).data;
                    if ((trip === null || trip === void 0 ? void 0 : trip.owner_id) === userId)
                        return [2 /*return*/, "owner"];
                    return [4 /*yield*/, db
                            .from("trip_members")
                            .select("user_id")
                            .eq("trip_id", tripId)
                            .eq("user_id", userId)
                            .eq("role", "member")
                            .maybeSingle()];
                case 3:
                    member = (_b.sent()).data;
                    return [2 /*return*/, member ? "member" : null];
                case 4:
                    _a = _b.sent();
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
/** Admin default radius — returns 150 if table missing. */
function getAdminDefaults(db) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        var _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    _f.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db
                            .from("geofence_admin_settings")
                            .select("default_radius_m, min_radius_m, max_radius_m, no_show_affects_reliability")
                            .eq("id", 1)
                            .maybeSingle()];
                case 1:
                    data = (_f.sent()).data;
                    return [2 /*return*/, {
                            defaultRadiusM: (_b = data === null || data === void 0 ? void 0 : data.default_radius_m) !== null && _b !== void 0 ? _b : 150,
                            minRadiusM: (_c = data === null || data === void 0 ? void 0 : data.min_radius_m) !== null && _c !== void 0 ? _c : 50,
                            maxRadiusM: (_d = data === null || data === void 0 ? void 0 : data.max_radius_m) !== null && _d !== void 0 ? _d : 5000,
                            noShowAffectsReliability: (_e = data === null || data === void 0 ? void 0 : data.no_show_affects_reliability) !== null && _e !== void 0 ? _e : false,
                        }];
                case 2:
                    _a = _f.sent();
                    return [2 /*return*/, { defaultRadiusM: 150, minRadiusM: 50, maxRadiusM: 5000, noShowAffectsReliability: false }];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Write an attendance event (never auto-punishes). */
function writeAttendanceEvent(db, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    _d.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db.from("plan_attendance_events").insert({
                            geofence_id: opts.geofenceId,
                            trip_id: opts.tripId,
                            user_id: opts.userId,
                            event_type: opts.eventType,
                            actor_id: (_b = opts.actorId) !== null && _b !== void 0 ? _b : null,
                            metadata: (_c = opts.metadata) !== null && _c !== void 0 ? _c : {},
                        })];
                case 1:
                    _d.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _d.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/** Upsert a check-in row and write the matching attendance event. */
function upsertCheckin(db, opts) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, db.from("plan_checkins").upsert({
                        geofence_id: opts.geofenceId,
                        trip_id: opts.tripId,
                        user_id: opts.userId,
                        status: opts.status,
                        checked_in_at: opts.status === "arrived" || opts.status === "late" ? new Date().toISOString() : undefined,
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "geofence_id,user_id" })];
                case 1:
                    _b.sent();
                    return [4 /*yield*/, writeAttendanceEvent(db, {
                            geofenceId: opts.geofenceId,
                            tripId: opts.tripId,
                            userId: opts.userId,
                            eventType: opts.eventType,
                            actorId: opts.actorId,
                            metadata: (_a = opts.metadata) !== null && _a !== void 0 ? _a : {},
                        })];
                case 2:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// ── GET /api/trips/:tripId/geofence ───────────────────────────────────────────
// Non-accepted viewers see only public preview level (city/neighborhood/venue label).
// Accepted members see exact location only when host's exactVisibility allows it
// (or when the host has explicitly revealed it).
router.get("/trips/:tripId/geofence", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, tripId, role, _a, data, error, g, isAccepted, revealExact, myStatus, chk, exactLabel;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
    return __generator(this, function (_z) {
        switch (_z.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _z.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_z.sent())) {
                    res.status(200).json({ geofence: null, featureEnabled: false });
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                return [4 /*yield*/, getMemberRole(db, tripId, user.id)];
            case 3:
                role = _z.sent();
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .select("id, trip_id, check_in_radius_m, public_preview_level, exact_visibility, " +
                        "check_in_required, check_in_window_start, check_in_window_end, " +
                        "arrival_status_visible, no_show_affects_reliability, host_enabled, host_revealed, " +
                        "location_name, city, neighborhood, venue_name, created_at, updated_at")
                        .eq("trip_id", tripId)
                        .maybeSingle()];
            case 4:
                _a = _z.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "geofence: read failed");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    res.status(200).json({ geofence: null, featureEnabled: true });
                    return [2 /*return*/];
                }
                g = data;
                // Non-members get a stripped public card (no coords, no check-in data)
                if (!role) {
                    res.status(200).json({
                        featureEnabled: true,
                        geofence: {
                            id: g.id,
                            publicPreviewLevel: (_b = g.public_preview_level) !== null && _b !== void 0 ? _b : "neighborhood",
                            city: (_c = g.city) !== null && _c !== void 0 ? _c : null,
                            neighborhood: (_d = g.neighborhood) !== null && _d !== void 0 ? _d : null,
                            venueName: (_e = g.venue_name) !== null && _e !== void 0 ? _e : null,
                            locationName: g.public_preview_level === "venue_tagged" ? ((_f = g.location_name) !== null && _f !== void 0 ? _f : null) : null,
                            exactRevealLabel: "Exact meetup revealed after acceptance",
                            hostEnabled: g.host_enabled,
                            viewerRole: "none",
                        },
                    });
                    return [2 /*return*/];
                }
                isAccepted = role === "owner" || role === "member";
                revealExact = isAccepted && (g.exact_visibility === "exact_after_acceptance" ||
                    (g.exact_visibility === "exact_private_host_reveal" && g.host_revealed === true));
                myStatus = "not_checked_in";
                if (!isAccepted) return [3 /*break*/, 6];
                return [4 /*yield*/, db
                        .from("plan_checkins")
                        .select("status")
                        .eq("geofence_id", g.id)
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 5:
                chk = (_z.sent()).data;
                myStatus = (_g = chk === null || chk === void 0 ? void 0 : chk.status) !== null && _g !== void 0 ? _g : "not_checked_in";
                _z.label = 6;
            case 6:
                exactLabel = revealExact
                    ? ((_l = (_k = (_j = (_h = g.location_name) !== null && _h !== void 0 ? _h : g.venue_name) !== null && _j !== void 0 ? _j : g.neighborhood) !== null && _k !== void 0 ? _k : g.city) !== null && _l !== void 0 ? _l : "Exact location shared")
                    : (g.exact_visibility === "exact_after_acceptance"
                        ? "Exact meetup revealed after acceptance"
                        : "Exact location will be shared when the host reveals it");
                res.status(200).json({
                    featureEnabled: true,
                    geofence: {
                        id: g.id,
                        publicPreviewLevel: (_m = g.public_preview_level) !== null && _m !== void 0 ? _m : "neighborhood",
                        exactVisibility: (_o = g.exact_visibility) !== null && _o !== void 0 ? _o : "exact_after_acceptance",
                        checkInRequired: (_p = g.check_in_required) !== null && _p !== void 0 ? _p : false,
                        checkInWindowStart: (_q = g.check_in_window_start) !== null && _q !== void 0 ? _q : null,
                        checkInWindowEnd: (_r = g.check_in_window_end) !== null && _r !== void 0 ? _r : null,
                        arrivalStatusVisible: (_s = g.arrival_status_visible) !== null && _s !== void 0 ? _s : true,
                        noShowAffectsReliability: (_t = g.no_show_affects_reliability) !== null && _t !== void 0 ? _t : false,
                        hostEnabled: g.host_enabled,
                        hostRevealed: (_u = g.host_revealed) !== null && _u !== void 0 ? _u : false,
                        city: (_v = g.city) !== null && _v !== void 0 ? _v : null,
                        neighborhood: (_w = g.neighborhood) !== null && _w !== void 0 ? _w : null,
                        venueName: (_x = g.venue_name) !== null && _x !== void 0 ? _x : null,
                        // Exact location label (never raw coords)
                        locationLabel: exactLabel,
                        locationName: revealExact ? ((_y = g.location_name) !== null && _y !== void 0 ? _y : null) : null,
                        exactLocationRevealed: revealExact,
                        checkInRadiusM: g.check_in_radius_m,
                        myCheckInStatus: myStatus,
                        viewerRole: role,
                        createdAt: g.created_at,
                        updatedAt: g.updated_at,
                    },
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/trips/:tripId/geofence ──────────────────────────────────────────
// Owner creates/updates geofence with full host settings.
router.post("/trips/:tripId/geofence", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, parsed, tripId, trip, adminDefaults, radiusM, d, record, existing, writeError, error, error;
    var _a, _b, _c, _d, _e, _f, _g, _h;
    return __generator(this, function (_j) {
        switch (_j.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _j.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_j.sent())) {
                    (0, http_js_1.sendError)(res, "feature_disabled", "Plan geofencing is not enabled");
                    return [2 /*return*/];
                }
                parsed = createSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "Invalid payload");
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                return [4 /*yield*/, db
                        .from("trips")
                        .select("owner_id")
                        .eq("id", tripId)
                        .maybeSingle()];
            case 3:
                trip = (_j.sent()).data;
                if (!trip || trip.owner_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the trip owner can set a geofence");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, getAdminDefaults(db)];
            case 4:
                adminDefaults = _j.sent();
                radiusM = Math.max(adminDefaults.minRadiusM, Math.min(adminDefaults.maxRadiusM, parsed.data.checkInRadiusM));
                d = parsed.data;
                record = {
                    trip_id: tripId,
                    lat: d.lat,
                    lng: d.lng,
                    check_in_radius_m: radiusM,
                    public_preview_level: d.publicPreviewLevel,
                    exact_visibility: d.exactVisibility,
                    check_in_required: d.checkInRequired,
                    check_in_window_start: (_c = d.checkInWindowStart) !== null && _c !== void 0 ? _c : null,
                    check_in_window_end: (_d = d.checkInWindowEnd) !== null && _d !== void 0 ? _d : null,
                    arrival_status_visible: d.arrivalStatusVisible,
                    no_show_affects_reliability: d.noShowAffectsReliability,
                    location_name: (_e = d.locationName) !== null && _e !== void 0 ? _e : null,
                    city: (_f = d.city) !== null && _f !== void 0 ? _f : null,
                    neighborhood: (_g = d.neighborhood) !== null && _g !== void 0 ? _g : null,
                    venue_name: (_h = d.venueName) !== null && _h !== void 0 ? _h : null,
                    host_enabled: d.hostEnabled,
                    created_by: user.id,
                    updated_at: new Date().toISOString(),
                };
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .select("id")
                        .eq("trip_id", tripId)
                        .maybeSingle()];
            case 5:
                existing = (_j.sent()).data;
                writeError = null;
                if (!(existing === null || existing === void 0 ? void 0 : existing.id)) return [3 /*break*/, 7];
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .update(record)
                        .eq("id", existing.id)];
            case 6:
                error = (_j.sent()).error;
                writeError = error;
                return [3 /*break*/, 9];
            case 7: return [4 /*yield*/, db
                    .from("plan_geofences")
                    .insert(record)];
            case 8:
                error = (_j.sent()).error;
                writeError = error;
                _j.label = 9;
            case 9:
                if (writeError) {
                    req.log.error({ err: writeError }, "geofence: write failed");
                    (0, http_js_1.sendError)(res, "db_error", writeError.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ ok: true, effectiveRadiusM: radiusM });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/trips/:tripId/geofence/reveal ────────────────────────────────────
// Host reveals exact location to accepted members (when exactVisibility = host_reveal).
router.post("/trips/:tripId/geofence/reveal", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, tripId, trip, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_a.sent())) {
                    (0, http_js_1.sendError)(res, "feature_disabled", "Plan geofencing is not enabled");
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                return [4 /*yield*/, db
                        .from("trips")
                        .select("owner_id")
                        .eq("id", tripId)
                        .maybeSingle()];
            case 3:
                trip = (_a.sent()).data;
                if (!trip || trip.owner_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the trip owner can reveal the exact location");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .update({ host_revealed: true, updated_at: new Date().toISOString() })
                        .eq("trip_id", tripId)];
            case 4:
                error = (_a.sent()).error;
                if (error) {
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/trips/:tripId/geofence/check-in ─────────────────────────────────
// Accepted member checks in. Validates: accepted role, within radius, within window.
// Stores arrival status without exposing coordinates publicly.
// Routes suspicious GPS through LocationSafetyService → location_trust_event.
var checkInSchema = zod_1.z.object({
    lat: zod_1.z.number().min(-90).max(90),
    lng: zod_1.z.number().min(-180).max(180),
});
router.post("/trips/:tripId/geofence/check-in", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, parsed, tripId, _a, lat, lng, role, _b, gf, gfErr, geofence, geofenceId, now, trustResult, isSuspicious, distanceM, radiusM, isLate, arrivalStatus, eventType;
    var _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_f.sent())) {
                    (0, http_js_1.sendError)(res, "feature_disabled", "Plan geofencing is not enabled");
                    return [2 /*return*/];
                }
                parsed = checkInSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid payload");
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                _a = parsed.data, lat = _a.lat, lng = _a.lng;
                return [4 /*yield*/, getMemberRole(db, tripId, user.id)];
            case 3:
                role = _f.sent();
                if (!role) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to check in");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .select("id, lat, lng, check_in_radius_m, check_in_required, check_in_window_start, check_in_window_end, host_enabled, trip_id")
                        .eq("trip_id", tripId)
                        .maybeSingle()];
            case 4:
                _b = _f.sent(), gf = _b.data, gfErr = _b.error;
                if (gfErr) {
                    (0, http_js_1.sendError)(res, "db_error", gfErr.message);
                    return [2 /*return*/];
                }
                if (!gf || !gf.host_enabled) {
                    (0, http_js_1.sendError)(res, "not_found", "No active geofence for this trip");
                    return [2 /*return*/];
                }
                geofence = gf;
                geofenceId = geofence.id;
                now = new Date();
                if (geofence.check_in_window_start && new Date(geofence.check_in_window_start) > now) {
                    res.status(200).json({
                        ok: false,
                        reason: "window_not_open",
                        message: "Check-in window has not opened yet. Come back closer to the meetup time.",
                    });
                    return [2 /*return*/];
                }
                if (geofence.check_in_window_end && new Date(geofence.check_in_window_end) < now) {
                    res.status(200).json({
                        ok: false,
                        reason: "window_closed",
                        message: "The check-in window has closed. Contact the host if you have trouble.",
                    });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, LocationSafetyService_js_1.checkAndRecordSnapshot)(db, user.id, lat, lng)];
            case 5:
                trustResult = _f.sent();
                isSuspicious = !trustResult.trusted;
                distanceM = (0, locationVerify_js_1.calculateDistanceMeters)(lat, lng, geofence.lat, geofence.lng);
                radiusM = (_e = geofence.check_in_radius_m) !== null && _e !== void 0 ? _e : 150;
                if (!isSuspicious) return [3 /*break*/, 7];
                // Write a trust event and allow a fallback/manual-review path
                return [4 /*yield*/, writeAttendanceEvent(db, {
                        geofenceId: geofenceId,
                        tripId: tripId,
                        userId: user.id,
                        eventType: "suspicious_check_in",
                        metadata: {
                            suspicionReason: trustResult.suspicionReason,
                            distanceBucket: distanceM <= radiusM ? "inside" : "outside",
                        },
                    })];
            case 6:
                // Write a trust event and allow a fallback/manual-review path
                _f.sent();
                res.status(200).json({
                    ok: false,
                    reason: "suspicious_gps",
                    message: "We couldn't verify your location. Your check-in has been flagged for review. Contact the host if you need assistance.",
                });
                return [2 /*return*/];
            case 7:
                if (distanceM > radiusM) {
                    // Outside radius — friendly message, no coordinates leaked
                    res.status(200).json({
                        ok: false,
                        reason: "outside_radius",
                        message: "You're not close enough to check in yet. Make sure you're at the meetup location.",
                    });
                    return [2 /*return*/];
                }
                isLate = Boolean(geofence.check_in_window_end && new Date(geofence.check_in_window_end) <= now);
                arrivalStatus = isLate ? "late" : "arrived";
                eventType = isLate ? "late_check_in" : "checked_in_successfully";
                return [4 /*yield*/, upsertCheckin(db, {
                        geofenceId: geofenceId,
                        tripId: tripId,
                        userId: user.id,
                        status: arrivalStatus,
                        eventType: eventType,
                        metadata: { distanceBucket: distanceM <= 100 ? "same_venue" : "inside_radius" },
                    })];
            case 8:
                _f.sent();
                res.status(200).json({
                    ok: true,
                    status: arrivalStatus,
                    message: isLate ? "You're checked in (late arrival recorded)." : "You're checked in! 🎉",
                });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/trips/:tripId/geofence/attendance ────────────────────────────────
// Host attendance dashboard — counts + per-attendee status text (no pins).
router.get("/trips/:tripId/geofence/attendance", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, tripId, trip, gf, geofenceId, members, memberIds, checkins, checkinMap, _i, _a, c, allIds, profileMap, profiles, _b, _c, p, STATUS_LABEL, attendees, totals;
    var _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_f.sent())) {
                    (0, http_js_1.sendError)(res, "feature_disabled", "Plan geofencing is not enabled");
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                return [4 /*yield*/, db
                        .from("trips")
                        .select("owner_id")
                        .eq("id", tripId)
                        .maybeSingle()];
            case 3:
                trip = (_f.sent()).data;
                if (!trip || trip.owner_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the trip owner can view attendance");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .select("id, check_in_radius_m, check_in_window_start, check_in_window_end")
                        .eq("trip_id", tripId)
                        .maybeSingle()];
            case 4:
                gf = (_f.sent()).data;
                if (!gf) {
                    res.status(200).json({ attendance: null, message: "No geofence configured" });
                    return [2 /*return*/];
                }
                geofenceId = gf.id;
                return [4 /*yield*/, db
                        .from("trip_members")
                        .select("user_id")
                        .eq("trip_id", tripId)
                        .eq("role", "member")];
            case 5:
                members = (_f.sent()).data;
                memberIds = (members !== null && members !== void 0 ? members : []).map(function (m) { return m.user_id; });
                return [4 /*yield*/, db
                        .from("plan_checkins")
                        .select("user_id, status, checked_in_at, updated_at")
                        .eq("geofence_id", geofenceId)];
            case 6:
                checkins = (_f.sent()).data;
                checkinMap = {};
                for (_i = 0, _a = checkins !== null && checkins !== void 0 ? checkins : []; _i < _a.length; _i++) {
                    c = _a[_i];
                    checkinMap[c.user_id] = c;
                }
                allIds = __spreadArray([], memberIds, true);
                profileMap = {};
                if (!(allIds.length > 0)) return [3 /*break*/, 8];
                return [4 /*yield*/, db
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", allIds)];
            case 7:
                profiles = (_f.sent()).data;
                for (_b = 0, _c = profiles !== null && profiles !== void 0 ? profiles : []; _b < _c.length; _b++) {
                    p = _c[_b];
                    profileMap[p.id] = p;
                }
                _f.label = 8;
            case 8:
                STATUS_LABEL = {
                    not_checked_in: "Not checked in",
                    on_the_way: "On the way",
                    nearby: "Nearby",
                    arrived: "Arrived",
                    late: "Arrived (late)",
                    no_show: "No-show",
                    left: "Left",
                };
                attendees = memberIds.map(function (uid) {
                    var _a, _b, _c, _d, _e, _f, _g, _h;
                    var p = (_a = profileMap[uid]) !== null && _a !== void 0 ? _a : {};
                    var c = checkinMap[uid];
                    return {
                        userId: uid,
                        handle: (_b = p.handle) !== null && _b !== void 0 ? _b : "",
                        name: (_c = p.name) !== null && _c !== void 0 ? _c : "",
                        avatarUrl: (_d = p.avatar_url) !== null && _d !== void 0 ? _d : null,
                        status: (_e = c === null || c === void 0 ? void 0 : c.status) !== null && _e !== void 0 ? _e : "not_checked_in",
                        statusLabel: (_g = STATUS_LABEL[(_f = c === null || c === void 0 ? void 0 : c.status) !== null && _f !== void 0 ? _f : "not_checked_in"]) !== null && _g !== void 0 ? _g : "Unknown",
                        checkedInAt: (_h = c === null || c === void 0 ? void 0 : c.checked_in_at) !== null && _h !== void 0 ? _h : null,
                    };
                });
                totals = {
                    accepted: memberIds.length,
                    checkedIn: attendees.filter(function (a) { return a.status === "arrived" || a.status === "late"; }).length,
                    nearby: attendees.filter(function (a) { return a.status === "nearby"; }).length,
                    onTheWay: attendees.filter(function (a) { return a.status === "on_the_way"; }).length,
                    noShow: attendees.filter(function (a) { return a.status === "no_show"; }).length,
                    left: attendees.filter(function (a) { return a.status === "left"; }).length,
                    notCheckedIn: attendees.filter(function (a) { return a.status === "not_checked_in"; }).length,
                };
                res.json({
                    geofenceId: geofenceId,
                    checkInRadiusM: gf.check_in_radius_m,
                    checkInWindowStart: (_d = gf.check_in_window_start) !== null && _d !== void 0 ? _d : null,
                    checkInWindowEnd: (_e = gf.check_in_window_end) !== null && _e !== void 0 ? _e : null,
                    totals: totals,
                    attendees: attendees,
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/trips/:tripId/geofence/attendance/:userId/override ──────────────
// Host manually overrides a member's attendance status.
router.post("/trips/:tripId/geofence/attendance/:userId/override", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, parsed, _a, tripId, userId, trip, gf, geofenceId;
    var _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_f.sent())) {
                    (0, http_js_1.sendError)(res, "feature_disabled", "Plan geofencing is not enabled");
                    return [2 /*return*/];
                }
                parsed = overrideSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                _a = req.params, tripId = _a.tripId, userId = _a.userId;
                return [4 /*yield*/, db
                        .from("trips")
                        .select("owner_id")
                        .eq("id", tripId)
                        .maybeSingle()];
            case 3:
                trip = (_f.sent()).data;
                if (!trip || trip.owner_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the trip owner can override attendance");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .select("id")
                        .eq("trip_id", tripId)
                        .maybeSingle()];
            case 4:
                gf = (_f.sent()).data;
                if (!gf) {
                    (0, http_js_1.sendError)(res, "not_found", "No geofence configured for this trip");
                    return [2 /*return*/];
                }
                geofenceId = gf.id;
                // Upsert check-in with override
                return [4 /*yield*/, db.from("plan_checkins").upsert({
                        geofence_id: geofenceId,
                        trip_id: tripId,
                        user_id: userId,
                        status: parsed.data.status,
                        override_by: user.id,
                        override_note: (_d = parsed.data.note) !== null && _d !== void 0 ? _d : null,
                        updated_at: new Date().toISOString(),
                    }, { onConflict: "geofence_id,user_id" })];
            case 5:
                // Upsert check-in with override
                _f.sent();
                return [4 /*yield*/, writeAttendanceEvent(db, {
                        geofenceId: geofenceId,
                        tripId: tripId,
                        userId: userId,
                        eventType: "host_manual_override",
                        actorId: user.id,
                        metadata: { newStatus: parsed.data.status, note: (_e = parsed.data.note) !== null && _e !== void 0 ? _e : null },
                    })];
            case 6:
                _f.sent();
                res.json({ ok: true, userId: userId, newStatus: parsed.data.status });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
