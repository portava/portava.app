"use strict";
/**
 * Messaging routes
 *
 * GET  /api/me/message-settings
 * PATCH /api/me/message-settings
 * GET  /api/me/language-settings
 * PATCH /api/me/language-settings
 * GET  /api/users/:userId/message-permission
 * POST /api/users/:userId/message-request
 * GET  /api/me/message-requests
 * POST /api/message-requests/:requestId/accept
 * POST /api/message-requests/:requestId/decline
 * POST /api/message-requests/:requestId/cancel
 * POST /api/users/:userId/open-thread
 * GET  /api/me/threads
 * GET  /api/threads/:threadId/messages
 * POST /api/threads/:threadId/messages
 * POST /api/messages/:messageId/translate/retry
 *
 * Privacy guarantee: no private posts, trips, live location, exact GPS,
 * circle memberships, or trip memberships are exposed through any of these
 * endpoints. Thread access is gated ONLY by message_thread_members rows.
 */
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
var express_1 = require("express");
var zod_1 = require("zod");
var http_1 = require("../lib/http");
var messagingPermissions_1 = require("../lib/messagingPermissions");
var supabase_1 = require("../lib/supabase");
var followDecisions_1 = require("../lib/followDecisions");
var messageTranslation_1 = require("../services/messageTranslation");
var groupChatSync_1 = require("../services/groupChatSync");
var telegraphEvents_1 = require("../lib/telegraphEvents");
var router = (0, express_1.Router)();
var PROFILE_PUBLIC = 'id, handle, name, avatar_url';
var MESSAGE_PRIVACY_VALUES = [
    'everyone',
    'followers',
    'following',
    'friends',
    'trip_members',
    'no_one',
];
var LANGUAGE_CODES = [
    'en', 'es', 'fr', 'de', 'ja', 'ko', 'zh', 'pt', 'it', 'ru',
    'ar', 'th', 'vi', 'id', 'tl', 'sv', 'nl', 'pl', 'tr', 'hi',
];
var MessageSettingsPatchSchema = zod_1.z.object({
    message_privacy: zod_1.z.enum(MESSAGE_PRIVACY_VALUES).optional(),
    allow_message_requests: zod_1.z.boolean().optional(),
    allow_trip_member_messages: zod_1.z.boolean().optional(),
    allow_circle_member_messages: zod_1.z.boolean().optional(),
});
var LanguageSettingsPatchSchema = zod_1.z.object({
    preferred_message_language: zod_1.z.enum(LANGUAGE_CODES).optional(),
    preferred_language: zod_1.z.enum(LANGUAGE_CODES).nullable().optional(),
    auto_translate_messages: zod_1.z.boolean().optional(),
    show_original_messages: zod_1.z.boolean().optional(),
});
/* ---------------------------------------------------------------------------
 * GET /api/me/message-settings
 * ---------------------------------------------------------------------------
 */
router.get('/me/message-settings', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                return [4 /*yield*/, client
                        .from('user_message_settings')
                        .select('message_privacy, allow_message_requests, allow_trip_member_messages, allow_circle_member_messages, updated_at')
                        .eq('user_id', user.id)
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'message settings select failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json(data !== null && data !== void 0 ? data : {
                    message_privacy: 'everyone',
                    allow_message_requests: true,
                    allow_trip_member_messages: true,
                    allow_circle_member_messages: true,
                    updated_at: null,
                });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * PATCH /api/me/message-settings
 * ---------------------------------------------------------------------------
 */
router.patch('/me/message-settings', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, patch, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = MessageSettingsPatchSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, 'invalid_payload', parsed.error.issues.map(function (i) { return i.message; }).join('; '));
                    return [2 /*return*/];
                }
                patch = __assign(__assign({}, parsed.data), { user_id: user.id, updated_at: new Date().toISOString() });
                return [4 /*yield*/, client
                        .from('user_message_settings')
                        .upsert(patch, { onConflict: 'user_id' })
                        .select('message_privacy, allow_message_requests, allow_trip_member_messages, allow_circle_member_messages, updated_at')
                        .single()];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'message settings upsert failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json(data);
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/me/language-settings
 * ---------------------------------------------------------------------------
 * Returns the current user's translation / language preferences.
 */
router.get('/me/language-settings', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, data, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                return [4 /*yield*/, client
                        .from('profiles')
                        .select('preferred_message_language, preferred_language, auto_translate_messages, show_original_messages, translation_updated_at')
                        .eq('id', user.id)
                        .maybeSingle()];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'language settings select failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json(data !== null && data !== void 0 ? data : {
                    preferred_message_language: 'en',
                    preferred_language: null,
                    auto_translate_messages: true,
                    show_original_messages: false,
                    translation_updated_at: null,
                });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * PATCH /api/me/language-settings
 * ---------------------------------------------------------------------------
 */
router.patch('/me/language-settings', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, patch, before, _a, data, error, newLang, oldLang, sc;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = LanguageSettingsPatchSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_1.sendError)(res, 'invalid_payload', parsed.error.issues.map(function (i) { return i.message; }).join('; '));
                    return [2 /*return*/];
                }
                patch = __assign(__assign({}, parsed.data), { translation_updated_at: new Date().toISOString() });
                return [4 /*yield*/, client
                        .from('profiles')
                        .select('preferred_language')
                        .eq('id', user.id)
                        .single()];
            case 2:
                before = (_b.sent()).data;
                return [4 /*yield*/, client
                        .from('profiles')
                        .update(patch)
                        .eq('id', user.id)
                        .select('preferred_message_language, preferred_language, auto_translate_messages, show_original_messages, translation_updated_at')
                        .single()];
            case 3:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'language settings update failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                newLang = data.preferred_language;
                oldLang = before === null || before === void 0 ? void 0 : before.preferred_language;
                if (newLang && newLang !== oldLang) {
                    sc = (0, supabase_1.getServiceClient)();
                    if (sc) {
                        (0, messageTranslation_1.retranslateForUser)(sc, user.id, newLang, req.log).catch(function () { });
                    }
                }
                res.status(200).json(data);
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/users/:userId/message-permission
 * ---------------------------------------------------------------------------
 */
