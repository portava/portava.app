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
/**
 * Unified Request Inbox
 *
 * GET  /me/requests       — all-status list (friend, circle, trip) split incoming/outgoing
 * GET  /me/requests/count — incoming-only pending count for the nav badge
 *
 * POST /me/requests/friend_request/:id/accept|decline|cancel
 * POST /me/requests/circle_invite/:id/accept|decline
 * POST /me/requests/trip_invite/:tripId/accept|decline
 * POST /me/requests/trip_invite/:tripId/cancel   (body: { inviteeId })
 *
 * All writes use auth.client (service-role, JWT-verified) so they work in tests
 * via the _setTestClient slot in http.ts.
 */
var express_1 = require("express");
var http_1 = require("../lib/http");
var friendDecisions_1 = require("../lib/friendDecisions");
var router = (0, express_1.Router)();
var PROFILE_PUBLIC = "id, handle, name, avatar_url";
function profileToActor(p) {
    var _a, _b, _c;
    if (!p)
        return null;
    return { id: p.id, handle: (_a = p.handle) !== null && _a !== void 0 ? _a : null, name: (_b = p.name) !== null && _b !== void 0 ? _b : null, avatarUrl: (_c = p.avatar_url) !== null && _c !== void 0 ? _c : null };
}
function batchProfiles(sc, ids) {
    return __awaiter(this, void 0, void 0, function () {
        var uniq, data, map, _i, _a, p;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    uniq = __spreadArray([], new Set(ids.filter(Boolean)), true);
                    if (uniq.length === 0)
                        return [2 /*return*/, {}];
                    return [4 /*yield*/, sc.from("profiles").select(PROFILE_PUBLIC).in("id", uniq)];
                case 1:
                    data = (_b.sent()).data;
                    map = {};
                    for (_i = 0, _a = (data !== null && data !== void 0 ? data : []); _i < _a.length; _i++) {
                        p = _a[_i];
                        map[p.id] = p;
                    }
                    return [2 /*return*/, map];
            }
        });
    });
}
/* =============================================================================
 * GET /me/requests
 * =============================================================================
 * Returns all social request items regardless of status (pending, accepted,
 * declined, cancelled, invited) so the UI can display history and status chips.
 * Items are sorted globally newest-first.
 * =============================================================================
 */
