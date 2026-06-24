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
 * Safe Return routes
 *
 * All user-facing routes are gated by the 'safe_return_enabled' feature flag.
 * Live-share routes additionally require 'safe_return_live_share_enabled'.
 *
 * Endpoint set:
 *   GET  /api/me/safe-return/suggest/:planItemId
 *   POST /api/me/safe-return/sessions
 *   POST /api/me/safe-return/sessions/:id/start
 *   GET  /api/me/safe-return/sessions/active
 *   POST /api/me/safe-return/sessions/:id/extend
 *   POST /api/me/safe-return/sessions/:id/confirm
 *   POST /api/me/safe-return/sessions/:id/cancel
 *   POST /api/me/safe-return/sessions/:id/trigger-missed
 *   POST /api/me/safe-return/sessions/:id/live-share/start
 *   POST /api/me/safe-return/sessions/:id/live-share/stop
 *   GET  /api/safe-return/live-share/:shareId
 *   GET  /api/me/safe-return/history
 *   GET  /api/me/safe-return/trusted-contacts
 *
 * Privacy: exact coords never appear in API responses (enforced by toPublicSession).
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var supabase_1 = require("../lib/supabase");
var SafeReturnService_1 = require("../services/safeReturn/SafeReturnService");
var SafeReturnTriggerService_1 = require("../services/safeReturn/SafeReturnTriggerService");
var SafeReturnNotificationService_1 = require("../services/safeReturn/SafeReturnNotificationService");
var SafeReturnLiveShareService_1 = require("../services/safeReturn/SafeReturnLiveShareService");
var SafeReturnPrivacyGuard_1 = require("../services/safeReturn/SafeReturnPrivacyGuard");
var router = (0, express_1.Router)();
// ── Feature flag helpers ──────────────────────────────────────────────────────
function isFlagEnabled(db, flag) {
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
                            .eq("key", flag)
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
// ── Schemas ───────────────────────────────────────────────────────────────────
var contactSchema = zod_1.z.object({
    contactUserId: zod_1.z.string().uuid().optional().nullable(),
    contactName: zod_1.z.string().max(200).optional().nullable(),
    contactPhone: zod_1.z.string().max(30).optional().nullable(),
    contactEmail: zod_1.z.string().email().max(200).optional().nullable(),
    contactMethod: zod_1.z.enum(["in_app", "sms", "email"]),
    canReceiveLiveLocation: zod_1.z.boolean().optional().default(false),
});
var createSessionSchema = zod_1.z.object({
    planItemId: zod_1.z.string().uuid().optional().nullable(),
    tripId: zod_1.z.string().uuid().optional().nullable(),
    triggerReason: zod_1.z.string().max(500).optional().nullable(),
    escalationLevel: zod_1.z.union([zod_1.z.literal(0), zod_1.z.literal(1), zod_1.z.literal(2), zod_1.z.literal(3)]).optional().default(0),
    timerMinutes: zod_1.z.number().int().min(5).max(480).optional().nullable(),
    trustedCircleEnabled: zod_1.z.boolean().optional().default(false),
    liveShareEnabled: zod_1.z.boolean().optional().default(false),
    notifyHostEnabled: zod_1.z.boolean().optional().default(false),
    notifyTripCrewEnabled: zod_1.z.boolean().optional().default(false),
    emergencyNote: zod_1.z.string().max(1000).optional().nullable(),
    contacts: zod_1.z.array(contactSchema).max(10).optional().default([]),
});
var extendSchema = zod_1.z.object({
    minutes: zod_1.z.number().int().min(5).max(240),
});
// ── GET /api/me/safe-return/suggest/:planItemId ───────────────────────────────
router.get("/me/safe-return/suggest/:planItemId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, planItemId, item, tripId, membership, homeCity, currentCity, profile, locState, _a, attendeeCount, count, _b, hasLocationCautionFlag, lat, lng, delta, zones, _c, planItemCtx, result;
    var _d, _e, _f, _g, _h, _j, _k;
    return __generator(this, function (_l) {
        switch (_l.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _l.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_d = (0, supabase_1.getServiceClient)()) !== null && _d !== void 0 ? _d : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_l.sent())) {
                    res.status(200).json({ suggest: false, featureEnabled: false });
                    return [2 /*return*/];
                }
                planItemId = req.params.planItemId;
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .select("id, category, starts_at, day_date, location_name, lat, lng, trip_id")
                        .eq("id", planItemId)
                        .maybeSingle()];
            case 3:
                item = (_l.sent()).data;
                if (!item) {
                    (0, http_1.sendError)(res, "not_found", "Plan item not found");
                    return [2 /*return*/];
                }
                tripId = item.trip_id;
                if (!tripId) return [3 /*break*/, 5];
                return [4 /*yield*/, client
                        .from("trip_members")
                        .select("user_id")
                        .eq("trip_id", tripId)
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 4:
                membership = (_l.sent()).data;
                if (!membership) {
                    (0, http_1.sendError)(res, "forbidden", "You are not a member of this trip");
                    return [2 /*return*/];
                }
                _l.label = 5;
            case 5:
                homeCity = null;
                currentCity = null;
                _l.label = 6;
            case 6:
                _l.trys.push([6, 9, , 10]);
                return [4 /*yield*/, client
                        .from("profiles")
                        .select("home_city")
                        .eq("id", user.id)
                        .maybeSingle()];
            case 7:
                profile = (_l.sent()).data;
                homeCity = (_e = profile === null || profile === void 0 ? void 0 : profile.home_city) !== null && _e !== void 0 ? _e : null;
                return [4 /*yield*/, client
                        .from("user_location_state")
                        .select("city")
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 8:
                locState = (_l.sent()).data;
                currentCity = (_f = locState === null || locState === void 0 ? void 0 : locState.city) !== null && _f !== void 0 ? _f : null;
                return [3 /*break*/, 10];
            case 9:
                _a = _l.sent();
                return [3 /*break*/, 10];
            case 10:
                _l.trys.push([10, 13, , 14]);
                if (!item.trip_id) return [3 /*break*/, 12];
                return [4 /*yield*/, client
                        .from("trip_members")
                        .select("*", { count: "exact", head: true })
                        .eq("trip_id", item.trip_id)];
            case 11:
                count = (_l.sent()).count;
                attendeeCount = count !== null && count !== void 0 ? count : undefined;
                _l.label = 12;
            case 12: return [3 /*break*/, 14];
            case 13:
                _b = _l.sent();
                return [3 /*break*/, 14];
            case 14:
                hasLocationCautionFlag = false;
                _l.label = 15;
            case 15:
                _l.trys.push([15, 18, , 19]);
                lat = item.lat;
                lng = item.lng;
                if (!(lat != null && lng != null)) return [3 /*break*/, 17];
                delta = 0.45;
                return [4 /*yield*/, db
                        .from("geo_zones")
                        .select("safety_rating")
                        .in("safety_rating", ["caution", "avoid"])
                        .gte("center_lat", lat - delta)
                        .lte("center_lat", lat + delta)
                        .gte("center_lng", lng - delta)
                        .lte("center_lng", lng + delta)
                        .limit(1)];
            case 16:
                zones = (_l.sent()).data;
                hasLocationCautionFlag = !!zones && zones.length > 0;
                _l.label = 17;
            case 17: return [3 /*break*/, 19];
            case 18:
                _c = _l.sent();
                return [3 /*break*/, 19];
            case 19:
                planItemCtx = {
                    id: item.id,
                    category: (_g = item.category) !== null && _g !== void 0 ? _g : "other",
                    startsAt: (_h = item.starts_at) !== null && _h !== void 0 ? _h : null,
                    dayDate: (_j = item.day_date) !== null && _j !== void 0 ? _j : null,
                    locationName: (_k = item.location_name) !== null && _k !== void 0 ? _k : null,
                    attendeeCount: attendeeCount,
                    hasLocationCautionFlag: hasLocationCautionFlag,
                };
                result = (0, SafeReturnTriggerService_1.shouldSuggest)(planItemCtx, user.id, { homeCity: homeCity, currentCity: currentCity });
                res.status(200).json({
                    suggest: result.shouldSuggest,
                    reasons: result.reasons,
                    confidence: result.confidence,
                    reasonText: result.shouldSuggest ? (0, SafeReturnTriggerService_1.getSuggestionReason)(result.reasons) : null,
                    planItemId: planItemId,
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions ────────────────────────────────────────
router.post("/me/safe-return/sessions", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, parsed, session;
    var _a, _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_d.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Safe Return is not yet enabled");
                    return [2 /*return*/];
                }
                parsed = createSessionSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.createSession)(db, __assign({ userId: user.id }, parsed.data))];
            case 3:
                session = _d.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "db_error", "Failed to create session");
                    return [2 /*return*/];
                }
                res.status(201).json({ ok: true, session: (0, SafeReturnPrivacyGuard_1.toPublicSession)(session) });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions/:id/start ───────────────────────────────
router.post("/me/safe-return/sessions/:id/start", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, session;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.startSession)(db, req.params.id, user.id)];
            case 3:
                session = _b.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "not_found", "Session not found or cannot be started");
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, session: (0, SafeReturnPrivacyGuard_1.toPublicSession)(session) });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/safe-return/sessions/active ───────────────────────────────────
router.get("/me/safe-return/sessions/active", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, session;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_b.sent())) {
                    res.status(200).json({ session: null, featureEnabled: false });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.getActiveSession)(db, user.id)];
            case 3:
                session = _b.sent();
                res.status(200).json({ session: session ? (0, SafeReturnPrivacyGuard_1.toPublicSession)(session) : null });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions/:id/extend ─────────────────────────────
