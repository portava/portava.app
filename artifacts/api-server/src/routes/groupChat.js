"use strict";
/**
 * Group chat routes — trip and circle threads.
 *
 * GET  /api/trips/:tripId/chat           — resolve or create trip thread, return thread + messages
 * GET  /api/circles/:circleId/chat       — resolve or create circle thread, return thread + messages
 * PATCH /api/messages/:messageId         — edit own message (any thread type)
 * DELETE /api/messages/:messageId        — soft-delete own message (any thread type)
 * POST /api/trips/:tripId/chat/sync      — admin/dev repair: force membership sync
 * POST /api/circles/:circleId/chat/sync  — admin/dev repair: force membership sync
 *
 * Privacy guarantees:
 * - No GPS, live location, private posts, or service-role fields are exposed.
 * - Access is gated ONLY on accepted trip/circle membership + thread membership.
 * - left_at is checked on all group-thread reads and sends.
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
var http_1 = require("../lib/http");
var followDecisions_1 = require("../lib/followDecisions");
var chatSync_1 = require("../lib/chatSync");
var messageTranslation_1 = require("../services/messageTranslation");
var router = (0, express_1.Router)();
var PROFILE_PUBLIC = 'id, handle, name, avatar_url';
var INITIAL_MSG_LIMIT = 50;
// ── Helpers ───────────────────────────────────────────────────────────────────
function isAcceptedCircleMember(sc, circleOwnerId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (userId === circleOwnerId)
                        return [2 /*return*/, true];
                    return [4 /*yield*/, sc
                            .from('circle_memberships')
                            .select('member_id')
                            .eq('owner_id', circleOwnerId)
                            .eq('member_id', userId)
                            .maybeSingle()];
                case 1:
                    data = (_a.sent()).data;
                    return [2 /*return*/, Boolean(data)];
            }
        });
    });
}
function isActiveThreadMember(sc, threadId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, left;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, sc
                        .from('message_thread_members')
                        .select('user_id, left_at')
                        .eq('thread_id', threadId)
                        .eq('user_id', userId)
                        .maybeSingle()];
                case 1:
                    data = (_a.sent()).data;
                    if (!data)
                        return [2 /*return*/, { active: false, left: false }];
                    left = data.left_at !== null;
                    return [2 /*return*/, { active: !left, left: left }];
            }
        });
    });
}
function fetchMessagesForThread(sc, threadId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, rows, incomingIds, translationMap, tRows, _i, _a, t;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, sc
                        .from('messages')
                        .select("id, thread_id, sender_id, body, deleted_at, created_at, edited_at, original_language, profile:profiles!messages_sender_id_fkey(".concat(PROFILE_PUBLIC, ")"))
                        .eq('thread_id', threadId)
                        .order('created_at', { ascending: false })
                        .limit(INITIAL_MSG_LIMIT)];
                case 1:
                    data = (_b.sent()).data;
                    rows = (data !== null && data !== void 0 ? data : []);
                    incomingIds = rows
                        .filter(function (m) { return m.sender_id !== userId && !m.deleted_at; })
                        .map(function (m) { return m.id; });
                    translationMap = {};
                    if (!(incomingIds.length > 0)) return [3 /*break*/, 3];
                    return [4 /*yield*/, sc
                            .from('message_translations')
                            .select('message_id, source_language, target_language, translated_body, status')
                            .in('message_id', incomingIds)
                            .eq('recipient_id', userId)];
                case 2:
                    tRows = (_b.sent()).data;
                    for (_i = 0, _a = tRows !== null && tRows !== void 0 ? tRows : []; _i < _a.length; _i++) {
                        t = _a[_i];
                        translationMap[t.message_id] = t;
                    }
                    _b.label = 3;
                case 3: return [2 /*return*/, rows.map(function (m) {
                        var _a, _b, _c, _d, _e, _f;
                        var p = (_a = m.profile) !== null && _a !== void 0 ? _a : {};
                        var isDeleted = Boolean(m.deleted_at);
                        var tRow = (_b = translationMap[m.id]) !== null && _b !== void 0 ? _b : null;
                        var display = (0, messageTranslation_1.buildDisplayFields)({
                            body: isDeleted ? null : m.body,
                            deleted: isDeleted,
                            senderId: m.sender_id,
                            originalLanguage: m.original_language,
                        }, userId, tRow
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
                            displayBody: display.displayBody,
                            originalBody: display.originalBody,
                            originalLanguage: display.originalLanguage,
                            translated: display.translated,
                            translationStatus: display.translationStatus,
                            translationLabel: display.translationLabel,
                            canShowOriginal: display.canShowOriginal,
                        };
                    })];
            }
        });
    });
}
// ── GET /api/trips/:tripId/chat ───────────────────────────────────────────────
router.get('/trips/:tripId/chat', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, tripId, isMember, invited, threadId, _a, active, left, threadRow, messages, _b;
    var _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _g.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!(0, followDecisions_1.isUuid)(tripId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid tripId');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_1.isAcceptedTripMember)(sc, tripId, user.id)];
            case 2:
                isMember = _g.sent();
                if (!!isMember) return [3 /*break*/, 4];
                return [4 /*yield*/, sc
                        .from('trip_members')
                        .select('role')
                        .eq('trip_id', tripId)
                        .eq('user_id', user.id)
                        .eq('role', 'invited')
                        .maybeSingle()];
            case 3:
                invited = (_g.sent()).data;
                if (invited) {
                    res.status(403).json({
                        error: 'pending_invite',
                        message: 'Accept the invite to join this chat.',
                    });
                }
                else {
                    res.status(403).json({
                        error: 'not_member',
                        message: 'You must be an accepted trip member to access this chat.',
                    });
                }
                return [2 /*return*/];
            case 4: return [4 /*yield*/, (0, chatSync_1.syncTripChatMembers)(tripId, sc)];
            case 5:
                threadId = _g.sent();
                if (!threadId) {
                    (0, http_1.sendError)(res, 'db_error', 'Failed to resolve trip chat thread');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isActiveThreadMember(sc, threadId, user.id)];
            case 6:
                _a = _g.sent(), active = _a.active, left = _a.left;
                return [4 /*yield*/, sc
                        .from('message_threads')
                        .select('id, thread_type, trip_id, title, status, last_message_at, created_at')
                        .eq('id', threadId)
                        .maybeSingle()];
            case 7:
                threadRow = (_g.sent()).data;
                if (!active) return [3 /*break*/, 9];
                return [4 /*yield*/, fetchMessagesForThread(sc, threadId, user.id)];
            case 8:
                _b = _g.sent();
                return [3 /*break*/, 10];
            case 9:
                _b = [];
                _g.label = 10;
            case 10:
                messages = _b;
                res.status(200).json({
                    thread: {
                        id: threadId,
                        threadType: 'trip',
                        tripId: tripId,
                        title: (_c = threadRow === null || threadRow === void 0 ? void 0 : threadRow.title) !== null && _c !== void 0 ? _c : 'Trip Chat',
                        status: (_d = threadRow === null || threadRow === void 0 ? void 0 : threadRow.status) !== null && _d !== void 0 ? _d : 'active',
                        lastMessageAt: (_e = threadRow === null || threadRow === void 0 ? void 0 : threadRow.last_message_at) !== null && _e !== void 0 ? _e : null,
                        createdAt: (_f = threadRow === null || threadRow === void 0 ? void 0 : threadRow.created_at) !== null && _f !== void 0 ? _f : null,
                        memberAccess: left ? 'removed' : 'active',
                    },
                    messages: __spreadArray([], messages, true).reverse(),
                });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/circles/:circleId/chat ──────────────────────────────────────────
// :circleId is the circle owner's user ID.
router.get('/circles/:circleId/chat', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, circleOwnerId, isMember, invited, threadId, _a, active, left, threadRow, messages, _b;
    var _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _g.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                circleOwnerId = req.params.circleId;
                if (!(0, followDecisions_1.isUuid)(circleOwnerId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid circleId');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isAcceptedCircleMember(sc, circleOwnerId, user.id)];
            case 2:
                isMember = _g.sent();
                if (!!isMember) return [3 /*break*/, 4];
                return [4 /*yield*/, sc
                        .from('circle_invites')
                        .select('id')
                        .eq('owner_id', circleOwnerId)
                        .eq('recipient_id', user.id)
                        .eq('status', 'pending')
                        .maybeSingle()];
            case 3:
                invited = (_g.sent()).data;
                if (invited) {
                    res.status(403).json({
                        error: 'pending_invite',
                        message: 'Accept the invite to join this chat.',
                    });
                }
                else {
                    res.status(403).json({
                        error: 'not_member',
                        message: 'You must be an accepted circle member to access this chat.',
                    });
                }
                return [2 /*return*/];
            case 4: return [4 /*yield*/, (0, chatSync_1.syncCircleChatMembers)(circleOwnerId, sc)];
            case 5:
                threadId = _g.sent();
                if (!threadId) {
                    (0, http_1.sendError)(res, 'db_error', 'Failed to resolve circle chat thread');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isActiveThreadMember(sc, threadId, user.id)];
            case 6:
                _a = _g.sent(), active = _a.active, left = _a.left;
                return [4 /*yield*/, sc
                        .from('message_threads')
                        .select('id, thread_type, circle_owner_id, title, status, last_message_at, created_at')
                        .eq('id', threadId)
                        .maybeSingle()];
            case 7:
                threadRow = (_g.sent()).data;
                if (!active) return [3 /*break*/, 9];
                return [4 /*yield*/, fetchMessagesForThread(sc, threadId, user.id)];
            case 8:
                _b = _g.sent();
                return [3 /*break*/, 10];
            case 9:
                _b = [];
                _g.label = 10;
            case 10:
                messages = _b;
                res.status(200).json({
                    thread: {
                        id: threadId,
                        threadType: 'circle',
                        circleOwnerId: circleOwnerId,
                        title: (_c = threadRow === null || threadRow === void 0 ? void 0 : threadRow.title) !== null && _c !== void 0 ? _c : 'Trusted Circle',
                        status: (_d = threadRow === null || threadRow === void 0 ? void 0 : threadRow.status) !== null && _d !== void 0 ? _d : 'active',
                        lastMessageAt: (_e = threadRow === null || threadRow === void 0 ? void 0 : threadRow.last_message_at) !== null && _e !== void 0 ? _e : null,
                        createdAt: (_f = threadRow === null || threadRow === void 0 ? void 0 : threadRow.created_at) !== null && _f !== void 0 ? _f : null,
                        memberAccess: left ? 'removed' : 'active',
                    },
                    messages: __spreadArray([], messages, true).reverse(),
                });
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /api/messages/:messageId — edit own message ────────────────────────
router.patch('/messages/:messageId', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, messageId, newBody, msgRow, m, active, now, updateErr, senderProfile, senderLanguage;
    var _a, _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                messageId = req.params.messageId;
                if (!(0, followDecisions_1.isUuid)(messageId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid messageId');
                    return [2 /*return*/];
                }
                newBody = typeof ((_a = req.body) === null || _a === void 0 ? void 0 : _a.body) === 'string' ? req.body.body.trim() : '';
                if (!newBody) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'body is required');
                    return [2 /*return*/];
                }
                if (newBody.length > 4000) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'body must be 4000 characters or fewer');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('messages')
                        .select('id, thread_id, sender_id, body, deleted_at')
                        .eq('id', messageId)
                        .maybeSingle()];
            case 2:
                msgRow = (_d.sent()).data;
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
                return [4 /*yield*/, isActiveThreadMember(sc, m.thread_id, user.id)];
            case 3:
                active = (_d.sent()).active;
                if (!active) {
                    (0, http_1.sendError)(res, 'forbidden', 'You no longer have access to this thread');
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('messages')
                        .update({ body: newBody, edited_at: now })
                        .eq('id', messageId)];
            case 4:
                updateErr = (_d.sent()).error;
                if (updateErr) {
                    req.log.error({ err: updateErr }, 'message edit failed');
                    (0, http_1.sendError)(res, 'db_error', updateErr.message);
                    return [2 /*return*/];
                }
                res.status(200).json({
                    id: messageId,
                    threadId: m.thread_id,
                    senderId: user.id,
                    body: newBody,
                    deleted: false,
                    editedAt: now,
                });
                return [4 /*yield*/, (0, messageTranslation_1.markTranslationsPending)(sc, messageId)];
            case 5:
                _d.sent();
                return [4 /*yield*/, sc
                        .from('profiles')
                        .select('preferred_language, preferred_message_language')
                        .eq('id', user.id)
                        .maybeSingle()];
            case 6:
                senderProfile = (_d.sent()).data;
                senderLanguage = (_c = (_b = senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_language) !== null && _b !== void 0 ? _b : senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.preferred_message_language) !== null && _c !== void 0 ? _c : 'en';
                (0, messageTranslation_1.translateMessageForThread)(sc, {
                    messageId: messageId,
                    body: newBody,
                    senderId: user.id,
                    threadId: m.thread_id,
                    senderPreferredLanguage: senderLanguage,
                    logger: req.log,
                }).catch(function () { });
                return [2 /*return*/];
        }
    });
}); });
// ── DELETE /api/messages/:messageId — soft-delete own message ────────────────
router.delete('/messages/:messageId', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, messageId, msgRow, m, active, now, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                messageId = req.params.messageId;
                if (!(0, followDecisions_1.isUuid)(messageId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid messageId');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('messages')
                        .select('id, thread_id, sender_id, deleted_at')
                        .eq('id', messageId)
                        .maybeSingle()];
            case 2:
                msgRow = (_a.sent()).data;
                if (!msgRow) {
                    (0, http_1.sendError)(res, 'not_found', 'Message not found');
                    return [2 /*return*/];
                }
                m = msgRow;
                if (m.deleted_at) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Message is already deleted');
                    return [2 /*return*/];
                }
                if (m.sender_id !== user.id) {
                    (0, http_1.sendError)(res, 'forbidden', 'Only the sender can delete this message');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, isActiveThreadMember(sc, m.thread_id, user.id)];
            case 3:
                active = (_a.sent()).active;
                if (!active) {
                    (0, http_1.sendError)(res, 'forbidden', 'You no longer have access to this thread');
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc
                        .from('messages')
                        .update({ deleted_at: now, body: null })
                        .eq('id', messageId)];
            case 4:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, 'message delete failed');
                    (0, http_1.sendError)(res, 'db_error', error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ id: messageId, deleted: true });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/trips/:tripId/chat/sync — owner-only repair endpoint ────────────
