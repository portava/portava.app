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
 * Safe Return routes (Phase 4 seam — gated by safe_return_geo_enabled flag)
 *
 * POST /api/me/safe-return/start      — start a Safe Return session
 * POST /api/me/safe-return/checkin    — "I made it back" / check-in
 * GET  /api/me/safe-return/active     — list active sessions (public labels only)
 *
 * PRIVACY: exact coords stored server-side only. Public responses contain
 * only city/district labels, timer info, and status.
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var LocationSessionService_1 = require("../services/location/LocationSessionService");
var router = (0, express_1.Router)();
var VALID_TIMERS = ["15min", "30min", "1hr", "until_plan_ends", "manual"];
var startSchema = zod_1.z.object({
    timer: zod_1.z.enum(VALID_TIMERS).default("30min"),
    city: zod_1.z.string().max(128).nullable().optional(),
    district: zod_1.z.string().max(128).nullable().optional(),
    country: zod_1.z.string().max(128).nullable().optional(),
    countryCode: zod_1.z.string().max(8).nullable().optional(),
    lat: zod_1.z.number().min(-90).max(90).nullable().optional(),
    lng: zod_1.z.number().min(-180).max(180).nullable().optional(),
    relatedTripId: zod_1.z.string().uuid().nullable().optional(),
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
                            .eq("key", "safe_return_geo_enabled")
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
// ── POST /api/me/safe-return/start ────────────────────────────────────────────
router.post("/me/safe-return/start", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, db, parsed, session;
    var _a, _b;
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
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_c.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Safe Return is not yet enabled");
                    return [2 /*return*/];
                }
                parsed = startSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "Invalid payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, LocationSessionService_1.startSession)(db, {
                        userId: user.id,
                        sessionType: "safe_return",
                        timer: parsed.data.timer,
                        city: parsed.data.city,
                        district: parsed.data.district,
                        country: parsed.data.country,
                        countryCode: parsed.data.countryCode,
                        lat: parsed.data.lat,
                        lng: parsed.data.lng,
                        relatedTripId: parsed.data.relatedTripId,
                    })];
            case 3:
                session = _c.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "db_error", "Failed to start session");
                    return [2 /*return*/];
                }
                // Return public shape — no coords
                res.status(201).json({
                    ok: true,
                    session: {
                        id: session.id,
                        sessionType: session.sessionType,
                        startedAt: session.startedAt,
                        expiresAt: session.expiresAt,
                        city: session.city,
                        district: session.district,
                        country: session.country,
                        safeReturnActive: true,
                    },
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/checkin ─────────────────────────────────────────
router.post("/me/safe-return/checkin", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, db, sessionId, ok, active;
    var _a;
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
                    (0, http_1.sendError)(res, "server_not_configured");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Safe Return is not yet enabled");
                    return [2 /*return*/];
                }
                sessionId = ((_a = req.body) !== null && _a !== void 0 ? _a : {}).sessionId;
                if (!sessionId) return [3 /*break*/, 4];
                return [4 /*yield*/, (0, LocationSessionService_1.endSession)(db, sessionId, user.id)];
            case 3:
                ok = _b.sent();
                res.status(200).json({ ok: ok, safeReturnActive: !ok });
                return [2 /*return*/];
            case 4: return [4 /*yield*/, (0, LocationSessionService_1.getActiveSessions)(db, user.id, "safe_return")];
            case 5:
                active = _b.sent();
                return [4 /*yield*/, Promise.all(active.map(function (s) { return (0, LocationSessionService_1.endSession)(db, s.id, user.id); }))];
            case 6:
                _b.sent();
                res.status(200).json({ ok: true, ended: active.length, safeReturnActive: false });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/safe-return/active ────────────────────────────────────────────
router.get("/me/safe-return/active", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, db, active;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                db = (0, supabase_1.getServiceClient)();
                if (!db) {
                    res.status(200).json({ sessions: [], safeReturnActive: false });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isFeatureEnabled(db)];
            case 2:
                if (!(_a.sent())) {
                    res.status(200).json({ sessions: [], safeReturnActive: false, featureEnabled: false });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, LocationSessionService_1.getActiveSessions)(db, user.id, "safe_return")];
            case 3:
                active = _a.sent();
                res.status(200).json({
                    safeReturnActive: active.length > 0,
                    sessions: active.map(function (s) { return ({
                        id: s.id,
                        startedAt: s.startedAt,
                        expiresAt: s.expiresAt,
                        city: s.city,
                        district: s.district,
                        country: s.country,
                    }); }),
                });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
