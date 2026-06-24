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
var zod_1 = require("zod");
var supabase_1 = require("../lib/supabase");
var http_js_1 = require("../lib/http.js");
var plan_js_1 = require("./plan.js");
var chatSync_js_1 = require("../lib/chatSync.js");
var router = (0, express_1.Router)();
router.post("/trips", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var authHeader, token, client, _a, user, authError, _b, title, destinationCity, destinationCountry, startDate, endDate, status, visibility, coverUrl, _c, data, error, newTripId;
    var _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0:
                if (!supabase_1.isServiceClientReady) {
                    res.status(503).json({ error: "Server not configured: SUPABASE_SERVICE_ROLE_KEY is missing" });
                    return [2 /*return*/];
                }
                authHeader = req.headers.authorization;
                if (!(authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer "))) {
                    res.status(401).json({ error: "Missing Authorization header" });
                    return [2 /*return*/];
                }
                token = authHeader.slice(7);
                client = (0, supabase_1.getServiceClient)();
                return [4 /*yield*/, client.auth.getUser(token)];
            case 1:
                _a = _e.sent(), user = _a.data.user, authError = _a.error;
                if (authError || !user) {
                    res.status(401).json({ error: (_d = authError === null || authError === void 0 ? void 0 : authError.message) !== null && _d !== void 0 ? _d : "Invalid or expired token" });
                    return [2 /*return*/];
                }
                _b = req.body, title = _b.title, destinationCity = _b.destinationCity, destinationCountry = _b.destinationCountry, startDate = _b.startDate, endDate = _b.endDate, status = _b.status, visibility = _b.visibility, coverUrl = _b.coverUrl;
                if (!title || !destinationCity) {
                    res.status(400).json({ error: "title and destinationCity are required" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trips")
                        .insert({
                        owner_id: user.id,
                        title: title,
                        destination_city: destinationCity,
                        destination_country: destinationCountry !== null && destinationCountry !== void 0 ? destinationCountry : null,
                        start_date: startDate !== null && startDate !== void 0 ? startDate : null,
                        end_date: endDate !== null && endDate !== void 0 ? endDate : null,
                        status: status !== null && status !== void 0 ? status : "planning",
                        visibility: visibility !== null && visibility !== void 0 ? visibility : "private",
                        cover_url: coverUrl !== null && coverUrl !== void 0 ? coverUrl : null,
                    })
                        .select("*")
                        .single()];
            case 2:
                _c = _e.sent(), data = _c.data, error = _c.error;
                if (error) {
                    req.log.error({ err: error }, "Failed to insert trip");
                    res.status(500).json({ error: error.message });
                    return [2 /*return*/];
                }
                res.status(201).json(data);
                newTripId = data === null || data === void 0 ? void 0 : data.id;
                if (newTripId) {
                    (0, chatSync_js_1.syncTripChatMembers)(newTripId, client).catch(function () { });
                }
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /trips/:tripId/members  — list accepted trip members (for invite picker)
 * ===========================================================================
 * Returns profiles of all accepted members (role = owner|member), excluding
 * the caller. Caller must be an accepted trip member themselves.
 */
router.get("/trips/:tripId/members", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, ok, sc, _a, rows, rowsErr, memberIds, invitedIds, allIds, _b, profiles, profErr, profileMap, _i, _c, p, toUser;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                ok = _d.sent();
                if (!ok) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a trip member");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("trip_members")
                        .select("user_id, role")
                        .eq("trip_id", tripId)
                        .in("role", ["owner", "member", "invited"])];
            case 3:
                _a = _d.sent(), rows = _a.data, rowsErr = _a.error;
                if (rowsErr) {
                    (0, http_js_1.sendError)(res, "db_error", rowsErr.message);
                    return [2 /*return*/];
                }
                memberIds = (rows !== null && rows !== void 0 ? rows : [])
                    .filter(function (r) { return r.role === "owner" || r.role === "member"; })
                    .map(function (r) { return r.user_id; })
                    .filter(function (id) { return id !== user.id; });
                invitedIds = (rows !== null && rows !== void 0 ? rows : [])
                    .filter(function (r) { return r.role === "invited"; })
                    .map(function (r) { return r.user_id; })
                    .filter(function (id) { return id !== user.id; });
                allIds = __spreadArray(__spreadArray([], memberIds, true), invitedIds, true);
                if (allIds.length === 0) {
                    res.status(200).json({ members: [], invited: [] });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", allIds)];
            case 4:
                _b = _d.sent(), profiles = _b.data, profErr = _b.error;
                if (profErr) {
                    (0, http_js_1.sendError)(res, "db_error", profErr.message);
                    return [2 /*return*/];
                }
                profileMap = {};
                for (_i = 0, _c = profiles !== null && profiles !== void 0 ? profiles : []; _i < _c.length; _i++) {
                    p = _c[_i];
                    profileMap[p.id] = p;
                }
                toUser = function (id) {
                    var _a, _b, _c;
                    var p = profileMap[id];
                    return {
                        id: id,
                        handle: (_a = p === null || p === void 0 ? void 0 : p.handle) !== null && _a !== void 0 ? _a : "",
                        name: (_b = p === null || p === void 0 ? void 0 : p.name) !== null && _b !== void 0 ? _b : "",
                        avatarUrl: (_c = p === null || p === void 0 ? void 0 : p.avatar_url) !== null && _c !== void 0 ? _c : null,
                    };
                };
                res.status(200).json({
                    members: memberIds.map(toUser),
                    invited: invitedIds.map(toUser),
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /trips/:tripId/invitable-users  — grouped invite picker data
 * ===========================================================================
 * Returns trip members (groupMembers) + caller's friends not in the trip
 * (otherFollowers), so the invite picker can render two labelled sections.
 * Caller must be an accepted trip member.
 */
router.get("/trips/:tripId/invitable-users", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, tripId, sc, membership, _a, memberRows, friendsAsA, friendsAsB, groupMemberIds, groupMemberSet, otherFollowerIds, allIds, profileMap, profiles, _i, _b, p, toUser;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _c.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.requireTripMember)(sc, tripId, user.id)];
            case 2:
                membership = _c.sent();
                if (!membership) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a trip member");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, Promise.all([
                        sc.from("trip_members").select("user_id").eq("trip_id", tripId).in("role", ["owner", "member"]),
                        sc.from("user_friendships").select("user_b").eq("user_a", user.id),
                        sc.from("user_friendships").select("user_a").eq("user_b", user.id),
                    ])];
            case 3:
                _a = _c.sent(), memberRows = _a[0].data, friendsAsA = _a[1].data, friendsAsB = _a[2].data;
                groupMemberIds = (memberRows !== null && memberRows !== void 0 ? memberRows : [])
                    .map(function (r) { return r.user_id; })
                    .filter(function (id) { return id !== user.id; });
                groupMemberSet = new Set(groupMemberIds);
                otherFollowerIds = __spreadArray(__spreadArray([], (friendsAsA !== null && friendsAsA !== void 0 ? friendsAsA : []).map(function (r) { return r.user_b; }), true), (friendsAsB !== null && friendsAsB !== void 0 ? friendsAsB : []).map(function (r) { return r.user_a; }), true).filter(function (id) { return id !== user.id && !groupMemberSet.has(id); });
                allIds = __spreadArray(__spreadArray([], groupMemberIds, true), otherFollowerIds, true);
                profileMap = {};
                if (!(allIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc.from("profiles").select("id, handle, name, avatar_url").in("id", allIds)];
            case 4:
                profiles = (_c.sent()).data;
                for (_i = 0, _b = profiles !== null && profiles !== void 0 ? profiles : []; _i < _b.length; _i++) {
                    p = _b[_i];
                    profileMap[p.id] = p;
                }
                _c.label = 5;
            case 5:
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
 * GET /me/trip-invites/pending  — list pending trip invitations for the caller
 * ===========================================================================
 * Returns every trip_members row where role = 'invited' for the current user,
 * enriched with trip details (name, destination, dates) and inviter profile.
 */
router.get("/me/trip-invites/pending", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, sc, _a, inviteRows, invErr, tripIds, _b, trips, tripsErr, tripMap, _i, _c, t, ownerIds, profileMap, profiles, _d, _e, p, invites;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _f.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("trip_members")
                        .select("trip_id, created_at")
                        .eq("user_id", user.id)
                        .eq("role", "invited")];
            case 2:
                _a = _f.sent(), inviteRows = _a.data, invErr = _a.error;
                if (invErr) {
                    (0, http_js_1.sendError)(res, "db_error", invErr.message);
                    return [2 /*return*/];
                }
                if (!inviteRows || inviteRows.length === 0) {
                    res.status(200).json({ invites: [] });
                    return [2 /*return*/];
                }
                tripIds = inviteRows.map(function (r) { return r.trip_id; });
                return [4 /*yield*/, sc
                        .from("trips")
                        .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id")
                        .in("id", tripIds)];
            case 3:
                _b = _f.sent(), trips = _b.data, tripsErr = _b.error;
                if (tripsErr) {
                    (0, http_js_1.sendError)(res, "db_error", tripsErr.message);
                    return [2 /*return*/];
                }
                tripMap = {};
                for (_i = 0, _c = trips !== null && trips !== void 0 ? trips : []; _i < _c.length; _i++) {
                    t = _c[_i];
                    tripMap[t.id] = t;
                }
                ownerIds = __spreadArray([], new Set((trips !== null && trips !== void 0 ? trips : []).map(function (t) { return t.owner_id; })), true);
                profileMap = {};
                if (!(ownerIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", ownerIds)];
            case 4:
                profiles = (_f.sent()).data;
                for (_d = 0, _e = profiles !== null && profiles !== void 0 ? profiles : []; _d < _e.length; _d++) {
                    p = _e[_d];
                    profileMap[p.id] = p;
                }
                _f.label = 5;
            case 5:
                invites = inviteRows
                    .map(function (row) {
                    var _a, _b, _c, _d, _e, _f;
                    var trip = tripMap[row.trip_id];
                    if (!trip)
                        return null;
                    var inviter = (_a = profileMap[trip.owner_id]) !== null && _a !== void 0 ? _a : null;
                    return {
                        tripId: trip.id,
                        tripTitle: trip.title,
                        destinationCity: trip.destination_city,
                        destinationCountry: (_b = trip.destination_country) !== null && _b !== void 0 ? _b : null,
                        startDate: (_c = trip.start_date) !== null && _c !== void 0 ? _c : null,
                        endDate: (_d = trip.end_date) !== null && _d !== void 0 ? _d : null,
                        coverUrl: (_e = trip.cover_url) !== null && _e !== void 0 ? _e : null,
                        invitedAt: row.created_at,
                        inviter: inviter ? {
                            id: inviter.id,
                            name: inviter.name,
                            handle: inviter.handle,
                            avatarUrl: (_f = inviter.avatar_url) !== null && _f !== void 0 ? _f : null,
                        } : null,
                    };
                })
                    .filter(Boolean);
                res.status(200).json({ invites: invites });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * PATCH /trips/:tripId  — update trip plan-edit permission (owner only)
 * ===========================================================================
 * Accepts: { planEditPermission, planEditors? }
 * planEditors is the full replacement list of user IDs for specific_members mode.
 */
var PlanEditPermissionEnum = ["owner_only", "all_members", "specific_members"];
var UUID_RE = /^[0-9a-f-]{36}$/i;
var PatchTripSchema = zod_1.z.object({
    planEditPermission: zod_1.z.enum(PlanEditPermissionEnum).optional(),
    planEditors: zod_1.z.array(zod_1.z.string().regex(UUID_RE)).optional(),
});
router.patch("/trips/:tripId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, parsed, _a, planEditPermission, planEditors, sc, trip, error, delErr, rows, insErr, updated, editorRows;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!UUID_RE.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                parsed = PatchTripSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                _a = parsed.data, planEditPermission = _a.planEditPermission, planEditors = _a.planEditors;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle()];
            case 2:
                trip = (_e.sent()).data;
                if (!trip) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (trip.owner_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the trip owner can change plan permissions");
                    return [2 /*return*/];
                }
                if (!(planEditPermission !== undefined)) return [3 /*break*/, 4];
                return [4 /*yield*/, sc.from("trips").update({ plan_edit_permission: planEditPermission }).eq("id", tripId)];
            case 3:
                error = (_e.sent()).error;
                if (error) {
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                _e.label = 4;
            case 4:
                if (!(planEditors !== undefined)) return [3 /*break*/, 7];
                return [4 /*yield*/, sc.from("plan_editors").delete().eq("trip_id", tripId)];
            case 5:
                delErr = (_e.sent()).error;
                if (delErr) {
                    (0, http_js_1.sendError)(res, "db_error", delErr.message);
                    return [2 /*return*/];
                }
                if (!(planEditors.length > 0)) return [3 /*break*/, 7];
                rows = planEditors.map(function (uid) { return ({ trip_id: tripId, user_id: uid }); });
                return [4 /*yield*/, sc.from("plan_editors").insert(rows)];
            case 6:
                insErr = (_e.sent()).error;
                if (insErr) {
                    (0, http_js_1.sendError)(res, "db_error", insErr.message);
                    return [2 /*return*/];
                }
                _e.label = 7;
            case 7: return [4 /*yield*/, sc
                    .from("trips")
                    .select("id, plan_edit_permission")
                    .eq("id", tripId)
                    .maybeSingle()];
            case 8:
                updated = (_e.sent()).data;
                return [4 /*yield*/, sc
                        .from("plan_editors")
                        .select("user_id")
                        .eq("trip_id", tripId)];
            case 9:
                editorRows = (_e.sent()).data;
                res.json({
                    tripId: tripId,
                    planEditPermission: (_d = updated === null || updated === void 0 ? void 0 : updated.plan_edit_permission) !== null && _d !== void 0 ? _d : "all_members",
                    planEditors: (editorRows !== null && editorRows !== void 0 ? editorRows : []).map(function (r) { return r.user_id; }),
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /trips/:tripId/plan-permission  — get current plan permission for caller
 * ===========================================================================
 * Returns { planEditPermission, planEditors, canEdit } for the calling user.
 */
router.get("/trips/:tripId/plan-permission", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, sc, member, trip, perm, ownerId, editorRows, editorIds, canEdit;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!UUID_RE.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _b.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "Not a trip member");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("trips")
                        .select("owner_id, plan_edit_permission")
                        .eq("id", tripId)
                        .maybeSingle()];
            case 3:
                trip = (_b.sent()).data;
                if (!trip) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                perm = (_a = trip.plan_edit_permission) !== null && _a !== void 0 ? _a : "all_members";
                ownerId = trip.owner_id;
                return [4 /*yield*/, sc
                        .from("plan_editors")
                        .select("user_id")
                        .eq("trip_id", tripId)];
            case 4:
                editorRows = (_b.sent()).data;
                editorIds = (editorRows !== null && editorRows !== void 0 ? editorRows : []).map(function (r) { return r.user_id; });
                canEdit = false;
                if (user.id === ownerId)
                    canEdit = true;
                else if (perm === "all_members")
                    canEdit = true;
                else if (perm === "owner_only")
                    canEdit = false;
                else
                    canEdit = editorIds.includes(user.id);
                res.json({ planEditPermission: perm, planEditors: editorIds, canEdit: canEdit, isOwner: user.id === ownerId });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /trips/:tripId/invite  — trip owner invites a user
 * ===========================================================================
 * Reuses the existing trip_members table with role='invited'.
 * Friendship alone NEVER creates this row — only explicit owner invitation.
 */
router.post("/trips/:tripId/invite", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var authHeader, client, _a, user, authErr, tripId, userId, trip, existing, error;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                if (!supabase_1.isServiceClientReady) {
                    res.status(503).json({ error: "server_not_configured" });
                    return [2 /*return*/];
                }
                authHeader = req.headers.authorization;
                if (!(authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer "))) {
                    res.status(401).json({ error: "Missing Authorization header" });
                    return [2 /*return*/];
                }
                client = (0, supabase_1.getServiceClient)();
                return [4 /*yield*/, client.auth.getUser(authHeader.slice(7))];
            case 1:
                _a = _c.sent(), user = _a.data.user, authErr = _a.error;
                if (authErr || !user) {
                    res.status(401).json({ error: "Invalid or expired token" });
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" });
                    return [2 /*return*/];
                }
                userId = (_b = req.body) === null || _b === void 0 ? void 0 : _b.userId;
                if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
                    res.status(400).json({ error: "invalid_payload", message: "userId must be a valid UUID" });
                    return [2 /*return*/];
                }
                if (userId === user.id) {
                    res.status(400).json({ error: "invalid_payload", message: "You cannot invite yourself" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("trips").select("owner_id").eq("id", tripId).maybeSingle()];
            case 2:
                trip = (_c.sent()).data;
                if (!trip) {
                    res.status(404).json({ error: "not_found", message: "Trip not found" });
                    return [2 /*return*/];
                }
                if (trip.owner_id !== user.id) {
                    res.status(403).json({ error: "forbidden", message: "Only the trip owner can invite members" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", userId).maybeSingle()];
            case 3:
                existing = (_c.sent()).data;
                if (existing) {
                    res.status(200).json({ status: "already_member", role: existing.role, idempotent: true });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("trip_members").insert({ trip_id: tripId, user_id: userId, role: "invited" })];
            case 4:
                error = (_c.sent()).error;
                if (error) {
                    res.status(500).json({ error: "db_error", message: error.message });
                    return [2 /*return*/];
                }
                res.status(201).json({ status: "invited", tripId: tripId, userId: userId });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /trips/:tripId/accept-invite  — invitee accepts their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/accept-invite", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var authHeader, client, _a, user, authErr, tripId, membership, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                if (!supabase_1.isServiceClientReady) {
                    res.status(503).json({ error: "server_not_configured" });
                    return [2 /*return*/];
                }
                authHeader = req.headers.authorization;
                if (!(authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer "))) {
                    res.status(401).json({ error: "Missing Authorization header" });
                    return [2 /*return*/];
                }
                client = (0, supabase_1.getServiceClient)();
                return [4 /*yield*/, client.auth.getUser(authHeader.slice(7))];
            case 1:
                _a = _b.sent(), user = _a.data.user, authErr = _a.error;
                if (authErr || !user) {
                    res.status(401).json({ error: "Invalid or expired token" });
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle()];
            case 2:
                membership = (_b.sent()).data;
                if (!membership) {
                    res.status(404).json({ error: "not_found", message: "No invitation found for this trip" });
                    return [2 /*return*/];
                }
                if (membership.role !== "invited") {
                    res.status(400).json({ error: "invalid_payload", message: "Already a ".concat(membership.role) });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("trip_members").update({ role: "member" }).eq("trip_id", tripId).eq("user_id", user.id)];
            case 3:
                error = (_b.sent()).error;
                if (error) {
                    res.status(500).json({ error: "db_error", message: error.message });
                    return [2 /*return*/];
                }
                // Fire-and-forget: sync group chat membership for this trip.
                (0, chatSync_js_1.syncTripChatMembers)(tripId, client).catch(function (e) { var _a; return (_a = req.log) === null || _a === void 0 ? void 0 : _a.error({ err: e }, "syncTripChatMembers failed"); });
                res.status(200).json({ status: "accepted", tripId: tripId, role: "member" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /trips/:tripId/decline-invite  — invitee declines their trip invitation
 * ===========================================================================
 */
router.post("/trips/:tripId/decline-invite", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var authHeader, client, _a, user, authErr, tripId, membership, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0:
                if (!supabase_1.isServiceClientReady) {
                    res.status(503).json({ error: "server_not_configured" });
                    return [2 /*return*/];
                }
                authHeader = req.headers.authorization;
                if (!(authHeader === null || authHeader === void 0 ? void 0 : authHeader.startsWith("Bearer "))) {
                    res.status(401).json({ error: "Missing Authorization header" });
                    return [2 /*return*/];
                }
                client = (0, supabase_1.getServiceClient)();
                return [4 /*yield*/, client.auth.getUser(authHeader.slice(7))];
            case 1:
                _a = _b.sent(), user = _a.data.user, authErr = _a.error;
                if (authErr || !user) {
                    res.status(401).json({ error: "Invalid or expired token" });
                    return [2 /*return*/];
                }
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    res.status(400).json({ error: "invalid_payload", message: "Invalid trip id" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle()];
            case 2:
                membership = (_b.sent()).data;
                if (!membership) {
                    res.status(404).json({ error: "not_found", message: "No invitation found for this trip" });
                    return [2 /*return*/];
                }
                if (membership.role !== "invited") {
                    res.status(400).json({ error: "invalid_payload", message: "Cannot decline — you are already a member" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", user.id)];
            case 3:
                error = (_b.sent()).error;
                if (error) {
                    res.status(500).json({ error: "db_error", message: error.message });
                    return [2 /*return*/];
                }
                res.status(200).json({ status: "declined", tripId: tripId });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /me/plan-editable-trips  — trips where caller has plan-edit permission
 * ===========================================================================
 * Returns only trips where the calling user can add/edit plan items.
 * Respects plan_edit_permission: owner_only | all_members | specific_members.
 */
router.get("/me/plan-editable-trips", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, sc, _a, memberRows, memErr, tripIds, _b, trips, tripsErr, specificIds, editorMap, editorRows, _i, _c, e, eid, editable;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _d.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                sc = (0, supabase_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("trip_members")
                        .select("trip_id, role")
                        .eq("user_id", user.id)
                        .in("role", ["owner", "member"])];
            case 2:
                _a = _d.sent(), memberRows = _a.data, memErr = _a.error;
                if (memErr) {
                    (0, http_js_1.sendError)(res, "db_error", memErr.message);
                    return [2 /*return*/];
                }
                if (!memberRows || memberRows.length === 0) {
                    res.json({ trips: [] });
                    return [2 /*return*/];
                }
                tripIds = memberRows.map(function (r) { return r.trip_id; });
                return [4 /*yield*/, sc
                        .from("trips")
                        .select("id, title, destination_city, destination_country, start_date, end_date, cover_url, owner_id, plan_edit_permission")
                        .in("id", tripIds)];
            case 3:
                _b = _d.sent(), trips = _b.data, tripsErr = _b.error;
                if (tripsErr) {
                    (0, http_js_1.sendError)(res, "db_error", tripsErr.message);
                    return [2 /*return*/];
                }
                if (!trips || trips.length === 0) {
                    res.json({ trips: [] });
                    return [2 /*return*/];
                }
                specificIds = trips
                    .filter(function (t) { return t.plan_edit_permission === "specific_members"; })
                    .map(function (t) { return t.id; });
                editorMap = {};
                if (!(specificIds.length > 0)) return [3 /*break*/, 5];
                return [4 /*yield*/, sc
                        .from("plan_editors")
                        .select("trip_id, user_id")
                        .in("trip_id", specificIds)];
            case 4:
                editorRows = (_d.sent()).data;
                for (_i = 0, _c = editorRows !== null && editorRows !== void 0 ? editorRows : []; _i < _c.length; _i++) {
                    e = _c[_i];
                    eid = e.trip_id;
                    if (!editorMap[eid])
                        editorMap[eid] = [];
                    editorMap[eid].push(e.user_id);
                }
                _d.label = 5;
            case 5:
                editable = trips.filter(function (trip) {
                    var _a, _b;
                    if (trip.owner_id === user.id)
                        return true;
                    var perm = (_a = trip.plan_edit_permission) !== null && _a !== void 0 ? _a : "all_members";
                    if (perm === "all_members")
                        return true;
                    if (perm === "owner_only")
                        return false;
                    return ((_b = editorMap[trip.id]) !== null && _b !== void 0 ? _b : []).includes(user.id);
                });
                res.json({
                    trips: editable.map(function (t) {
                        var _a, _b, _c, _d;
                        return ({
                            id: t.id,
                            title: t.title,
                            destinationCity: t.destination_city,
                            destinationCountry: (_a = t.destination_country) !== null && _a !== void 0 ? _a : null,
                            startDate: (_b = t.start_date) !== null && _b !== void 0 ? _b : null,
                            endDate: (_c = t.end_date) !== null && _c !== void 0 ? _c : null,
                            coverUrl: (_d = t.cover_url) !== null && _d !== void 0 ? _d : null,
                        });
                    }),
                });
                return [2 /*return*/];
        }
    });
}); });
// ── Zod schemas for plan items ────────────────────────────────────────────────
var UUID = /^[0-9a-f-]{36}$/i;
var CATEGORIES = ["accommodation", "activity", "dining", "transport", "free_time", "meeting_point", "other"];
var STATUSES = ["confirmed", "tentative", "done", "cancelled"];
var SOURCE_TYPES = ["manual", "place", "meetup"];
var CreatePlanItemSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(200),
    category: zod_1.z.enum(CATEGORIES).default("activity"),
    status: zod_1.z.enum(STATUSES).default("tentative"),
    sourceType: zod_1.z.enum(SOURCE_TYPES).default("manual"),
    sourceId: zod_1.z.string().optional(),
    dayDate: zod_1.z.string().optional(),
    startsAt: zod_1.z.string().optional(),
    endsAt: zod_1.z.string().optional(),
    locationName: zod_1.z.string().max(300).optional(),
    lat: zod_1.z.number().nullable().optional(),
    lng: zod_1.z.number().nullable().optional(),
    locationIsPrivate: zod_1.z.boolean().default(false),
    notes: zod_1.z.string().max(1000).optional(),
    sortOrder: zod_1.z.number().int().default(0),
});
var UpdatePlanItemSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(200).optional(),
    category: zod_1.z.enum(CATEGORIES).optional(),
    status: zod_1.z.enum(STATUSES).optional(),
    dayDate: zod_1.z.string().nullable().optional(),
    startsAt: zod_1.z.string().nullable().optional(),
    endsAt: zod_1.z.string().nullable().optional(),
    locationName: zod_1.z.string().max(300).nullable().optional(),
    lat: zod_1.z.number().nullable().optional(),
    lng: zod_1.z.number().nullable().optional(),
    locationIsPrivate: zod_1.z.boolean().optional(),
    notes: zod_1.z.string().max(1000).nullable().optional(),
    sortOrder: zod_1.z.number().int().optional(),
});
var ReorderSchema = zod_1.z.object({
    sortOrder: zod_1.z.number().int(),
});
// ── Conflict detection helper ─────────────────────────────────────────────────
function computeWarnings(items, tripStartDate, tripEndDate, cancelledMeetupIds) {
    var _a, _b;
    if (cancelledMeetupIds === void 0) { cancelledMeetupIds = new Set(); }
    var warnMap = new Map();
    for (var _i = 0, items_1 = items; _i < items_1.length; _i++) {
        var item = items_1[_i];
        warnMap.set(item.id, []);
    }
    // 1. Duplicate source_id across active items
    var sourceCount = new Map();
    for (var _c = 0, items_2 = items; _c < items_2.length; _c++) {
        var item = items_2[_c];
        if (item.source_id)
            sourceCount.set(item.source_id, ((_a = sourceCount.get(item.source_id)) !== null && _a !== void 0 ? _a : 0) + 1);
    }
    for (var _d = 0, items_3 = items; _d < items_3.length; _d++) {
        var item = items_3[_d];
        if (item.source_id && ((_b = sourceCount.get(item.source_id)) !== null && _b !== void 0 ? _b : 0) > 1) {
            warnMap.get(item.id).push("duplicate");
        }
    }
    // 2. Time overlap: items on same day with truly overlapping time windows (not just start proximity)
    var byDay = new Map();
    for (var _e = 0, items_4 = items; _e < items_4.length; _e++) {
        var item = items_4[_e];
        if (item.day_date && item.starts_at) {
            if (!byDay.has(item.day_date))
                byDay.set(item.day_date, []);
            byDay.get(item.day_date).push(item);
        }
    }
    for (var _f = 0, _g = byDay.values(); _f < _g.length; _f++) {
        var dayItems = _g[_f];
        for (var i = 0; i < dayItems.length; i++) {
            for (var j = i + 1; j < dayItems.length; j++) {
                var a = dayItems[i], b = dayItems[j];
                var aStart = new Date(a.starts_at).getTime();
                var bStart = new Date(b.starts_at).getTime();
                // Default 1-hour duration when ends_at is absent
                var aEnd = a.ends_at ? new Date(a.ends_at).getTime() : aStart + 3600000;
                var bEnd = b.ends_at ? new Date(b.ends_at).getTime() : bStart + 3600000;
                if (aStart < bEnd && bStart < aEnd) {
                    if (!warnMap.get(a.id).includes("time_overlap"))
                        warnMap.get(a.id).push("time_overlap");
                    if (!warnMap.get(b.id).includes("time_overlap"))
                        warnMap.get(b.id).push("time_overlap");
                }
            }
        }
    }
    // 3. Outside trip dates
    if (tripStartDate && tripEndDate) {
        var start = new Date(tripStartDate + "T00:00:00Z").getTime();
        var end = new Date(tripEndDate + "T23:59:59Z").getTime();
        for (var _h = 0, items_5 = items; _h < items_5.length; _h++) {
            var item = items_5[_h];
            if (item.day_date) {
                var ms = new Date(item.day_date + "T00:00:00Z").getTime();
                if (ms < start || ms > end)
                    warnMap.get(item.id).push("outside_trip_dates");
            }
        }
    }
    // 4. Missing location: has a location name but no coordinates (can't appear on map)
    for (var _j = 0, items_6 = items; _j < items_6.length; _j++) {
        var item = items_6[_j];
        if (item.location_name && (item.lat == null || item.lng == null)) {
            warnMap.get(item.id).push("missing_location");
        }
    }
    // 5. Cancelled source: meetup-sourced item from a cancelled meetup
    for (var _k = 0, items_7 = items; _k < items_7.length; _k++) {
        var item = items_7[_k];
        if (item.source_type === "meetup" && item.source_id && cancelledMeetupIds.has(item.source_id)) {
            warnMap.get(item.id).push("cancelled_source");
        }
    }
    return warnMap;
}
// ── GET /trips/:tripId/plan ───────────────────────────────────────────────────
router.get("/trips/:tripId/plan", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, tripId, member, trip, tripStartDate, tripEndDate, editAllowed, canEdit, _a, data, error, rows, meetupSourceIds, cancelledMeetupIds, meetups, _i, _b, m, warnMap;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _e.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                tripId = req.params.tripId;
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _e.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to view the plan");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trips")
                        .select("start_date,end_date,owner_id,plan_edit_permission")
                        .eq("id", tripId)
                        .maybeSingle()];
            case 3:
                trip = (_e.sent()).data;
                tripStartDate = (_c = trip === null || trip === void 0 ? void 0 : trip.start_date) !== null && _c !== void 0 ? _c : null;
                tripEndDate = (_d = trip === null || trip === void 0 ? void 0 : trip.end_date) !== null && _d !== void 0 ? _d : null;
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 4:
                editAllowed = _e.sent();
                canEdit = editAllowed === true;
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .select("*")
                        .eq("trip_id", tripId)
                        .is("removed_at", null)
                        .order("day_date", { ascending: true, nullsFirst: false })
                        .order("starts_at", { ascending: true, nullsFirst: false })
                        .order("sort_order", { ascending: true })];
            case 5:
                _a = _e.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "get trip plan");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                rows = data !== null && data !== void 0 ? data : [];
                meetupSourceIds = rows
                    .filter(function (i) { return i.source_type === "meetup" && i.source_id; })
                    .map(function (i) { return i.source_id; });
                cancelledMeetupIds = new Set();
                if (!(meetupSourceIds.length > 0)) return [3 /*break*/, 7];
                return [4 /*yield*/, client
                        .from("meetups")
                        .select("id, status")
                        .in("id", meetupSourceIds)];
            case 6:
                meetups = (_e.sent()).data;
                for (_i = 0, _b = (meetups !== null && meetups !== void 0 ? meetups : []); _i < _b.length; _i++) {
                    m = _b[_i];
                    if (m.status === "cancelled")
                        cancelledMeetupIds.add(m.id);
                }
                _e.label = 7;
            case 7:
                warnMap = computeWarnings(rows, tripStartDate, tripEndDate, cancelledMeetupIds);
                res.json({
                    items: rows.map(function (row) { var _a; return (0, plan_js_1.toCamel)(row, { warnings: (_a = warnMap.get(row.id)) !== null && _a !== void 0 ? _a : [] }); }),
                    canEdit: canEdit,
                });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /trips/:tripId/plan/map — only items with safe public coordinates ──────
router.get("/trips/:tripId/plan/map", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, tripId, member, _a, data, error, mapItems;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _b.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                tripId = req.params.tripId;
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _b.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to view the map");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .select("*")
                        .eq("trip_id", tripId)
                        .is("removed_at", null)
                        .order("sort_order", { ascending: true })];
            case 3:
                _a = _b.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "get trip plan map");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                mapItems = (data !== null && data !== void 0 ? data : [])
                    .filter(function (row) { return !row.location_is_private && row.lat != null && row.lng != null; })
                    .map(function (row) { return (0, plan_js_1.toCamel)(row, {}); });
                res.json({ items: mapItems });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /trips/:tripId/plan/items ────────────────────────────────────────────
router.post("/trips/:tripId/plan/items", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, tripId, permitted, parsed, b, dup, _a, item, error;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    return __generator(this, function (_o) {
        switch (_o.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _o.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                tripId = req.params.tripId;
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 2:
                permitted = _o.sent();
                if (permitted === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!permitted) {
                    (0, http_js_1.sendError)(res, "forbidden", "You do not have permission to add plan items on this trip");
                    return [2 /*return*/];
                }
                parsed = CreatePlanItemSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                b = parsed.data;
                if (!b.sourceId) return [3 /*break*/, 4];
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .select("id")
                        .eq("trip_id", tripId)
                        .eq("source_type", b.sourceType)
                        .eq("source_id", b.sourceId)
                        .is("removed_at", null)
                        .maybeSingle()];
            case 3:
                dup = (_o.sent()).data;
                if (dup) {
                    res.status(409).json({ error: "duplicate", message: "This item is already in the plan" });
                    return [2 /*return*/];
                }
                _o.label = 4;
            case 4: return [4 /*yield*/, client
                    .from("trip_plan_items")
                    .insert({
                    trip_id: tripId,
                    creator_id: user.id, // always from token
                    title: b.title,
                    category: b.category,
                    status: b.status,
                    source_type: b.sourceType,
                    source_id: (_d = b.sourceId) !== null && _d !== void 0 ? _d : null,
                    day_date: (_e = b.dayDate) !== null && _e !== void 0 ? _e : null,
                    starts_at: (_f = b.startsAt) !== null && _f !== void 0 ? _f : null,
                    ends_at: (_g = b.endsAt) !== null && _g !== void 0 ? _g : null,
                    location_name: (_h = b.locationName) !== null && _h !== void 0 ? _h : null,
                    lat: (_j = b.lat) !== null && _j !== void 0 ? _j : null,
                    lng: (_k = b.lng) !== null && _k !== void 0 ? _k : null,
                    location_is_private: (_l = b.locationIsPrivate) !== null && _l !== void 0 ? _l : false,
                    notes: (_m = b.notes) !== null && _m !== void 0 ? _m : null,
                    sort_order: b.sortOrder,
                    visibility: "members",
                })
                    .select("*")
                    .single()];
            case 5:
                _a = _o.sent(), item = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "create plan item");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json((0, plan_js_1.toCamel)(item));
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /trips/:tripId/plan/items/:itemId ───────────────────────────────────
router.patch("/trips/:tripId/plan/items/:itemId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, _a, tripId, itemId, parsed, patch, permitted, auth, dbPatch, _b, updated, error;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _e.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                _a = req.params, tripId = _a.tripId, itemId = _a.itemId;
                if (!UUID.test(tripId) || !UUID.test(itemId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                parsed = UpdatePlanItemSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid body");
                    return [2 /*return*/];
                }
                patch = parsed.data;
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 2:
                permitted = _e.sent();
                if (permitted === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!permitted) {
                    (0, http_js_1.sendError)(res, "forbidden", "You do not have permission to edit plan items on this trip");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, tripId, itemId, user.id)];
            case 3:
                auth = _e.sent();
                if (!auth.permitted) {
                    (0, http_js_1.sendError)(res, auth.code, auth.message);
                    return [2 /*return*/];
                }
                dbPatch = { updated_at: new Date().toISOString() };
                if (patch.title !== undefined)
                    dbPatch.title = patch.title;
                if (patch.category !== undefined)
                    dbPatch.category = patch.category;
                if (patch.status !== undefined)
                    dbPatch.status = patch.status;
                if (patch.dayDate !== undefined)
                    dbPatch.day_date = patch.dayDate;
                if (patch.startsAt !== undefined)
                    dbPatch.starts_at = patch.startsAt;
                if (patch.endsAt !== undefined)
                    dbPatch.ends_at = patch.endsAt;
                if (patch.locationName !== undefined)
                    dbPatch.location_name = patch.locationName;
                if (patch.lat !== undefined)
                    dbPatch.lat = patch.lat;
                if (patch.lng !== undefined)
                    dbPatch.lng = patch.lng;
                if (patch.locationIsPrivate !== undefined)
                    dbPatch.location_is_private = patch.locationIsPrivate;
                if (patch.notes !== undefined)
                    dbPatch.notes = patch.notes;
                if (patch.sortOrder !== undefined)
                    dbPatch.sort_order = patch.sortOrder;
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .update(dbPatch)
                        .eq("id", itemId)
                        .select("*")
                        .single()];
            case 4:
                _b = _e.sent(), updated = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "update plan item");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json((0, plan_js_1.toCamel)(updated));
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /trips/:tripId/plan/items/:itemId/remove — soft-delete ──────────────
router.patch("/trips/:tripId/plan/items/:itemId/remove", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, _a, tripId, itemId, permitted, auth, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _b.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                _a = req.params, tripId = _a.tripId, itemId = _a.itemId;
                if (!UUID.test(tripId) || !UUID.test(itemId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 2:
                permitted = _b.sent();
                if (permitted === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!permitted) {
                    (0, http_js_1.sendError)(res, "forbidden", "You do not have permission to edit plan items on this trip");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, tripId, itemId, user.id)];
            case 3:
                auth = _b.sent();
                if (!auth.permitted) {
                    (0, http_js_1.sendError)(res, auth.code, auth.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .update({ removed_at: new Date().toISOString() })
                        .eq("id", itemId)];
            case 4:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "remove plan item");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ status: "removed", itemId: itemId });
                return [2 /*return*/];
        }
    });
}); });
// ── DELETE /trips/:tripId/plan/items/:itemId — REST soft-delete ───────────────
router.delete("/trips/:tripId/plan/items/:itemId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, _a, tripId, itemId, permitted, auth, error;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _b.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                _a = req.params, tripId = _a.tripId, itemId = _a.itemId;
                if (!UUID.test(tripId) || !UUID.test(itemId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 2:
                permitted = _b.sent();
                if (permitted === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!permitted) {
                    (0, http_js_1.sendError)(res, "forbidden", "You do not have permission to edit plan items on this trip");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlanItem)(client, tripId, itemId, user.id)];
            case 3:
                auth = _b.sent();
                if (!auth.permitted) {
                    (0, http_js_1.sendError)(res, auth.code, auth.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .update({ removed_at: new Date().toISOString() })
                        .eq("id", itemId)];
            case 4:
                error = (_b.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "delete plan item");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(204).send();
                return [2 /*return*/];
        }
    });
}); });
// ── POST /trips/:tripId/plan/items/:itemId/reorder — plan-edit permission ─────
router.post("/trips/:tripId/plan/items/:itemId/reorder", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, _a, tripId, itemId, parsed, permitted, _b, updated, error;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _c.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                _a = req.params, tripId = _a.tripId, itemId = _a.itemId;
                if (!UUID.test(tripId) || !UUID.test(itemId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                parsed = ReorderSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "sortOrder must be an integer");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 2:
                permitted = _c.sent();
                if (permitted === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!permitted) {
                    (0, http_js_1.sendError)(res, "forbidden", "You don't have permission to reorder plan items");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .update({ sort_order: parsed.data.sortOrder, updated_at: new Date().toISOString() })
                        .eq("id", itemId)
                        .eq("trip_id", tripId)
                        .select("id")
                        .maybeSingle()];
            case 3:
                _b = _c.sent(), updated = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "reorder plan item");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!updated) {
                    (0, http_js_1.sendError)(res, "not_found", "Plan item not found in this trip");
                    return [2 /*return*/];
                }
                res.json({ status: "reordered", itemId: itemId, sortOrder: parsed.data.sortOrder });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
