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
 * Telegraph Feedback Routes
 *
 * POST /api/telegraph/recommendations/:id/feedback
 *   Records a preference signal for a recommendation and updates
 *   the user's inferred preference profile.
 *
 * Signals: more_like_this | less_like_this | not_for_me | save | dismiss
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
var FeedbackSchema = zod_1.z.object({
    category: zod_1.z.string().min(1).max(80),
    signal: zod_1.z.enum(VALID_SIGNALS),
    tripId: zod_1.z.string().optional().nullable(),
});
function getOrCreateInferred(client, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, blank, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, client
                        .from("user_preference_profiles")
                        .select("inferred_preferences_json")
                        .eq("user_id", userId)
                        .maybeSingle()];
                case 1:
                    data = (_b.sent()).data;
                    if (data) {
                        try {
                            return [2 /*return*/, JSON.parse(data.inferred_preferences_json)];
                        }
                        catch (_c) {
                            return [2 /*return*/, (0, preferenceLearning_js_1.defaultInferred)()];
                        }
                    }
                    blank = { user_id: userId, explicit_preferences_json: JSON.stringify((0, preferenceLearning_js_1.defaultExplicit)()), inferred_preferences_json: JSON.stringify((0, preferenceLearning_js_1.defaultInferred)()) };
                    _b.label = 2;
                case 2:
                    _b.trys.push([2, 4, , 5]);
                    return [4 /*yield*/, client.from("user_preference_profiles").insert(blank)];
                case 3:
                    _b.sent();
                    return [3 /*break*/, 5];
                case 4:
                    _a = _b.sent();
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/, (0, preferenceLearning_js_1.defaultInferred)()];
            }
        });
    });
}
/* ===========================================================================
 * POST /telegraph/recommendations/:id/feedback
 * ===========================================================================
 */
router.post("/telegraph/recommendations/:id/feedback", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, recommendationId, parsed, _a, category, signal, tripId, now, _b, inferred, updated;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                recommendationId = req.params.id;
                parsed = FeedbackSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid body");
                    return [2 /*return*/];
                }
                _a = parsed.data, category = _a.category, signal = _a.signal, tripId = _a.tripId;
                now = new Date().toISOString();
                _e.label = 2;
            case 2:
                _e.trys.push([2, 4, , 5]);
                return [4 /*yield*/, client.from("user_preference_events").insert({
                        user_id: user.id,
                        recommendation_id: recommendationId,
                        category: category,
                        signal: signal,
                        trip_id: tripId !== null && tripId !== void 0 ? tripId : null,
                        created_at: now,
                    })];
            case 3:
                _e.sent();
                return [3 /*break*/, 5];
            case 4:
                _b = _e.sent();
                return [3 /*break*/, 5];
            case 5: return [4 /*yield*/, getOrCreateInferred(client, user.id)];
            case 6:
                inferred = _e.sent();
                updated = (0, preferenceLearning_js_1.applyEvent)(inferred, {
                    userId: user.id,
                    recommendationId: recommendationId,
                    category: category,
                    signal: signal,
                    createdAt: now,
                    tripId: tripId,
                });
                return [4 /*yield*/, client.from("user_preference_profiles").update({
                        inferred_preferences_json: JSON.stringify(updated),
                        updated_at: now,
                    }).eq("user_id", user.id)];
            case 7:
                _e.sent();
                res.status(201).json({ ok: true, signal: signal, category: category, recommendationId: recommendationId });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
