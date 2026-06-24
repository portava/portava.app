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
var express_1 = require("express");
var http_1 = require("../lib/http");
var friendDecisions_1 = require("../lib/friendDecisions");
var supabase_1 = require("../lib/supabase");
var chatSync_1 = require("../lib/chatSync");
var router = (0, express_1.Router)();
var PROFILE_PUBLIC = "id, handle, name, avatar_url";
function getRequest(sc, requestId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, sc
                    .from("friend_requests")
                    .select("id, requester_id, recipient_id, status")
                    .eq("id", requestId)
                    .maybeSingle()];
        });
    });
}
/* ===========================================================================
 * POST /users/:userId/friend-request  — send (or ensure pending) request
 * ===========================================================================
 * Privacy guarantee: writes ONLY to friend_requests + user_friendships.
 * Never touches circle_memberships, trip_members, live_location, or visibility.
 */
router.post("/users/:userId/friend-request", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, recipientId, decision, sc, profile, existing, now, incoming, now, _a, ua, ub, _b, newReq, error;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                recipientId = req.params.userId;
                if (!(0, friendDecisions_1.isUuid)(recipientId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                decision = (0, friendDecisions_1.decideSendRequest)(user.id, recipientId);
                if (!decision.ok) {
                    (0, http_1.sendError)(res, "invalid_payload", decision.reason);
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("profiles").select("id").eq("id", recipientId).maybeSingle()];
            case 2:
                profile = (_c.sent()).data;
                if (!profile) {
                    (0, http_1.sendError)(res, "not_found", "User not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("friend_requests")
                        .select("id, status")
                        .eq("requester_id", user.id)
                        .eq("recipient_id", recipientId)
                        .maybeSingle()];
            case 3:
                existing = (_c.sent()).data;
                if (!existing) return [3 /*break*/, 5];
                if (existing.status === "pending") {
                    res.status(200).json({ requestId: existing.id, status: "outgoing_pending", idempotent: true });
                    return [2 /*return*/];
                }
                if (existing.status === "accepted") {
                    res.status(200).json({ requestId: existing.id, status: "friends" });
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests")
                        .update({ status: "pending", responded_at: null, updated_at: now })
                        .eq("id", existing.id)];
            case 4:
                _c.sent();
                res.status(200).json({ requestId: existing.id, status: "outgoing_pending", reactivated: true });
                return [2 /*return*/];
            case 5: return [4 /*yield*/, sc
                    .from("friend_requests")
                    .select("id")
                    .eq("requester_id", recipientId)
                    .eq("recipient_id", user.id)
                    .eq("status", "pending")
                    .maybeSingle()];
            case 6:
                incoming = (_c.sent()).data;
                if (!incoming) return [3 /*break*/, 9];
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests")
                        .update({ status: "accepted", responded_at: now, updated_at: now })
                        .eq("id", incoming.id)];
            case 7:
                _c.sent();
                _a = (0, friendDecisions_1.normalizedFriendshipPair)(user.id, recipientId), ua = _a[0], ub = _a[1];
                return [4 /*yield*/, sc.from("user_friendships")
                        .upsert({ user_a: ua, user_b: ub, accepted_request_id: incoming.id, created_at: now })];
            case 8:
                _c.sent();
                res.status(200).json({ requestId: incoming.id, status: "friends", autoAccepted: true });
                return [2 /*return*/];
            case 9: return [4 /*yield*/, sc
                    .from("friend_requests")
                    .insert({ requester_id: user.id, recipient_id: recipientId })
                    .select("id")
                    .single()];
            case 10:
                _b = _c.sent(), newReq = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to create friend request");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ requestId: newReq.id, status: "outgoing_pending" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /friend-requests/:requestId/accept
 * ===========================================================================
 * Only the recipient may call this. Creates the user_friendships row.
 * DOES NOT create circle_memberships or trip_members.
 */
router.post("/friend-requests/:requestId/accept", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, requestId, sc, fr, decision, now, _a, ua, ub;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                requestId = req.params.requestId;
                if (!(0, friendDecisions_1.isUuid)(requestId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid request id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, getRequest(sc, requestId)];
            case 2:
                fr = (_b.sent()).data;
                if (!fr) {
                    (0, http_1.sendError)(res, "not_found", "Friend request not found");
                    return [2 /*return*/];
                }
                if (fr.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Request is already ".concat(fr.status));
                    return [2 /*return*/];
                }
                decision = (0, friendDecisions_1.decideAcceptRequest)(user.id, fr.recipient_id);
                if (!decision.ok) {
                    (0, http_1.sendError)(res, "forbidden", decision.reason);
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests")
                        .update({ status: "accepted", responded_at: now, updated_at: now })
                        .eq("id", requestId)];
            case 3:
                _b.sent();
                _a = (0, friendDecisions_1.normalizedFriendshipPair)(fr.requester_id, fr.recipient_id), ua = _a[0], ub = _a[1];
                return [4 /*yield*/, sc.from("user_friendships")
                        .upsert({ user_a: ua, user_b: ub, accepted_request_id: requestId, created_at: now })];
            case 4:
                _b.sent();
                res.status(200).json({ status: "friends", requestId: requestId });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /friend-requests/:requestId/decline
 * ===========================================================================
 */
router.post("/friend-requests/:requestId/decline", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, requestId, sc, fr, decision, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                requestId = req.params.requestId;
                if (!(0, friendDecisions_1.isUuid)(requestId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid request id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, getRequest(sc, requestId)];
            case 2:
                fr = (_a.sent()).data;
                if (!fr) {
                    (0, http_1.sendError)(res, "not_found", "Friend request not found");
                    return [2 /*return*/];
                }
                if (fr.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Request is already ".concat(fr.status));
                    return [2 /*return*/];
                }
                decision = (0, friendDecisions_1.decideDeclineRequest)(user.id, fr.recipient_id);
                if (!decision.ok) {
                    (0, http_1.sendError)(res, "forbidden", decision.reason);
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests")
                        .update({ status: "declined", responded_at: now, updated_at: now })
                        .eq("id", requestId)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "declined", requestId: requestId });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /friend-requests/:requestId/cancel
 * ===========================================================================
 */
router.post("/friend-requests/:requestId/cancel", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, requestId, sc, fr, decision, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                requestId = req.params.requestId;
                if (!(0, friendDecisions_1.isUuid)(requestId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid request id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, getRequest(sc, requestId)];
            case 2:
                fr = (_a.sent()).data;
                if (!fr) {
                    (0, http_1.sendError)(res, "not_found", "Friend request not found");
                    return [2 /*return*/];
                }
                if (fr.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Request is already ".concat(fr.status));
                    return [2 /*return*/];
                }
                decision = (0, friendDecisions_1.decideCancelRequest)(user.id, fr.requester_id);
                if (!decision.ok) {
                    (0, http_1.sendError)(res, "forbidden", decision.reason);
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests")
                        .update({ status: "cancelled", updated_at: now })
                        .eq("id", requestId)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "cancelled", requestId: requestId });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/friend-requests/incoming
 * ===========================================================================
 */
router.get("/me/friend-requests/incoming", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, _a, data, error, requesterIds, profileMap, profiles, _i, _b, p, requests;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("friend_requests")
                        .select("id, status, created_at, requester_id")
                        .eq("recipient_id", user.id)
                        .eq("status", "pending")
                        .order("created_at", { ascending: false })];
            case 2:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "incoming requests query failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                requesterIds = __spreadArray([], new Set((data !== null && data !== void 0 ? data : []).map(function (r) { return r.requester_id; })), true);
                profileMap = {};
                if (!(requesterIds.length > 0)) return [3 /*break*/, 4];
                return [4 /*yield*/, sc.from("profiles").select(PROFILE_PUBLIC).in("id", requesterIds)];
            case 3:
                profiles = (_c.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    profileMap[p.id] = p;
                }
                _c.label = 4;
            case 4:
                requests = (data !== null && data !== void 0 ? data : []).map(function (r) {
                    var _a;
                    var p = profileMap[r.requester_id];
                    return {
                        requestId: r.id,
                        status: r.status,
                        createdAt: r.created_at,
                        user: p ? { id: p.id, handle: p.handle, name: p.name, avatarUrl: (_a = p.avatar_url) !== null && _a !== void 0 ? _a : null } : null,
                    };
                });
                res.status(200).json({ requests: requests });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/friend-requests/outgoing
 * ===========================================================================
 */
router.get("/me/friend-requests/outgoing", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, _a, data, error, recipientIds, profileMap, profiles, _i, _b, p, requests;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("friend_requests")
                        .select("id, status, created_at, recipient_id")
                        .eq("requester_id", user.id)
                        .eq("status", "pending")
                        .order("created_at", { ascending: false })];
            case 2:
                _a = _c.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "outgoing requests query failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                recipientIds = __spreadArray([], new Set((data !== null && data !== void 0 ? data : []).map(function (r) { return r.recipient_id; })), true);
                profileMap = {};
                if (!(recipientIds.length > 0)) return [3 /*break*/, 4];
                return [4 /*yield*/, sc.from("profiles").select(PROFILE_PUBLIC).in("id", recipientIds)];
            case 3:
                profiles = (_c.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    profileMap[p.id] = p;
                }
                _c.label = 4;
            case 4:
                requests = (data !== null && data !== void 0 ? data : []).map(function (r) {
                    var _a;
                    var p = profileMap[r.recipient_id];
                    return {
                        requestId: r.id,
                        status: r.status,
                        createdAt: r.created_at,
                        user: p ? { id: p.id, handle: p.handle, name: p.name, avatarUrl: (_a = p.avatar_url) !== null && _a !== void 0 ? _a : null } : null,
                    };
                });
                res.status(200).json({ requests: requests });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/friends
 * ===========================================================================
 */
router.get("/me/friends", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, _a, asA, asB, entries, friendIds, profileMap, profiles, _i, _b, p, friends;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc.from("user_friendships").select("user_b, created_at").eq("user_a", user.id),
                        sc.from("user_friendships").select("user_a, created_at").eq("user_b", user.id),
                    ])];
            case 2:
                _a = _c.sent(), asA = _a[0].data, asB = _a[1].data;
                entries = __spreadArray(__spreadArray([], (asA !== null && asA !== void 0 ? asA : []).map(function (r) { return ({ friendId: r.user_b, since: r.created_at }); }), true), (asB !== null && asB !== void 0 ? asB : []).map(function (r) { return ({ friendId: r.user_a, since: r.created_at }); }), true);
                friendIds = entries.map(function (e) { return e.friendId; });
                profileMap = {};
                if (!(friendIds.length > 0)) return [3 /*break*/, 4];
                return [4 /*yield*/, sc.from("profiles").select(PROFILE_PUBLIC).in("id", friendIds)];
            case 3:
                profiles = (_c.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    profileMap[p.id] = p;
                }
                _c.label = 4;
            case 4:
                friends = entries
                    .map(function (e) {
                    var _a;
                    var p = profileMap[e.friendId];
                    return p ? { id: p.id, handle: p.handle, name: p.name, avatarUrl: (_a = p.avatar_url) !== null && _a !== void 0 ? _a : null, since: e.since } : null;
                })
                    .filter(Boolean);
                res.status(200).json({ friends: friends });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /circles/:circleOwnerId/members  — list circle members (for invite picker)
 * ===========================================================================
 * Returns profiles of all circle members, excluding the caller.
 * Caller must be the owner or a member of this circle.
 */
router.get("/circles/:circleOwnerId/members", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, circleOwnerId, sc, isOwner, mem, _a, memberships, memErr, memberIds, _b, profiles, profErr;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                circleOwnerId = req.params.circleOwnerId;
                if (!(0, friendDecisions_1.isUuid)(circleOwnerId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid circle owner id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                isOwner = user.id === circleOwnerId;
                if (!!isOwner) return [3 /*break*/, 3];
                return [4 /*yield*/, sc
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", circleOwnerId)
                        .eq("member_id", user.id)
                        .maybeSingle()];
            case 2:
                mem = (_c.sent()).data;
                if (!mem) {
                    (0, http_1.sendError)(res, "forbidden", "Not a circle member");
                    return [2 /*return*/];
                }
                _c.label = 3;
            case 3: return [4 /*yield*/, sc
                    .from("circle_memberships")
                    .select("member_id")
                    .eq("owner_id", circleOwnerId)];
            case 4:
                _a = _c.sent(), memberships = _a.data, memErr = _a.error;
                if (memErr) {
                    (0, http_1.sendError)(res, "db_error", memErr.message);
                    return [2 /*return*/];
                }
                memberIds = (memberships !== null && memberships !== void 0 ? memberships : [])
                    .map(function (m) { return m.member_id; })
                    .concat(!isOwner ? [circleOwnerId] : [])
                    .filter(function (id) { return id !== user.id; });
                if (memberIds.length === 0) {
                    res.status(200).json({ members: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", memberIds)];
            case 5:
                _b = _c.sent(), profiles = _b.data, profErr = _b.error;
                if (profErr) {
                    (0, http_1.sendError)(res, "db_error", profErr.message);
                    return [2 /*return*/];
                }
                res.status(200).json({
                    members: (profiles !== null && profiles !== void 0 ? profiles : []).map(function (p) {
                        var _a;
                        return ({
                            id: p.id,
                            handle: p.handle,
                            name: p.name,
                            avatarUrl: (_a = p.avatar_url) !== null && _a !== void 0 ? _a : null,
                        });
                    }),
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /circles/:circleOwnerId/invitable-users  — grouped invite picker data
 * ===========================================================================
 * Returns circle members (groupMembers) + caller's friends not in the circle
 * (otherFollowers). Caller must be the circle owner or a circle member.
 */
router.get("/circles/:circleOwnerId/invitable-users", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, circleOwnerId, sc, isOwner, mem, _a, memberships, friendsAsA, friendsAsB, groupMemberIds, groupMemberSet, otherFollowerIds, allIds, profileMap, profiles, _i, _b, p, toUser;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                circleOwnerId = req.params.circleOwnerId;
                if (!(0, friendDecisions_1.isUuid)(circleOwnerId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid circle owner id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                isOwner = user.id === circleOwnerId;
                if (!!isOwner) return [3 /*break*/, 3];
                return [4 /*yield*/, sc
                        .from("circle_memberships").select("member_id")
                        .eq("owner_id", circleOwnerId).eq("member_id", user.id).maybeSingle()];
            case 2:
                mem = (_c.sent()).data;
                if (!mem) {
                    (0, http_1.sendError)(res, "forbidden", "Not a circle member");
                    return [2 /*return*/];
                }
                _c.label = 3;
            case 3: return [4 /*yield*/, Promise.all([
                    sc.from("circle_memberships").select("member_id").eq("owner_id", circleOwnerId),
                    sc.from("user_friendships").select("user_b").eq("user_a", user.id),
                    sc.from("user_friendships").select("user_a").eq("user_b", user.id),
                ])];
            case 4:
                _a = _c.sent(), memberships = _a[0].data, friendsAsA = _a[1].data, friendsAsB = _a[2].data;
                groupMemberIds = (memberships !== null && memberships !== void 0 ? memberships : [])
                    .map(function (m) { return m.member_id; })
                    .concat(!isOwner ? [circleOwnerId] : [])
                    .filter(function (id) { return id !== user.id; });
                groupMemberSet = new Set(groupMemberIds);
                otherFollowerIds = __spreadArray(__spreadArray([], (friendsAsA !== null && friendsAsA !== void 0 ? friendsAsA : []).map(function (r) { return r.user_b; }), true), (friendsAsB !== null && friendsAsB !== void 0 ? friendsAsB : []).map(function (r) { return r.user_a; }), true).filter(function (id) { return id !== user.id && !groupMemberSet.has(id); });
                allIds = __spreadArray(__spreadArray([], groupMemberIds, true), otherFollowerIds, true);
                profileMap = {};
                if (!(allIds.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, sc.from("profiles").select(PROFILE_PUBLIC).in("id", allIds)];
            case 5:
                profiles = (_c.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    profileMap[p.id] = p;
                }
                _c.label = 6;
            case 6:
                toUser = function (id) {
                    var _a;
                    var p = profileMap[id];
                    if (!p)
                        return null;
                    return { id: p.id, handle: p.handle, name: p.name, avatarUrl: (_a = p.avatar_url) !== null && _a !== void 0 ? _a : null };
                };
                res.status(200).json({
                    groupMembers: groupMemberIds.map(toUser).filter(Boolean),
                    otherFollowers: __spreadArray([], new Set(otherFollowerIds), true).map(toUser).filter(Boolean),
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/:userId/friend-status
 * ===========================================================================
 * Returns: none | outgoing_pending | incoming_pending | friends | self
 * requestId is included when status is *_pending (needed for accept/decline/cancel).
 */
router.get("/users/:userId/friend-status", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, targetId, sc, _a, ua, ub, friendship, outgoing, incomingReq;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                targetId = req.params.userId;
                if (!(0, friendDecisions_1.isUuid)(targetId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                if (user.id === targetId) {
                    res.status(200).json({ userId: targetId, status: "self" });
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                _a = (0, friendDecisions_1.normalizedFriendshipPair)(user.id, targetId), ua = _a[0], ub = _a[1];
                return [4 /*yield*/, sc
                        .from("user_friendships").select("user_a").eq("user_a", ua).eq("user_b", ub).maybeSingle()];
            case 2:
                friendship = (_b.sent()).data;
                if (friendship) {
                    res.status(200).json({ userId: targetId, status: "friends" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("friend_requests").select("id")
                        .eq("requester_id", user.id).eq("recipient_id", targetId).eq("status", "pending").maybeSingle()];
            case 3:
                outgoing = (_b.sent()).data;
                if (outgoing) {
                    res.status(200).json({ userId: targetId, status: "outgoing_pending", requestId: outgoing.id });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("friend_requests").select("id")
                        .eq("requester_id", targetId).eq("recipient_id", user.id).eq("status", "pending").maybeSingle()];
            case 4:
                incomingReq = (_b.sent()).data;
                if (incomingReq) {
                    res.status(200).json({ userId: targetId, status: "incoming_pending", requestId: incomingReq.id });
                    return [2 /*return*/];
                }
                res.status(200).json({ userId: targetId, status: "none" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /circle-invites  — invite someone to your trusted circle
 * ===========================================================================
 * Friendship makes inviting easier — but acceptance is the ONLY mechanism
 * that writes a circle_memberships row. This endpoint never does that.
 */
router.post("/circle-invites", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, recipientId, sc, existing, s, now, _a, invite, error;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                recipientId = (_b = req.body) === null || _b === void 0 ? void 0 : _b.recipientId;
                if (!recipientId || !(0, friendDecisions_1.isUuid)(recipientId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "recipientId must be a valid UUID");
                    return [2 /*return*/];
                }
                if (recipientId === user.id) {
                    (0, http_1.sendError)(res, "invalid_payload", "You cannot invite yourself to your circle");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("circle_invites").select("id, status")
                        .eq("owner_id", user.id).eq("recipient_id", recipientId).maybeSingle()];
            case 2:
                existing = (_c.sent()).data;
                if (!existing) return [3 /*break*/, 4];
                s = existing.status;
                if (s === "pending") {
                    res.status(200).json({ inviteId: existing.id, status: "pending", idempotent: true });
                    return [2 /*return*/];
                }
                if (s === "accepted") {
                    res.status(200).json({ inviteId: existing.id, status: "accepted" });
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("circle_invites").update({ status: "pending", responded_at: null }).eq("id", existing.id)];
            case 3:
                _c.sent();
                res.status(200).json({ inviteId: existing.id, status: "pending", reactivated: true });
                return [2 /*return*/];
            case 4: return [4 /*yield*/, sc
                    .from("circle_invites")
                    .insert({ owner_id: user.id, recipient_id: recipientId })
                    .select("id").single()];
            case 5:
                _a = _c.sent(), invite = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "circle_invites insert failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ inviteId: invite.id, status: "pending" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /circle-invites/:inviteId/accept
 * ===========================================================================
 * THIS IS THE ONLY PLACE that creates a circle_memberships row.
 * Friendship alone never does this.
 */
router.post("/circle-invites/:inviteId/accept", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, inviteId, sc, inv, now, cmErr;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                inviteId = req.params.inviteId;
                if (!(0, friendDecisions_1.isUuid)(inviteId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid invite id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("circle_invites").select("id, owner_id, recipient_id, status")
                        .eq("id", inviteId).maybeSingle()];
            case 2:
                inv = (_a.sent()).data;
                if (!inv) {
                    (0, http_1.sendError)(res, "not_found", "Circle invite not found");
                    return [2 /*return*/];
                }
                if (inv.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the recipient can accept this invite");
                    return [2 /*return*/];
                }
                if (inv.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Invite is already ".concat(inv.status));
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("circle_invites").update({ status: "accepted", responded_at: now }).eq("id", inviteId)];
            case 3:
                _a.sent();
                return [4 /*yield*/, sc
                        .from("circle_memberships")
                        .upsert({ owner_id: inv.owner_id, member_id: user.id, created_at: now })];
            case 4:
                cmErr = (_a.sent()).error;
                if (cmErr)
                    req.log.error({ err: cmErr }, "circle_memberships upsert failed after invite accept");
                // Fire-and-forget: sync group chat membership for this circle.
                (0, chatSync_1.syncCircleChatMembers)(inv.owner_id, sc).catch(function (e) { return req.log.error({ err: e }, "syncCircleChatMembers failed"); });
                res.status(200).json({ status: "accepted", ownerId: inv.owner_id });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /circle-invites/:inviteId/decline
 * ===========================================================================
 */
router.post("/circle-invites/:inviteId/decline", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, inviteId, sc, inv, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                inviteId = req.params.inviteId;
                if (!(0, friendDecisions_1.isUuid)(inviteId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid invite id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("circle_invites").select("id, recipient_id, status")
                        .eq("id", inviteId).maybeSingle()];
            case 2:
                inv = (_a.sent()).data;
                if (!inv) {
                    (0, http_1.sendError)(res, "not_found", "Circle invite not found");
                    return [2 /*return*/];
                }
                if (inv.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the recipient can decline this invite");
                    return [2 /*return*/];
                }
                if (inv.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Invite is already ".concat(inv.status));
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("circle_invites").update({ status: "declined", responded_at: now }).eq("id", inviteId)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "declined" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * DELETE /circles/:circleOwnerId/members/:memberId
 * Only the circle owner may remove an accepted member.
 * Immediately sets left_at on the member's chat thread row via sync.
 * ===========================================================================
 */
router.delete("/circles/:circleOwnerId/members/:memberId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, _a, circleOwnerId, memberId, membership;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                _a = req.params, circleOwnerId = _a.circleOwnerId, memberId = _a.memberId;
                if (!(0, friendDecisions_1.isUuid)(circleOwnerId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid circleOwnerId");
                    return [2 /*return*/];
                }
                if (!(0, friendDecisions_1.isUuid)(memberId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid memberId");
                    return [2 /*return*/];
                }
                if (user.id !== circleOwnerId) {
                    (0, http_1.sendError)(res, "forbidden", "Only the circle owner may remove members");
                    return [2 /*return*/];
                }
                if (memberId === circleOwnerId) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot remove yourself from your own circle");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", circleOwnerId)
                        .eq("member_id", memberId)
                        .maybeSingle()];
            case 2:
                membership = (_b.sent()).data;
                if (!membership) {
                    (0, http_1.sendError)(res, "not_found", "Membership not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("circle_memberships").delete().eq("owner_id", circleOwnerId).eq("member_id", memberId)];
            case 3:
                _b.sent();
                res.status(200).json({ status: "removed", memberId: memberId });
                // Immediately revoke chat access by syncing — sets left_at for the removed member.
                (0, chatSync_1.syncCircleChatMembers)(circleOwnerId, sc).catch(function () { });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