router.get("/me/requests", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, _a, frIn, frOut, ciIn, ciOut, tripInvited, ownedTrips, ownedTripIds, tripInviteesOut, invitees, allTripIds, tripTitleMap, tripOwnerMap, _b, tripsData, ownerRows, _i, _c, t, _d, _e, r, actorIds, profileMap, items, _f, _g, r, _h, _j, r, _k, _l, r, _m, _o, r, _p, _q, r, _r, tripInviteesOut_1, r;
    var _s, _t, _u;
    return __generator(this, function (_v) {
        switch (_v.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _v.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                return [4 /*yield*/, Promise.all([
                        sc.from("friend_requests").select("id, status, created_at, requester_id")
                            .eq("recipient_id", user.id).order("created_at", { ascending: false }),
                        sc.from("friend_requests").select("id, status, created_at, recipient_id")
                            .eq("requester_id", user.id).order("created_at", { ascending: false }),
                        sc.from("circle_invites").select("id, status, created_at, owner_id")
                            .eq("recipient_id", user.id).order("created_at", { ascending: false }),
                        sc.from("circle_invites").select("id, status, created_at, recipient_id")
                            .eq("owner_id", user.id).order("created_at", { ascending: false }),
                        // Incoming trip invites (user is invitee)
                        sc.from("trip_members").select("trip_id, created_at")
                            .eq("user_id", user.id).eq("role", "invited").order("created_at", { ascending: false }),
                        // Trips user owns (for outgoing trip invites)
                        sc.from("trip_members").select("trip_id")
                            .eq("user_id", user.id).eq("role", "owner"),
                    ])];
            case 2:
                _a = _v.sent(), frIn = _a[0].data, frOut = _a[1].data, ciIn = _a[2].data, ciOut = _a[3].data, tripInvited = _a[4].data, ownedTrips = _a[5].data;
                ownedTripIds = (ownedTrips !== null && ownedTrips !== void 0 ? ownedTrips : []).map(function (r) { return r.trip_id; });
                tripInviteesOut = [];
                if (!(ownedTripIds.length > 0)) return [3 /*break*/, 4];
                return [4 /*yield*/, sc.from("trip_members")
                        .select("trip_id, user_id, created_at")
                        .in("trip_id", ownedTripIds)
                        .eq("role", "invited")
                        .order("created_at", { ascending: false })];
            case 3:
                invitees = (_v.sent()).data;
                tripInviteesOut = invitees !== null && invitees !== void 0 ? invitees : [];
                _v.label = 4;
            case 4:
                allTripIds = __spreadArray([], new Set(__spreadArray(__spreadArray([], (tripInvited !== null && tripInvited !== void 0 ? tripInvited : []).map(function (r) { return r.trip_id; }), true), tripInviteesOut.map(function (r) { return r.trip_id; }), true)), true);
                tripTitleMap = {};
                tripOwnerMap = {};
                if (!(allTripIds.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, Promise.all([
                        sc.from("trips").select("id, title").in("id", allTripIds),
                        sc.from("trip_members").select("trip_id, user_id")
                            .in("trip_id", allTripIds).eq("role", "owner"),
                    ])];
            case 5:
                _b = _v.sent(), tripsData = _b[0].data, ownerRows = _b[1].data;
                for (_i = 0, _c = (tripsData !== null && tripsData !== void 0 ? tripsData : []); _i < _c.length; _i++) {
                    t = _c[_i];
                    tripTitleMap[t.id] = (_s = t.title) !== null && _s !== void 0 ? _s : null;
                }
                for (_d = 0, _e = (ownerRows !== null && ownerRows !== void 0 ? ownerRows : []); _d < _e.length; _d++) {
                    r = _e[_d];
                    tripOwnerMap[r.trip_id] = r.user_id;
                }
                _v.label = 6;
            case 6:
                actorIds = __spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], (frIn !== null && frIn !== void 0 ? frIn : []).map(function (r) { return r.requester_id; }), true), (frOut !== null && frOut !== void 0 ? frOut : []).map(function (r) { return r.recipient_id; }), true), (ciIn !== null && ciIn !== void 0 ? ciIn : []).map(function (r) { return r.owner_id; }), true), (ciOut !== null && ciOut !== void 0 ? ciOut : []).map(function (r) { return r.recipient_id; }), true), Object.values(tripOwnerMap), true), tripInviteesOut.map(function (r) { return r.user_id; }), true);
                return [4 /*yield*/, batchProfiles(sc, actorIds)];
            case 7:
                profileMap = _v.sent();
                items = [];
                for (_f = 0, _g = (frIn !== null && frIn !== void 0 ? frIn : []); _f < _g.length; _f++) {
                    r = _g[_f];
                    items.push({
                        id: r.id, type: "friend_request", direction: "incoming", status: r.status,
                        actor: profileToActor(profileMap[r.requester_id]), targetName: null, createdAt: r.created_at,
                    });
                }
                for (_h = 0, _j = (ciIn !== null && ciIn !== void 0 ? ciIn : []); _h < _j.length; _h++) {
                    r = _j[_h];
                    items.push({
                        id: r.id, type: "circle_invite", direction: "incoming", status: r.status,
                        actor: profileToActor(profileMap[r.owner_id]), targetName: null, createdAt: r.created_at,
                    });
                }
                for (_k = 0, _l = (tripInvited !== null && tripInvited !== void 0 ? tripInvited : []); _k < _l.length; _k++) {
                    r = _l[_k];
                    items.push({
                        id: r.trip_id, type: "trip_invite", direction: "incoming", status: "invited",
                        actor: profileToActor(profileMap[tripOwnerMap[r.trip_id]]),
                        targetName: (_t = tripTitleMap[r.trip_id]) !== null && _t !== void 0 ? _t : null, createdAt: r.created_at,
                    });
                }
                for (_m = 0, _o = (frOut !== null && frOut !== void 0 ? frOut : []); _m < _o.length; _m++) {
                    r = _o[_m];
                    items.push({
                        id: r.id, type: "friend_request", direction: "outgoing", status: r.status,
                        actor: profileToActor(profileMap[r.recipient_id]), targetName: null, createdAt: r.created_at,
                    });
                }
                for (_p = 0, _q = (ciOut !== null && ciOut !== void 0 ? ciOut : []); _p < _q.length; _p++) {
                    r = _q[_p];
                    items.push({
                        id: r.id, type: "circle_invite", direction: "outgoing", status: r.status,
                        actor: profileToActor(profileMap[r.recipient_id]), targetName: null, createdAt: r.created_at,
                    });
                }
                for (_r = 0, tripInviteesOut_1 = tripInviteesOut; _r < tripInviteesOut_1.length; _r++) {
                    r = tripInviteesOut_1[_r];
                    // Compound ID: tripId|inviteeId — the owner needs this for cancel
                    items.push({
                        id: "".concat(r.trip_id, "|").concat(r.user_id), type: "trip_invite", direction: "outgoing", status: "invited",
                        actor: profileToActor(profileMap[r.user_id]),
                        targetName: (_u = tripTitleMap[r.trip_id]) !== null && _u !== void 0 ? _u : null, createdAt: r.created_at,
                    });
                }
                // ── 6. Sort globally newest-first ─────────────────────────────────────────
                items.sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
                res.status(200).json({ items: items });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * GET /me/requests/count  — incoming pending count for nav badge
 * =============================================================================
 */