router.post("/me/safe-return/sessions/:id/extend", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, parsed, session;
    var _a, _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_d.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled");
                    return [2 /*return*/];
                }
                parsed = extendSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid minutes");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.extendTimer)(db, req.params.id, user.id, parsed.data.minutes)];
            case 3:
                session = _d.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "not_found", "Session not found or cannot be extended");
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, session: (0, SafeReturnPrivacyGuard_1.toPublicSession)(session) });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions/:id/confirm ────────────────────────────
router.post("/me/safe-return/sessions/:id/confirm", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, session;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.confirmSafe)(db, req.params.id, user.id)];
            case 3:
                session = _b.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "not_found", "Session not found or already closed");
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, session: (0, SafeReturnPrivacyGuard_1.toPublicSession)(session) });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions/:id/cancel ─────────────────────────────
router.post("/me/safe-return/sessions/:id/cancel", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, session;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.cancelSession)(db, req.params.id, user.id)];
            case 3:
                session = _b.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "not_found", "Session not found or already closed");
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, session: (0, SafeReturnPrivacyGuard_1.toPublicSession)(session) });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions/:id/trigger-missed ─────────────────────
// Marks a session as missed and escalates. Timer must have already expired.
router.post("/me/safe-return/sessions/:id/trigger-missed", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, existing, session, contacts, flagTcEnabled;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.getSessionById)(db, req.params.id, user.id)];
            case 3:
                existing = _b.sent();
                if (!existing || existing.status !== "active") {
                    (0, http_1.sendError)(res, "not_found", "Active session not found");
                    return [2 /*return*/];
                }
                // Timer must have already expired — reject premature triggers
                if (existing.timerEndAt && new Date(existing.timerEndAt) > new Date()) {
                    (0, http_1.sendError)(res, "forbidden", "Timer has not yet expired");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.markMissed)(db, req.params.id, user.id)];
            case 4:
                session = _b.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "db_error", "Failed to mark session as missed");
                    return [2 /*return*/];
                }
                // Escalation: Level 0 = notify only the user
                //             Level 1 = user + TC (if enabled)
                //             Level 2 = user + TC + live share prompt
                //             Level 3 = user + TC + host + crew
                return [4 /*yield*/, (0, SafeReturnNotificationService_1.sendMissedCheckIn)(db, session)];
            case 5:
                // Escalation: Level 0 = notify only the user
                //             Level 1 = user + TC (if enabled)
                //             Level 2 = user + TC + live share prompt
                //             Level 3 = user + TC + host + crew
                _b.sent();
                if (!(session.escalationLevel >= 1)) return [3 /*break*/, 10];
                return [4 /*yield*/, (0, SafeReturnService_1.listContacts)(db, session.id, user.id)];
            case 6:
                contacts = _b.sent();
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_trusted_circle_alerts_enabled")];
            case 7:
                flagTcEnabled = _b.sent();
                if (!flagTcEnabled) return [3 /*break*/, 10];
                return [4 /*yield*/, (0, SafeReturnNotificationService_1.notifyTrustedCircle)(db, session, contacts)];
            case 8:
                _b.sent();
                // Mark contacts as notified
                return [4 /*yield*/, Promise.all(contacts.map(function (c) { return (0, SafeReturnService_1.markContactNotified)(db, c.id); }))];
            case 9:
                // Mark contacts as notified
                _b.sent();
                _b.label = 10;
            case 10:
                if (!(session.escalationLevel >= 3)) return [3 /*break*/, 13];
                return [4 /*yield*/, (0, SafeReturnNotificationService_1.notifyHost)(db, session)];
            case 11:
                _b.sent();
                return [4 /*yield*/, (0, SafeReturnNotificationService_1.notifyTripCrew)(db, session)];
            case 12:
                _b.sent();
                _b.label = 13;
            case 13:
                res.status(200).json({ ok: true, session: (0, SafeReturnPrivacyGuard_1.toPublicSession)(session), escalationLevel: session.escalationLevel });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions/:id/live-share/start ───────────────────