// Only the trip owner may force a membership re-sync (e.g. after a bulk-remove).
router.post('/trips/:tripId/chat/sync', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, tripId, ownerRow, threadId;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!(0, followDecisions_1.isUuid)(tripId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid tripId');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from('trip_members')
                        .select('role')
                        .eq('trip_id', tripId)
                        .eq('user_id', user.id)
                        .maybeSingle()];
            case 2:
                ownerRow = (_a.sent()).data;
                if (!ownerRow || ownerRow.role !== 'owner') {
                    (0, http_1.sendError)(res, 'forbidden', 'Only the trip owner can trigger sync');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, chatSync_1.syncTripChatMembers)(tripId, sc)];
            case 3:
                threadId = _a.sent();
                if (!threadId) {
                    (0, http_1.sendError)(res, 'db_error', 'Sync failed');
                    return [2 /*return*/];
                }
                res.status(200).json({ status: 'synced', threadId: threadId });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/circles/:circleId/chat/sync — owner-only repair endpoint ────────
// Only the circle owner may force a membership re-sync.
router.post('/circles/:circleId/chat/sync', function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, circleOwnerId, threadId;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                circleOwnerId = req.params.circleId;
                if (!(0, followDecisions_1.isUuid)(circleOwnerId)) {
                    (0, http_1.sendError)(res, 'invalid_payload', 'Invalid circleId');
                    return [2 /*return*/];
                }
                if (user.id !== circleOwnerId) {
                    (0, http_1.sendError)(res, 'forbidden', 'Only the circle owner can trigger sync');
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, chatSync_1.syncCircleChatMembers)(circleOwnerId, sc)];
            case 2:
                threadId = _a.sent();
                if (!threadId) {
                    (0, http_1.sendError)(res, 'db_error', 'Sync failed');
                    return [2 /*return*/];
                }
                res.status(200).json({ status: 'synced', threadId: threadId });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