router.get('/users/:userId/message-permission', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, targetId, sc, verdict;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                targetId = req.params.userId;
                if (!(0, followDecisions_1.isUuid)(targetId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid user id');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, user.id, targetId)];
            case 2:
                verdict = _b.sent();
                res.status(200).json({
                    verdict: verdict.verdict,
                    allowed: verdict.allowed,
                    reason: (_a = verdict.reason) !== null && _a !== void 0 ? _a : null,
                    relationship_context: verdict.relationship_context,
                });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/users/:userId/open-thread
 * ---------------------------------------------------------------------------
 */
router.post('/users/:userId/open-thread', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, recipientId, sc, verdict, myMemberships, myThreadIds, existingThreadId, allMembers, membersByThread, _i, _a, m, _b, _c, _d, threadId_1, members, now, _e, thread, tErr, threadId;
    var _f, _g;
    return __generator(this, function (_h) {
        switch (_h.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _h.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                recipientId = req.params.userId;
                if (!(0, followDecisions_1.isUuid)(recipientId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid user id');
                    return [2 /*return*/];
                }
                if (recipientId === user.id) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Cannot open a thread with yourself');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, user.id, recipientId)];
            case 2:
                verdict = _h.sent();
                if (verdict.verdict === 'denied') {
                    (0, http_1.sendError)(res, 'forbidden', "Cannot message this user: ".concat((_f = verdict.reason) !== null && _f !== void 0 ? _f : 'denied'));
                    return [2 /*return*/];
                }
                if (verdict.verdict === 'requires_request') {
                    (0, http_1.sendError)(res, 'forbidden', 'This user requires a message request first. Use POST /api/users/:userId/message-request.');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .select('thread_id')
                        .eq('user_id', user.id)];
            case 3:
                myMemberships = (_h.sent()).data;
                myThreadIds = (myMemberships !== null && myMemberships !== void 0 ? myMemberships : []).map(function (m) { return m.thread_id; });
                existingThreadId = null;
                if (!(myThreadIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .select('thread_id, user_id')
                        .in('thread_id', myThreadIds)];
            case 4:
                allMembers = (_h.sent()).data;
                membersByThread = {};
                for (_i = 0, _a = (allMembers !== null && allMembers !== void 0 ? allMembers : []); _i < _a.length; _i++) {
                    m = _a[_i];
                    if (!membersByThread[m.thread_id])
                        membersByThread[m.thread_id] = [];
                    membersByThread[m.thread_id].push(m.user_id);
                }
                for (_b = 0, _c = Object.entries(membersByThread); _b < _c.length; _b++) {
                    _d = _c[_b], threadId_1 = _d[0], members = _d[1];
                    if (members.length === 2 && members.includes(user.id) && members.includes(recipientId)) {
                        existingThreadId = threadId_1;
                        break;
                    }
                }
                _h.label = 5;
            case 5:
                if (existingThreadId) {
                    res.status(200).json({ threadId: existingThreadId, created: false });
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('message_threads')
                        .insert({ created_at: now, updated_at: now })
                        .select('id')
                        .single()];
            case 6:
                _e = _h.sent(), thread = _e.data, tErr = _e.error;
                if (tErr || !thread) {
                    req.log.error({ err: tErr }, 'thread creation failed');
                    (0, http_1.sendError)(res, 'db_error', (_g = tErr === null || tErr === void 0 ? void 0 : tErr.message) !== null && _g !== void 0 ? _g : 'Failed to create thread');
                    return [2 /*return*/];
                }
                threadId = thread.id;
                return [4 /*yield*/, sc.from('message_thread_members').insert([
                        { thread_id: threadId, user_id: user.id, joined_at: now },
                        { thread_id: threadId, user_id: recipientId, joined_at: now },
                    ])];
            case 7:
                _h.sent();
                res.status(201).json({ threadId: threadId, created: true });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/users/:userId/outgoing-request
 * Returns whether the current user has a pending message request to :userId.
 * ---------------------------------------------------------------------------
 */
router.get('/users/:userId/outgoing-request', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, recipientId, sc, _a, data, error;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                recipientId = req.params.userId;
                if (!(0, followDecisions_1.isUuid)(recipientId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid user id');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_requests')
                        .select('id, status')
                        .eq('sender_id', user.id)
                        .eq('recipient_id', recipientId)
                        .eq('status', 'pending')
                        .maybeSingle()];
            case 2:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'outgoing-request check failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ pending: data !== null, requestId: (_b = data === null || data === void 0 ? void 0 : data.id) !== null && _b !== void 0 ? _b : null });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/users/:userId/message-request
 * ---------------------------------------------------------------------------
 */
router.post('/users/:userId/message-request', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, recipientId, profile, sc, verdict, existing, ex, previewText, _a, newReq, error;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                recipientId = req.params.userId;
                if (!(0, followDecisions_1.isUuid)(recipientId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid user id');
                    return [2 /*return*/];
                }
                if (recipientId === user.id) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'You cannot send a message request to yourself');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from('profiles').select('id').eq('id', recipientId).maybeSingle()];
            case 2:
                profile = (_d.sent()).data;
                if (!profile) {
                    (0, http_1.sendError)(res, 'not_found', 'User not found');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, messagingPermissions_1.canMessage)(sc, user.id, recipientId)];
            case 3:
                verdict = _d.sent();
                if (verdict.verdict === 'denied') {
                    (0, http_1.sendError)(res, 'forbidden', "Cannot message this user: ".concat((_b = verdict.reason) !== null && _b !== void 0 ? _b : 'denied'));
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_requests')
                        .select('id, status')
                        .eq('sender_id', user.id)
                        .eq('recipient_id', recipientId)
                        .maybeSingle()];
            case 4:
                existing = (_d.sent()).data;
                if (existing) {
                    ex = existing;
                    if (ex.status === 'pending') {
                        res.status(200).json({ requestId: ex.id, status: 'pending', idempotent: true });
                        return [2 /*return*/];
                    }
                    if (ex.status === 'accepted') {
                        res.status(200).json({ requestId: ex.id, status: 'accepted' });
                        return [2 /*return*/];
                    }
                }
                previewText = typeof ((_c = req.body) === null || _c === void 0 ? void 0 : _c.previewText) === 'string'
                    ? req.body.previewText.slice(0, 280)
                    : null;
                return [4 /*yield*/, sc
                        .from('message_requests')
                        .insert({ sender_id: user.id, recipient_id: recipientId, preview_text: previewText })
                        .select('id')
                        .single()];
            case 5:
                _a = _d.sent(), newReq = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'message_requests insert failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ requestId: newReq.id, status: 'pending' });
                // Realtime: notify the recipient a new message request arrived.
                void (0, telegraphEvents_1.publishToUsers)([recipientId], {
                    type: 'request.created',
                    payload: { requestId: newReq.id, senderId: user.id },
                });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/me/message-requests
 * ---------------------------------------------------------------------------
 */
router.get('/me/message-requests', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, _a, data, error, senderIds, profileMap, locationMap, profiles, _i, _b, p, locations, _c, _d, l, requests;
    var _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_requests')
                        .select('id, sender_id, preview_text, created_at')
                        .eq('recipient_id', user.id)
                        .eq('status', 'pending')
                        .order('created_at', { ascending: false })];
            case 2:
                _a = _f.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'message_requests query failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                senderIds = __spreadArray([], new Set((data !== null && data !== void 0 ? data : []).map(function (r) { return r.sender_id; })), true);
                profileMap = {};
                locationMap = {};
                if (!(senderIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from('profiles')
                        .select('id, handle, name, avatar_url, default_language')
                        .in('id', senderIds)];
            case 3:
                profiles = (_f.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    profileMap[p.id] = p;
                }
                return [4 /*yield*/, sc
                        .from('user_location_state')
                        .select('user_id, city')
                        .in('user_id', senderIds)];
            case 4:
                locations = (_f.sent()).data;
                for (_c = 0, _d = locations !== null && locations !== void 0 ? locations : []; _c < _d.length; _c++) {
                    l = _d[_c];
                    locationMap[l.user_id] = (_e = l.city) !== null && _e !== void 0 ? _e : null;
                }
                _f.label = 5;
            case 5:
                requests = (data !== null && data !== void 0 ? data : []).map(function (r) {
                    var _a, _b, _c, _d;
                    var p = profileMap[r.sender_id];
                    return {
                        requestId: r.id,
                        previewText: (_a = r.preview_text) !== null && _a !== void 0 ? _a : null,
                        createdAt: r.created_at,
                        sender: p
                            ? {
                                id: p.id,
                                handle: p.handle,
                                name: p.name,
                                avatarUrl: (_b = p.avatar_url) !== null && _b !== void 0 ? _b : null,
                                city: (_c = locationMap[p.id]) !== null && _c !== void 0 ? _c : null,
                                language: (_d = p.default_language) !== null && _d !== void 0 ? _d : null,
                            }
                            : null,
                    };
                });
                res.status(200).json({ requests: requests });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/accept
 * ---------------------------------------------------------------------------
 */
router.post('/message-requests/:requestId/accept', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, requestId, sc, mr, req_, now, senderMemberships, senderThreadIds, existingDirectThreadId, allMembers, membersByThread, _i, _a, m, _b, _c, _d, tid, members, threadId, _e, thread, tErr, previewBody, senderProfile, senderLanguage, previewMsg;
    var _f, _g, _h;
    return __generator(this, function (_j) {
        switch (_j.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _j.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                requestId = req.params.requestId;
                if (!(0, followDecisions_1.isUuid)(requestId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid request id');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_requests')
                        .select('id, sender_id, recipient_id, status, preview_text')
                        .eq('id', requestId)
                        .maybeSingle()];
            case 2:
                mr = (_j.sent()).data;
                if (!mr) {
                    (0, http_1.sendError)(res, 'not_found', 'Message request not found');
                    return [2 /*return*/];
                }
                req_ = mr;
                if (req_.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, 'forbidden', 'Only the recipient can accept this request');
                    return [2 /*return*/];
                }
                if (req_.status !== 'pending') {
                    (0, http_1.sendError)(res, 'invalid_payload', "Request is already ".concat(req_.status));
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .select('thread_id')
                        .eq('user_id', req_.sender_id)];
            case 3:
                senderMemberships = (_j.sent()).data;
                senderThreadIds = (senderMemberships !== null && senderMemberships !== void 0 ? senderMemberships : []).map(function (m) { return m.thread_id; });
                existingDirectThreadId = null;
                if (!(senderThreadIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .select('thread_id, user_id')
                        .in('thread_id', senderThreadIds)];
            case 4:
                allMembers = (_j.sent()).data;
                membersByThread = {};
                for (_i = 0, _a = (allMembers !== null && allMembers !== void 0 ? allMembers : []); _i < _a.length; _i++) {
                    m = _a[_i];
                    if (!membersByThread[m.thread_id])
                        membersByThread[m.thread_id] = [];
                    membersByThread[m.thread_id].push(m.user_id);
                }
                for (_b = 0, _c = Object.entries(membersByThread); _b < _c.length; _b++) {
                    _d = _c[_b], tid = _d[0], members = _d[1];
                    if (members.length === 2 &&
                        members.includes(req_.sender_id) &&
                        members.includes(req_.recipient_id)) {
                        existingDirectThreadId = tid;
                        break;
                    }
                }
                _j.label = 5;
            case 5:
                if (!existingDirectThreadId) return [3 /*break*/, 6];
                threadId = existingDirectThreadId;
                return [3 /*break*/, 9];
            case 6: return [4 /*yield*/, sc
                    .from('message_threads')
                    .insert({ created_at: now, updated_at: now })
                    .select('id')
                    .single()];
            case 7:
                _e = _j.sent(), thread = _e.data, tErr = _e.error;
                if (tErr || !thread) {
                    req.log.error({ err: tErr }, 'thread creation failed');
                    (0, http_1.sendError)(res, 'db_error', (_f = tErr === null || tErr === void 0 ? void 0 : tErr.message) !== null && _f !== void 0 ? _f : 'Failed to create thread');
                    return [2 /*return*/];
                }
                threadId = thread.id;
                return [4 /*yield*/, sc.from('message_thread_members').insert([
                        { thread_id: threadId, user_id: req_.sender_id, joined_at: now },
                        { thread_id: threadId, user_id: req_.recipient_id, joined_at: now },
                    ])];
            case 8:
                _j.sent();
                _j.label = 9;
            case 9: return [4 /*yield*/, sc
                    .from('message_requests')
                    .update({ status: 'accepted', responded_at: now })
                    .eq('id', requestId)];
            case 10:
                _j.sent();
                res.status(200).json({ status: 'accepted', threadId: threadId, requestId: requestId });
                // Realtime: notify the original sender that their request was accepted and a
                // thread now exists. Members of the (possibly new) thread get a thread.updated.
                void (0, telegraphEvents_1.publishToUsers)([req_.sender_id], {
                    type: 'request.accepted',
                    threadId: threadId,
                    payload: { requestId: requestId, threadId: threadId, byUserId: user.id },
                });
                void (0, telegraphEvents_1.publishToThread)(sc, threadId, { type: 'thread.updated', payload: { threadId: threadId } });
                previewBody = typeof req_.preview_text === 'string' ? req_.preview_text.trim() : '';
                if (!previewBody) return [3 /*break*/, 14];
                return [4 /*yield*/, sc
                        .from('profiles')
                        .select('preferred_language, preferred_message_language')
                        .eq('id', req_.sender_id)
                        .maybeSingle()];
            case 11:
                senderProfile = (_j.sent()).data;
                senderLanguage = (_h = (_g = senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_language) !== null && _g !== void 0 ? _g : senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_message_language) !== null && _h !== void 0 ? _h : 'en';
                return [4 /*yield*/, sc
                        .from('messages')
                        .insert({ thread_id: threadId, sender_id: req_.sender_id, body: previewBody, created_at: now })
                        .select('id')
                        .single()];
            case 12:
                previewMsg = (_j.sent()).data;
                return [4 /*yield*/, sc
                        .from('message_threads')
                        .update({ last_message_at: now, updated_at: now })
                        .eq('id', threadId)];
            case 13:
                _j.sent();
                if (previewMsg) {
                    (0, messageTranslation_1.translateMessageForThread)(sc, {
                        messageId: previewMsg.id,
                        body: previewBody,
                        senderId: req_.sender_id,
                        threadId: threadId,
                        senderPreferredLanguage: senderLanguage,
                        logger: req.log,
                    }).catch(function () { });
                }
                _j.label = 14;
            case 14: return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/decline
 * ---------------------------------------------------------------------------
 */
router.post('/message-requests/:requestId/decline', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, requestId, sc, mr, req_, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                requestId = req.params.requestId;
                if (!(0, followDecisions_1.isUuid)(requestId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid request id');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_requests')
                        .select('id, sender_id, recipient_id, status')
                        .eq('id', requestId)
                        .maybeSingle()];
            case 2:
                mr = (_a.sent()).data;
                if (!mr) {
                    (0, http_1.sendError)(res, 'not_found', 'Message request not found');
                    return [2 /*return*/];
                }
                req_ = mr;
                if (req_.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, 'forbidden', 'Only the recipient can decline this request');
                    return [2 /*return*/];
                }
                if (req_.status !== 'pending') {
                    (0, http_1.sendError)(res, 'invalid_payload', "Request is already ".concat(req_.status));
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from('message_requests').update({ status: 'declined', responded_at: now }).eq('id', requestId)];
            case 3:
                _a.sent();
                res.status(200).json({ status: 'declined', requestId: requestId });
                // Realtime: notify the original sender their request was declined.
                if (req_.sender_id) {
                    void (0, telegraphEvents_1.publishToUsers)([req_.sender_id], {
                        type: 'request.declined',
                        payload: { requestId: requestId },
                    });
                }
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/message-requests/:requestId/cancel
 * ---------------------------------------------------------------------------
 */
router.post('/message-requests/:requestId/cancel', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, requestId, sc, mr, req_;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                requestId = req.params.requestId;
                if (!(0, followDecisions_1.isUuid)(requestId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid request id');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_requests')
                        .select('id, sender_id, status')
                        .eq('id', requestId)
                        .maybeSingle()];
            case 2:
                mr = (_a.sent()).data;
                if (!mr) {
                    (0, http_1.sendError)(res, 'not_found', 'Message request not found');
                    return [2 /*return*/];
                }
                req_ = mr;
                if (req_.sender_id !== user.id) {
                    (0, http_1.sendError)(res, 'forbidden', 'Only the sender can cancel this request');
                    return [2 /*return*/];
                }
                if (req_.status !== 'pending') {
                    (0, http_1.sendError)(res, 'invalid_payload', "Request is already ".concat(req_.status));
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from('message_requests').update({ status: 'cancelled' }).eq('id', requestId)];
            case 3:
                _a.sent();
                res.status(200).json({ status: 'cancelled', requestId: requestId });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/me/unread-counts
 * ---------------------------------------------------------------------------
 * Returns { messages: number; notifications: number; meetups: number; newHighlights: number }
 *   messages       — threads with at least one unread message not sent by the caller
 *   notifications  — pending inbox items (friend requests, circle invites, trip
 *                    invites, message requests) created after the caller last
 *                    viewed their Inbox (profiles.notifications_inbox_viewed_at).
 *   newHighlights  — active highlights from circle members posted since the
 *                    caller last opened the highlights viewer
 *                    (profiles.highlights_last_viewed_at).
 */
router.get('/me/unread-counts', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    // ── Notification unread count ─────────────────────────────────────────────
    // Count pending inbox items created after the user last viewed the Inbox.
    // Covers: friend requests, circle invites, trip invites, message requests.
    function pendingSince(table, filterCol) {
        var q = sc.from(table).select('id', { count: 'exact', head: true })
            .eq(filterCol, user.id).eq('status', 'pending');
        if (inboxViewedAt)
            q = q.gt('created_at', inboxViewedAt);
        return q;
    }
    var auth, user, sc, _a, membershipsResult, profileResult, memberships, mErr, fallback, inboxViewedAt, highlightsViewedAt, threadIds, messageCount, readAtByThread_1, _i, _b, m, _c, threads, tErr, potentiallyUnreadThreadIds, _d, lastMsgs, lmErr, lastMsgByThread, _e, _f, m, _g, potentiallyUnreadThreadIds_1, threadId, lm, lastReadAt, tiQ, anQ, meetupCountPromise, _h, frResult, ciResult, tiResult, mrResult, anResult, meetups, notifCount, newHighlights, now, _j, blockedByMe, blockingMe, blockedSet_1, circleRows, circleIds, q, hCount, e_1;
    var _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x;
    return __generator(this, function (_y) {
        switch (_y.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _y.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc
                            .from('message_thread_members')
                            .select('thread_id, last_read_at')
                            .eq('user_id', user.id)
                            .is('left_at', null),
                        sc
                            .from('profiles')
                            .select('notifications_inbox_viewed_at, highlights_last_viewed_at')
                            .eq('id', user.id)
                            .maybeSingle(),
                    ])];
            case 2:
                _a = _y.sent(), membershipsResult = _a[0], profileResult = _a[1];
                memberships = membershipsResult.data, mErr = membershipsResult.error;
                if (!(mErr && mErr.code === '42703')) return [3 /*break*/, 4];
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .select('thread_id')
                        .eq('user_id', user.id)
                        .is('left_at', null)];
            case 3:
                fallback = _y.sent();
                if (fallback.error) {
                    req.log.error({ err: fallback.error }, 'unread-counts membership query failed');
                    (0, http_1.sendError)(res, 'db_error', fallback.error.message);
                    return [2 /*return*/];
                }
                memberships = ((_k = fallback.data) !== null && _k !== void 0 ? _k : []).map(function (r) { return (__assign(__assign({}, r), { last_read_at: null })); });
                mErr = null;
                _y.label = 4;
            case 4:
                if (mErr) {
                    req.log.error({ err: mErr }, 'unread-counts membership query failed');
                    (0, http_1.sendError)(res, 'db_error', mErr.message);
                    return [2 /*return*/];
                }
                inboxViewedAt = (_m = (_l = profileResult.data) === null || _l === void 0 ? void 0 : _l.notifications_inbox_viewed_at) !== null && _m !== void 0 ? _m : null;
                highlightsViewedAt = (_p = (_o = profileResult.data) === null || _o === void 0 ? void 0 : _o.highlights_last_viewed_at) !== null && _p !== void 0 ? _p : null;
                threadIds = (memberships !== null && memberships !== void 0 ? memberships : []).map(function (m) { return m.thread_id; });
                messageCount = 0;
                if (!(threadIds.length > 0)) return [3 /*break*/, 7];
                readAtByThread_1 = {};
                for (_i = 0, _b = memberships !== null && memberships !== void 0 ? memberships : []; _i < _b.length; _i++) {
                    m = _b[_i];
                    // last_read_at may be absent if migration 0016 is pending; default null
                    readAtByThread_1[m.thread_id] = (_q = m.last_read_at) !== null && _q !== void 0 ? _q : null;
                }
                return [4 /*yield*/, sc
                        .from('message_threads')
                        .select('id, last_message_at')
                        .in('id', threadIds)
                        .not('last_message_at', 'is', null)];
            case 5:
                _c = _y.sent(), threads = _c.data, tErr = _c.error;
                if (tErr) {
                    req.log.error({ err: tErr }, 'unread-counts thread query failed');
                    (0, http_1.sendError)(res, 'db_error', tErr.message);
                    return [2 /*return*/];
                }
                potentiallyUnreadThreadIds = (threads !== null && threads !== void 0 ? threads : [])
                    .filter(function (t) {
                    var lastReadAt = readAtByThread_1[t.id];
                    if (!lastReadAt)
                        return true;
                    return new Date(t.last_message_at) > new Date(lastReadAt);
                })
                    .map(function (t) { return t.id; });
                if (!(potentiallyUnreadThreadIds.length > 0)) return [3 /*break*/, 7];
                return [4 /*yield*/, sc
                        .from('messages')
                        .select('thread_id, sender_id, created_at')
                        .in('thread_id', potentiallyUnreadThreadIds)
                        .is('deleted_at', null)
                        .order('created_at', { ascending: false })];
            case 6:
                _d = _y.sent(), lastMsgs = _d.data, lmErr = _d.error;
                if (lmErr) {
                    req.log.error({ err: lmErr }, 'unread-counts messages query failed');
                    (0, http_1.sendError)(res, 'db_error', lmErr.message);
                    return [2 /*return*/];
                }
                lastMsgByThread = {};
                for (_e = 0, _f = lastMsgs !== null && lastMsgs !== void 0 ? lastMsgs : []; _e < _f.length; _e++) {
                    m = _f[_e];
                    if (!lastMsgByThread[m.thread_id]) {
                        lastMsgByThread[m.thread_id] = m;
                    }
                }
                for (_g = 0, potentiallyUnreadThreadIds_1 = potentiallyUnreadThreadIds; _g < potentiallyUnreadThreadIds_1.length; _g++) {
                    threadId = potentiallyUnreadThreadIds_1[_g];
                    lm = lastMsgByThread[threadId];
                    if (!lm)
                        continue;
                    if (lm.sender_id === user.id)
                        continue;
                    lastReadAt = readAtByThread_1[threadId];
                    if (!lastReadAt || new Date(lm.created_at) > new Date(lastReadAt)) {
                        messageCount++;
                    }
                }
                _y.label = 7;
            case 7:
                tiQ = sc.from('trip_members').select('user_id', { count: 'exact', head: true })
                    .eq('user_id', user.id).eq('role', 'invited');
                if (inboxViewedAt)
                    tiQ = tiQ.gt('created_at', inboxViewedAt);
                anQ = sc.from('availability_nudges')
                    .select('id', { count: 'exact', head: true })
                    .eq('recipient_id', user.id);
                if (inboxViewedAt)
                    anQ = anQ.gt('created_at', inboxViewedAt);
                meetupCountPromise = (function () { return __awaiter(void 0, void 0, void 0, function () {
                    var now, upcoming, ids, count;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0:
                                now = new Date().toISOString();
                                return [4 /*yield*/, sc
                                        .from('meetups')
                                        .select('id')
                                        .eq('status', 'confirmed')
                                        .gt('starts_at', now)];
                            case 1:
                                upcoming = (_a.sent()).data;
                                ids = (upcoming !== null && upcoming !== void 0 ? upcoming : []).map(function (m) { return m.id; });
                                if (ids.length === 0)
                                    return [2 /*return*/, 0];
                                return [4 /*yield*/, sc
                                        .from('meetup_invites')
                                        .select('meetup_id', { count: 'exact', head: true })
                                        .eq('user_id', user.id)
                                        .in('status', ['going', 'maybe'])
                                        .in('meetup_id', ids)];
                            case 2:
                                count = (_a.sent()).count;
                                return [2 /*return*/, count !== null && count !== void 0 ? count : 0];
                        }
                    });
                }); })();
                return [4 /*yield*/, Promise.all([
                        pendingSince('friend_requests', 'recipient_id'),
                        pendingSince('circle_invites', 'recipient_id'),
                        tiQ,
                        pendingSince('message_requests', 'recipient_id'),
                        anQ,
                    ])];
            case 8:
                _h = _y.sent(), frResult = _h[0], ciResult = _h[1], tiResult = _h[2], mrResult = _h[3], anResult = _h[4];
                return [4 /*yield*/, meetupCountPromise.catch(function () { return 0; })];
            case 9:
                meetups = _y.sent();
                notifCount = ((_r = frResult.count) !== null && _r !== void 0 ? _r : 0) +
                    ((_s = ciResult.count) !== null && _s !== void 0 ? _s : 0) +
                    ((_t = tiResult.count) !== null && _t !== void 0 ? _t : 0) +
                    ((_u = mrResult.count) !== null && _u !== void 0 ? _u : 0) +
                    ((_v = anResult.count) !== null && _v !== void 0 ? _v : 0);
                newHighlights = 0;
                _y.label = 10;
            case 10:
                _y.trys.push([10, 15, , 16]);
                now = new Date().toISOString();
                return [4 /*yield*/, Promise.all([
                        sc.from('blocks').select('blocked_id').eq('blocker_id', user.id),
                        sc.from('blocks').select('blocker_id').eq('blocked_id', user.id),
                    ])];
            case 11:
                _j = _y.sent(), blockedByMe = _j[0], blockingMe = _j[1];
                blockedSet_1 = new Set(__spreadArray(__spreadArray([], (((_w = blockedByMe.data) !== null && _w !== void 0 ? _w : []).map(function (r) { return r.blocked_id; })), true), (((_x = blockingMe.data) !== null && _x !== void 0 ? _x : []).map(function (r) { return r.blocker_id; })), true));
                return [4 /*yield*/, sc
                        .from('circle_memberships')
                        .select('other_id')
                        .eq('user_id', user.id)];
            case 12:
                circleRows = (_y.sent()).data;
                circleIds = (circleRows !== null && circleRows !== void 0 ? circleRows : [])
                    .map(function (r) { return r.other_id; })
                    .filter(function (id) { return !blockedSet_1.has(id); });
                if (!(circleIds.length > 0)) return [3 /*break*/, 14];
                q = sc
                    .from('highlights')
                    .select('id', { count: 'exact', head: true })
                    .in('owner_id', circleIds)
                    .is('deleted_at', null)
                    .gt('expires_at', now)
                    .in('visibility', ['public', 'travelers_nearby', 'circle_only']);
                if (highlightsViewedAt) {
                    q = q.gt('created_at', highlightsViewedAt);
                }
                return [4 /*yield*/, q];
            case 13:
                hCount = (_y.sent()).count;
                newHighlights = hCount !== null && hCount !== void 0 ? hCount : 0;
                _y.label = 14;
            case 14: return [3 /*break*/, 16];
            case 15:
                e_1 = _y.sent();
                req.log.warn({ err: e_1 }, 'unread-counts newHighlights query failed — defaulting to 0');
                return [3 /*break*/, 16];
            case 16:
                res.status(200).json({ messages: messageCount, notifications: notifCount, meetups: meetups, newHighlights: newHighlights });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/me/notifications/read-all
 * ---------------------------------------------------------------------------
 * Records that the current user has viewed their Inbox by setting
 * profiles.notifications_inbox_viewed_at = now(). The unread-counts endpoint
 * uses this timestamp to compute the notification badge count.
 */
router.post('/me/notifications/read-all', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, now, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('profiles')
                        .update({ notifications_inbox_viewed_at: now })
                        .eq('id', user.id)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, 'mark notifications read failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, viewedAt: now });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/me/highlights/mark-viewed
 * ---------------------------------------------------------------------------
 * Records that the current user has opened the highlights viewer by setting
 * profiles.highlights_last_viewed_at = now(). The unread-counts endpoint
 * uses this timestamp to compute the newHighlights badge count.
 */
router.post('/me/highlights/mark-viewed', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, now, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('profiles')
                        .update({ highlights_last_viewed_at: now })
                        .eq('id', user.id)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, 'mark highlights viewed failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, viewedAt: now });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/threads/:threadId/read
 * ---------------------------------------------------------------------------
 * Marks the thread as read for the current user by updating last_read_at.
 * Idempotent — safe to call on every thread open.
 */
router.post('/threads/:threadId/read', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, threadId, sc, now, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                threadId = req.params.threadId;
                if (!(0, followDecisions_1.isUuid)(threadId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid thread id');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .update({ last_read_at: now })
                        .eq('thread_id', threadId)
                        .eq('user_id', user.id)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, 'mark thread read failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, threadId: threadId, lastReadAt: now });
                // Realtime: let other members update read receipts for this user.
                void (0, telegraphEvents_1.publishToThread)(sc, threadId, { type: 'read.updated', payload: { userId: user.id, lastReadAt: now } }, { excludeUserId: user.id });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/me/threads
 * ---------------------------------------------------------------------------
 */
router.get('/me/threads', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, memberships, mErr, threadIds, sc, _b, threadsRes, lastMsgRes, allMembersRes, lastMsgByThread, _i, _c, m, lastMsgIds, translationsByMsgId, tRows, _d, _e, t, membersByThread, _f, _g, m, p, membershipMap, _h, _j, m, msgsByThread, _k, _l, m, tripIds, tripCityMap, tripRows, _m, _o, tr, threads;
    var _p, _q, _r, _s, _t, _u, _v, _w;
    return __generator(this, function (_x) {
        switch (_x.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _x.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                return [4 /*yield*/, client
                        .from('message_thread_members')
                        .select('thread_id, muted_at, archived_at, left_at, last_read_at')
                        .eq('user_id', user.id)
                        .is('left_at', null)];
            case 2:
                _a = _x.sent(), memberships = _a.data, mErr = _a.error;
                if (mErr) {
                    req.log.error({ err: mErr }, 'thread membership query failed');
                    (0, http_1.sendError)(res, 'db_error', mErr.message);
                    return [2 /*return*/];
                }
                threadIds = (memberships !== null && memberships !== void 0 ? memberships : []).map(function (m) { return m.thread_id; });
                if (threadIds.length === 0) {
                    res.status(200).json({ threads: [] });
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc
                            .from('message_threads')
                            .select('id, thread_type, trip_id, circle_owner_id, title, created_at, updated_at, last_message_at, status')
                            .in('id', threadIds)
                            .order('last_message_at', { ascending: false, nullsFirst: false }),
                        sc
                            .from('messages')
                            .select('id, thread_id, body, sender_id, created_at, deleted_at, original_language, msg_type')
                            .in('thread_id', threadIds)
                            .is('deleted_at', null)
                            .order('created_at', { ascending: false }),
                        sc
                            .from('message_thread_members')
                            .select("user_id, thread_id, profile:profiles!message_thread_members_user_id_fkey(".concat(PROFILE_PUBLIC, ")"))
                            .in('thread_id', threadIds),
                    ])];
            case 3:
                _b = _x.sent(), threadsRes = _b[0], lastMsgRes = _b[1], allMembersRes = _b[2];
                lastMsgByThread = {};
                for (_i = 0, _c = ((_p = lastMsgRes.data) !== null && _p !== void 0 ? _p : []); _i < _c.length; _i++) {
                    m = _c[_i];
                    if (!lastMsgByThread[m.thread_id])
                        lastMsgByThread[m.thread_id] = m;
                }
                lastMsgIds = Object.values(lastMsgByThread)
                    .filter(function (m) { return m.sender_id !== user.id; })
                    .map(function (m) { return m.id; })
                    .filter(Boolean);
                translationsByMsgId = {};
                if (!(lastMsgIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from('message_translations')
                        .select('message_id, translated_body, status, source_language')
                        .in('message_id', lastMsgIds)
                        .eq('recipient_id', user.id)];
            case 4:
                tRows = (_x.sent()).data;
                for (_d = 0, _e = tRows !== null && tRows !== void 0 ? tRows : []; _d < _e.length; _d++) {
                    t = _e[_d];
                    translationsByMsgId[t.message_id] = t;
                }
                _x.label = 5;
            case 5:
                membersByThread = {};
                for (_f = 0, _g = ((_q = allMembersRes.data) !== null && _q !== void 0 ? _q : []); _f < _g.length; _f++) {
                    m = _g[_f];
                    if (m.user_id === user.id)
                        continue;
                    if (!membersByThread[m.thread_id])
                        membersByThread[m.thread_id] = [];
                    p = (_r = m.profile) !== null && _r !== void 0 ? _r : {};
                    membersByThread[m.thread_id].push({
                        id: p.id,
                        handle: p.handle,
                        name: p.name,
                        avatarUrl: (_s = p.avatar_url) !== null && _s !== void 0 ? _s : null,
                    });
                }
                membershipMap = {};
                for (_h = 0, _j = memberships !== null && memberships !== void 0 ? memberships : []; _h < _j.length; _h++) {
                    m = _j[_h];
                    membershipMap[m.thread_id] = m;
                }
                msgsByThread = {};
                for (_k = 0, _l = ((_t = lastMsgRes.data) !== null && _t !== void 0 ? _t : []); _k < _l.length; _k++) {
                    m = _l[_k];
                    if (!msgsByThread[m.thread_id])
                        msgsByThread[m.thread_id] = [];
                    msgsByThread[m.thread_id].push(m);
                }
                tripIds = ((_u = threadsRes.data) !== null && _u !== void 0 ? _u : [])
                    .filter(function (t) { return t.thread_type === 'trip' && t.trip_id; })
                    .map(function (t) { return t.trip_id; });
                tripCityMap = {};
                if (!(tripIds.length > 0)) return [3 /*break*/, 7];
                return [4 /*yield*/, sc
                        .from('trips')
                        .select('id, destination_city')
                        .in('id', tripIds)];
            case 6:
                tripRows = (_x.sent()).data;
                for (_m = 0, _o = tripRows !== null && tripRows !== void 0 ? tripRows : []; _m < _o.length; _m++) {
                    tr = _o[_m];
                    tripCityMap[tr.id] = (_v = tr.destination_city) !== null && _v !== void 0 ? _v : null;
                }
                _x.label = 7;
            case 7:
                threads = ((_w = threadsRes.data) !== null && _w !== void 0 ? _w : []).map(function (t) {
                    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s;
                    var lm = lastMsgByThread[t.id];
                    var mem = (_a = membershipMap[t.id]) !== null && _a !== void 0 ? _a : {};
                    var lastReadAt = (_b = mem.last_read_at) !== null && _b !== void 0 ? _b : null;
                    // Unread count: messages newer than last_read_at not sent by the user.
                    var threadMsgs = (_c = msgsByThread[t.id]) !== null && _c !== void 0 ? _c : [];
                    var unreadCount = 0;
                    if (lastReadAt) {
                        var lastReadTs_1 = new Date(lastReadAt).getTime();
                        unreadCount = threadMsgs.filter(function (m) { return m.sender_id !== user.id && new Date(m.created_at).getTime() > lastReadTs_1; }).length;
                    }
                    else {
                        unreadCount = threadMsgs.filter(function (m) { return m.sender_id !== user.id; }).length;
                    }
                    var lastMessagePreview = null;
                    if (lm) {
                        var displayBody = (_e = (_d = lm.body) === null || _d === void 0 ? void 0 : _d.slice(0, 80)) !== null && _e !== void 0 ? _e : '';
                        if (lm.sender_id !== user.id) {
                            var tRow = translationsByMsgId[lm.id];
                            if ((tRow === null || tRow === void 0 ? void 0 : tRow.status) === 'translated' && tRow.translated_body) {
                                displayBody = tRow.translated_body.slice(0, 80);
                            }
                        }
                        lastMessagePreview = {
                            body: (_g = (_f = lm.body) === null || _f === void 0 ? void 0 : _f.slice(0, 80)) !== null && _g !== void 0 ? _g : '',
                            displayBody: displayBody,
                            senderId: lm.sender_id,
                            createdAt: lm.created_at,
                            msgType: (_h = lm.msg_type) !== null && _h !== void 0 ? _h : 'text',
                        };
                    }
                    var isAiLastMessage = (lm === null || lm === void 0 ? void 0 : lm.msg_type) === 'ai_recommendation';
                    var tripCity = t.thread_type === 'trip' && t.trip_id ? ((_j = tripCityMap[t.trip_id]) !== null && _j !== void 0 ? _j : null) : null;
                    return {
                        id: t.id,
                        threadType: ((_k = t.thread_type) !== null && _k !== void 0 ? _k : 'direct'),
                        tripId: (_l = t.trip_id) !== null && _l !== void 0 ? _l : null,
                        circleOwnerId: (_m = t.circle_owner_id) !== null && _m !== void 0 ? _m : null,
                        title: (_o = t.title) !== null && _o !== void 0 ? _o : null,
                        status: t.status,
                        lastMessageAt: (_p = t.last_message_at) !== null && _p !== void 0 ? _p : null,
                        createdAt: t.created_at,
                        mutedAt: (_q = mem.muted_at) !== null && _q !== void 0 ? _q : null,
                        archivedAt: (_r = mem.archived_at) !== null && _r !== void 0 ? _r : null,
                        otherMembers: (_s = membersByThread[t.id]) !== null && _s !== void 0 ? _s : [],
                        lastMessagePreview: lastMessagePreview,
                        unreadCount: unreadCount,
                        tripCity: tripCity,
                        isAiLastMessage: isAiLastMessage,
                    };
                });
                res.status(200).json({ threads: threads });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/threads/:threadId/messages
 * ---------------------------------------------------------------------------
 * Thread members only. Paginated. Extended with translation display fields.
 */
router.get('/threads/:threadId/messages', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, threadId, membership, before, limit, sc, query, _a, data, error, rows, incomingMsgIds, translationMap, tRows, _i, _b, t, messages;
    var _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                threadId = req.params.threadId;
                if (!(0, followDecisions_1.isUuid)(threadId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid thread id');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from('message_thread_members')
                        .select('user_id, left_at')
                        .eq('thread_id', threadId)
                        .eq('user_id', user.id)
                        .is('left_at', null)
                        .maybeSingle()];
            case 2:
                membership = (_d.sent()).data;
                if (!membership) {
                    (0, http_1.sendError)(res, 'forbidden', 'Not a member of this thread');
                    return [2 /*return*/];
                }
                if (membership.left_at !== null) {
                    (0, http_1.sendError)(res, 'forbidden', 'You no longer have access to this thread');
                    return [2 /*return*/];
                }
                before = req.query.before;
                limit = Math.min(Number((_c = req.query.limit) !== null && _c !== void 0 ? _c : 50), 100);
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                query = sc
                    .from('messages')
                    .select("id, thread_id, sender_id, body, deleted_at, created_at, edited_at, original_language, msg_type, subtype, profile:profiles!messages_sender_id_fkey(".concat(PROFILE_PUBLIC, ")"))
                    .eq('thread_id', threadId)
                    .order('created_at', { ascending: false })
                    .limit(limit);
                if (before)
                    query = query.lt('created_at', before);
                return [4 /*yield*/, query];
            case 3:
                _a = _d.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, 'messages query failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                rows = (data !== null && data !== void 0 ? data : []);
                incomingMsgIds = rows
                    .filter(function (m) { return m.sender_id !== user.id && !m.deleted_at; })
                    .map(function (m) { return m.id; });
                translationMap = {};
                if (!(incomingMsgIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from('message_translations')
                        .select('message_id, source_language, target_language, translated_body, status')
                        .in('message_id', incomingMsgIds)
                        .eq('recipient_id', user.id)];
            case 4:
                tRows = (_d.sent()).data;
                for (_i = 0, _b = tRows !== null && tRows !== void 0 ? tRows : []; _i < _b.length; _i++) {
                    t = _b[_i];
                    translationMap[t.message_id] = t;
                }
                _d.label = 5;
            case 5:
                messages = rows.map(function (m) {
                    var _a, _b, _c, _d, _e, _f, _g, _h;
                    var p = (_a = m.profile) !== null && _a !== void 0 ? _a : {};
                    var isDeleted = Boolean(m.deleted_at);
                    var tRow = (_b = translationMap[m.id]) !== null && _b !== void 0 ? _b : null;
                    var display = (0, messageTranslation_1.buildDisplayFields)({
                        body: isDeleted ? null : m.body,
                        deleted: isDeleted,
                        senderId: m.sender_id,
                        originalLanguage: m.original_language,
                    }, user.id, tRow
                        ? {
                            source_language: tRow.source_language,
                            target_language: tRow.target_language,
                            translated_body: tRow.translated_body,
                            status: tRow.status,
                        }
                        : null);
                    return {
                        id: m.id,
                        threadId: m.thread_id,
                        senderId: m.sender_id,
                        senderHandle: (_c = p.handle) !== null && _c !== void 0 ? _c : null,
                        senderName: (_d = p.name) !== null && _d !== void 0 ? _d : null,
                        senderAvatarUrl: (_e = p.avatar_url) !== null && _e !== void 0 ? _e : null,
                        body: isDeleted ? null : m.body,
                        deleted: isDeleted,
                        createdAt: m.created_at,
                        editedAt: (_f = m.edited_at) !== null && _f !== void 0 ? _f : null,
                        // Translation display fields
                        displayBody: display.displayBody,
                        originalBody: display.originalBody,
                        originalLanguage: display.originalLanguage,
                        translated: display.translated,
                        translationStatus: display.translationStatus,
                        translationLabel: display.translationLabel,
                        canShowOriginal: display.canShowOriginal,
                        msgType: (_g = m.msg_type) !== null && _g !== void 0 ? _g : 'text',
                        subtype: (_h = m.subtype) !== null && _h !== void 0 ? _h : null,
                    };
                });
                res.status(200).json({ messages: messages, threadId: threadId });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/threads/:threadId/messages
 * ---------------------------------------------------------------------------
 * Thread members only. Saves message, then runs translation pipeline.
 */
router.post('/threads/:threadId/messages', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, threadId, body, msgTypeRaw, msgType, subtype, clientId, membership, sc, senderProfile, senderLanguage, now, _a, msg, msgErr, m;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    return __generator(this, function (_o) {
        switch (_o.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _o.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                threadId = req.params.threadId;
                if (!(0, followDecisions_1.isUuid)(threadId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid thread id');
                    return [2 /*return*/];
                }
                body = typeof ((_b = req.body) === null || _b === void 0 ? void 0 : _b.body) === 'string' ? req.body.body.trim() : '';
                if (!body) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'body is required');
                    return [2 /*return*/];
                }
                if (body.length > 4000) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'body must be 4000 characters or fewer');
                    return [2 /*return*/];
                }
                msgTypeRaw = typeof ((_c = req.body) === null || _c === void 0 ? void 0 : _c.msgType) === 'string' ? req.body.msgType : 'text';
                msgType = msgTypeRaw === 'system' ? 'system' : 'text';
                subtype = typeof ((_d = req.body) === null || _d === void 0 ? void 0 : _d.subtype) === 'string' ? req.body.subtype : null;
                clientId = typeof ((_e = req.body) === null || _e === void 0 ? void 0 : _e.clientId) === 'string' ? req.body.clientId.slice(0, 64) : null;
                return [4 /*yield*/, client
                        .from('message_thread_members')
                        .select('user_id, left_at')
                        .eq('thread_id', threadId)
                        .eq('user_id', user.id)
                        .is('left_at', null)
                        .maybeSingle()];
            case 2:
                membership = (_o.sent()).data;
                if (!membership) {
                    (0, http_1.sendError)(res, 'forbidden', 'Not a member of this thread');
                    return [2 /*return*/];
                }
                if (membership.left_at !== null) {
                    (0, http_1.sendError)(res, 'forbidden', 'You no longer have access to this thread');
                    return [2 /*return*/];
                }
                sc = client;
                return [4 /*yield*/, sc
                        .from('profiles')
                        .select('preferred_language, preferred_message_language')
                        .eq('id', user.id)
                        .maybeSingle()];
            case 3:
                senderProfile = (_o.sent()).data;
                senderLanguage = (_g = (_f = senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_language) !== null && _f !== void 0 ? _f : senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_message_language) !== null && _g !== void 0 ? _g : 'en';
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('messages')
                        .insert({ thread_id: threadId, sender_id: user.id, body: body, created_at: now, msg_type: msgType, subtype: subtype })
                        .select('id, thread_id, sender_id, body, created_at, msg_type, subtype')
                        .single()];
            case 4:
                _a = _o.sent(), msg = _a.data, msgErr = _a.error;
                if (msgErr || !msg) {
                    req.log.error({ err: msgErr }, 'message insert failed');
                    (0, http_1.sendError)(res, 'db_error', (_h = msgErr === null || msgErr === void 0 ? void 0 : msgErr.message) !== null && _h !== void 0 ? _h : 'Failed to insert message');
                    return [2 /*return*/];
                }
                // Bump thread last_message_at.
                return [4 /*yield*/, sc
                        .from('message_threads')
                        .update({ last_message_at: now, updated_at: now })
                        .eq('id', threadId)];
            case 5:
                // Bump thread last_message_at.
                _o.sent();
                m = msg;
                // Respond immediately, then run translation pipeline in background.
                res.status(201).json({
                    id: m.id,
                    threadId: m.thread_id,
                    senderId: m.sender_id,
                    body: m.body,
                    deleted: false,
                    createdAt: m.created_at,
                    editedAt: null,
                    displayBody: m.body,
                    originalBody: m.body,
                    originalLanguage: null,
                    translated: false,
                    translationStatus: null,
                    translationLabel: null,
                    canShowOriginal: false,
                    msgType: (_j = m.msg_type) !== null && _j !== void 0 ? _j : 'text',
                    subtype: (_k = m.subtype) !== null && _k !== void 0 ? _k : null,
                    clientId: clientId,
                });
                // Realtime: notify other active members a new message landed, and bump the
                // thread for inbox ordering. Fire-and-forget — delivery must never affect the
                // write path (clients keep polling as a fallback).
                void (0, telegraphEvents_1.publishToThread)(sc, threadId, {
                    type: 'message.created',
                    payload: {
                        messageId: m.id,
                        senderId: m.sender_id,
                        msgType: (_l = m.msg_type) !== null && _l !== void 0 ? _l : 'text',
                        subtype: (_m = m.subtype) !== null && _m !== void 0 ? _m : null,
                        createdAt: m.created_at,
                        clientId: clientId,
                    },
                }, { excludeUserId: user.id });
                void (0, telegraphEvents_1.publishToThread)(sc, threadId, {
                    type: 'thread.updated',
                    payload: { lastMessageAt: now },
                });
                // Fire-and-forget: translate in background (does not block the response).
                (0, messageTranslation_1.translateMessageForThread)(sc, {
                    messageId: m.id,
                    body: body,
                    senderId: user.id,
                    threadId: threadId,
                    senderPreferredLanguage: senderLanguage,
                    logger: req.log,
                }).catch(function () {
                    // Outer safety net — translateMessageForThread already catches internally.
                });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * POST /api/messages/:messageId/translate/retry
 * ---------------------------------------------------------------------------
 * Re-triggers translation for a message where status = 'failed'.
 * Only the thread members can trigger this.
 */
router.post('/messages/:messageId/translate/retry', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, messageId, sc, msgRow, m, mem, tRow, senderProfile, senderLanguage;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                messageId = req.params.messageId;
                if (!(0, followDecisions_1.isUuid)(messageId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid message id');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('messages')
                        .select('id, thread_id, sender_id, body, deleted_at, original_language')
                        .eq('id', messageId)
                        .maybeSingle()];
            case 2:
                msgRow = (_c.sent()).data;
                if (!msgRow) {
                    (0, http_1.sendError)(res, 'not_found', 'Message not found');
                    return [2 /*return*/];
                }
                m = msgRow;
                if (m.deleted_at) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Cannot retry translation on a deleted message');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from('message_thread_members')
                        .select('user_id')
                        .eq('thread_id', m.thread_id)
                        .eq('user_id', user.id)
                        .maybeSingle()];
            case 3:
                mem = (_c.sent()).data;
                if (!mem) {
                    (0, http_1.sendError)(res, 'forbidden', 'Not a member of this thread');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_translations')
                        .select('id, status')
                        .eq('message_id', messageId)
                        .eq('recipient_id', user.id)
                        .maybeSingle()];
            case 4:
                tRow = (_c.sent()).data;
                if (!tRow || tRow.status === 'translated' || tRow.status === 'skipped') {
                    (0, http_1.sendError)(res, 'invalid_payload', 'No failed translation to retry');
                    return [2 /*return*/];
                }
                res.status(202).json({ status: 'retry_queued', messageId: messageId });
                // Reset to pending and re-run.
                return [4 /*yield*/, (0, messageTranslation_1.markTranslationsPending)(sc, messageId)];
            case 5:
                // Reset to pending and re-run.
                _c.sent();
                return [4 /*yield*/, sc
                        .from('profiles')
                        .select('preferred_language, preferred_message_language')
                        .eq('id', m.sender_id)
                        .maybeSingle()];
            case 6:
                senderProfile = (_c.sent()).data;
                senderLanguage = (_b = (_a = senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_language) !== null && _a !== void 0 ? _a : senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_message_language) !== null && _b !== void 0 ? _b : 'en';
                (0, messageTranslation_1.translateMessageForThread)(sc, {
                    messageId: messageId,
                    body: m.body,
                    senderId: m.sender_id,
                    threadId: m.thread_id,
                    senderPreferredLanguage: senderLanguage,
                    logger: req.log,
                }).catch(function () { });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * PATCH /api/threads/:threadId/messages/:messageId
 * ---------------------------------------------------------------------------
 * Sender only. Updates message body, sets edited_at, invalidates + regenerates
 * translations.
 */
router.patch('/threads/:threadId/messages/:messageId', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, threadId, messageId, newBody, mem, sc, msgRow, m, now, updateErr, senderProfile, senderLanguage;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                _a = req.params, threadId = _a.threadId, messageId = _a.messageId;
                if (!(0, followDecisions_1.isUuid)(threadId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid thread id');
                    return [2 /*return*/];
                }
                if (!(0, followDecisions_1.isUuid)(messageId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid message id');
                    return [2 /*return*/];
                }
                newBody = typeof ((_b = req.body) === null || _b === void 0 ? void 0 : _b.body) === 'string' ? req.body.body.trim() : '';
                if (!newBody) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'body is required');
                    return [2 /*return*/];
                }
                if (newBody.length > 4000) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'body must be 4000 characters or fewer');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from('message_thread_members')
                        .select('user_id')
                        .eq('thread_id', threadId)
                        .eq('user_id', user.id)
                        .maybeSingle()];
            case 2:
                mem = (_e.sent()).data;
                if (!mem) {
                    (0, http_1.sendError)(res, 'forbidden', 'Not a member of this thread');
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('messages')
                        .select('id, thread_id, sender_id, body, deleted_at')
                        .eq('id', messageId)
                        .eq('thread_id', threadId)
                        .maybeSingle()];
            case 3:
                msgRow = (_e.sent()).data;
                if (!msgRow) {
                    (0, http_1.sendError)(res, 'not_found', 'Message not found');
                    return [2 /*return*/];
                }
                m = msgRow;
                if (m.deleted_at) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Cannot edit a deleted message');
                    return [2 /*return*/];
                }
                if (m.sender_id !== user.id) {
                    (0, http_1.sendError)(res, 'forbidden', 'Only the sender can edit this message');
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('messages')
                        .update({ body: newBody, edited_at: now })
                        .eq('id', messageId)];
            case 4:
                updateErr = (_e.sent()).error;
                if (updateErr) {
                    req.log.error({ err: updateErr }, 'message edit failed');
                    (0, http_1.sendError)(res, 'db_error', updateErr.message);
                    return [2 /*return*/];
                }
                res.status(200).json({
                    id: messageId,
                    threadId: threadId,
                    senderId: user.id,
                    body: newBody,
                    deleted: false,
                    editedAt: now,
                });
                // Realtime: notify other members the message body changed.
                void (0, telegraphEvents_1.publishToThread)(sc, threadId, { type: 'message.updated', payload: { messageId: messageId, editedAt: now } }, { excludeUserId: user.id });
                // Invalidate existing translations and regenerate for updated body.
                return [4 /*yield*/, (0, messageTranslation_1.markTranslationsPending)(sc, messageId)];
            case 5:
                // Invalidate existing translations and regenerate for updated body.
                _e.sent();
                return [4 /*yield*/, sc
                        .from('profiles')
                        .select('preferred_language, preferred_message_language')
                        .eq('id', user.id)
                        .maybeSingle()];
            case 6:
                senderProfile = (_e.sent()).data;
                senderLanguage = (_d = (_c = senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_language) !== null && _c !== void 0 ? _c : senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_message_language) !== null && _d !== void 0 ? _d : 'en';
                (0, messageTranslation_1.translateMessageForThread)(sc, {
                    messageId: messageId,
                    body: newBody,
                    senderId: user.id,
                    threadId: threadId,
                    senderPreferredLanguage: senderLanguage,
                    logger: req.log,
                }).catch(function () { });
                return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/trips/:tripId/chat
 * ---------------------------------------------------------------------------
 * Returns the group chat thread for a trip (creates it on first call).
 * Caller must be an accepted trip member (role = owner or member).
 * Also syncs current accepted members into the thread.
 */
router.get('/trips/:tripId/chat', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, tripId, tripMembership, trip, threadId, threadTitle, e_2;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!(0, followDecisions_1.isUuid)(tripId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid trip id');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('trip_members')
                        .select('role')
                        .eq('trip_id', tripId)
                        .eq('user_id', user.id)
                        .in('role', ['owner', 'member'])
                        .maybeSingle()];
            case 2:
                tripMembership = (_c.sent()).data;
                if (!tripMembership) {
                    (0, http_1.sendError)(res, 'forbidden', 'You must be an accepted trip member to access the trip chat');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('trips')
                        .select('id, title, destination_city')
                        .eq('id', tripId)
                        .maybeSingle()];
            case 3:
                trip = (_c.sent()).data;
                if (!trip) {
                    (0, http_1.sendError)(res, 'not_found', 'Trip not found');
                    return [2 /*return*/];
                }
                _c.label = 4;
            case 4:
                _c.trys.push([4, 6, , 7]);
                return [4 /*yield*/, (0, groupChatSync_1.syncTripChatMembers)(sc, tripId)];
            case 5:
                threadId = _c.sent();
                threadTitle = (_b = (_a = trip.title) !== null && _a !== void 0 ? _a : trip.destination_city) !== null && _b !== void 0 ? _b : 'Trip Chat';
                res.status(200).json({
                    threadId: threadId,
                    threadType: 'trip',
                    title: threadTitle,
                    tripId: tripId,
                    circleOwnerId: null,
                });
                return [3 /*break*/, 7];
            case 6:
                e_2 = _c.sent();
                req.log.error({ err: e_2 }, 'syncTripChatMembers failed in GET /trips/:tripId/chat');
                (0, http_1.sendError)(res, 'db_error', 'Failed to open trip chat');
                return [3 /*break*/, 7];
            case 7: return [2 /*return*/];
        }
    });
}); });
/* ---------------------------------------------------------------------------
 * GET /api/circles/:circleOwnerId/chat
 * ---------------------------------------------------------------------------
 * Returns the group chat thread for a trusted circle (creates it on first call).
 * Caller must be the circle owner OR an accepted circle member.
 * Also syncs current circle members into the thread.
 */
router.get('/circles/:circleOwnerId/chat', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, circleOwnerId, isOwner, circleMembership, ownerProfile, threadId, displayName, threadTitle, e_3;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                circleOwnerId = req.params.circleOwnerId;
                if (!(0, followDecisions_1.isUuid)(circleOwnerId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid circle owner id');
                    return [2 /*return*/];
                }
                isOwner = user.id === circleOwnerId;
                if (!!isOwner) return [3 /*break*/, 3];
                return [4 /*yield*/, sc
                        .from('circle_memberships')
                        .select('member_id')
                        .eq('owner_id', circleOwnerId)
                        .eq('member_id', user.id)
                        .maybeSingle()];
            case 2:
                circleMembership = (_c.sent()).data;
                if (!circleMembership) {
                    (0, http_1.sendError)(res, 'forbidden', 'You must be a member of this circle to access the circle chat');
                    return [2 /*return*/];
                }
                _c.label = 3;
            case 3: return [4 /*yield*/, sc
                    .from('profiles')
                    .select('id, name, handle')
                    .eq('id', circleOwnerId)
                    .maybeSingle()];
            case 4:
                ownerProfile = (_c.sent()).data;
                if (!ownerProfile) {
                    (0, http_1.sendError)(res, 'not_found', 'Circle owner not found');
                    return [2 /*return*/];
                }
                _c.label = 5;
            case 5:
                _c.trys.push([5, 7, , 8]);
                return [4 /*yield*/, (0, groupChatSync_1.syncCircleChatMembers)(sc, circleOwnerId)];
            case 6:
                threadId = _c.sent();
                displayName = (_b = (_a = ownerProfile.name) !== null && _a !== void 0 ? _a : ownerProfile.handle) !== null && _b !== void 0 ? _b : 'Circle';
                threadTitle = "".concat(displayName, "'s Circle");
                res.status(200).json({
                    threadId: threadId,
                    threadType: 'circle',
                    title: threadTitle,
                    tripId: null,
                    circleOwnerId: circleOwnerId,
                });
                return [3 /*break*/, 8];
            case 7:
                e_3 = _c.sent();
                req.log.error({ err: e_3 }, 'syncCircleChatMembers failed in GET /circles/:circleOwnerId/chat');
                (0, http_1.sendError)(res, 'db_error', 'Failed to open circle chat');
                return [3 /*break*/, 8];
            case 8: return [2 /*return*/];
        }
    });
}); });
// ── Mute / unmute thread ──────────────────────────────────────────────────────
/**
 * PATCH /api/threads/:threadId/mute
 * Body: { muted: boolean }
 * Toggles muted_at on message_thread_members for the caller.
 */
router.patch('/threads/:threadId/mute', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, threadId, muted, now, member, error;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                threadId = req.params.threadId;
                muted = ((_a = req.body) === null || _a === void 0 ? void 0 : _a.muted) === true;
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .select('id')
                        .eq('thread_id', threadId)
                        .eq('user_id', user.id)
                        .is('left_at', null)
                        .maybeSingle()];
            case 2:
                member = (_b.sent()).data;
                if (!member) {
                    (0, http_1.sendError)(res, 'forbidden', 'Not a member of this thread');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .update({ muted_at: muted ? now : null })
                        .eq('thread_id', threadId)
                        .eq('user_id', user.id)];
            case 3:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, 'mute thread failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true, muted: muted });
                return [2 /*return*/];
        }
    });
}); });
// ── Leave thread ──────────────────────────────────────────────────────────────
/**
 * POST /api/threads/:threadId/leave
 * Sets left_at for the current user in message_thread_members.
 */
router.post('/threads/:threadId/leave', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, threadId, now, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                threadId = req.params.threadId;
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .update({ left_at: now })
                        .eq('thread_id', threadId)
                        .eq('user_id', user.id)
                        .is('left_at', null)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, 'leave thread failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ ok: true });
                // Realtime: notify remaining members that someone left.
                void (0, telegraphEvents_1.publishToThread)(sc, threadId, { type: 'member.left', payload: { userId: user.id } }, { excludeUserId: user.id });
                return [2 /*return*/];
        }
    });
}); });
// ── Report thread ─────────────────────────────────────────────────────────────
/**
 * POST /api/threads/:threadId/report
 * Body: { reason: string }
 * Records a user report against a conversation. Best-effort insert.
 */
