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
var express_1 = require("express");
var http_1 = require("../lib/http");
var telegraphEvents_1 = require("../lib/telegraphEvents");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
/* ===========================================================================
 * POST /users/:userId/block  — block a user
 * ===========================================================================
 * Inserts a block row, then removes all follow edges between the two users.
 * Idempotent: blocking someone already blocked returns 200.
 */
router.post("/users/:userId/block", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, target, blockErr;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                target = req.params.userId;
                if (!UUID.test(target)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                if (target === user.id) {
                    (0, http_1.sendError)(res, "invalid_payload", "You cannot block yourself");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("blocks")
                        .upsert({ blocker_id: user.id, blocked_id: target }, { onConflict: "blocker_id,blocked_id", ignoreDuplicates: true })];
            case 2:
                blockErr = (_a.sent()).error;
                if (blockErr) {
                    req.log.error({ err: blockErr }, "Failed to insert block");
                    (0, http_1.sendError)(res, "db_error", blockErr.message);
                    return [2 /*return*/];
                }
                // Remove all follow edges between the two users (both directions) — fire-and-forget errors
                return [4 /*yield*/, Promise.all([
                        client.from("user_follows").delete().eq("follower_id", user.id).eq("following_id", target),
                        client.from("user_follows").delete().eq("follower_id", target).eq("following_id", user.id),
                        // Also remove any pending friend requests between them
                        client.from("friend_requests").delete()
                            .or("and(from_user.eq.".concat(user.id, ",to_user.eq.").concat(target, "),and(from_user.eq.").concat(target, ",to_user.eq.").concat(user.id, ")")),
                        // Remove friendship if it exists
                        client.from("user_friendships").delete()
                            .or("and(user_a.eq.".concat(user.id, ",user_b.eq.").concat(target, "),and(user_a.eq.").concat(target, ",user_b.eq.").concat(user.id, ")")),
                    ]).catch(function (e) { return req.log.warn({ err: e }, "cleanup after block partially failed"); })];
            case 3:
                // Remove all follow edges between the two users (both directions) — fire-and-forget errors
                _a.sent();
                res.status(200).json({ blocked: true, userId: target });
                // Realtime: let the blocker's other sessions refresh (threads/follow state
                // may have changed). Not sent to the blocked user.
                void (0, telegraphEvents_1.publishToUsers)([user.id], {
                    type: "user.blocked",
                    payload: { blockedId: target },
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * DELETE /users/:userId/block  — unblock a user
 * ===========================================================================
 */
router.delete("/users/:userId/block", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, target, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                target = req.params.userId;
                if (!UUID.test(target)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                if (target === user.id) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid request");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("blocks")
                        .delete()
                        .eq("blocker_id", user.id)
                        .eq("blocked_id", target)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to delete block");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ blocked: false, userId: target });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/blocks  — list users I have blocked
 * ===========================================================================
 * Returns id, handle, name, avatarUrl for each blocked user.
 */
router.get("/me/blocks", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, rows, error, ids, _b, profiles, profErr, profileMap, _i, _c, p;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                return [4 /*yield*/, client
                        .from("blocks")
                        .select("blocked_id, created_at")
                        .eq("blocker_id", user.id)
                        .order("created_at", { ascending: false })
                        .limit(500)];
            case 2:
                _a = _d.sent(), rows = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to fetch block list");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                ids = (rows !== null && rows !== void 0 ? rows : []).map(function (r) { return r.blocked_id; });
                if (ids.length === 0) {
                    res.status(200).json({ blocked: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", ids)];
            case 3:
                _b = _d.sent(), profiles = _b.data, profErr = _b.error;
                if (profErr) {
                    req.log.error({ err: profErr }, "Failed to fetch blocked profiles");
                    (0, http_1.sendError)(res, "db_error", profErr.message);
                    return [2 /*return*/];
                }
                profileMap = {};
                for (_i = 0, _c = profiles !== null && profiles !== void 0 ? profiles : []; _i < _c.length; _i++) {
                    p = _c[_i];
                    profileMap[p.id] = p;
                }
                res.status(200).json({
                    blocked: (rows !== null && rows !== void 0 ? rows : []).map(function (r) {
                        var _a, _b, _c, _d;
                        var p = (_a = profileMap[r.blocked_id]) !== null && _a !== void 0 ? _a : {};
                        return {
                            id: r.blocked_id,
                            handle: (_b = p.handle) !== null && _b !== void 0 ? _b : null,
                            name: (_c = p.name) !== null && _c !== void 0 ? _c : null,
                            avatarUrl: (_d = p.avatar_url) !== null && _d !== void 0 ? _d : null,
                            blockedAt: r.created_at,
                        };
                    }),
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/:userId/block-status  — am I blocking or blocked by this user?
 * ===========================================================================
 */
router.get("/users/:userId/block-status", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, target, _a, iBlocked, theyBlocked;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                target = req.params.userId;
                if (!UUID.test(target)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        client.from("blocks").select("blocked_id").eq("blocker_id", user.id).eq("blocked_id", target).maybeSingle(),
                        client.from("blocks").select("blocked_id").eq("blocker_id", target).eq("blocked_id", user.id).maybeSingle(),
                    ])];
            case 2:
                _a = _b.sent(), iBlocked = _a[0], theyBlocked = _a[1];
                res.status(200).json({
                    userId: target,
                    iBlocked: Boolean(iBlocked.data),
                    theyBlockedMe: Boolean(theyBlocked.data),
                });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
