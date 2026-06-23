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
 * User Preference Routes
 *
 * GET    /api/me/preferences           — fetch full preference profile
 * PATCH  /api/me/preferences           — update explicit preferences
 * POST   /api/me/preferences/events    — record a preference signal event
 * POST   /api/me/preferences/reset-learned — clear inferred_preferences_json only
 * GET    /api/me/preferences/summary   — lightweight summary for UI
 *
 * All routes resolve identity from auth token only — never from request body.
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var preferenceLearning_js_1 = require("../lib/preferenceLearning.js");
var router = (0, express_1.Router)();
var VALID_SIGNALS = [
    "save", "add_to_plan", "more_like_this", "less_like_this",
    "not_for_me", "dismiss", "view", "share",
];
var VALID_PACES = ["relaxed", "balanced", "packed"];
var VALID_GROUPS = ["solo", "small", "group", "mixed"];
var VALID_TIMES = ["morning", "afternoon", "evening", "late_night"];
var PatchPreferencesSchema = zod_1.z.object({
    interests: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
    foodPreferences: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
    nightlifePreferences: zod_1.z.array(zod_1.z.string().max(50)).max(20).optional(),
    pace: zod_1.z.enum(VALID_PACES).optional(),
    groupStyle: zod_1.z.enum(VALID_GROUPS).optional(),
    preferredActivityTimes: zod_1.z.array(zod_1.z.enum(VALID_TIMES)).max(4).optional(),
    avoidList: zod_1.z.array(zod_1.z.string().max(50)).max(30).optional(),
});
var PreferenceEventSchema = zod_1.z.object({
    recommendationId: zod_1.z.string().min(1).max(120),
    category: zod_1.z.string().min(1).max(80),
    signal: zod_1.z.enum(VALID_SIGNALS),
    tripId: zod_1.z.string().optional().nullable(),
});
/* ── helpers ── */
function getOrCreateProfile(client, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error, blank, created;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, client
                        .from("user_preference_profiles")
                        .select("*")
                        .eq("user_id", userId)
                        .maybeSingle()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error)
                        return [2 /*return*/, null];
                    if (data)
                        return [2 /*return*/, data];
                    blank = {
                        user_id: userId,
                        explicit_preferences_json: JSON.stringify((0, preferenceLearning_js_1.defaultExplicit)()),
                        inferred_preferences_json: JSON.stringify((0, preferenceLearning_js_1.defaultInferred)()),
                    };
                    return [4 /*yield*/, client
                            .from("user_preference_profiles")
                            .insert(blank)
                            .select("*")
                            .single()];
                case 2:
                    created = (_b.sent()).data;
                    return [2 /*return*/, created !== null && created !== void 0 ? created : null];
            }
        });
    });
}
function parseProfile(row) {
    var _a;
    var explicit = (function () { try {
        return JSON.parse(row.explicit_preferences_json);
    }
    catch (_a) {
        return (0, preferenceLearning_js_1.defaultExplicit)();
    } })();
    var inferred = (function () { try {
        return JSON.parse(row.inferred_preferences_json);
    }
    catch (_a) {
        return (0, preferenceLearning_js_1.defaultInferred)();
    } })();
    return { userId: row.user_id, explicit: explicit, inferred: inferred, lastUpdatedAt: (_a = row.updated_at) !== null && _a !== void 0 ? _a : row.created_at };
}
/* ===========================================================================
 * GET /me/preferences
 * ===========================================================================
 */
