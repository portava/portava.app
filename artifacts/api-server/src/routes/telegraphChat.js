"use strict";
/**
 * Telegraph Chat Suggestion routes.
 *
 * GET  /api/threads/:threadId/telegraph/suggestions
 *   Returns active, non-expired suggestions for the authed user in a thread.
 *   Accepts optional ?message=<text> to run live intent detection and persist
 *   new suggestions.
 *
 * POST /api/threads/:threadId/telegraph/suggestions/:id/dismiss
 * POST /api/threads/:threadId/telegraph/suggestions/:id/add-to-plan
 * POST /api/threads/:threadId/telegraph/suggestions/:id/create-meetup
 * POST /api/threads/:threadId/telegraph/suggestions/:id/start-poll
 *
 * PATCH /api/me/telegraph-chat-settings
 *   { show_telegraph_dm?, show_telegraph_trip?, show_telegraph_circle? }
 *
 * Privacy guarantees:
 *   - Thread membership is verified on every call.
 *   - TelegraphChatPrivacyVerdict gates all suggestion generation.
 *   - No GPS or live location is ever returned.
 *   - Trip/circle context is only used when the caller is a confirmed member.
 */
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
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var telegraphIntent_js_1 = require("../services/telegraphIntent.js");
var telegraphChatSuggestions_js_1 = require("../services/telegraphChatSuggestions.js");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
// ── helpers ──────────────────────────────────────────────────────────────────
function verifyThreadMember(client, threadId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client
                        .from("message_thread_members")
                        .select("user_id, left_at")
                        .eq("thread_id", threadId)
                        .eq("user_id", userId)
                        .maybeSingle()];
                case 1:
                    data = (_a.sent()).data;
                    if (!data)
                        return [2 /*return*/, false];
                    return [2 /*return*/, data.left_at === null];
            }
        });
    });
}
// ── GET /api/threads/:threadId/telegraph/suggestions ─────────────────────────
router.get("/threads/:threadId/telegraph/suggestions", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, threadId, isMember, messageText, intent, verdict_1, withinLimit, notInCooldown, allCards, cards, _i, allCards_1, card, categoryOk, rows, suggestions;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                threadId = req.params.threadId;
                if (!UUID.test(threadId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid threadId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, verifyThreadMember(client, threadId, user.id)];
            case 2:
                isMember = _a.sent();
                if (!isMember) {
                    (0, http_js_1.sendError)(res, "forbidden", "You are not an active member of this thread");
                    return [2 /*return*/];
                }
                messageText = typeof req.query.message === "string" ? req.query.message : null;
                if (!(messageText && messageText.trim().length >= 6)) return [3 /*break*/, 11];
                intent = (0, telegraphIntent_js_1.detectIntent)(messageText);
                if (!intent) return [3 /*break*/, 11];
                return [4 /*yield*/, (0, telegraphChatSuggestions_js_1.resolvePrivacyVerdict)(client, user.id, threadId)];
            case 3:
                verdict_1 = _a.sent();
                if (!verdict_1.canShowRecommendation) return [3 /*break*/, 11];
                return [4 /*yield*/, (0, telegraphChatSuggestions_js_1.checkRateLimit)(client, user.id, threadId)];
            case 4:
                withinLimit = _a.sent();
                return [4 /*yield*/, (0, telegraphChatSuggestions_js_1.checkCooldown)(client, user.id, threadId, intent.intent)];
            case 5:
                notInCooldown = _a.sent();
                if (!(withinLimit && notInCooldown)) return [3 /*break*/, 11];
                allCards = (0, telegraphChatSuggestions_js_1.buildSuggestions)(user.id, threadId, intent, verdict_1);
                cards = [];
                _i = 0, allCards_1 = allCards;
                _a.label = 6;
            case 6:
                if (!(_i < allCards_1.length)) return [3 /*break*/, 9];
                card = allCards_1[_i];
                return [4 /*yield*/, (0, telegraphChatSuggestions_js_1.checkCategoryDeclineCooldown)(client, user.id, card.category)];
            case 7:
                categoryOk = _a.sent();
                if (categoryOk)
                    cards.push(card);
                _a.label = 8;
            case 8:
                _i++;
                return [3 /*break*/, 6];
            case 9:
                if (!(cards.length > 0)) return [3 /*break*/, 11];
                rows = cards.map(function (c) {
                    var _a, _b, _c, _d;
                    return ({
                        thread_id: threadId,
                        user_id: user.id,
                        trip_id: (_a = verdict_1.tripId) !== null && _a !== void 0 ? _a : null,
                        circle_id: (_b = verdict_1.circleOwnerId) !== null && _b !== void 0 ? _b : null,
                        intent_type: c.intent_type,
                        title: c.title,
                        reason: c.reason,
                        category: c.category,
                        action_type: c.action_type,
                        location_context: (_c = c.location_context) !== null && _c !== void 0 ? _c : null,
                        time_context: (_d = c.time_context) !== null && _d !== void 0 ? _d : null,
                        status: "shown",
                    });
                });
                return [4 /*yield*/, client.from("telegraph_chat_suggestions").insert(rows)];
            case 10:
                _a.sent();
                _a.label = 11;
            case 11: return [4 /*yield*/, client
                    .from("telegraph_chat_suggestions")
                    .select("id, intent_type, title, reason, category, action_type, location_context, time_context, created_at, expires_at")
                    .eq("user_id", user.id)
                    .eq("thread_id", threadId)
                    .eq("status", "shown")
                    .gt("expires_at", new Date().toISOString())
                    .order("created_at", { ascending: false })
                    .limit(2)];
            case 12:
                suggestions = (_a.sent()).data;
                res.status(200).json({ suggestions: suggestions !== null && suggestions !== void 0 ? suggestions : [] });
                return [2 /*return*/];
        }
    });
}); });
// ── POST .../dismiss ──────────────────────────────────────────────────────────
router.post("/threads/:threadId/telegraph/suggestions/:suggestionId/dismiss", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, threadId, suggestionId, isMember, suggestion, error, _b;
    var _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                _a = req.params, threadId = _a.threadId, suggestionId = _a.suggestionId;
                if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, verifyThreadMember(client, threadId, user.id)];
            case 2:
                isMember = _d.sent();
                if (!isMember) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a thread member");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .select("category, intent_type")
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)
                        .eq("thread_id", threadId)
                        .maybeSingle()];
            case 3:
                suggestion = (_d.sent()).data;
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)
                        .eq("thread_id", threadId)];
            case 4:
                error = (_d.sent()).error;
                if (error) {
                    (0, http_js_1.sendError)(res, "db_error", "Failed to dismiss suggestion");
                    return [2 /*return*/];
                }
                if (!suggestion) return [3 /*break*/, 8];
                _d.label = 5;
            case 5:
                _d.trys.push([5, 7, , 8]);
                return [4 /*yield*/, client.from("user_preference_events").insert({
                        user_id: user.id,
                        recommendation_id: suggestionId,
                        category: (_c = suggestion.category) !== null && _c !== void 0 ? _c : "unknown",
                        signal: "dismiss",
                        created_at: new Date().toISOString(),
                    })];
            case 6:
                _d.sent();
                return [3 /*break*/, 8];
            case 7:
                _b = _d.sent();
                return [3 /*break*/, 8];
            case 8:
                res.status(200).json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