router.post("/me/safe-return/sessions/:id/live-share/start", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, session, schema, parsed, contact, share;
    var _a, _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_e.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_live_share_enabled")];
            case 3:
                if (!(_e.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Live location sharing is not yet enabled");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.getSessionById)(db, req.params.id, user.id)];
            case 4:
                session = _e.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "not_found", "Session not found");
                    return [2 /*return*/];
                }
                if (!session.liveShareEnabled) {
                    (0, http_1.sendError)(res, "forbidden", "Live share was not enabled for this session");
                    return [2 /*return*/];
                }
                schema = zod_1.z.object({
                    recipientContactId: zod_1.z.string().uuid(),
                    durationMinutes: zod_1.z.number().int().min(5).max(240).optional().default(60),
                });
                parsed = schema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "recipientContactId (uuid) is required");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, db
                        .from("safe_return_contacts")
                        .select("id, contact_user_id, can_receive_live_location")
                        .eq("id", parsed.data.recipientContactId)
                        .eq("session_id", session.id)
                        .maybeSingle()];
            case 5:
                contact = (_e.sent()).data;
                if (!contact) {
                    (0, http_1.sendError)(res, "not_found", "Contact not found on this session");
                    return [2 /*return*/];
                }
                if (!contact.can_receive_live_location) {
                    (0, http_1.sendError)(res, "forbidden", "This contact has not been granted live location access");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnLiveShareService_1.startShare)(db, session.id, user.id, (_d = contact.contact_user_id) !== null && _d !== void 0 ? _d : null, contact.id, parsed.data.durationMinutes)];
            case 6:
                share = _e.sent();
                if (!share) {
                    (0, http_1.sendError)(res, "db_error", "Failed to start live share");
                    return [2 /*return*/];
                }
                res.status(201).json({
                    ok: true,
                    share: {
                        id: share.id,
                        status: share.status,
                        startedAt: share.startedAt,
                        expiresAt: share.expiresAt,
                        // No GPS in response
                    },
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/me/safe-return/sessions/:id/live-share/stop ────────────────────
router.post("/me/safe-return/sessions/:id/live-share/stop", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, shareId, share;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_a = (0, supabase_1.getServiceClient)()) !== null && _a !== void 0 ? _a : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_c.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled");
                    return [2 /*return*/];
                }
                shareId = ((_b = req.body) !== null && _b !== void 0 ? _b : {}).shareId;
                if (!shareId || typeof shareId !== "string") {
                    (0, http_1.sendError)(res, "invalid_payload", "shareId is required");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnLiveShareService_1.stopShare)(db, shareId, user.id)];
            case 3:
                share = _c.sent();
                if (!share) {
                    (0, http_1.sendError)(res, "not_found", "Live share not found or already stopped");
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, share: { id: share.id, status: share.status, stoppedAt: share.stoppedAt } });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/safe-return/live-share/:shareId ──────────────────────────────────
// Recipient view — requireSafeReturnRecipient middleware enforces strict
// recipient-only access before the handler runs.
router.get("/safe-return/live-share/:shareId", SafeReturnPrivacyGuard_1.requireSafeReturnRecipient, function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var _a, db, callerUserId, shareId, result;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                _a = req.safeReturnRecipient, db = _a.db, callerUserId = _a.callerUserId;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 1:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Safe Return is not yet enabled");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_live_share_enabled")];
            case 2:
                if (!(_b.sent())) {
                    (0, http_1.sendError)(res, "feature_disabled", "Live location sharing is not yet enabled");
                    return [2 /*return*/];
                }
                shareId = req.safeReturnRecipient.shareId;
                return [4 /*yield*/, (0, SafeReturnLiveShareService_1.getRecipientView)(db, shareId, callerUserId)];
            case 3:
                result = _b.sent();
                if ("error" in result) {
                    if (result.error === "not_found") {
                        (0, http_1.sendError)(res, "not_found", "Live share not found");
                        return [2 /*return*/];
                    }
                    if (result.error === "expired") {
                        (0, http_1.sendError)(res, "not_found", "Live share has expired");
                        return [2 /*return*/];
                    }
                    if (result.error === "stopped") {
                        (0, http_1.sendError)(res, "not_found", "Live share has been stopped");
                        return [2 /*return*/];
                    }
                    if (result.error === "forbidden") {
                        (0, http_1.sendError)(res, "forbidden", "You are not authorized to view this share");
                        return [2 /*return*/];
                    }
                }
                if ("view" in result) {
                    res.status(200).json({ ok: true, share: result.view });
                    return [2 /*return*/];
                }
                (0, http_1.sendError)(res, "not_found");
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/safe-return/history ──────────────────────────────────────────
router.get("/me/safe-return/history", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, limit, sessions, sessionIds, eventsBySession, events, _i, _a, ev, sid, agg, t, _b;
    var _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_c = (0, supabase_1.getServiceClient)()) !== null && _c !== void 0 ? _c : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_f.sent())) {
                    res.status(200).json({ sessions: [], featureEnabled: false });
                    return [2 /*return*/];
                }
                limit = Math.min(50, parseInt(String((_d = req.query.limit) !== null && _d !== void 0 ? _d : "20"), 10) || 20);
                return [4 /*yield*/, (0, SafeReturnService_1.listHistory)(db, user.id, limit)];
            case 3:
                sessions = _f.sent();
                sessionIds = sessions.map(function (s) { return s.id; });
                eventsBySession = {};
                _f.label = 4;
            case 4:
                _f.trys.push([4, 7, , 8]);
                if (!(sessionIds.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, db
                        .from("safe_return_events")
                        .select("session_id, event_type")
                        .in("session_id", sessionIds)];
            case 5:
                events = (_f.sent()).data;
                for (_i = 0, _a = (_e = events) !== null && _e !== void 0 ? _e : []; _i < _a.length; _i++) {
                    ev = _a[_i];
                    sid = ev.session_id;
                    if (!eventsBySession[sid]) {
                        eventsBySession[sid] = { alertsSent: 0, missedCount: 0, liveShareStarted: 0, liveShareStopped: 0 };
                    }
                    agg = eventsBySession[sid];
                    t = ev.event_type;
                    // Count all alert-family events as "alertsSent" — trusted circle,
                    // host, and crew notifications are the actual alert event types;
                    // "alert_sent" is kept as an alias for any legacy rows.
                    if (t === "alert_sent" || t === "trusted_circle_notified" || t === "host_notified" || t === "crew_notified")
                        agg.alertsSent++;
                    if (t === "check_in_missed")
                        agg.missedCount++;
                    if (t === "live_share_started")
                        agg.liveShareStarted++;
                    if (t === "live_share_stopped" || t === "live_share_expired")
                        agg.liveShareStopped++;
                }
                _f.label = 6;
            case 6: return [3 /*break*/, 8];
            case 7:
                _b = _f.sent();
                return [3 /*break*/, 8];
            case 8:
                res.status(200).json({
                    sessions: sessions.map(function (s) {
                        var _a;
                        return (__assign(__assign({}, (0, SafeReturnPrivacyGuard_1.toPublicSession)(s)), { events: (_a = eventsBySession[s.id]) !== null && _a !== void 0 ? _a : { alertsSent: 0, missedCount: 0, liveShareStarted: 0, liveShareStopped: 0 } }));
                    }),
                });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/safe-return/trusted-contacts ──────────────────────────────────
// List the user's Trusted Circle members (for contact selection in setup)
router.get("/me/safe-return/trusted-contacts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, db, following, contacts, _a;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client;
                db = (_b = (0, supabase_1.getServiceClient)()) !== null && _b !== void 0 ? _b : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_d.sent())) {
                    res.status(200).json({ contacts: [], featureEnabled: false });
                    return [2 /*return*/];
                }
                _d.label = 3;
            case 3:
                _d.trys.push([3, 5, , 6]);
                return [4 /*yield*/, client
                        .from("follows")
                        .select("followee_id, profiles!follows_followee_id_fkey(id, display_name, handle, avatar_url)")
                        .eq("follower_id", auth.user.id)];
            case 4:
                following = (_d.sent()).data;
                contacts = ((_c = following) !== null && _c !== void 0 ? _c : []).map(function (f) {
                    var _a, _b, _c, _d, _e, _f;
                    return ({
                        userId: f.followee_id,
                        displayName: (_b = (_a = f.profiles) === null || _a === void 0 ? void 0 : _a.display_name) !== null && _b !== void 0 ? _b : null,
                        handle: (_d = (_c = f.profiles) === null || _c === void 0 ? void 0 : _c.handle) !== null && _d !== void 0 ? _d : null,
                        avatarUrl: (_f = (_e = f.profiles) === null || _e === void 0 ? void 0 : _e.avatar_url) !== null && _f !== void 0 ? _f : null,
                    });
                });
                res.status(200).json({ contacts: contacts });
                return [3 /*break*/, 6];
            case 5:
                _a = _d.sent();
                res.status(200).json({ contacts: [] });
                return [3 /*break*/, 6];
            case 6: return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/safe-return/sessions/:id/contacts ─────────────────────────────