router.get("/me/preferences", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, row;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                return [4 /*yield*/, getOrCreateProfile(client, user.id)];
            case 2:
                row = _a.sent();
                if (!row) {
                    (0, http_js_1.sendError)(res, "db_error", "Could not load preference profile");
                    return [2 /*return*/];
                }
                res.json(parseProfile(row));
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * PATCH /me/preferences
 * ===========================================================================
 */
router.patch("/me/preferences", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, patch, row, current, merged, error;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = PatchPreferencesSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "Invalid body");
                    return [2 /*return*/];
                }
                patch = parsed.data;
                return [4 /*yield*/, getOrCreateProfile(client, user.id)];
            case 2:
                row = _c.sent();
                if (!row) {
                    (0, http_js_1.sendError)(res, "db_error", "Could not load preference profile");
                    return [2 /*return*/];
                }
                current = (function () { try {
                    return JSON.parse(row.explicit_preferences_json);
                }
                catch (_a) {
                    return (0, preferenceLearning_js_1.defaultExplicit)();
                } })();
                merged = __assign(__assign({}, current), patch);
                return [4 /*yield*/, client
                        .from("user_preference_profiles")
                        .update({
                        explicit_preferences_json: JSON.stringify(merged),
                        updated_at: new Date().toISOString(),
                    })
                        .eq("user_id", user.id)];
            case 3:
                error = (_c.sent()).error;
                if (error) {
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ ok: true, explicit: merged });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /me/preferences/events
 * ===========================================================================
 */
router.post("/me/preferences/events", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, _a, recommendationId, category, signal, tripId, now, evtError, row, inferred, updated;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = PreferenceEventSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                _a = parsed.data, recommendationId = _a.recommendationId, category = _a.category, signal = _a.signal, tripId = _a.tripId;
                now = new Date().toISOString();
                return [4 /*yield*/, client
                        .from("user_preference_events")
                        .insert({
                        user_id: user.id,
                        recommendation_id: recommendationId,
                        category: category,
                        signal: signal,
                        trip_id: tripId !== null && tripId !== void 0 ? tripId : null,
                        created_at: now,
                    })];
            case 2:
                evtError = (_d.sent()).error;
                if (evtError) {
                    req.log.warn({ err: evtError }, "Failed to insert preference event");
                }
                return [4 /*yield*/, getOrCreateProfile(client, user.id)];
            case 3:
                row = _d.sent();
                if (!row) return [3 /*break*/, 5];
                inferred = (function () { try {
                    return JSON.parse(row.inferred_preferences_json);
                }
                catch (_a) {
                    return (0, preferenceLearning_js_1.defaultInferred)();
                } })();
                updated = (0, preferenceLearning_js_1.applyEvent)(inferred, { userId: user.id, recommendationId: recommendationId, category: category, signal: signal, createdAt: now, tripId: tripId });
                return [4 /*yield*/, client
                        .from("user_preference_profiles")
                        .update({ inferred_preferences_json: JSON.stringify(updated), updated_at: now })
                        .eq("user_id", user.id)];
            case 4:
                _d.sent();
                _d.label = 5;
            case 5:
                res.status(201).json({ ok: true, signal: signal, category: category });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /me/preferences/reset-learned
 * ===========================================================================
 */
router.post("/me/preferences/reset-learned", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, blank, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                blank = JSON.stringify((0, preferenceLearning_js_1.defaultInferred)());
                return [4 /*yield*/, client
                        .from("user_preference_profiles")
                        .update({ inferred_preferences_json: blank, updated_at: new Date().toISOString() })
                        .eq("user_id", user.id)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                // Events are retained for analytics; only the computed inferred profile is cleared.
                res.json({ ok: true, reset: "learned_preferences" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/preferences/summary
 * ===========================================================================
 */
router.get("/me/preferences/summary", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, row, profile, topCategories;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                return [4 /*yield*/, getOrCreateProfile(client, user.id)];
            case 2:
                row = _a.sent();
                if (!row) {
                    (0, http_js_1.sendError)(res, "db_error", "Could not load preference profile");
                    return [2 /*return*/];
                }
                profile = parseProfile(row);
                topCategories = Object.entries(profile.inferred.categoryAffinities)
                    .sort(function (_a, _b) {
                    var a = _a[1];
                    var b = _b[1];
                    return b - a;
                })
                    .slice(0, 5)
                    .map(function (_a) {
                    var cat = _a[0], score = _a[1];
                    return ({ category: cat, score: Math.round(score * 100) / 100 });
                });
                res.json({
                    interests: profile.explicit.interests,
                    pace: profile.explicit.pace,
                    groupStyle: profile.explicit.groupStyle,
                    avoidList: profile.explicit.avoidList,
                    topInferred: topCategories,
                    lastUpdatedAt: profile.lastUpdatedAt,
                });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
