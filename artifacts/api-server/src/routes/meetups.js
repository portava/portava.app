"use strict";
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
/**
 * Meetup routes
 *
 * POST   /api/meetups                            — create meetup
 * GET    /api/meetups/:meetupId                  — get meetup + invite counts
 * PATCH  /api/meetups/:meetupId                  — update (creator only)
 * DELETE /api/meetups/:meetupId                  — cancel (creator only)
 * POST   /api/meetups/:meetupId/invites          — invite users (creator only)
 * POST   /api/meetups/:meetupId/rsvp             — RSVP Going/Maybe/Declined
 * POST   /api/meetups/:meetupId/time-options     — add time slot (creator only)
 * POST   /api/meetups/:meetupId/time-options/:optionId/vote — vote yes/maybe/no
 * POST   /api/meetups/:meetupId/confirm-time     — confirm winning time (creator only)
 * POST   /api/meetups/:meetupId/add-to-trip-plan — add as trip plan item (idempotent)
 *
 * HARD RULES:
 *  - No lat/lng on meetups — text location_name only
 *  - creator_id always set from JWT
 *  - Visibility enforcement on every GET
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var supabase_js_1 = require("../lib/supabase.js");
var push_js_1 = require("../lib/push.js");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
// ── Frequent-invitee cache (per user, 1 h TTL) ────────────────────────────────
var FREQ_TTL_MS = 60 * 60 * 1000;
var freqCache = new Map();
function freqCacheFresh(e) { return Date.now() - e.cachedAt < FREQ_TTL_MS; }
// ── Visibility helper ─────────────────────────────────────────────────────────
function canAccessMeetup(client, meetupId, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var meetup, invite, ok, ownerId, mem, creatorId, friendship;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, client
                        .from("meetups")
                        .select("*")
                        .eq("id", meetupId)
                        .maybeSingle()];
                case 1:
                    meetup = (_a.sent()).data;
                    if (!meetup)
                        return [2 /*return*/, { ok: false }];
                    // Creator always has access
                    if (meetup.creator_id === userId)
                        return [2 /*return*/, { ok: true, meetup: meetup }];
                    return [4 /*yield*/, client
                            .from("meetup_invites")
                            .select("id")
                            .eq("meetup_id", meetupId)
                            .eq("user_id", userId)
                            .maybeSingle()];
                case 2:
                    invite = (_a.sent()).data;
                    if (invite)
                        return [2 /*return*/, { ok: true, meetup: meetup }];
                    if (!(meetup.visibility === "trip" && meetup.trip_id)) return [3 /*break*/, 4];
                    return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, meetup.trip_id, userId)];
                case 3:
                    ok = _a.sent();
                    if (ok)
                        return [2 /*return*/, { ok: true, meetup: meetup }];
                    _a.label = 4;
                case 4:
                    if (!(meetup.visibility === "circle" && meetup.circle_owner_id)) return [3 /*break*/, 6];
                    ownerId = meetup.circle_owner_id;
                    if (userId === ownerId)
                        return [2 /*return*/, { ok: true, meetup: meetup }];
                    return [4 /*yield*/, client
                            .from("circle_memberships")
                            .select("member_id")
                            .eq("owner_id", ownerId)
                            .eq("member_id", userId)
                            .maybeSingle()];
                case 5:
                    mem = (_a.sent()).data;
                    if (mem)
                        return [2 /*return*/, { ok: true, meetup: meetup }];
                    _a.label = 6;
                case 6:
                    if (!(meetup.visibility === "friends")) return [3 /*break*/, 8];
                    creatorId = meetup.creator_id;
                    return [4 /*yield*/, client
                            .from("user_friendships")
                            .select("user_a")
                            .or("and(user_a.eq.".concat(userId, ",user_b.eq.").concat(creatorId, "),") +
                            "and(user_b.eq.".concat(userId, ",user_a.eq.").concat(creatorId, ")"))
                            .maybeSingle()];
                case 7:
                    friendship = (_a.sent()).data;
                    if (friendship)
                        return [2 /*return*/, { ok: true, meetup: meetup }];
                    _a.label = 8;
                case 8: return [2 /*return*/, { ok: false }];
            }
        });
    });
}
// ── POST /api/meetups ─────────────────────────────────────────────────────────
var CreateMeetupSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(200),
    description: zod_1.z.string().max(1000).optional(),
    locationName: zod_1.z.string().max(300).optional(),
    approximateDate: zod_1.z.string().optional(), // YYYY-MM-DD
    timeBlock: zod_1.z.enum(["morning", "afternoon", "evening", "late"]).optional(),
    startsAt: zod_1.z.string().optional(), // ISO datetime when exact time is set
    tripId: zod_1.z.string().regex(UUID).optional(),
    circleOwnerId: zod_1.z.string().regex(UUID).optional(),
    visibility: zod_1.z.enum(["invitees", "trip", "circle", "friends"]).default("invitees"),
    inviteeIds: zod_1.z.array(zod_1.z.string().regex(UUID)).optional(),
});
router.post("/meetups", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, parsed, b, ok, isOwner, mem, _a, meetup, error, meetupId, inviteErrors, candidateIds, tripMemberRows, eligible_1, circleMemberRows, eligible_2, orParts, friendships, friendSet_1, inviteRows, iErr;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q;
    return __generator(this, function (_r) {
        switch (_r.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _r.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                parsed = CreateMeetupSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                b = parsed.data;
                if (!b.tripId) return [3 /*break*/, 3];
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, b.tripId, user.id)];
            case 2:
                ok = _r.sent();
                if (!ok) {
                    (0, http_js_1.sendError)(res, "not_member", "Must be accepted trip member to create a trip meetup");
                    return [2 /*return*/];
                }
                _r.label = 3;
            case 3:
                if (!b.circleOwnerId) return [3 /*break*/, 5];
                isOwner = user.id === b.circleOwnerId;
                if (!!isOwner) return [3 /*break*/, 5];
                return [4 /*yield*/, client
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", b.circleOwnerId)
                        .eq("member_id", user.id)
                        .maybeSingle()];
            case 4:
                mem = (_r.sent()).data;
                if (!mem) {
                    (0, http_js_1.sendError)(res, "forbidden", "Must be circle member to create a circle meetup");
                    return [2 /*return*/];
                }
                _r.label = 5;
            case 5: return [4 /*yield*/, client
                    .from("meetups")
                    .insert({
                    creator_id: user.id,
                    title: b.title,
                    description: (_d = b.description) !== null && _d !== void 0 ? _d : null,
                    location_name: (_e = b.locationName) !== null && _e !== void 0 ? _e : null,
                    approximate_date: (_f = b.approximateDate) !== null && _f !== void 0 ? _f : null,
                    time_block: b.startsAt ? null : ((_g = b.timeBlock) !== null && _g !== void 0 ? _g : null),
                    starts_at: (_h = b.startsAt) !== null && _h !== void 0 ? _h : null,
                    trip_id: (_j = b.tripId) !== null && _j !== void 0 ? _j : null,
                    circle_owner_id: (_k = b.circleOwnerId) !== null && _k !== void 0 ? _k : null,
                    visibility: b.visibility,
                    status: "active",
                })
                    .select("*")
                    .single()];
            case 6:
                _a = _r.sent(), meetup = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "create meetup");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                meetupId = meetup.id;
                inviteErrors = [];
                if (!(b.inviteeIds && b.inviteeIds.length > 0)) return [3 /*break*/, 16];
                candidateIds = b.inviteeIds.filter(function (id) { return id !== user.id; });
                if (!(b.tripId && candidateIds.length > 0)) return [3 /*break*/, 8];
                return [4 /*yield*/, client
                        .from("trip_members")
                        .select("user_id")
                        .eq("trip_id", b.tripId)
                        .in("role", ["owner", "member"])
                        .in("user_id", candidateIds)];
            case 7:
                tripMemberRows = (_r.sent()).data;
                eligible_1 = new Set((tripMemberRows !== null && tripMemberRows !== void 0 ? tripMemberRows : []).map(function (r) { return r.user_id; }));
                candidateIds = candidateIds.filter(function (id) { return eligible_1.has(id); });
                _r.label = 8;
            case 8:
                if (!(b.circleOwnerId && !b.tripId && candidateIds.length > 0)) return [3 /*break*/, 10];
                return [4 /*yield*/, client
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", b.circleOwnerId)
                        .in("member_id", candidateIds)];
            case 9:
                circleMemberRows = (_r.sent()).data;
                eligible_2 = new Set(__spreadArray([
                    b.circleOwnerId
                ], ((circleMemberRows !== null && circleMemberRows !== void 0 ? circleMemberRows : []).map(function (r) { return r.member_id; })), true));
                candidateIds = candidateIds.filter(function (id) { return eligible_2.has(id); });
                _r.label = 10;
            case 10:
                if (!(!b.tripId && !b.circleOwnerId && candidateIds.length > 0)) return [3 /*break*/, 12];
                orParts = candidateIds.flatMap(function (id) { return [
                    "and(user_a.eq.".concat(user.id, ",user_b.eq.").concat(id, ")"),
                    "and(user_b.eq.".concat(user.id, ",user_a.eq.").concat(id, ")"),
                ]; }).join(",");
                return [4 /*yield*/, client
                        .from("user_friendships")
                        .select("user_a, user_b")
                        .or(orParts)];
            case 11:
                friendships = (_r.sent()).data;
                friendSet_1 = new Set((friendships !== null && friendships !== void 0 ? friendships : [])
                    .flatMap(function (f) { return [f.user_a, f.user_b]; })
                    .filter(function (id) { return id !== user.id; }));
                candidateIds = candidateIds.filter(function (id) { return friendSet_1.has(id); });
                _r.label = 12;
            case 12:
                inviteRows = candidateIds.map(function (uid) { return ({ meetup_id: meetupId, user_id: uid }); });
                if (!(inviteRows.length > 0)) return [3 /*break*/, 16];
                return [4 /*yield*/, client
                        .from("meetup_invites")
                        .insert(inviteRows)];
            case 13:
                iErr = (_r.sent()).error;
                if (!iErr) return [3 /*break*/, 14];
                inviteErrors.push(iErr.message);
                return [3 /*break*/, 16];
            case 14: return [4 /*yield*/, createMeetupInboxItems(client, meetupId, meetup.title, inviteRows.map(function (r) { return r.user_id; }), user.id)];
            case 15:
                _r.sent();
                _r.label = 16;
            case 16:
                if (!((b.tripId || b.circleOwnerId) && !inviteErrors.length)) return [3 /*break*/, 18];
                return [4 /*yield*/, postMeetupSystemMessage(client, meetupId, meetup.title, (_l = b.tripId) !== null && _l !== void 0 ? _l : null, (_m = b.circleOwnerId) !== null && _m !== void 0 ? _m : null, user.id, {
                        locationName: (_o = b.locationName) !== null && _o !== void 0 ? _o : null,
                        approximateDate: (_p = b.approximateDate) !== null && _p !== void 0 ? _p : null,
                        timeBlock: (_q = b.timeBlock) !== null && _q !== void 0 ? _q : null,
                    })];
            case 17:
                _r.sent();
                _r.label = 18;
            case 18:
                res.status(201).json(__assign(__assign({}, meetup), { inviteErrors: inviteErrors }));
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/meetups/:meetupId ────────────────────────────────────────────────
router.get("/meetups/:meetupId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, access, meetup, invites, counts, goingIds, _i, _a, inv, s, options, optionIds, voteMap, votes, _b, _c, opt, _d, _e, v, bucket, vote, myInvite, isCreator, creator, goingAttendees, sc, _f, creatorResult, goingResult, cp;
    var _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w;
    return __generator(this, function (_x) {
        switch (_x.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _x.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, canAccessMeetup(client, meetupId, user.id)];
            case 2:
                access = _x.sent();
                if (!access.ok) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found or access denied");
                    return [2 /*return*/];
                }
                meetup = access.meetup;
                return [4 /*yield*/, client
                        .from("meetup_invites")
                        .select("user_id, status")
                        .eq("meetup_id", meetupId)];
            case 3:
                invites = (_x.sent()).data;
                counts = { going: 0, maybe: 0, declined: 0, pending: 0 };
                goingIds = [];
                for (_i = 0, _a = invites !== null && invites !== void 0 ? invites : []; _i < _a.length; _i++) {
                    inv = _a[_i];
                    s = inv.status;
                    if (s === "going") {
                        counts.going++;
                        if (goingIds.length < 4)
                            goingIds.push(inv.user_id);
                    }
                    else if (s === "maybe")
                        counts.maybe++;
                    else if (s === "declined")
                        counts.declined++;
                    else
                        counts.pending++;
                }
                return [4 /*yield*/, client
                        .from("meetup_time_options")
                        .select("*")
                        .eq("meetup_id", meetupId)
                        .order("proposed_date", { ascending: true })];
            case 4:
                options = (_x.sent()).data;
                optionIds = (options !== null && options !== void 0 ? options : []).map(function (o) { return o.id; });
                voteMap = {};
                if (!(optionIds.length > 0)) return [3 /*break*/, 6];
                return [4 /*yield*/, client
                        .from("meetup_time_votes")
                        .select("option_id, user_id, vote")
                        .in("option_id", optionIds)];
            case 5:
                votes = (_x.sent()).data;
                for (_b = 0, _c = options !== null && options !== void 0 ? options : []; _b < _c.length; _b++) {
                    opt = _c[_b];
                    voteMap[opt.id] = { yes: 0, maybe: 0, no: 0, myVote: null };
                }
                for (_d = 0, _e = votes !== null && votes !== void 0 ? votes : []; _d < _e.length; _d++) {
                    v = _e[_d];
                    bucket = voteMap[v.option_id];
                    if (bucket) {
                        vote = v.vote;
                        if (vote === "yes")
                            bucket.yes++;
                        else if (vote === "maybe")
                            bucket.maybe++;
                        else if (vote === "no")
                            bucket.no++;
                        if (v.user_id === user.id)
                            bucket.myVote = vote;
                    }
                }
                _x.label = 6;
            case 6: return [4 /*yield*/, client
                    .from("meetup_invites")
                    .select("status")
                    .eq("meetup_id", meetupId)
                    .eq("user_id", user.id)
                    .maybeSingle()];
            case 7:
                myInvite = (_x.sent()).data;
                isCreator = meetup.creator_id === user.id;
                creator = null;
                goingAttendees = [];
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) return [3 /*break*/, 9];
                return [4 /*yield*/, Promise.all([
                        sc.from("profiles").select("id, handle, name, avatar_url").eq("id", meetup.creator_id).maybeSingle(),
                        goingIds.length > 0
                            ? sc.from("profiles").select("id, handle, name, avatar_url").in("id", goingIds)
                            : Promise.resolve({ data: [] }),
                    ])];
            case 8:
                _f = _x.sent(), creatorResult = _f[0], goingResult = _f[1];
                if (creatorResult.data) {
                    cp = creatorResult.data;
                    creator = { id: cp.id, handle: (_g = cp.handle) !== null && _g !== void 0 ? _g : null, displayName: (_h = cp.name) !== null && _h !== void 0 ? _h : null, avatarUrl: (_j = cp.avatar_url) !== null && _j !== void 0 ? _j : null };
                }
                goingAttendees = ((_k = goingResult.data) !== null && _k !== void 0 ? _k : []).map(function (p) {
                    var _a, _b, _c;
                    return ({
                        id: p.id,
                        handle: (_a = p.handle) !== null && _a !== void 0 ? _a : null,
                        displayName: (_b = p.name) !== null && _b !== void 0 ? _b : null,
                        avatarUrl: (_c = p.avatar_url) !== null && _c !== void 0 ? _c : null,
                    });
                });
                _x.label = 9;
            case 9:
                res.json({
                    id: meetup.id,
                    creatorId: meetup.creator_id,
                    title: meetup.title,
                    description: (_l = meetup.description) !== null && _l !== void 0 ? _l : null,
                    locationName: (_m = meetup.location_name) !== null && _m !== void 0 ? _m : null,
                    approximateDate: (_o = meetup.approximate_date) !== null && _o !== void 0 ? _o : null,
                    timeBlock: (_p = meetup.time_block) !== null && _p !== void 0 ? _p : null,
                    startsAt: (_q = meetup.starts_at) !== null && _q !== void 0 ? _q : null,
                    endsAt: (_r = meetup.ends_at) !== null && _r !== void 0 ? _r : null,
                    status: meetup.status,
                    tripId: (_s = meetup.trip_id) !== null && _s !== void 0 ? _s : null,
                    circleOwnerId: (_t = meetup.circle_owner_id) !== null && _t !== void 0 ? _t : null,
                    visibility: meetup.visibility,
                    chatThreadId: (_u = meetup.chat_thread_id) !== null && _u !== void 0 ? _u : null,
                    chatMessageId: (_v = meetup.chat_message_id) !== null && _v !== void 0 ? _v : null,
                    createdAt: meetup.created_at,
                    updatedAt: meetup.updated_at,
                    counts: counts,
                    myRsvp: (_w = myInvite === null || myInvite === void 0 ? void 0 : myInvite.status) !== null && _w !== void 0 ? _w : null,
                    isCreator: isCreator,
                    creator: creator,
                    goingAttendees: goingAttendees,
                    totalGoing: counts.going,
                    timeOptions: (options !== null && options !== void 0 ? options : []).map(function (o) {
                        var _a, _b, _c, _d, _e;
                        return ({
                            id: o.id,
                            proposedDate: o.proposed_date,
                            proposedTime: (_a = o.proposed_time) !== null && _a !== void 0 ? _a : null,
                            timeBlock: (_b = o.time_block) !== null && _b !== void 0 ? _b : null,
                            label: (_c = o.label) !== null && _c !== void 0 ? _c : null,
                            confirmed: (_d = o.confirmed) !== null && _d !== void 0 ? _d : false,
                            votes: (_e = voteMap[o.id]) !== null && _e !== void 0 ? _e : { yes: 0, maybe: 0, no: 0, myVote: null },
                        });
                    }),
                });
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /api/meetups/:meetupId ─────────────────────────────────────────────
var UpdateMeetupSchema = zod_1.z.object({
    title: zod_1.z.string().min(1).max(200).optional(),
    description: zod_1.z.string().max(1000).nullable().optional(),
    locationName: zod_1.z.string().max(300).nullable().optional(),
    approximateDate: zod_1.z.string().nullable().optional(),
    timeBlock: zod_1.z.enum(["morning", "afternoon", "evening", "late"]).nullable().optional(),
    startsAt: zod_1.z.string().nullable().optional(),
    status: zod_1.z.enum(["draft", "active", "confirmed", "cancelled"]).optional(),
});
router.patch("/meetups/:meetupId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, meetup, parsed, b, patch, _a, updated, error;
    var _b, _c;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _d.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("meetups").select("creator_id").eq("id", meetupId).maybeSingle()];
            case 2:
                meetup = (_d.sent()).data;
                if (!meetup) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found");
                    return [2 /*return*/];
                }
                if (meetup.creator_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the creator can edit this meetup");
                    return [2 /*return*/];
                }
                parsed = UpdateMeetupSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                b = parsed.data;
                patch = { updated_at: new Date().toISOString() };
                if (b.title !== undefined)
                    patch.title = b.title;
                if (b.description !== undefined)
                    patch.description = b.description;
                if (b.locationName !== undefined)
                    patch.location_name = b.locationName;
                if (b.approximateDate !== undefined)
                    patch.approximate_date = b.approximateDate;
                if (b.timeBlock !== undefined)
                    patch.time_block = b.timeBlock;
                if (b.startsAt !== undefined)
                    patch.starts_at = b.startsAt;
                if (b.status !== undefined)
                    patch.status = b.status;
                return [4 /*yield*/, client
                        .from("meetups").update(patch).eq("id", meetupId).select("*").single()];
            case 3:
                _a = _d.sent(), updated = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "update meetup");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json(toCamelMeetup(updated));
                return [2 /*return*/];
        }
    });
}); });
// ── DELETE /api/meetups/:meetupId ────────────────────────────────────────────
router.delete("/meetups/:meetupId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, meetup, now;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _a.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetups")
                        .select("creator_id, title, trip_id, circle_owner_id")
                        .eq("id", meetupId)
                        .maybeSingle()];
            case 2:
                meetup = (_a.sent()).data;
                if (!meetup) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found");
                    return [2 /*return*/];
                }
                if (meetup.creator_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the creator can cancel this meetup");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, client.from("meetups").update({ status: "cancelled", updated_at: now }).eq("id", meetupId)];
            case 3:
                _a.sent();
                return [4 /*yield*/, client.from("meetup_invites").update({ status: "cancelled", updated_at: now }).eq("meetup_id", meetupId).eq("status", "pending")];
            case 4:
                _a.sent();
                // Post a system message to the linked chat thread (best-effort)
                postCancelSystemMessage(client, meetupId, meetup.title, meetup.trip_id, meetup.circle_owner_id, user.id).catch(function () { });
                res.status(200).json({ status: "cancelled", meetupId: meetupId });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/meetups/:meetupId/invites ──────────────────────────────────────
var InviteSchema = zod_1.z.object({
    userIds: zod_1.z.array(zod_1.z.string().regex(UUID)).min(1).max(50),
});
router.post("/meetups/:meetupId/invites", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, meetup, parsed, candidateIds, ineligible, tripId, circleOwnerId, tripMembers, eligibleSet_1, circleMembers, eligibleSet_2, creatorId_1, orParts, friendships, friendSet_2, existing, alreadyInvited, toInvite;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _c.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetups")
                        .select("creator_id, title, status, trip_id, circle_owner_id, visibility")
                        .eq("id", meetupId)
                        .maybeSingle()];
            case 2:
                meetup = (_c.sent()).data;
                if (!meetup) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found");
                    return [2 /*return*/];
                }
                if (meetup.creator_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the creator can invite users");
                    return [2 /*return*/];
                }
                if (meetup.status === "cancelled") {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Cannot invite to a cancelled meetup");
                    return [2 /*return*/];
                }
                parsed = InviteSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_b = (_a = parsed.error.issues[0]) === null || _a === void 0 ? void 0 : _a.message) !== null && _b !== void 0 ? _b : "Invalid body");
                    return [2 /*return*/];
                }
                candidateIds = parsed.data.userIds.filter(function (id) { return id !== user.id; });
                if (candidateIds.length === 0) {
                    res.json({ invited: [], skipped: [], ineligible: [] });
                    return [2 /*return*/];
                }
                ineligible = [];
                tripId = meetup.trip_id;
                circleOwnerId = meetup.circle_owner_id;
                if (!tripId) return [3 /*break*/, 4];
                return [4 /*yield*/, client
                        .from("trip_members")
                        .select("user_id")
                        .eq("trip_id", tripId)
                        .in("role", ["owner", "member"])
                        .in("user_id", candidateIds)];
            case 3:
                tripMembers = (_c.sent()).data;
                eligibleSet_1 = new Set((tripMembers !== null && tripMembers !== void 0 ? tripMembers : []).map(function (r) { return r.user_id; }));
                ineligible = candidateIds.filter(function (id) { return !eligibleSet_1.has(id); });
                candidateIds = candidateIds.filter(function (id) { return eligibleSet_1.has(id); });
                return [3 /*break*/, 8];
            case 4:
                if (!circleOwnerId) return [3 /*break*/, 6];
                return [4 /*yield*/, client
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", circleOwnerId)
                        .in("member_id", candidateIds)];
            case 5:
                circleMembers = (_c.sent()).data;
                eligibleSet_2 = new Set(__spreadArray([
                    circleOwnerId
                ], ((circleMembers !== null && circleMembers !== void 0 ? circleMembers : []).map(function (r) { return r.member_id; })), true));
                ineligible = candidateIds.filter(function (id) { return !eligibleSet_2.has(id); });
                candidateIds = candidateIds.filter(function (id) { return eligibleSet_2.has(id); });
                return [3 /*break*/, 8];
            case 6:
                creatorId_1 = meetup.creator_id;
                if (!(candidateIds.length > 0)) return [3 /*break*/, 8];
                orParts = candidateIds.flatMap(function (id) { return [
                    "and(user_a.eq.".concat(creatorId_1, ",user_b.eq.").concat(id, ")"),
                    "and(user_b.eq.".concat(creatorId_1, ",user_a.eq.").concat(id, ")"),
                ]; }).join(",");
                return [4 /*yield*/, client
                        .from("user_friendships")
                        .select("user_a, user_b")
                        .or(orParts)];
            case 7:
                friendships = (_c.sent()).data;
                friendSet_2 = new Set((friendships !== null && friendships !== void 0 ? friendships : [])
                    .flatMap(function (f) { return [f.user_a, f.user_b]; })
                    .filter(function (id) { return id !== creatorId_1; }));
                ineligible = candidateIds.filter(function (id) { return !friendSet_2.has(id); });
                candidateIds = candidateIds.filter(function (id) { return friendSet_2.has(id); });
                _c.label = 8;
            case 8:
                if (candidateIds.length === 0 && ineligible.length > 0) {
                    (0, http_js_1.sendError)(res, "forbidden", "None of the provided users are eligible to be invited (scope restriction)");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetup_invites").select("user_id").eq("meetup_id", meetupId).in("user_id", candidateIds)];
            case 9:
                existing = (_c.sent()).data;
                alreadyInvited = new Set((existing !== null && existing !== void 0 ? existing : []).map(function (r) { return r.user_id; }));
                toInvite = candidateIds.filter(function (id) { return !alreadyInvited.has(id); });
                if (!(toInvite.length > 0)) return [3 /*break*/, 12];
                return [4 /*yield*/, client.from("meetup_invites").insert(toInvite.map(function (uid) { return ({ meetup_id: meetupId, user_id: uid }); }))];
            case 10:
                _c.sent();
                return [4 /*yield*/, createMeetupInboxItems(client, meetupId, meetup.title, toInvite, user.id)];
            case 11:
                _c.sent();
                _c.label = 12;
            case 12:
                res.json({ invited: toInvite, skipped: __spreadArray([], alreadyInvited, true), ineligible: ineligible });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/meetups/:meetupId/rsvp ─────────────────────────────────────────
var RsvpSchema = zod_1.z.object({
    status: zod_1.z.enum(["going", "maybe", "declined"]),
});
router.post("/meetups/:meetupId/rsvp", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, access, parsed, now, _a, data, error, invites, counts, _i, _b, inv, s;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _e.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, canAccessMeetup(client, meetupId, user.id)];
            case 2:
                access = _e.sent();
                if (!access.ok) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found or access denied");
                    return [2 /*return*/];
                }
                if (access.meetup.status === "cancelled") {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Cannot RSVP to a cancelled meetup");
                    return [2 /*return*/];
                }
                parsed = RsvpSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid body");
                    return [2 /*return*/];
                }
                now = new Date().toISOString();
                return [4 /*yield*/, client
                        .from("meetup_invites")
                        .upsert({ meetup_id: meetupId, user_id: user.id, status: parsed.data.status, updated_at: now }, { onConflict: "meetup_id,user_id" })
                        .select("*")
                        .single()];
            case 3:
                _a = _e.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "rsvp meetup");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetup_invites").select("status").eq("meetup_id", meetupId)];
            case 4:
                invites = (_e.sent()).data;
                counts = { going: 0, maybe: 0, declined: 0, pending: 0 };
                for (_i = 0, _b = invites !== null && invites !== void 0 ? invites : []; _i < _b.length; _i++) {
                    inv = _b[_i];
                    s = inv.status;
                    if (s === "going")
                        counts.going++;
                    else if (s === "maybe")
                        counts.maybe++;
                    else if (s === "declined")
                        counts.declined++;
                    else
                        counts.pending++;
                }
                res.json({ status: data.status, meetupId: meetupId, counts: counts });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/meetups/:meetupId/time-options ─────────────────────────────────
