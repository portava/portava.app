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
 * Plan geofence routes (Phase 3 seam — gated by plan_geofence_enabled flag)
 *
 * GET  /api/trips/:tripId/geofence   — load geofence for a trip
 * POST /api/trips/:tripId/geofence   — create/update geofence
 *
 * PRIVACY: exact lat/lng are stored server-side only. Public responses
 * return visibility labels and arrival status — never raw coordinates.
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var router = (0, express_1.Router)();
var VISIBILITY_VALUES = ["hidden_until_accepted", "accepted_members", "public_approximate"];
var createSchema = zod_1.z.object({
    lat: zod_1.z.number().min(-90).max(90),
    lng: zod_1.z.number().min(-180).max(180),
    checkInRadiusM: zod_1.z.number().int().min(50).max(5000).default(150),
    visibility: zod_1.z.enum(VISIBILITY_VALUES).default("hidden_until_accepted"),
    hostEnabled: zod_1.z.boolean().default(true),
});
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
function isTripMember(db, tripId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var trip, member, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!db)
                        return [2 /*return*/, false];
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
                        return [2 /*return*/, true];
                    return [4 /*yield*/, db
                            .from("trip_members")
                            .select("user_id")
                            .eq("trip_id", tripId)
                            .eq("user_id", userId)
                            .eq("role", "member")
                            .maybeSingle()];
                case 3:
                    member = (_b.sent()).data;
                    return [2 /*return*/, Boolean(member)];
                case 4:
                    _a = _b.sent();
                    return [2 /*return*/, false];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// ── GET /api/trips/:tripId/geofence ───────────────────────────────────────────
router.get("/trips/:tripId/geofence", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, tripId, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_b.sent())) {
                    res.status(200).json({ geofence: null, featureEnabled: false });
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                return [4 /*yield*/, isTripMember(db, tripId, user.id)];
            case 3:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "forbidden", "Not a trip member");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .select("id, check_in_radius_m, visibility, arrival_status, host_enabled, created_at, updated_at")
                        .eq("trip_id", tripId)
                        .maybeSingle()];
            case 4:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "geofence: read failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!data) {
                    res.status(200).json({ geofence: null, featureEnabled: true });
                    return [2 /*return*/];
                }
                // Exact coords are NEVER returned — only visibility labels
                res.status(200).json({
                    featureEnabled: true,
                    geofence: {
                        id: data.id,
                        checkInRadiusM: data.check_in_radius_m,
                        visibility: data.visibility,
                        arrivalStatus: data.arrival_status,
                        hostEnabled: data.host_enabled,
                        createdAt: data.created_at,
                        updatedAt: data.updated_at,
                    },
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/trips/:tripId/geofence ──────────────────────────────────────────
router.post("/trips/:tripId/geofence", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, db, user, parsed, tripId, trip, existing, record, writeError, error, error;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                db = auth.client, user = auth.user;
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_c.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Plan geofencing is not enabled");
                    return [2 /*return*/];
                }
                parsed = createSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "Invalid payload");
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                return [4 /*yield*/, db
                        .from("trips")
                        .select("owner_id")
                        .eq("id", tripId)
                        .maybeSingle()];
            case 3:
                trip = (_c.sent()).data;
                if (!trip || trip.owner_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the trip owner can set a geofence");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .select("id")
                        .eq("trip_id", tripId)
                        .maybeSingle()];
            case 4:
                existing = (_c.sent()).data;
                record = {
                    trip_id: tripId,
                    lat: parsed.data.lat,
                    lng: parsed.data.lng,
                    check_in_radius_m: parsed.data.checkInRadiusM,
                    visibility: parsed.data.visibility,
                    host_enabled: parsed.data.hostEnabled,
                    created_by: user.id,
                    updated_at: new Date().toISOString(),
                };
                writeError = null;
                if (!(existing === null || existing === void 0 ? void 0 : existing.id)) return [3 /*break*/, 6];
                return [4 /*yield*/, db
                        .from("plan_geofences")
                        .update(record)
                        .eq("id", existing.id)];
            case 5:
                error = (_c.sent()).error;
                writeError = error;
                return [3 /*break*/, 8];
            case 6: return [4 /*yield*/, db
                    .from("plan_geofences")
                    .insert(record)];
            case 7:
                error = (_c.sent()).error;
                writeError = error;
                _c.label = 8;
            case 8:
                if (writeError) {
                    req.log.error({ err: writeError }, "geofence: write failed");
                    (0, http_1.sendError)(res, "db_error", writeError.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