// List contacts attached to a session (supports "Share Location Now" picker)
router.get("/me/safe-return/sessions/:id/contacts", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, db, session, rows, contacts, _a;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                db = (_b = (0, supabase_1.getServiceClient)()) !== null && _b !== void 0 ? _b : client;
                return [4 /*yield*/, isFlagEnabled(db, "safe_return_enabled")];
            case 2:
                if (!(_d.sent())) {
                    res.status(200).json({ contacts: [], featureEnabled: false });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, SafeReturnService_1.getSessionById)(db, req.params.id, user.id)];
            case 3:
                session = _d.sent();
                if (!session) {
                    (0, http_1.sendError)(res, "not_found", "Session not found");
                    return [2 /*return*/];
                }
                _d.label = 4;
            case 4:
                _d.trys.push([4, 6, , 7]);
                return [4 /*yield*/, db
                        .from("safe_return_contacts")
                        .select("id, contact_user_id, contact_name, can_receive_live_location")
                        .eq("session_id", session.id)];
            case 5:
                rows = (_d.sent()).data;
                contacts = ((_c = rows) !== null && _c !== void 0 ? _c : []).map(function (r) {
                    var _a, _b;
                    return ({
                        id: r.id,
                        contactUserId: (_a = r.contact_user_id) !== null && _a !== void 0 ? _a : null,
                        contactName: (_b = r.contact_name) !== null && _b !== void 0 ? _b : null,
                        canReceiveLiveLocation: !!r.can_receive_live_location,
                    });
                });
                res.status(200).json({ ok: true, contacts: contacts });
                return [3 /*break*/, 7];
            case 6:
                _a = _d.sent();
                res.status(200).json({ ok: true, contacts: [] });
                return [3 /*break*/, 7];
            case 7: return [2 /*return*/];
        }
    });
}); });
exports.default = router;
