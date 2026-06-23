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
var followDecisions_1 = require("../lib/followDecisions");
var router = (0, express_1.Router)();
/* Helper: does a profile exist? (service-role read) */
function profileExists(client, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, client.from("profiles").select("id").eq("id", userId).maybeSingle()];
                case 1:
                    _a = _b.sent(), data = _a.data, error = _a.error;
                    if (error)
                        return [2 /*return*/, false];
                    return [2 /*return*/, Boolean(data)];
            }
        });
    });
}
/* ===========================================================================
 * POST /users/:userId/follow  — follow a user
 * ===========================================================================
 * follower is the verified user (never client-supplied). No self-follow.
 * A follow grants NOTHING sensitive — it only inserts a social edge.
 */
router.post("/users/:userId/follow", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, target, targetExists, _a, decision, map, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                target = req.params.userId;
                if (!(0, followDecisions_1.isUuid)(target)) return [3 /*break*/, 3];
                return [4 /*yield*/, profileExists(client, target)];
            case 2:
                _a = _b.sent();
                return [3 /*break*/, 4];
            case 3:
                _a = false;
                _b.label = 4;
            case 4:
                targetExists = _a;
                decision = (0, followDecisions_1.decideFollow)(user.id, target, { targetExists: targetExists, blocked: false });
                if (!decision.ok) {
                    map = {
                        unauthenticated: "unauthenticated",
                        invalid_payload: "invalid_payload",
                        cannot_follow_self: "invalid_payload",
                        not_found: "not_found",
                        blocked: "forbidden",
                    };
                    (0, http_1.sendError)(res, map[decision.code], decision.code === "cannot_follow_self" ? "You cannot follow yourself" : undefined);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("user_follows")
                        .upsert({ follower_id: user.id, following_id: target }, { onConflict: "follower_id,following_id", ignoreDuplicates: true })];
            case 5:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to follow");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ following: true, userId: target });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * DELETE /users/:userId/follow  — unfollow
 * ===========================================================================
 */
router.delete("/users/:userId/follow", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, target, decision, error;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                target = req.params.userId;
                decision = (0, followDecisions_1.decideUnfollow)(user.id, target);
                if (!decision.ok) {
                    (0, http_1.sendError)(res, decision.code === "unauthenticated" ? "unauthenticated" : "invalid_payload");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("user_follows")
                        .delete()
                        .eq("follower_id", user.id) // only your own follow row
                        .eq("following_id", target)];
            case 2:
                error = (_a.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "Failed to unfollow");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ following: false, userId: target });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/:userId/follow-status  — am I following this user? + counts
 * ===========================================================================
 */
router.get("/users/:userId/follow-status", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, target, _a, mine, followers, following;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                target = req.params.userId;
                if (!(0, followDecisions_1.isUuid)(target)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        client.from("user_follows").select("follower_id").eq("follower_id", user.id).eq("following_id", target).maybeSingle(),
                        client.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
                        client.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
                    ])];
            case 2:
                _a = _d.sent(), mine = _a[0], followers = _a[1], following = _a[2];
                res.status(200).json({
                    userId: target,
                    isFollowing: Boolean(mine.data),
                    followersCount: (_b = followers.count) !== null && _b !== void 0 ? _b : 0,
                    followingCount: (_c = following.count) !== null && _c !== void 0 ? _c : 0,
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/following  — users I follow
 * GET /me/followers  — users who follow me
 * ===========================================================================
 * Returns ONLY the social edge + public profile basics (id, handle, name,
 * avatar). Never private content.
 */
var PUBLIC_PROFILE = "id, handle, name, avatar_url";
router.get("/me/following", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
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
                        .from("user_follows")
                        .select("following_id, created_at, profile:profiles!user_follows_following_id_fkey(".concat(PUBLIC_PROFILE, ")"))
                        .eq("follower_id", user.id)
                        .order("created_at", { ascending: false })
                        .limit(200)];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "following list failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ users: (data !== null && data !== void 0 ? data : []).map(rowToUser) });
                return [2 /*return*/];
        }
    });
}); });
router.get("/me/followers", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
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
                        .from("user_follows")
                        .select("follower_id, created_at, profile:profiles!user_follows_follower_id_fkey(".concat(PUBLIC_PROFILE, ")"))
                        .eq("following_id", user.id)
                        .order("created_at", { ascending: false })
                        .limit(200)];
            case 2:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "followers list failed");
                    (0, http_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(200).json({ users: (data !== null && data !== void 0 ? data : []).map(rowToUser) });
                return [2 /*return*/];
        }
    });
}); });
function rowToUser(r) {
    var _a, _b;
    var p = (_a = r.profile) !== null && _a !== void 0 ? _a : {};
    return { id: p.id, handle: p.handle, name: p.name, avatarUrl: (_b = p.avatar_url) !== null && _b !== void 0 ? _b : null, since: r.created_at };
}
exports.default = router;