router.get("/me/requests/count", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, _a, frRows, ciRows, tiRows, miRows, count;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                return [4 /*yield*/, Promise.all([
                        sc.from("friend_requests").select("id").eq("recipient_id", user.id).eq("status", "pending"),
                        sc.from("circle_invites").select("id").eq("recipient_id", user.id).eq("status", "pending"),
                        sc.from("trip_members").select("trip_id").eq("user_id", user.id).eq("role", "invited"),
                        sc.from("meetup_invites").select("id").eq("user_id", user.id).eq("status", "pending"),
                    ])];
            case 2:
                _a = _b.sent(), frRows = _a[0].data, ciRows = _a[1].data, tiRows = _a[2].data, miRows = _a[3].data;
                count = (frRows !== null && frRows !== void 0 ? frRows : []).length + (ciRows !== null && ciRows !== void 0 ? ciRows : []).length + (tiRows !== null && tiRows !== void 0 ? tiRows : []).length + (miRows !== null && miRows !== void 0 ? miRows : []).length;
                res.status(200).json({ count: count });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/friend_request/:id/accept
 * Only the recipient may accept.  Creates user_friendships row.
 * =============================================================================
 */
router.post("/me/requests/friend_request/:id/accept", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, id, fr, now, _a, ua, ub;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                id = req.params.id;
                if (!(0, friendDecisions_1.isUuid)(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid request id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("friend_requests")
                        .select("id, requester_id, recipient_id, status").eq("id", id).maybeSingle()];
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
                if (fr.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the recipient may accept this request");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests").update({ status: "accepted", responded_at: now, updated_at: now }).eq("id", id)];
            case 3:
                _b.sent();
                _a = (0, friendDecisions_1.normalizedFriendshipPair)(fr.requester_id, fr.recipient_id), ua = _a[0], ub = _a[1];
                return [4 /*yield*/, sc.from("user_friendships").upsert({ user_a: ua, user_b: ub, accepted_request_id: id, created_at: now })];
            case 4:
                _b.sent();
                res.status(200).json({ status: "friends", requestId: id });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/friend_request/:id/decline
 * Only the recipient may decline.
 * =============================================================================
 */
router.post("/me/requests/friend_request/:id/decline", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, id, fr, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                id = req.params.id;
                if (!(0, friendDecisions_1.isUuid)(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid request id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("friend_requests")
                        .select("id, recipient_id, status").eq("id", id).maybeSingle()];
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
                if (fr.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the recipient may decline this request");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests").update({ status: "declined", responded_at: now, updated_at: now }).eq("id", id)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "declined", requestId: id });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/friend_request/:id/cancel
 * Only the requester may cancel.
 * =============================================================================
 */
router.post("/me/requests/friend_request/:id/cancel", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, id, fr, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                id = req.params.id;
                if (!(0, friendDecisions_1.isUuid)(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid request id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("friend_requests")
                        .select("id, requester_id, status").eq("id", id).maybeSingle()];
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
                if (fr.requester_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the requester may cancel this request");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("friend_requests").update({ status: "cancelled", updated_at: now }).eq("id", id)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "cancelled", requestId: id });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/circle_invite/:id/accept
 * Only the recipient may accept.  Creates circle_memberships row.
 * =============================================================================
 */
router.post("/me/requests/circle_invite/:id/accept", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, id, inv, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                id = req.params.id;
                if (!(0, friendDecisions_1.isUuid)(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid invite id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("circle_invites")
                        .select("id, owner_id, recipient_id, status").eq("id", id).maybeSingle()];
            case 2:
                inv = (_a.sent()).data;
                if (!inv) {
                    (0, http_1.sendError)(res, "not_found", "Circle invite not found");
                    return [2 /*return*/];
                }
                if (inv.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Invite is already ".concat(inv.status));
                    return [2 /*return*/];
                }
                if (inv.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the recipient may accept this invite");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("circle_invites").update({ status: "accepted", responded_at: now }).eq("id", id)];
            case 3:
                _a.sent();
                return [4 /*yield*/, sc.from("circle_memberships").upsert({ owner_id: inv.owner_id, member_id: user.id, created_at: now })];
            case 4:
                _a.sent();
                res.status(200).json({ status: "accepted", ownerId: inv.owner_id });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/circle_invite/:id/cancel
 * Only the owner (sender) may cancel a pending invite.
 * =============================================================================
 */
router.post("/me/requests/circle_invite/:id/cancel", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, id, inv, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                id = req.params.id;
                if (!(0, friendDecisions_1.isUuid)(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid invite id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("circle_invites")
                        .select("id, owner_id, status").eq("id", id).maybeSingle()];
            case 2:
                inv = (_a.sent()).data;
                if (!inv) {
                    (0, http_1.sendError)(res, "not_found", "Circle invite not found");
                    return [2 /*return*/];
                }
                if (inv.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Invite is already ".concat(inv.status));
                    return [2 /*return*/];
                }
                if (inv.owner_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the invite owner may cancel this invite");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("circle_invites").update({ status: "cancelled", updated_at: now }).eq("id", id)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "cancelled" });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/circle_invite/:id/decline
 * Only the recipient may decline.
 * =============================================================================
 */
router.post("/me/requests/circle_invite/:id/decline", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, id, inv, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                id = req.params.id;
                if (!(0, friendDecisions_1.isUuid)(id)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid invite id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("circle_invites")
                        .select("id, recipient_id, status").eq("id", id).maybeSingle()];
            case 2:
                inv = (_a.sent()).data;
                if (!inv) {
                    (0, http_1.sendError)(res, "not_found", "Circle invite not found");
                    return [2 /*return*/];
                }
                if (inv.status !== "pending") {
                    (0, http_1.sendError)(res, "invalid_payload", "Invite is already ".concat(inv.status));
                    return [2 /*return*/];
                }
                if (inv.recipient_id !== user.id) {
                    (0, http_1.sendError)(res, "forbidden", "Only the recipient may decline this invite");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, sc.from("circle_invites").update({ status: "declined", responded_at: now }).eq("id", id)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "declined" });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/trip_invite/:tripId/accept
 * Only the invitee may accept (role 'invited' → 'member').
 * =============================================================================
 */
router.post("/me/requests/trip_invite/:tripId/accept", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, tripId, tm;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!(0, friendDecisions_1.isUuid)(tripId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members")
                        .select("trip_id, user_id, role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle()];
            case 2:
                tm = (_a.sent()).data;
                if (!tm) {
                    (0, http_1.sendError)(res, "not_found", "Trip invite not found");
                    return [2 /*return*/];
                }
                if (tm.role !== "invited") {
                    (0, http_1.sendError)(res, "invalid_payload", "Trip membership is already '".concat(tm.role, "'"));
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members").update({ role: "member" }).eq("trip_id", tripId).eq("user_id", user.id)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "member", tripId: tripId });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/trip_invite/:tripId/decline
 * Only the invitee may decline (removes the trip_members row).
 * =============================================================================
 */
router.post("/me/requests/trip_invite/:tripId/decline", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, tripId, tm;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!(0, friendDecisions_1.isUuid)(tripId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members")
                        .select("trip_id, user_id, role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle()];
            case 2:
                tm = (_a.sent()).data;
                if (!tm) {
                    (0, http_1.sendError)(res, "not_found", "Trip invite not found");
                    return [2 /*return*/];
                }
                if (tm.role !== "invited") {
                    (0, http_1.sendError)(res, "invalid_payload", "Trip membership is already '".concat(tm.role, "'"));
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", user.id)];
            case 3:
                _a.sent();
                res.status(200).json({ status: "declined", tripId: tripId });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /me/requests/trip_invite/:tripId/cancel
 * Body: { inviteeId: string }
 * Only the trip owner may cancel a pending invite.
 * =============================================================================
 */
router.post("/me/requests/trip_invite/:tripId/cancel", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, tripId, inviteeId, ownerRow, inviteRow;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                tripId = req.params.tripId;
                inviteeId = ((_a = req.body) !== null && _a !== void 0 ? _a : {}).inviteeId;
                if (!(0, friendDecisions_1.isUuid)(tripId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                if (!inviteeId || !(0, friendDecisions_1.isUuid)(inviteeId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "inviteeId must be a valid UUID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members")
                        .select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle()];
            case 2:
                ownerRow = (_b.sent()).data;
                if (!ownerRow || ownerRow.role !== "owner") {
                    (0, http_1.sendError)(res, "forbidden", "Only the trip owner may cancel invites");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members")
                        .select("role").eq("trip_id", tripId).eq("user_id", inviteeId).maybeSingle()];
            case 3:
                inviteRow = (_b.sent()).data;
                if (!inviteRow) {
                    (0, http_1.sendError)(res, "not_found", "Invite not found");
                    return [2 /*return*/];
                }
                if (inviteRow.role !== "invited") {
                    (0, http_1.sendError)(res, "invalid_payload", "Membership is already '".concat(inviteRow.role, "'"));
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", inviteeId)];
            case 4:
                _b.sent();
                res.status(200).json({ status: "cancelled", tripId: tripId, inviteeId: inviteeId });
                return [2 /*return*/];
        }
    });
}); });
/* =============================================================================
 * POST /trips/:tripId/remove-member
 * Body: { memberId: string }
 * Only the trip owner may remove an accepted member.
 * Immediately sets left_at on the member's chat thread row via sync.
 * =============================================================================
 */
router.post("/trips/:tripId/remove-member", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, sc, user, tripId, memberId, ownerRow, memberRow, syncTripChatMembers;
    var _a;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                sc = auth.client, user = auth.user;
                tripId = req.params.tripId;
                memberId = ((_a = req.body) !== null && _a !== void 0 ? _a : {}).memberId;
                if (!(0, friendDecisions_1.isUuid)(tripId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "Invalid trip id");
                    return [2 /*return*/];
                }
                if (!memberId || !(0, friendDecisions_1.isUuid)(memberId)) {
                    (0, http_1.sendError)(res, "invalid_payload", "memberId must be a valid UUID");
                    return [2 /*return*/];
                }
                if (memberId === user.id) {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot remove yourself");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", user.id).maybeSingle()];
            case 2:
                ownerRow = (_b.sent()).data;
                if (!ownerRow || ownerRow.role !== "owner") {
                    (0, http_1.sendError)(res, "forbidden", "Only the trip owner may remove members");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("trip_members").select("role").eq("trip_id", tripId).eq("user_id", memberId).maybeSingle()];
            case 3:
                memberRow = (_b.sent()).data;
                if (!memberRow) {
                    (0, http_1.sendError)(res, "not_found", "Member not found on this trip");
                    return [2 /*return*/];
                }
                if (memberRow.role === "owner") {
                    (0, http_1.sendError)(res, "invalid_payload", "Cannot remove the trip owner");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc.from("trip_members").delete().eq("trip_id", tripId).eq("user_id", memberId)];
            case 4:
                _b.sent();
                res.status(200).json({ status: "removed", tripId: tripId, memberId: memberId });
                return [4 /*yield*/, Promise.resolve().then(function () { return require("../lib/chatSync.js"); })];
            case 5:
                syncTripChatMembers = (_b.sent()).syncTripChatMembers;
                syncTripChatMembers(tripId, sc).catch(function () { });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
