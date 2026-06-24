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
    var auth, client, user, target, targetExists, _a, blocked, blockRow, decision, map, error;
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
                blocked = false;
                if (!targetExists) return [3 /*break*/, 6];
                return [4 /*yield*/, client
                        .from("blocks")
                        .select("blocker_id")
                        .or("and(blocker_id.eq.".concat(user.id, ",blocked_id.eq.").concat(target, "),and(blocker_id.eq.").concat(target, ",blocked_id.eq.").concat(user.id, ")"))
                        .limit(1)
                        .maybeSingle()];
            case 5:
                blockRow = (_b.sent()).data;
                blocked = Boolean(blockRow);
                _b.label = 6;
            case 6:
                decision = (0, followDecisions_1.decideFollow)(user.id, target, { targetExists: targetExists, blocked: blocked });
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
            case 7:
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
/* ===========================================================================
 * GET /users/search  — search travelers by name or @username
 * ===========================================================================
 * ?q=<query>&limit=<n>
 * Excludes the calling user. Blocked users excluded when the user_blocks
 * table is available (graceful no-op if not). Private profiles appear in
 * results with minimal info (name, avatar, isPrivate=true); no follow action.
 */
router.get("/users/search", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, raw, q, limit, pattern, getServiceClient, sc, _a, profiles, profErr, rows, ids, blockedSet, blockQueryFailed, _b, blockRows, blockErr, isTableMissing, _i, _c, b, e_1, _d, followerEdgesRes, myFollowsRes, followerCounts, _e, _f, e, fid, followingSet, users;
    var _g, _h, _j, _k, _l, _m, _o;
    return __generator(this, function (_p) {
        switch (_p.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _p.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                raw = (_h = (_g = req.query.q) === null || _g === void 0 ? void 0 : _g.trim()) !== null && _h !== void 0 ? _h : "";
                q = raw.startsWith("@") ? raw.slice(1).trim() : raw;
                if (!q) {
                    res.status(200).json({ users: [] });
                    return [2 /*return*/];
                }
                limit = Math.min(Math.max(parseInt((_j = req.query.limit) !== null && _j !== void 0 ? _j : "20", 10) || 20, 1), 50);
                pattern = "%".concat(q.replace(/[%_]/g, "\\$&"), "%");
                return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/supabase"); })];
            case 2:
                getServiceClient = (_p.sent()).getServiceClient;
                sc = getServiceClient();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select("id, handle, name, avatar_url, is_private")
                        .or("name.ilike.".concat(pattern, ",handle.ilike.").concat(pattern))
                        .neq("id", user.id)
                        .limit(limit)];
            case 3:
                _a = _p.sent(), profiles = _a.data, profErr = _a.error;
                if (profErr) {
                    req.log.error({ err: profErr }, "user search failed");
                    (0, http_1.sendError)(res, "db_error", profErr.message);
                    return [2 /*return*/];
                }
                rows = profiles !== null && profiles !== void 0 ? profiles : [];
                if (rows.length === 0) {
                    res.status(200).json({ users: [] });
                    return [2 /*return*/];
                }
                ids = rows.map(function (p) { return p.id; });
                blockedSet = new Set();
                blockQueryFailed = false;
                _p.label = 4;
            case 4:
                _p.trys.push([4, 6, , 7]);
                return [4 /*yield*/, sc
                        .from("user_blocks")
                        .select("blocked_id, blocker_id")
                        .or("blocker_id.eq.".concat(user.id, ",blocked_id.eq.").concat(user.id))];
            case 5:
                _b = _p.sent(), blockRows = _b.data, blockErr = _b.error;
                if (blockErr) {
                    isTableMissing = blockErr.code === "42P01" ||
                        blockErr.code === "PGRST204" ||
                        ((_k = blockErr.message) !== null && _k !== void 0 ? _k : "").toLowerCase().includes("does not exist");
                    if (!isTableMissing) {
                        blockQueryFailed = true;
                        req.log.warn({ err: blockErr }, "user_blocks query failed; suppressing results");
                    }
                }
                else {
                    for (_i = 0, _c = (blockRows !== null && blockRows !== void 0 ? blockRows : []); _i < _c.length; _i++) {
                        b = _c[_i];
                        if (b.blocker_id === user.id)
                            blockedSet.add(b.blocked_id);
                        else
                            blockedSet.add(b.blocker_id);
                    }
                }
                return [3 /*break*/, 7];
            case 6:
                e_1 = _p.sent();
                // Network-level or unexpected error — fail safe.
                blockQueryFailed = true;
                req.log.warn({ err: e_1 }, "user_blocks query threw; suppressing results");
                return [3 /*break*/, 7];
            case 7:
                if (blockQueryFailed) {
                    res.status(200).json({ users: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc.from("user_follows").select("following_id").in("following_id", ids),
                        sc.from("user_follows").select("following_id").eq("follower_id", user.id).in("following_id", ids),
                    ])];
            case 8:
                _d = _p.sent(), followerEdgesRes = _d[0], myFollowsRes = _d[1];
                followerCounts = {};
                for (_e = 0, _f = ((_l = followerEdgesRes.data) !== null && _l !== void 0 ? _l : []); _e < _f.length; _e++) {
                    e = _f[_e];
                    fid = e.following_id;
                    followerCounts[fid] = ((_m = followerCounts[fid]) !== null && _m !== void 0 ? _m : 0) + 1;
                }
                followingSet = new Set(((_o = myFollowsRes.data) !== null && _o !== void 0 ? _o : []).map(function (e) { return e.following_id; }));
                users = rows
                    .filter(function (p) { return !blockedSet.has(p.id); })
                    .map(function (p) {
                    var _a, _b, _c, _d, _e;
                    return ({
                        id: p.id,
                        displayName: (_a = p.name) !== null && _a !== void 0 ? _a : null,
                        username: (_b = p.handle) !== null && _b !== void 0 ? _b : null,
                        avatarUrl: (_c = p.avatar_url) !== null && _c !== void 0 ? _c : null,
                        followerCount: (_d = followerCounts[p.id]) !== null && _d !== void 0 ? _d : 0,
                        isFollowing: followingSet.has(p.id),
                        isPrivate: (_e = p.is_private) !== null && _e !== void 0 ? _e : false,
                    });
                });
                res.status(200).json({ users: users });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/:userId  — public profile for Passport page
 * ===========================================================================
 * Returns safe public fields + follower/following counts + isFollowing state.
 * Auth optional: unauthenticated callers get counts but isFollowing=false.
 * Never returns private posts, trips, circle memberships, or location data.
 */
var PUBLIC_PASSPORT_FIELDS = "id, handle, name, avatar_url, bio, home_city, home_country, current_city, travel_style, interests, verified, verification_status, verified_at, open_to_meet, is_private, created_at, spoken_languages, default_language, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, availability_tags, planning_style";
router.get("/users/:userId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var target, authHeader, token, getServiceClient, sc, callerId, data, _a, profileRes, followersRes, followingRes, isFollowing, edge, p;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2;
    return __generator(this, function (_3) {
        switch (_3.label) {
            case 0:
                target = req.params.userId;
                if (!(0, followDecisions_1.isUuid)(target)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid user id");
                    return [2 /*return*/];
                }
                authHeader = req.headers.authorization;
                token = (authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer ")) ? authHeader.slice(7).trim() : null;
                return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/supabase"); })];
            case 1:
                getServiceClient = (_3.sent()).getServiceClient;
                sc = getServiceClient();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                callerId = null;
                if (!token) return [3 /*break*/, 3];
                return [4 /*yield*/, sc.auth.getUser(token)];
            case 2:
                data = (_3.sent()).data;
                callerId = (_c = (_b = data === null || data === void 0 ? void 0 : data.user) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : null;
                _3.label = 3;
            case 3: return [4 /*yield*/, Promise.all([
                    sc.from("profiles").select(PUBLIC_PASSPORT_FIELDS).eq("id", target).maybeSingle(),
                    sc.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
                    sc.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
                ])];
            case 4:
                _a = _3.sent(), profileRes = _a[0], followersRes = _a[1], followingRes = _a[2];
                if (profileRes.error || !profileRes.data) {
                    (0, http_1.sendError)(res, "not_found", "User not found");
                    return [2 /*return*/];
                }
                isFollowing = false;
                if (!(callerId && callerId !== target)) return [3 /*break*/, 6];
                return [4 /*yield*/, sc
                        .from("user_follows")
                        .select("follower_id")
                        .eq("follower_id", callerId)
                        .eq("following_id", target)
                        .maybeSingle()];
            case 5:
                edge = (_3.sent()).data;
                isFollowing = Boolean(edge);
                _3.label = 6;
            case 6:
                p = profileRes.data;
                res.status(200).json({
                    id: p.id,
                    handle: p.handle,
                    name: p.name,
                    avatarUrl: (_d = p.avatar_url) !== null && _d !== void 0 ? _d : null,
                    bio: (_e = p.bio) !== null && _e !== void 0 ? _e : null,
                    homeCity: (_f = p.home_city) !== null && _f !== void 0 ? _f : null,
                    homeCountry: (_g = p.home_country) !== null && _g !== void 0 ? _g : null,
                    currentCity: (_h = p.current_city) !== null && _h !== void 0 ? _h : null,
                    travelStyle: (_j = p.travel_style) !== null && _j !== void 0 ? _j : null,
                    interests: (_k = p.interests) !== null && _k !== void 0 ? _k : [],
                    verified: (_l = p.verified) !== null && _l !== void 0 ? _l : false,
                    verificationStatus: (_m = p.verification_status) !== null && _m !== void 0 ? _m : 'unverified',
                    verifiedAt: (_o = p.verified_at) !== null && _o !== void 0 ? _o : null,
                    openToMeet: (_p = p.open_to_meet) !== null && _p !== void 0 ? _p : false,
                    isPrivate: (_q = p.is_private) !== null && _q !== void 0 ? _q : false,
                    memberSince: p.created_at,
                    followersCount: (_r = followersRes.count) !== null && _r !== void 0 ? _r : 0,
                    followingCount: (_s = followingRes.count) !== null && _s !== void 0 ? _s : 0,
                    isFollowing: isFollowing,
                    isOwnProfile: callerId === target,
                    spokenLanguages: (_t = p.spoken_languages) !== null && _t !== void 0 ? _t : [],
                    defaultLanguage: (_u = p.default_language) !== null && _u !== void 0 ? _u : null,
                    travelStyles: (_v = p.travel_styles) !== null && _v !== void 0 ? _v : [],
                    travelPace: (_w = p.travel_pace) !== null && _w !== void 0 ? _w : null,
                    budgetStyle: (_x = p.budget_style) !== null && _x !== void 0 ? _x : null,
                    travelGroupStyle: (_y = p.travel_group_style) !== null && _y !== void 0 ? _y : [],
                    lookingFor: (_z = p.looking_for) !== null && _z !== void 0 ? _z : [],
                    comfortLevel: (_0 = p.comfort_level) !== null && _0 !== void 0 ? _0 : null,
                    availabilityTags: (_1 = p.availability_tags) !== null && _1 !== void 0 ? _1 : [],
                    planningStyle: (_2 = p.planning_style) !== null && _2 !== void 0 ? _2 : null,
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /users/by-handle/:handle  — look up a public profile by handle
 * ===========================================================================
 * Same response shape as GET /users/:userId. Handle lookup is case-insensitive.
 * Used by the profile page which routes by handle, not UUID.
 */
router.get("/users/by-handle/:handle", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var handle, authHeader, token, getServiceClient, sc, callerId, data, profileRes, target, _a, followersRes, followingRes, isFollowing, edge, p;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3;
    return __generator(this, function (_4) {
        switch (_4.label) {
            case 0:
                handle = (_b = req.params.handle) === null || _b === void 0 ? void 0 : _b.toLowerCase().trim();
                if (!handle) {
                    (0, http_1.sendError)(res, "invalid_payload", "handle is required");
                    return [2 /*return*/];
                }
                authHeader = req.headers.authorization;
                token = (authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer ")) ? authHeader.slice(7).trim() : null;
                return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/supabase"); })];
            case 1:
                getServiceClient = (_4.sent()).getServiceClient;
                sc = getServiceClient();
                if (!sc) {
                    (0, http_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                callerId = null;
                if (!token) return [3 /*break*/, 3];
                return [4 /*yield*/, sc.auth.getUser(token)];
            case 2:
                data = (_4.sent()).data;
                callerId = (_d = (_c = data === null || data === void 0 ? void 0 : data.user) === null || _c === void 0 ? void 0 : _c.id) !== null && _d !== void 0 ? _d : null;
                _4.label = 3;
            case 3: return [4 /*yield*/, sc
                    .from("profiles")
                    .select(PUBLIC_PASSPORT_FIELDS)
                    .ilike("handle", handle)
                    .maybeSingle()];
            case 4:
                profileRes = _4.sent();
                if (profileRes.error || !profileRes.data) {
                    (0, http_1.sendError)(res, "not_found", "User not found");
                    return [2 /*return*/];
                }
                target = profileRes.data.id;
                return [4 /*yield*/, Promise.all([
                        sc.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
                        sc.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
                    ])];
            case 5:
                _a = _4.sent(), followersRes = _a[0], followingRes = _a[1];
                isFollowing = false;
                if (!(callerId && callerId !== target)) return [3 /*break*/, 7];
                return [4 /*yield*/, sc
                        .from("user_follows").select("follower_id")
                        .eq("follower_id", callerId).eq("following_id", target).maybeSingle()];
            case 6:
                edge = (_4.sent()).data;
                isFollowing = Boolean(edge);
                _4.label = 7;
            case 7:
                p = profileRes.data;
                res.status(200).json({
                    id: p.id,
                    handle: p.handle,
                    name: p.name,
                    avatarUrl: (_e = p.avatar_url) !== null && _e !== void 0 ? _e : null,
                    bio: (_f = p.bio) !== null && _f !== void 0 ? _f : null,
                    homeCity: (_g = p.home_city) !== null && _g !== void 0 ? _g : null,
                    homeCountry: (_h = p.home_country) !== null && _h !== void 0 ? _h : null,
                    currentCity: (_j = p.current_city) !== null && _j !== void 0 ? _j : null,
                    travelStyle: (_k = p.travel_style) !== null && _k !== void 0 ? _k : null,
                    interests: (_l = p.interests) !== null && _l !== void 0 ? _l : [],
                    verified: (_m = p.verified) !== null && _m !== void 0 ? _m : false,
                    verificationStatus: (_o = p.verification_status) !== null && _o !== void 0 ? _o : 'unverified',
                    verifiedAt: (_p = p.verified_at) !== null && _p !== void 0 ? _p : null,
                    openToMeet: (_q = p.open_to_meet) !== null && _q !== void 0 ? _q : false,
                    isPrivate: (_r = p.is_private) !== null && _r !== void 0 ? _r : false,
                    memberSince: p.created_at,
                    followersCount: (_s = followersRes.count) !== null && _s !== void 0 ? _s : 0,
                    followingCount: (_t = followingRes.count) !== null && _t !== void 0 ? _t : 0,
                    isFollowing: isFollowing,
                    isOwnProfile: callerId === target,
                    spokenLanguages: (_u = p.spoken_languages) !== null && _u !== void 0 ? _u : [],
                    defaultLanguage: (_v = p.default_language) !== null && _v !== void 0 ? _v : null,
                    travelStyles: (_w = p.travel_styles) !== null && _w !== void 0 ? _w : [],
                    travelPace: (_x = p.travel_pace) !== null && _x !== void 0 ? _x : null,
                    budgetStyle: (_y = p.budget_style) !== null && _y !== void 0 ? _y : null,
                    travelGroupStyle: (_z = p.travel_group_style) !== null && _z !== void 0 ? _z : [],
                    lookingFor: (_0 = p.looking_for) !== null && _0 !== void 0 ? _0 : [],
                    comfortLevel: (_1 = p.comfort_level) !== null && _1 !== void 0 ? _1 : null,
                    availabilityTags: (_2 = p.availability_tags) !== null && _2 !== void 0 ? _2 : [],
                    planningStyle: (_3 = p.planning_style) !== null && _3 !== void 0 ? _3 : null,
                });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