// ── POST .../add-to-plan ──────────────────────────────────────────────────────
var AddToPlanSchema = zod_1.z.object({
    tripId: zod_1.z.string().regex(UUID, "tripId must be a valid UUID"),
    title: zod_1.z.string().max(200).optional(),
    dayDate: zod_1.z.string().optional(),
    startsAt: zod_1.z.string().optional(),
});
router.post("/threads/:threadId/telegraph/suggestions/:suggestionId/add-to-plan", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, threadId, suggestionId, isMember, parsed, _b, tripId, title, dayDate, startsAt, membership, suggestion, itemTitle, _c, planItem, planErr;
    var _d, _e, _f, _g;
    return __generator(this, function (_h) {
        switch (_h.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _h.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                _a = req.params, threadId = _a.threadId, suggestionId = _a.suggestionId;
                if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, verifyThreadMember(client, threadId, user.id)];
            case 2:
                isMember = _h.sent();
                if (!isMember) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a thread member");
                    return [2 /*return*/];
                }
                parsed = AddToPlanSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_e = (_d = parsed.error.issues[0]) === null || _d === void 0 ? void 0 : _d.message) !== null && _e !== void 0 ? _e : "Invalid payload");
                    return [2 /*return*/];
                }
                _b = parsed.data, tripId = _b.tripId, title = _b.title, dayDate = _b.dayDate, startsAt = _b.startsAt;
                return [4 /*yield*/, client
                        .from("trip_members")
                        .select("role")
                        .eq("trip_id", tripId)
                        .eq("user_id", user.id)
                        .in("role", ["owner", "member"])
                        .maybeSingle()];
            case 3:
                membership = (_h.sent()).data;
                if (!membership) {
                    (0, http_js_1.sendError)(res, "forbidden", "You are not an accepted member of that trip");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .select("id, title, location_context, time_context")
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 4:
                suggestion = (_h.sent()).data;
                if (!suggestion) {
                    (0, http_js_1.sendError)(res, "not_found", "Suggestion not found");
                    return [2 /*return*/];
                }
                itemTitle = (_f = title !== null && title !== void 0 ? title : suggestion.title) !== null && _f !== void 0 ? _f : "Telegraph suggestion";
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .insert({
                        trip_id: tripId,
                        creator_id: user.id,
                        title: itemTitle,
                        source_type: "telegraph",
                        source_id: suggestionId,
                        day_date: dayDate !== null && dayDate !== void 0 ? dayDate : null,
                        starts_at: startsAt !== null && startsAt !== void 0 ? startsAt : null,
                        notes: (_g = suggestion.location_context) !== null && _g !== void 0 ? _g : null,
                    })
                        .select("id, title")
                        .single()];
            case 5:
                _c = _h.sent(), planItem = _c.data, planErr = _c.error;
                if (planErr) {
                    (0, http_js_1.sendError)(res, "db_error", "Failed to add to plan");
                    return [2 /*return*/];
                }
                // Mark suggestion as acted
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .update({ status: "acted", acted_on_at: new Date().toISOString() })
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)];
            case 6:
                // Mark suggestion as acted
                _h.sent();
                res.status(200).json({ ok: true, planItem: planItem });
                return [2 /*return*/];
        }
    });
}); });
// ── POST .../create-meetup ────────────────────────────────────────────────────
router.post("/threads/:threadId/telegraph/suggestions/:suggestionId/create-meetup", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, threadId, suggestionId, isMember, suggestion, prefill;
    var _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                _a = req.params, threadId = _a.threadId, suggestionId = _a.suggestionId;
                if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, verifyThreadMember(client, threadId, user.id)];
            case 2:
                isMember = _f.sent();
                if (!isMember) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a thread member");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .select("id, title, location_context, time_context, trip_id, circle_id")
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 3:
                suggestion = (_f.sent()).data;
                if (!suggestion) {
                    (0, http_js_1.sendError)(res, "not_found", "Suggestion not found");
                    return [2 /*return*/];
                }
                prefill = {
                    title: (_b = suggestion.title) !== null && _b !== void 0 ? _b : "",
                    location: (_c = suggestion.location_context) !== null && _c !== void 0 ? _c : "",
                    suggestedTime: (_d = suggestion.time_context) !== null && _d !== void 0 ? _d : null,
                    tripId: (_e = suggestion.trip_id) !== null && _e !== void 0 ? _e : null,
                    threadId: threadId,
                };
                // Mark as acted
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .update({ status: "acted", acted_on_at: new Date().toISOString() })
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)];
            case 4:
                // Mark as acted
                _f.sent();
                res.status(200).json({ ok: true, prefill: prefill });
                return [2 /*return*/];
        }
    });
}); });
// ── POST .../start-poll ───────────────────────────────────────────────────────
var StartPollSchema = zod_1.z.object({
    options: zod_1.z
        .array(zod_1.z.string().max(100))
        .min(2)
        .max(6)
        .default(["Morning", "Afternoon", "Evening"]),
    question: zod_1.z.string().max(200).optional(),
});
router.post("/threads/:threadId/telegraph/suggestions/:suggestionId/start-poll", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, threadId, suggestionId, isMember, parsed, _b, options, question, suggestion, pollBody, _c, msg, msgErr;
    var _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _g.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                _a = req.params, threadId = _a.threadId, suggestionId = _a.suggestionId;
                if (!UUID.test(threadId) || !UUID.test(suggestionId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, verifyThreadMember(client, threadId, user.id)];
            case 2:
                isMember = _g.sent();
                if (!isMember) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a thread member");
                    return [2 /*return*/];
                }
                parsed = StartPollSchema.safeParse((_d = req.body) !== null && _d !== void 0 ? _d : {});
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_f = (_e = parsed.error.issues[0]) === null || _e === void 0 ? void 0 : _e.message) !== null && _f !== void 0 ? _f : "Invalid payload");
                    return [2 /*return*/];
                }
                _b = parsed.data, options = _b.options, question = _b.question;
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .select("id, title")
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 3:
                suggestion = (_g.sent()).data;
                if (!suggestion) {
                    (0, http_js_1.sendError)(res, "not_found", "Suggestion not found");
                    return [2 /*return*/];
                }
                pollBody = JSON.stringify({
                    type: "time_poll",
                    question: question !== null && question !== void 0 ? question : "When works for everyone? (".concat(suggestion.title, ")"),
                    options: options,
                    votes: {},
                    createdBy: user.id,
                });
                return [4 /*yield*/, client
                        .from("messages")
                        .insert({
                        thread_id: threadId,
                        sender_id: user.id,
                        body: pollBody,
                    })
                        .select("id")
                        .single()];
            case 4:
                _c = _g.sent(), msg = _c.data, msgErr = _c.error;
                if (msgErr) {
                    (0, http_js_1.sendError)(res, "db_error", "Failed to create poll");
                    return [2 /*return*/];
                }
                // Mark suggestion as acted
                return [4 /*yield*/, client
                        .from("telegraph_chat_suggestions")
                        .update({ status: "acted", acted_on_at: new Date().toISOString() })
                        .eq("id", suggestionId)
                        .eq("user_id", user.id)];
            case 5:
                // Mark suggestion as acted
                _g.sent();
                res.status(200).json({ ok: true, messageId: msg.id, options: options });
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /api/me/telegraph-chat-settings ────────────────────────────────────
var SettingsSchema = zod_1.z.object({
    show_telegraph_dm: zod_1.z.boolean().optional(),
    show_telegraph_trip: zod_1.z.boolean().optional(),
    show_telegraph_circle: zod_1.z.boolean().optional(),
});
router.patch("/me/telegraph-chat-settings", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, error;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = SettingsSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "Invalid payload");
                    return [2 /*return*/];
                }
                if (Object.keys(parsed.data).length === 0) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "At least one setting is required");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("profiles")
                        .update(parsed.data)
                        .eq("id", user.id)];
            case 2:
                error = (_c.sent()).error;
                if (error) {
                    (0, http_js_1.sendError)(res, "db_error", "Failed to update Telegraph settings");
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, settings: parsed.data });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