var TimeOptionSchema = zod_1.z.object({
    proposedDate: zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
    proposedTime: zod_1.z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Must be HH:MM or HH:MM:SS").optional(),
    timeBlock: zod_1.z.enum(["morning", "afternoon", "evening", "late"]).optional(),
    label: zod_1.z.string().max(200).optional(),
});
router.post("/meetups/:meetupId/time-options", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, meetup, parsed, b, existingCount, _a, option, error;
    var _b, _c, _d, _e, _f, _g, _h, _j;
    return __generator(this, function (_k) {
        switch (_k.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _k.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("meetups").select("creator_id, status").eq("id", meetupId).maybeSingle()];
            case 2:
                meetup = (_k.sent()).data;
                if (!meetup) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found");
                    return [2 /*return*/];
                }
                if (meetup.creator_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the creator can add time options");
                    return [2 /*return*/];
                }
                if (meetup.status === "cancelled") {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Cannot add options to cancelled meetup");
                    return [2 /*return*/];
                }
                parsed = TimeOptionSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                b = parsed.data;
                return [4 /*yield*/, client
                        .from("meetup_time_options")
                        .select("*", { count: "exact", head: true })
                        .eq("meetup_id", meetupId)];
            case 3:
                existingCount = (_k.sent()).count;
                if ((existingCount !== null && existingCount !== void 0 ? existingCount : 0) >= 5) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Maximum 5 time options allowed per meetup");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetup_time_options")
                        .insert({
                        meetup_id: meetupId,
                        proposed_date: b.proposedDate,
                        proposed_time: (_d = b.proposedTime) !== null && _d !== void 0 ? _d : null,
                        time_block: b.proposedTime ? null : ((_e = b.timeBlock) !== null && _e !== void 0 ? _e : null),
                        label: (_f = b.label) !== null && _f !== void 0 ? _f : null,
                    })
                        .select("*")
                        .single()];
            case 4:
                _a = _k.sent(), option = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "add time option");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({
                    id: option.id,
                    meetupId: meetupId,
                    proposedDate: option.proposed_date,
                    proposedTime: (_g = option.proposed_time) !== null && _g !== void 0 ? _g : null,
                    timeBlock: (_h = option.time_block) !== null && _h !== void 0 ? _h : null,
                    label: (_j = option.label) !== null && _j !== void 0 ? _j : null,
                    confirmed: false,
                    votes: { yes: 0, maybe: 0, no: 0, myVote: null },
                });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/meetups/:meetupId/time-options/:optionId/vote ──────────────────