router.post('/threads/:threadId/report', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, threadId, reason, error;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                threadId = req.params.threadId;
                reason = typeof ((_a = req.body) === null || _a === void 0 ? void 0 : _a.reason) === 'string' ? req.body.reason.trim().slice(0, 200) : '';
                if (!reason) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'reason is required');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('thread_reports')
                        .upsert({ thread_id: threadId, reporter_id: user.id, reason: reason, created_at: new Date().toISOString() }, { onConflict: 'thread_id,reporter_id' })];
            case 2:
                error = (_b.sent()).error;
                if (error) {
                    req.log.warn({ err: error }, 'thread report insert failed (table may not exist yet)');
                }
                res.status(201).json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
// ── Report message ────────────────────────────────────────────────────────────
/**
 * POST /api/messages/:messageId/report
 * Body: { reason: string }
 * Records a user report against a message. Best-effort insert.
 */
router.post('/messages/:messageId/report', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, messageId, reason, error;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, 'server_not_configured', 'Service client not ready');
                    return [2 /*return*/];
                }
                messageId = req.params.messageId;
                reason = typeof ((_a = req.body) === null || _a === void 0 ? void 0 : _a.reason) === 'string' ? req.body.reason.trim().slice(0, 200) : '';
                if (!reason) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'reason is required');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('message_reports')
                        .upsert({ message_id: messageId, reporter_id: user.id, reason: reason, created_at: new Date().toISOString() }, { onConflict: 'message_id,reporter_id' })];
            case 2:
                error = (_b.sent()).error;
                if (error) {
                    req.log.warn({ err: error }, 'message report insert failed (table may not exist yet)');
                }
                res.status(201).json({ ok: true });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