var VoteSchema = zod_1.z.object({
    vote: zod_1.z.enum(["yes", "maybe", "no"]),
});
router.post("/meetups/:meetupId/time-options/:optionId/vote", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, _a, meetupId, optionId, access, option, parsed, error, votes, counts, _i, _b, v, vt;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _e.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                _a = req.params, meetupId = _a.meetupId, optionId = _a.optionId;
                if (!UUID.test(meetupId) || !UUID.test(optionId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid ID");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, canAccessMeetup(client, meetupId, user.id)];
            case 2:
                access = _e.sent();
                if (!access.ok) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found or access denied");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetup_time_options").select("id, meetup_id").eq("id", optionId).eq("meetup_id", meetupId).maybeSingle()];
            case 3:
                option = (_e.sent()).data;
                if (!option) {
                    (0, http_js_1.sendError)(res, "not_found", "Time option not found");
                    return [2 /*return*/];
                }
                parsed = VoteSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid body");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetup_time_votes")
                        .upsert({ option_id: optionId, user_id: user.id, vote: parsed.data.vote, voted_at: new Date().toISOString() }, { onConflict: "option_id,user_id" })];
            case 4:
                error = (_e.sent()).error;
                if (error) {
                    req.log.error({ err: error }, "vote time option");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetup_time_votes").select("user_id, vote").eq("option_id", optionId)];
            case 5:
                votes = (_e.sent()).data;
                counts = { yes: 0, maybe: 0, no: 0, myVote: parsed.data.vote };
                for (_i = 0, _b = votes !== null && votes !== void 0 ? votes : []; _i < _b.length; _i++) {
                    v = _b[_i];
                    vt = v.vote;
                    if (vt === "yes")
                        counts.yes++;
                    else if (vt === "maybe")
                        counts.maybe++;
                    else
                        counts.no++;
                }
                res.json({ optionId: optionId, votes: counts });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/meetups/:meetupId/confirm-time ─────────────────────────────────
var ConfirmTimeSchema = zod_1.z.object({
    optionId: zod_1.z.string().regex(UUID),
});
router.post("/meetups/:meetupId/confirm-time", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, meetup, parsed, option, date, proposedTime, block, startsAt, _a, _b, h, _c, m, blockHour, hour, now, _d, updated, error;
    var _e, _f, _g;
    return __generator(this, function (_h) {
        switch (_h.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _h.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client.from("meetups").select("creator_id, status, title, trip_id, circle_owner_id, location_name").eq("id", meetupId).maybeSingle()];
            case 2:
                meetup = (_h.sent()).data;
                if (!meetup) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found");
                    return [2 /*return*/];
                }
                if (meetup.creator_id !== user.id) {
                    (0, http_js_1.sendError)(res, "forbidden", "Only the creator can confirm the time");
                    return [2 /*return*/];
                }
                if (meetup.status === "cancelled") {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Meetup is cancelled");
                    return [2 /*return*/];
                }
                parsed = ConfirmTimeSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_f = (_e = parsed.error.issues[0]) === null || _e === void 0 ? void 0 : _e.message) !== null && _f !== void 0 ? _f : "Invalid body");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetup_time_options").select("*").eq("id", parsed.data.optionId).eq("meetup_id", meetupId).maybeSingle()];
            case 3:
                option = (_h.sent()).data;
                if (!option) {
                    (0, http_js_1.sendError)(res, "not_found", "Time option not found in this meetup");
                    return [2 /*return*/];
                }
                date = option.proposed_date;
                proposedTime = option.proposed_time;
                block = option.time_block;
                if (proposedTime) {
                    _a = proposedTime.split(":"), _b = _a[0], h = _b === void 0 ? "00" : _b, _c = _a[1], m = _c === void 0 ? "00" : _c;
                    startsAt = "".concat(date, "T").concat(h.padStart(2, "0"), ":").concat(m.padStart(2, "0"), ":00");
                }
                else {
                    blockHour = { morning: 9, afternoon: 13, evening: 18, late: 22 };
                    hour = block ? ((_g = blockHour[block]) !== null && _g !== void 0 ? _g : 18) : 18;
                    startsAt = "".concat(date, "T").concat(String(hour).padStart(2, "0"), ":00:00");
                }
                now = new Date().toISOString();
                // Clear any previously confirmed options for this meetup first (single winner)
                return [4 /*yield*/, client.from("meetup_time_options").update({ confirmed: false }).eq("meetup_id", meetupId).eq("confirmed", true)];
            case 4:
                // Clear any previously confirmed options for this meetup first (single winner)
                _h.sent();
                return [4 /*yield*/, client.from("meetup_time_options").update({ confirmed: true }).eq("id", parsed.data.optionId)];
            case 5:
                _h.sent();
                return [4 /*yield*/, client
                        .from("meetups")
                        .update({ starts_at: startsAt, status: "confirmed", updated_at: now })
                        .eq("id", meetupId)
                        .select("*")
                        .single()];
            case 6:
                _d = _h.sent(), updated = _d.data, error = _d.error;
                if (error) {
                    req.log.error({ err: error }, "confirm time");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                // Notify invitees via the trip/circle chat thread (best-effort)
                return [4 /*yield*/, postConfirmTimeSystemMessage(client, meetupId, meetup.title, meetup.trip_id, meetup.circle_owner_id, user.id, startsAt, meetup.location_name).catch(function () { })];
            case 7:
                // Notify invitees via the trip/circle chat thread (best-effort)
                _h.sent();
                // Push-notify all Going/Maybe RSVPs (excluding the confirmer). Best-effort:
                // a push failure must never fail the confirm-time response.
                pushMeetupTimeConfirmed(meetupId, meetup.title, user.id, startsAt).catch(function (err) { return req.log.warn({ err: err }, "confirm-time push dispatch"); });
                res.json({ startsAt: startsAt, status: "confirmed", meetupId: meetupId, meetup: toCamelMeetup(updated) });
                return [2 /*return*/];
        }
    });
}); });
// ── POST /api/meetups/:meetupId/add-to-trip-plan ─────────────────────────────
var AddToPlanSchema = zod_1.z.object({
    tripId: zod_1.z.string().regex(UUID, "tripId must be a valid UUID"),
});
router.post("/meetups/:meetupId/add-to-trip-plan", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, parsed, tripId, canEdit, meetup, existing, _a, item, error;
    var _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _f.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                meetupId = req.params.meetupId;
                if (!UUID.test(meetupId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid meetupId");
                    return [2 /*return*/];
                }
                parsed = AddToPlanSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                tripId = parsed.data.tripId;
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 2:
                canEdit = _f.sent();
                if (canEdit === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!canEdit) {
                    (0, http_js_1.sendError)(res, "forbidden", "You do not have permission to add items to this trip's plan");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetups").select("id, title, starts_at, location_name, status, trip_id, visibility").eq("id", meetupId).maybeSingle()];
            case 3:
                meetup = (_f.sent()).data;
                if (!meetup) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found");
                    return [2 /*return*/];
                }
                // Enforce meetup-trip identity: a trip-scoped meetup may only be added to its own trip
                if (meetup.trip_id && meetup.trip_id !== tripId) {
                    (0, http_js_1.sendError)(res, "forbidden", "This meetup is scoped to a different trip");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .select("id")
                        .eq("trip_id", tripId)
                        .eq("source_type", "meetup")
                        .eq("source_id", meetupId)
                        .is("removed_at", null)
                        .maybeSingle()];
            case 4:
                existing = (_f.sent()).data;
                if (existing) {
                    res.status(200).json({ message: "already_added", planItemId: existing.id, idempotent: true });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .insert({
                        trip_id: tripId,
                        creator_id: user.id,
                        title: meetup.title,
                        category: "meeting_point",
                        status: "tentative",
                        source_type: "meetup",
                        source_id: meetupId,
                        starts_at: (_d = meetup.starts_at) !== null && _d !== void 0 ? _d : null,
                        location_name: (_e = meetup.location_name) !== null && _e !== void 0 ? _e : null,
                        sort_order: 0,
                        visibility: "members",
                    })
                        .select("*")
                        .single()];
            case 5:
                _a = _f.sent(), item = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "add meetup to trip plan");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json({ planItemId: item.id, tripId: tripId, meetupId: meetupId });
                return [2 /*return*/];
        }
    });
}); });
// ── Helpers ───────────────────────────────────────────────────────────────────
function toCamelMeetup(m) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    return {
        id: m.id,
        creatorId: m.creator_id,
        title: m.title,
        description: (_a = m.description) !== null && _a !== void 0 ? _a : null,
        locationName: (_b = m.location_name) !== null && _b !== void 0 ? _b : null,
        approximateDate: (_c = m.approximate_date) !== null && _c !== void 0 ? _c : null,
        timeBlock: (_d = m.time_block) !== null && _d !== void 0 ? _d : null,
        startsAt: (_e = m.starts_at) !== null && _e !== void 0 ? _e : null,
        endsAt: (_f = m.ends_at) !== null && _f !== void 0 ? _f : null,
        status: m.status,
        tripId: (_g = m.trip_id) !== null && _g !== void 0 ? _g : null,
        circleOwnerId: (_h = m.circle_owner_id) !== null && _h !== void 0 ? _h : null,
        visibility: m.visibility,
        chatThreadId: (_j = m.chat_thread_id) !== null && _j !== void 0 ? _j : null,
        chatMessageId: (_k = m.chat_message_id) !== null && _k !== void 0 ? _k : null,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
    };
}
// Push-notify every Going/Maybe RSVP (excluding the confirmer) that the meetup
// time was locked in. Best-effort: never throws — all errors are logged by the
// caller. Users without an expo_push_token are silently skipped by sendPushNotification.
function pushMeetupTimeConfirmed(meetupId, meetupTitle, confirmerId, startsAt) {
    return __awaiter(this, void 0, void 0, function () {
        var sc, invites, recipientIds, _a, tokenRows, confirmerProfile, confirmerName, when, pushTokens;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0:
                    sc = (0, supabase_js_1.getServiceClient)();
                    if (!sc)
                        return [2 /*return*/];
                    return [4 /*yield*/, sc
                            .from("meetup_invites")
                            .select("user_id, status")
                            .eq("meetup_id", meetupId)
                            .in("status", ["going", "maybe"])];
                case 1:
                    invites = (_d.sent()).data;
                    recipientIds = Array.from(new Set((invites !== null && invites !== void 0 ? invites : [])
                        .map(function (r) { return r.user_id; })
                        .filter(function (id) { return id && id !== confirmerId; })));
                    if (recipientIds.length === 0)
                        return [2 /*return*/];
                    return [4 /*yield*/, Promise.all([
                            sc.from("profiles").select("id, expo_push_token").in("id", recipientIds),
                            sc.from("profiles").select("name, handle").eq("id", confirmerId).maybeSingle(),
                        ])];
                case 2:
                    _a = _d.sent(), tokenRows = _a[0].data, confirmerProfile = _a[1].data;
                    confirmerName = (_c = (_b = confirmerProfile === null || confirmerProfile === void 0 ? void 0 : confirmerProfile.name) !== null && _b !== void 0 ? _b : confirmerProfile === null || confirmerProfile === void 0 ? void 0 : confirmerProfile.handle) !== null && _c !== void 0 ? _c : "The organizer";
                    when = formatMeetupWhen(startsAt);
                    pushTokens = (tokenRows !== null && tokenRows !== void 0 ? tokenRows : []).map(function (r) { return r.expo_push_token; });
                    return [4 /*yield*/, (0, push_js_1.sendPushNotification)(pushTokens, {
                            title: "".concat(confirmerName, " confirmed a meetup time"),
                            body: "".concat(meetupTitle, " \u2014 ").concat(when),
                            data: { screen: "meetup", meetupId: meetupId },
                        })];
                case 3:
                    _d.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// Format a meetup starts_at (local naive ISO like "2026-06-25T18:00:00") into a
// short human-readable "Thu, Jun 25 · 6:00 PM" label for the push body.
function formatMeetupWhen(startsAt) {
    var d = new Date(startsAt);
    if (Number.isNaN(d.getTime()))
        return startsAt;
    var datePart = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
    });
    var timePart = d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
    });
    return "".concat(datePart, " \u00B7 ").concat(timePart);
}
function postCancelSystemMessage(client, meetupId, title, tripId, circleOwnerId, creatorId) {
    return __awaiter(this, void 0, void 0, function () {
        var threadId, thread, thread, profile, creatorName, text, body;
        var _a, _b, _c, _d;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    threadId = null;
                    if (!tripId) return [3 /*break*/, 2];
                    return [4 /*yield*/, client
                            .from("message_threads").select("id").eq("trip_id", tripId).eq("thread_type", "trip").maybeSingle()];
                case 1:
                    thread = (_e.sent()).data;
                    threadId = (_a = thread === null || thread === void 0 ? void 0 : thread.id) !== null && _a !== void 0 ? _a : null;
                    return [3 /*break*/, 4];
                case 2:
                    if (!circleOwnerId) return [3 /*break*/, 4];
                    return [4 /*yield*/, client
                            .from("message_threads").select("id").eq("circle_owner_id", circleOwnerId).eq("thread_type", "circle").maybeSingle()];
                case 3:
                    thread = (_e.sent()).data;
                    threadId = (_b = thread === null || thread === void 0 ? void 0 : thread.id) !== null && _b !== void 0 ? _b : null;
                    _e.label = 4;
                case 4:
                    if (!threadId)
                        return [2 /*return*/];
                    return [4 /*yield*/, client
                            .from("profiles").select("name, handle").eq("id", creatorId).maybeSingle()];
                case 5:
                    profile = (_e.sent()).data;
                    creatorName = (_d = (_c = profile === null || profile === void 0 ? void 0 : profile.name) !== null && _c !== void 0 ? _c : profile === null || profile === void 0 ? void 0 : profile.handle) !== null && _d !== void 0 ? _d : "Someone";
                    text = "".concat(creatorName, " cancelled the meetup: ").concat(title);
                    body = JSON.stringify({ type: "meetup_cancelled", meetupId: meetupId, title: title, creatorName: creatorName, text: text });
                    return [4 /*yield*/, client.from("messages").insert({
                            thread_id: threadId,
                            sender_id: creatorId,
                            body: body,
                            msg_type: "system",
                            subtype: "meetup_cancelled",
                        })];
                case 6:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function createMeetupInboxItems(client, meetupId, title, userIds, creatorId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            // Insert a row into meetup_invites (already done by caller).
            // We also want to create a request inbox item — however, that table is
            // not generalised yet. We store the meetup invite itself and the mobile app
            // reads pending meetup_invites from GET /api/me/meetup-invites.
            // No separate inbox table row required — the count endpoint is extended.
            void meetupId;
            void title;
            void userIds;
            void creatorId;
            return [2 /*return*/];
        });
    });
}
function postConfirmTimeSystemMessage(client_1, meetupId_1, title_1, tripId_1, circleOwnerId_1, creatorId_2, startsAt_1) {
    return __awaiter(this, arguments, void 0, function (client, meetupId, title, tripId, circleOwnerId, creatorId, startsAt, locationName) {
        var threadId, thread, thread, profile, creatorName, confirmedDate, confirmedTime, parts, text, body;
        var _a, _b, _c, _d;
        if (locationName === void 0) { locationName = null; }
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    threadId = null;
                    if (!tripId) return [3 /*break*/, 2];
                    return [4 /*yield*/, client
                            .from("message_threads")
                            .select("id")
                            .eq("trip_id", tripId)
                            .eq("thread_type", "trip")
                            .maybeSingle()];
                case 1:
                    thread = (_e.sent()).data;
                    threadId = (_a = thread === null || thread === void 0 ? void 0 : thread.id) !== null && _a !== void 0 ? _a : null;
                    return [3 /*break*/, 4];
                case 2:
                    if (!circleOwnerId) return [3 /*break*/, 4];
                    return [4 /*yield*/, client
                            .from("message_threads")
                            .select("id")
                            .eq("circle_owner_id", circleOwnerId)
                            .eq("thread_type", "circle")
                            .maybeSingle()];
                case 3:
                    thread = (_e.sent()).data;
                    threadId = (_b = thread === null || thread === void 0 ? void 0 : thread.id) !== null && _b !== void 0 ? _b : null;
                    _e.label = 4;
                case 4:
                    if (!threadId)
                        return [2 /*return*/];
                    return [4 /*yield*/, client
                            .from("profiles")
                            .select("name, handle")
                            .eq("id", creatorId)
                            .maybeSingle()];
                case 5:
                    profile = (_e.sent()).data;
                    creatorName = (_d = (_c = profile === null || profile === void 0 ? void 0 : profile.name) !== null && _c !== void 0 ? _c : profile === null || profile === void 0 ? void 0 : profile.handle) !== null && _d !== void 0 ? _d : "Someone";
                    confirmedDate = new Date(startsAt).toLocaleDateString("en-US", {
                        weekday: "short", month: "short", day: "numeric",
                    });
                    confirmedTime = new Date(startsAt).toLocaleTimeString("en-US", {
                        hour: "numeric", minute: "2-digit",
                    });
                    parts = ["".concat(title, " \u2014 ").concat(confirmedDate, " at ").concat(confirmedTime)];
                    if (locationName)
                        parts.push(locationName);
                    text = "".concat(creatorName, " confirmed the meetup: ").concat(parts.join(" — "));
                    body = JSON.stringify({
                        type: "meetup_confirmed",
                        meetupId: meetupId,
                        title: title,
                        startsAt: startsAt,
                        locationName: locationName !== null && locationName !== void 0 ? locationName : undefined,
                        creatorName: creatorName,
                        text: text,
                    });
                    return [4 /*yield*/, client
                            .from("messages")
                            .insert({ thread_id: threadId, sender_id: creatorId, body: body, msg_type: "system", subtype: "meetup_confirmed" })];
                case 6:
                    _e.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function postMeetupSystemMessage(client_1, meetupId_1, title_1, tripId_1, circleOwnerId_1, creatorId_2) {
    return __awaiter(this, arguments, void 0, function (client, meetupId, title, tripId, circleOwnerId, creatorId, extras) {
        var threadId, thread, thread, profile, plannedByName, body, msg;
        var _a, _b, _c, _d;
        if (extras === void 0) { extras = {}; }
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    threadId = null;
                    if (!tripId) return [3 /*break*/, 2];
                    return [4 /*yield*/, client
                            .from("message_threads")
                            .select("id")
                            .eq("trip_id", tripId)
                            .eq("thread_type", "trip")
                            .maybeSingle()];
                case 1:
                    thread = (_e.sent()).data;
                    threadId = (_a = thread === null || thread === void 0 ? void 0 : thread.id) !== null && _a !== void 0 ? _a : null;
                    return [3 /*break*/, 4];
                case 2:
                    if (!circleOwnerId) return [3 /*break*/, 4];
                    return [4 /*yield*/, client
                            .from("message_threads")
                            .select("id")
                            .eq("circle_owner_id", circleOwnerId)
                            .eq("thread_type", "circle")
                            .maybeSingle()];
                case 3:
                    thread = (_e.sent()).data;
                    threadId = (_b = thread === null || thread === void 0 ? void 0 : thread.id) !== null && _b !== void 0 ? _b : null;
                    _e.label = 4;
                case 4:
                    if (!threadId)
                        return [2 /*return*/];
                    return [4 /*yield*/, client
                            .from("profiles")
                            .select("name, handle")
                            .eq("id", creatorId)
                            .maybeSingle()];
                case 5:
                    profile = (_e.sent()).data;
                    plannedByName = (_d = (_c = profile === null || profile === void 0 ? void 0 : profile.name) !== null && _c !== void 0 ? _c : profile === null || profile === void 0 ? void 0 : profile.handle) !== null && _d !== void 0 ? _d : null;
                    body = JSON.stringify(__assign(__assign(__assign(__assign({ type: "meetup_card", meetupId: meetupId, title: title }, (extras.locationName ? { locationName: extras.locationName } : {})), (extras.approximateDate ? { approximateDate: extras.approximateDate } : {})), (extras.timeBlock ? { timeBlock: extras.timeBlock } : {})), (plannedByName ? { plannedByName: plannedByName } : {})));
                    return [4 /*yield*/, client
                            .from("messages")
                            .insert({ thread_id: threadId, sender_id: creatorId, body: body, msg_type: "system", subtype: "meetup" })
                            .select("id")
                            .single()];
                case 6:
                    msg = (_e.sent()).data;
                    if (!msg) return [3 /*break*/, 8];
                    return [4 /*yield*/, client
                            .from("meetups")
                            .update({ chat_thread_id: threadId, chat_message_id: msg.id })
                            .eq("id", meetupId)];
                case 7:
                    _e.sent();
                    _e.label = 8;
                case 8: return [2 /*return*/];
            }
        });
    });
}
// ── GET /api/me/meetups ───────────────────────────────────────────────────────
// All meetups where the caller is creator or invitee.
// ?filter=upcoming  — exclude cancelled (default)
// ?filter=past      — confirmed+past or cancelled only
// ?filter=all       — no status filter
router.get("/me/meetups", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, filter, _a, inviteRows, invErr, inviteStatusMap, _i, _b, row, invitedIds, query, today, _c, meetups, mErr, meetupList, meetupIds, allInvites, countMap, myRsvpMap, _d, _e, inv, mid, s, result;
    var _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _g.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                filter = (_f = req.query.filter) !== null && _f !== void 0 ? _f : "upcoming";
                return [4 /*yield*/, client
                        .from("meetup_invites")
                        .select("meetup_id, status")
                        .eq("user_id", user.id)];
            case 2:
                _a = _g.sent(), inviteRows = _a.data, invErr = _a.error;
                if (invErr) {
                    (0, http_js_1.sendError)(res, "db_error", invErr.message);
                    return [2 /*return*/];
                }
                inviteStatusMap = new Map();
                for (_i = 0, _b = inviteRows !== null && inviteRows !== void 0 ? inviteRows : []; _i < _b.length; _i++) {
                    row = _b[_i];
                    inviteStatusMap.set(row.meetup_id, row.status);
                }
                invitedIds = Array.from(inviteStatusMap.keys());
                if (invitedIds.length > 0) {
                    query = client
                        .from("meetups")
                        .select("*")
                        .or("creator_id.eq.".concat(user.id, ",id.in.(").concat(invitedIds.join(","), ")"));
                }
                else {
                    query = client.from("meetups").select("*").eq("creator_id", user.id);
                }
                today = new Date().toISOString().split("T")[0];
                if (filter === "upcoming") {
                    query = query.neq("status", "cancelled");
                }
                else if (filter === "past") {
                    query = query.or("status.eq.cancelled,and(status.eq.confirmed,approximate_date.lt.".concat(today, ")"));
                }
                query = query.order("created_at", { ascending: false });
                return [4 /*yield*/, query];
            case 3:
                _c = _g.sent(), meetups = _c.data, mErr = _c.error;
                if (mErr) {
                    req.log.error({ err: mErr }, "get me/meetups");
                    (0, http_js_1.sendError)(res, "db_error", mErr.message);
                    return [2 /*return*/];
                }
                meetupList = meetups !== null && meetups !== void 0 ? meetups : [];
                if (meetupList.length === 0) {
                    res.json({ meetups: [] });
                    return [2 /*return*/];
                }
                meetupIds = meetupList.map(function (m) { return m.id; });
                return [4 /*yield*/, client
                        .from("meetup_invites")
                        .select("meetup_id, user_id, status")
                        .in("meetup_id", meetupIds)];
            case 4:
                allInvites = (_g.sent()).data;
                countMap = {};
                myRsvpMap = {};
                for (_d = 0, _e = allInvites !== null && allInvites !== void 0 ? allInvites : []; _d < _e.length; _d++) {
                    inv = _e[_d];
                    mid = inv.meetup_id;
                    if (!countMap[mid])
                        countMap[mid] = { going: 0, maybe: 0, declined: 0, pending: 0 };
                    s = inv.status;
                    if (s === "going")
                        countMap[mid].going++;
                    else if (s === "maybe")
                        countMap[mid].maybe++;
                    else if (s === "declined")
                        countMap[mid].declined++;
                    else
                        countMap[mid].pending++;
                    if (inv.user_id === user.id)
                        myRsvpMap[mid] = s;
                }
                result = meetupList.map(function (m) {
                    var _a, _b;
                    return (__assign(__assign({}, toCamelMeetup(m)), { isCreator: m.creator_id === user.id, myRsvp: (_a = myRsvpMap[m.id]) !== null && _a !== void 0 ? _a : null, counts: (_b = countMap[m.id]) !== null && _b !== void 0 ? _b : { going: 0, maybe: 0, declined: 0, pending: 0 } }));
                });
                res.json({ meetups: result });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/meetup-invites ────────────────────────────────────────────────
// Pending meetup invites for the inbox badge + inbox list
router.get("/me/meetup-invites", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, invites, meetupIds, meetups, meetupMap, _i, _a, m, creatorIds, profiles, profileMap, _b, _c, p, result;
    return __generator(this, function (_d) {
        switch (_d.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _d.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                return [4 /*yield*/, client
                        .from("meetup_invites")
                        .select("id, meetup_id, status, invited_at")
                        .eq("user_id", user.id)
                        .in("status", ["pending", "going", "maybe"])
                        .order("invited_at", { ascending: false })];
            case 2:
                invites = (_d.sent()).data;
                if (!invites || invites.length === 0) {
                    res.json({ invites: [] });
                    return [2 /*return*/];
                }
                meetupIds = invites.map(function (i) { return i.meetup_id; });
                return [4 /*yield*/, client
                        .from("meetups")
                        .select("id, title, location_name, approximate_date, time_block, starts_at, creator_id, status")
                        .in("id", meetupIds)
                        .neq("status", "cancelled")];
            case 3:
                meetups = (_d.sent()).data;
                meetupMap = {};
                for (_i = 0, _a = meetups !== null && meetups !== void 0 ? meetups : []; _i < _a.length; _i++) {
                    m = _a[_i];
                    meetupMap[m.id] = m;
                }
                creatorIds = __spreadArray([], new Set((meetups !== null && meetups !== void 0 ? meetups : []).map(function (m) { return m.creator_id; })), true);
                return [4 /*yield*/, client.from("profiles").select("id, handle, name, avatar_url").in("id", creatorIds)];
            case 4:
                profiles = (_d.sent()).data;
                profileMap = {};
                for (_b = 0, _c = profiles !== null && profiles !== void 0 ? profiles : []; _b < _c.length; _b++) {
                    p = _c[_b];
                    profileMap[p.id] = p;
                }
                result = invites
                    .filter(function (i) {
                    var m = meetupMap[i.meetup_id];
                    if (!m || m.status === "cancelled")
                        return false;
                    if (i.status === "pending")
                        return true;
                    // going / maybe → surface as confirmation notification only when meetup is confirmed
                    return (i.status === "going" || i.status === "maybe") && m.status === "confirmed";
                })
                    .map(function (i) {
                    var _a, _b, _c, _d, _e;
                    var m = meetupMap[i.meetup_id];
                    var creator = m ? profileMap[m.creator_id] : null;
                    var kind = i.status === "pending" ? "invite" : "confirmation";
                    return {
                        inviteId: i.id,
                        meetupId: i.meetup_id,
                        status: i.status,
                        invitedAt: i.invited_at,
                        kind: kind,
                        meetup: m ? {
                            id: m.id,
                            title: m.title,
                            locationName: (_a = m.location_name) !== null && _a !== void 0 ? _a : null,
                            approximateDate: (_b = m.approximate_date) !== null && _b !== void 0 ? _b : null,
                            timeBlock: (_c = m.time_block) !== null && _c !== void 0 ? _c : null,
                            startsAt: (_d = m.starts_at) !== null && _d !== void 0 ? _d : null,
                            status: m.status,
                        } : null,
                        creator: creator ? { id: creator.id, handle: creator.handle, name: creator.name, avatarUrl: (_e = creator.avatar_url) !== null && _e !== void 0 ? _e : null } : null,
                    };
                });
                res.json({ invites: result });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /me/frequent-invitees ─────────────────────────────────────────────────
// Returns the top 3 users the caller has most often invited to their meetups.
// Result is cached per user for 1 hour (memory, resets on server restart).
router.get("/me/frequent-invitees", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, cached, sc, _a, meetupRows, meetupErr, meetupIds, _b, inviteRows, invErr, countMap, _i, inviteRows_1, r, uid, top3, _c, profiles, profErr, profileMap, invitees;
    var _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                cached = freqCache.get(user.id);
                if (cached && freqCacheFresh(cached)) {
                    res.json({ invitees: cached.data });
                    return [2 /*return*/];
                }
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("meetups")
                        .select("id")
                        .eq("creator_id", user.id)];
            case 2:
                _a = _e.sent(), meetupRows = _a.data, meetupErr = _a.error;
                if (meetupErr) {
                    (0, http_js_1.sendError)(res, "db_error", meetupErr.message);
                    return [2 /*return*/];
                }
                if (!meetupRows || meetupRows.length === 0) {
                    res.json({ invitees: [] });
                    return [2 /*return*/];
                }
                meetupIds = meetupRows.map(function (r) { return r.id; });
                return [4 /*yield*/, sc
                        .from("meetup_invites")
                        .select("user_id")
                        .in("meetup_id", meetupIds)
                        .neq("user_id", user.id)];
            case 3:
                _b = _e.sent(), inviteRows = _b.data, invErr = _b.error;
                if (invErr) {
                    (0, http_js_1.sendError)(res, "db_error", invErr.message);
                    return [2 /*return*/];
                }
                if (!inviteRows || inviteRows.length === 0) {
                    freqCache.set(user.id, { data: [], cachedAt: Date.now() });
                    res.json({ invitees: [] });
                    return [2 /*return*/];
                }
                countMap = new Map();
                for (_i = 0, inviteRows_1 = inviteRows; _i < inviteRows_1.length; _i++) {
                    r = inviteRows_1[_i];
                    uid = r.user_id;
                    countMap.set(uid, ((_d = countMap.get(uid)) !== null && _d !== void 0 ? _d : 0) + 1);
                }
                top3 = __spreadArray([], countMap.entries(), true).sort(function (a, b) { return b[1] - a[1]; })
                    .slice(0, 3)
                    .map(function (_a) {
                    var id = _a[0], count = _a[1];
                    return ({ id: id, count: count });
                });
                return [4 /*yield*/, sc
                        .from("profiles")
                        .select("id, handle, name, avatar_url")
                        .in("id", top3.map(function (e) { return e.id; }))];
            case 4:
                _c = _e.sent(), profiles = _c.data, profErr = _c.error;
                if (profErr) {
                    (0, http_js_1.sendError)(res, "db_error", profErr.message);
                    return [2 /*return*/];
                }
                profileMap = new Map((profiles !== null && profiles !== void 0 ? profiles : []).map(function (p) { return [p.id, p]; }));
                invitees = top3
                    .map(function (_a) {
                    var _b;
                    var id = _a.id, count = _a.count;
                    var p = profileMap.get(id);
                    if (!p)
                        return null;
                    return {
                        id: p.id,
                        handle: p.handle,
                        name: p.name,
                        avatarUrl: (_b = p.avatar_url) !== null && _b !== void 0 ? _b : null,
                        count: count,
                    };
                })
                    .filter(function (x) { return x !== null; });
                freqCache.set(user.id, { data: invitees, cachedAt: Date.now() });
                res.json({ invitees: invitees });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
