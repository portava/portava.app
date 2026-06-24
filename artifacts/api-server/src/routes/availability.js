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
 * Availability routes
 *
 * GET/PATCH /api/me/availability         — own weekly grid + open_to_meet
 * GET/PATCH /api/me/quick-availability   — quick status (expires_at)
 * GET/PATCH /api/trips/:tripId/availability  — trip-scoped windows for accepted members
 * GET       /api/circles/:circleId/availability — circle member quick statuses
 *
 * HARD RULES:
 *  - user_id always resolved from JWT — never from body
 *  - No GPS / exact location exposed
 *  - Read gates: friend / circle / trip membership per visibility
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var supabase_js_1 = require("../lib/supabase.js");
var logger_js_1 = require("../lib/logger.js");
var push_js_1 = require("../lib/push.js");
var router = (0, express_1.Router)();
var WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
var BLOCKS = ["morning", "afternoon", "evening", "late"];
var WeeklyDaysSchema = zod_1.z.record(zod_1.z.enum(WEEKDAYS), zod_1.z.array(zod_1.z.enum(BLOCKS))).optional();
var PatchAvailabilitySchema = zod_1.z.object({
    weeklyDays: WeeklyDaysSchema,
    openToMeet: zod_1.z.boolean().optional(),
    strictMode: zod_1.z.boolean().optional(),
});
var QuickStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(["free_now", "busy", "open_to_plans", "free_tonight"]),
    expiresAt: zod_1.z.string().optional(), // ISO string
});
// ── GET /api/me/availability ─────────────────────────────────────────────────
router.get("/me/availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, _a, data, error, qs, quickStatus;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _e.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                return [4 /*yield*/, client
                        .from("user_availability")
                        .select("*")
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 2:
                _a = _e.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "get availability");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("quick_availability_status")
                        .select("*")
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 3:
                qs = (_e.sent()).data;
                quickStatus = qs && qs.expires_at > new Date().toISOString()
                    ? { status: qs.status, expiresAt: qs.expires_at }
                    : null;
                if (!data) {
                    res.json({ weeklyDays: {}, openToMeet: false, strictMode: false, quickStatus: quickStatus });
                    return [2 /*return*/];
                }
                res.json({
                    weeklyDays: (_b = data.weekly_days) !== null && _b !== void 0 ? _b : {},
                    openToMeet: (_c = data.open_to_meet) !== null && _c !== void 0 ? _c : false,
                    strictMode: (_d = data.strict_mode) !== null && _d !== void 0 ? _d : false,
                    quickStatus: quickStatus,
                });
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /api/me/availability ───────────────────────────────────────────────
router.patch("/me/availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, parsed, b, now, upsertRow, _a, data, error;
    var _b, _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _g.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                parsed = PatchAvailabilitySchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                b = parsed.data;
                now = new Date().toISOString();
                upsertRow = {
                    user_id: user.id,
                    updated_at: now,
                };
                if (b.weeklyDays !== undefined)
                    upsertRow.weekly_days = b.weeklyDays;
                if (b.openToMeet !== undefined)
                    upsertRow.open_to_meet = b.openToMeet;
                if (b.strictMode !== undefined)
                    upsertRow.strict_mode = b.strictMode;
                return [4 /*yield*/, client
                        .from("user_availability")
                        .upsert(upsertRow, { onConflict: "user_id" })
                        .select("*")
                        .single()];
            case 2:
                _a = _g.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "patch availability");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({
                    weeklyDays: (_d = data.weekly_days) !== null && _d !== void 0 ? _d : {},
                    openToMeet: (_e = data.open_to_meet) !== null && _e !== void 0 ? _e : false,
                    strictMode: (_f = data.strict_mode) !== null && _f !== void 0 ? _f : false,
                });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/quick-availability ──────────────────────────────────────────
router.get("/me/quick-availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, data;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _a.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                return [4 /*yield*/, client
                        .from("quick_availability_status")
                        .select("*")
                        .eq("user_id", user.id)
                        .maybeSingle()];
            case 2:
                data = (_a.sent()).data;
                if (!data || data.expires_at <= new Date().toISOString()) {
                    res.json({ status: null, expiresAt: null });
                    return [2 /*return*/];
                }
                res.json({ status: data.status, expiresAt: data.expires_at });
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /api/me/quick-availability ────────────────────────────────────────
router.patch("/me/quick-availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, parsed, b, defaultHours, expiresAt, _a, data, error;
    var _b, _c, _d, _e;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _f.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                parsed = QuickStatusSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                b = parsed.data;
                defaultHours = {
                    free_now: 4, free_tonight: 6, open_to_plans: 24, busy: 8,
                };
                expiresAt = (_d = b.expiresAt) !== null && _d !== void 0 ? _d : new Date(Date.now() + ((_e = defaultHours[b.status]) !== null && _e !== void 0 ? _e : 8) * 3600000).toISOString();
                return [4 /*yield*/, client
                        .from("quick_availability_status")
                        .upsert({ user_id: user.id, status: b.status, expires_at: expiresAt, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
                        .select("*")
                        .single()];
            case 2:
                _a = _f.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "patch quick-availability");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ status: data.status, expiresAt: data.expires_at });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/trips/:tripId/availability ─────────────────────────────────────
// Returns trip-scoped windows + quick statuses for all accepted trip members.
// Reads from trip_availability (trip-scoped) with fallback to user_availability.
router.get("/trips/:tripId/availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    function isFreeOnDate(uid, date) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        var openDays = (_b = (_a = tripAvMap[uid]) === null || _a === void 0 ? void 0 : _a.open_days) !== null && _b !== void 0 ? _b : null;
        var weeklyDays = (_d = (_c = globalAvMap[uid]) === null || _c === void 0 ? void 0 : _c.weekly_days) !== null && _d !== void 0 ? _d : {};
        if (openDays !== null) {
            if (Object.keys(openDays).length === 0)
                return false;
            return ((_f = (_e = openDays[date]) === null || _e === void 0 ? void 0 : _e.length) !== null && _f !== void 0 ? _f : 0) > 0;
        }
        if (Object.keys(weeklyDays).length === 0)
            return false;
        var wd = WDAY_IDX[new Date(date + "T12:00:00").getDay()];
        return ((_h = (_g = weeklyDays[wd]) === null || _g === void 0 ? void 0 : _g.length) !== null && _h !== void 0 ? _h : 0) > 0;
    }
    var ctx, client, user, tripId, member, members, memberIds, _a, tripAvRows, globalAvRows, qsRows, profiles, tripRow, now, tripAvMap, _i, _b, r, globalAvMap, _c, _d, r, qsMap, _e, _f, r, profileMap, _g, _h, p, result, WDAY_IDX, todayDate, rawStart, startDay, rawEnd, maxEnd, endDay, tripDays, cur, bestDays;
    return __generator(this, function (_j) {
        switch (_j.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _j.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _j.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to view availability");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_members")
                        .select("user_id")
                        .eq("trip_id", tripId)
                        .in("role", ["owner", "member"])];
            case 3:
                members = (_j.sent()).data;
                memberIds = (members !== null && members !== void 0 ? members : []).map(function (m) { return m.user_id; });
                return [4 /*yield*/, Promise.all([
                        client.from("trip_availability").select("user_id, open_days").eq("trip_id", tripId).in("user_id", memberIds),
                        client.from("user_availability").select("user_id, weekly_days, open_to_meet").in("user_id", memberIds),
                        client.from("quick_availability_status").select("user_id, status, expires_at").in("user_id", memberIds),
                        client.from("profiles").select("id, handle, name, avatar_url").in("id", memberIds),
                        client.from("trips").select("start_date, end_date").eq("id", tripId).maybeSingle(),
                    ])];
            case 4:
                _a = _j.sent(), tripAvRows = _a[0].data, globalAvRows = _a[1].data, qsRows = _a[2].data, profiles = _a[3].data, tripRow = _a[4].data;
                now = new Date().toISOString();
                tripAvMap = {};
                for (_i = 0, _b = tripAvRows !== null && tripAvRows !== void 0 ? tripAvRows : []; _i < _b.length; _i++) {
                    r = _b[_i];
                    tripAvMap[r.user_id] = r;
                }
                globalAvMap = {};
                for (_c = 0, _d = globalAvRows !== null && globalAvRows !== void 0 ? globalAvRows : []; _c < _d.length; _c++) {
                    r = _d[_c];
                    globalAvMap[r.user_id] = r;
                }
                qsMap = {};
                for (_e = 0, _f = qsRows !== null && qsRows !== void 0 ? qsRows : []; _e < _f.length; _e++) {
                    r = _f[_e];
                    if (r.expires_at > now)
                        qsMap[r.user_id] = r;
                }
                profileMap = {};
                for (_g = 0, _h = profiles !== null && profiles !== void 0 ? profiles : []; _g < _h.length; _g++) {
                    p = _h[_g];
                    profileMap[p.id] = p;
                }
                result = memberIds.map(function (uid) {
                    var _a, _b, _c, _d, _e, _f;
                    var ta = tripAvMap[uid];
                    var ga = globalAvMap[uid];
                    var qs = qsMap[uid];
                    var p = profileMap[uid];
                    return {
                        userId: uid,
                        handle: (_a = p === null || p === void 0 ? void 0 : p.handle) !== null && _a !== void 0 ? _a : null,
                        name: (_b = p === null || p === void 0 ? void 0 : p.name) !== null && _b !== void 0 ? _b : null,
                        avatarUrl: (_c = p === null || p === void 0 ? void 0 : p.avatar_url) !== null && _c !== void 0 ? _c : null,
                        // trip-scoped open_days takes priority; fall back to global weekly_days
                        openDays: (_d = ta === null || ta === void 0 ? void 0 : ta.open_days) !== null && _d !== void 0 ? _d : null,
                        weeklyDays: (_e = ga === null || ga === void 0 ? void 0 : ga.weekly_days) !== null && _e !== void 0 ? _e : {},
                        openToMeet: (_f = ga === null || ga === void 0 ? void 0 : ga.open_to_meet) !== null && _f !== void 0 ? _f : false,
                        quickStatus: qs ? { status: qs.status, expiresAt: qs.expires_at } : null,
                    };
                });
                WDAY_IDX = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
                todayDate = new Date();
                todayDate.setHours(0, 0, 0, 0);
                rawStart = (tripRow === null || tripRow === void 0 ? void 0 : tripRow.start_date) ? new Date(tripRow.start_date + "T00:00:00") : todayDate;
                startDay = rawStart >= todayDate ? rawStart : todayDate;
                rawEnd = (tripRow === null || tripRow === void 0 ? void 0 : tripRow.end_date)
                    ? new Date(tripRow.end_date + "T00:00:00")
                    : new Date(startDay.getTime() + 13 * 86400000);
                maxEnd = new Date(startDay.getTime() + 29 * 86400000);
                endDay = rawEnd < maxEnd ? rawEnd : maxEnd;
                tripDays = [];
                cur = new Date(startDay);
                while (cur <= endDay) {
                    tripDays.push(cur.toISOString().slice(0, 10));
                    cur.setDate(cur.getDate() + 1);
                }
                bestDays = tripDays
                    .map(function (date) { return ({ date: date, count: memberIds.filter(function (uid) { return isFreeOnDate(uid, date); }).length }); })
                    .filter(function (d) { return d.count >= 2; })
                    .sort(function (a, b) { return b.count - a.count; })
                    .slice(0, 3);
                res.json({ members: result, tripId: tripId, bestDays: bestDays });
                return [2 /*return*/];
        }
    });
}); });
// ── PATCH /api/trips/:tripId/availability ────────────────────────────────────
// Set trip-specific open days — stored in trip_availability (scoped per trip+user).
// Schema: { openDays: { "2025-07-04": ["morning","evening"], ... } }
var PatchTripAvailabilitySchema = zod_1.z.object({
    openDays: zod_1.z.record(zod_1.z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Key must be YYYY-MM-DD"), zod_1.z.array(zod_1.z.enum(BLOCKS))),
});
router.patch("/trips/:tripId/availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, tripId, member, parsed, _a, data, error, freeDates;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _e.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                tripId = req.params.tripId;
                if (!/^[0-9a-f-]{36}$/i.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _e.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to set availability");
                    return [2 /*return*/];
                }
                parsed = PatchTripAvailabilitySchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_availability")
                        .upsert({ trip_id: tripId, user_id: user.id, open_days: parsed.data.openDays, updated_at: new Date().toISOString() }, { onConflict: "trip_id,user_id" })
                        .select("*")
                        .single()];
            case 3:
                _a = _e.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "patch trip availability");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({ tripId: tripId, userId: user.id, openDays: (_d = data.open_days) !== null && _d !== void 0 ? _d : {} });
                freeDates = Object.entries(parsed.data.openDays)
                    .filter(function (_a) {
                    var blocks = _a[1];
                    return blocks.length > 0;
                })
                    .map(function (_a) {
                    var date = _a[0];
                    return date;
                });
                if (freeDates.length > 0) {
                    sendAvailabilityNudges(tripId, user.id, freeDates, req.log).catch(function () { });
                }
                return [2 /*return*/];
        }
    });
}); });
// ─── Availability nudge helper ─────────────────────────────────────────────────
function sendAvailabilityNudges(tripId, senderId, freeDates, log) {
    return __awaiter(this, void 0, void 0, function () {
        var sc, today, memberRows, recipientIds, existingAv, existingAvMap, _i, _a, row, rows, _loop_1, _b, recipientIds_1, recipientId, _c, insertedRows, error, newRows, newRecipientIds, nudgeDate, _d, tokenRows, senderProfile, tripRow, senderName, tripTitle, dateLabel, pushTokens;
        var _e, _f, _g, _h, _j;
        return __generator(this, function (_k) {
            switch (_k.label) {
                case 0:
                    sc = (0, supabase_js_1.getServiceClient)();
                    if (!sc)
                        return [2 /*return*/];
                    today = new Date().toISOString().slice(0, 10);
                    return [4 /*yield*/, sc
                            .from("trip_members")
                            .select("user_id")
                            .eq("trip_id", tripId)
                            .in("role", ["owner", "member"])
                            .neq("user_id", senderId)];
                case 1:
                    memberRows = (_k.sent()).data;
                    recipientIds = (memberRows !== null && memberRows !== void 0 ? memberRows : []).map(function (r) { return r.user_id; });
                    if (recipientIds.length === 0)
                        return [2 /*return*/];
                    return [4 /*yield*/, sc
                            .from("trip_availability")
                            .select("user_id, open_days")
                            .eq("trip_id", tripId)
                            .in("user_id", recipientIds)];
                case 2:
                    existingAv = (_k.sent()).data;
                    existingAvMap = {};
                    for (_i = 0, _a = existingAv !== null && existingAv !== void 0 ? existingAv : []; _i < _a.length; _i++) {
                        row = _a[_i];
                        existingAvMap[row.user_id] = (_e = row.open_days) !== null && _e !== void 0 ? _e : {};
                    }
                    rows = [];
                    _loop_1 = function (recipientId) {
                        var theirDays = (_f = existingAvMap[recipientId]) !== null && _f !== void 0 ? _f : {};
                        // Find the first free date the recipient hasn't explicitly set at all.
                        // Any explicit entry (empty or non-empty array) means they've already
                        // recorded their status for that day — free or busy.
                        var firstUnmarked = freeDates.find(function (d) { return !Object.prototype.hasOwnProperty.call(theirDays, d); });
                        if (!firstUnmarked)
                            return "continue"; // all dates already have an explicit entry
                        rows.push({
                            sender_id: senderId,
                            recipient_id: recipientId,
                            trip_id: tripId,
                            nudge_date: firstUnmarked,
                            sent_on: today,
                        });
                    };
                    for (_b = 0, recipientIds_1 = recipientIds; _b < recipientIds_1.length; _b++) {
                        recipientId = recipientIds_1[_b];
                        _loop_1(recipientId);
                    }
                    if (rows.length === 0)
                        return [2 /*return*/];
                    return [4 /*yield*/, sc
                            .from("availability_nudges")
                            .upsert(rows, { onConflict: "recipient_id,trip_id,sent_on", ignoreDuplicates: true })
                            .select("recipient_id, nudge_date")];
                case 3:
                    _c = _k.sent(), insertedRows = _c.data, error = _c.error;
                    if (error) {
                        logger_js_1.logger.warn({ err: error, tripId: tripId, senderId: senderId }, "availability nudge insert failed");
                        return [2 /*return*/];
                    }
                    newRows = insertedRows !== null && insertedRows !== void 0 ? insertedRows : [];
                    logger_js_1.logger.info({ inserted: newRows.length, attempted: rows.length, tripId: tripId }, "availability nudges");
                    if (newRows.length === 0)
                        return [2 /*return*/]; // all were duplicates — no push needed
                    newRecipientIds = newRows.map(function (r) { return r.recipient_id; });
                    nudgeDate = newRows
                        .map(function (r) { return r.nudge_date; })
                        .sort()[0];
                    return [4 /*yield*/, Promise.all([
                            sc.from("profiles").select("id, expo_push_token").in("id", newRecipientIds),
                            sc.from("profiles").select("name, handle").eq("id", senderId).single(),
                            sc.from("trips").select("title").eq("id", tripId).single(),
                        ])];
                case 4:
                    _d = _k.sent(), tokenRows = _d[0].data, senderProfile = _d[1].data, tripRow = _d[2].data;
                    senderName = (_h = (_g = senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.name) !== null && _g !== void 0 ? _g : senderProfile === null || senderProfile === void 0 ? void 0 : senderProfile.handle) !== null && _h !== void 0 ? _h : "A trip member";
                    tripTitle = (_j = tripRow === null || tripRow === void 0 ? void 0 : tripRow.title) !== null && _j !== void 0 ? _j : "your trip";
                    dateLabel = new Date(nudgeDate + "T12:00:00Z").toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                    });
                    pushTokens = (tokenRows !== null && tokenRows !== void 0 ? tokenRows : []).map(function (r) { return r.expo_push_token; });
                    return [4 /*yield*/, (0, push_js_1.sendPushNotification)(pushTokens, {
                            title: "Availability update 📅",
                            body: "".concat(senderName, " is free ").concat(dateLabel, " \u2014 are you?"),
                            data: { screen: "availability", tripId: tripId, tripTitle: tripTitle },
                        })];
                case 5:
                    _k.sent();
                    return [2 /*return*/];
            }
        });
    });
}
// ── PATCH /api/circles/:circleId/availability ────────────────────────────────
// Update the calling user's own general availability (gated by circle membership).
// Circle availability = shared general grid; no separate scoped table needed.
router.patch("/circles/:circleId/availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, circleId, isOwner, mem, parsed, b, now, upsertRow, _a, data, error;
    var _b, _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _g.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                circleId = req.params.circleId;
                if (!/^[0-9a-f-]{36}$/i.test(circleId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid circleId");
                    return [2 /*return*/];
                }
                isOwner = user.id === circleId;
                if (!!isOwner) return [3 /*break*/, 3];
                return [4 /*yield*/, client
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", circleId)
                        .eq("member_id", user.id)
                        .maybeSingle()];
            case 2:
                mem = (_g.sent()).data;
                if (!mem) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a circle member");
                    return [2 /*return*/];
                }
                _g.label = 3;
            case 3:
                parsed = PatchAvailabilitySchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                b = parsed.data;
                now = new Date().toISOString();
                upsertRow = { user_id: user.id, updated_at: now };
                if (b.weeklyDays !== undefined)
                    upsertRow.weekly_days = b.weeklyDays;
                if (b.openToMeet !== undefined)
                    upsertRow.open_to_meet = b.openToMeet;
                if (b.strictMode !== undefined)
                    upsertRow.strict_mode = b.strictMode;
                return [4 /*yield*/, client
                        .from("user_availability")
                        .upsert(upsertRow, { onConflict: "user_id" })
                        .select("*")
                        .single()];
            case 4:
                _a = _g.sent(), data = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "patch circle availability");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.json({
                    weeklyDays: (_d = data.weekly_days) !== null && _d !== void 0 ? _d : {},
                    openToMeet: (_e = data.open_to_meet) !== null && _e !== void 0 ? _e : false,
                    strictMode: (_f = data.strict_mode) !== null && _f !== void 0 ? _f : false,
                });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/me/availability-nudges ──────────────────────────────────────────
// Returns recent availability nudges for the calling user, enriched with
// sender profile and trip title so the notifications screen can render them.
router.get("/me/availability-nudges", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, user, sc, _a, rows, error, senderIds, tripIds, _b, profiles, trips, profileMap, _i, _c, p, tripMap, _d, _e, t, nudges;
    return __generator(this, function (_f) {
        switch (_f.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _f.sent();
                if (!ctx)
                    return [2 /*return*/];
                user = ctx.user;
                sc = (0, supabase_js_1.getServiceClient)();
                if (!sc) {
                    (0, http_js_1.sendError)(res, "server_not_configured", "Service client not ready");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, sc
                        .from("availability_nudges")
                        .select("id, sender_id, trip_id, nudge_date, created_at")
                        .eq("recipient_id", user.id)
                        .order("created_at", { ascending: false })
                        .limit(30)];
            case 2:
                _a = _f.sent(), rows = _a.data, error = _a.error;
                if (error) {
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                if (!rows || rows.length === 0) {
                    res.json({ nudges: [] });
                    return [2 /*return*/];
                }
                senderIds = __spreadArray([], new Set(rows.map(function (r) { return r.sender_id; })), true);
                tripIds = __spreadArray([], new Set(rows.map(function (r) { return r.trip_id; })), true);
                return [4 /*yield*/, Promise.all([
                        sc.from("profiles").select("id, name, handle, avatar_url").in("id", senderIds),
                        sc.from("trips").select("id, title, destination_city").in("id", tripIds),
                    ])];
            case 3:
                _b = _f.sent(), profiles = _b[0].data, trips = _b[1].data;
                profileMap = {};
                for (_i = 0, _c = profiles !== null && profiles !== void 0 ? profiles : []; _i < _c.length; _i++) {
                    p = _c[_i];
                    profileMap[p.id] = p;
                }
                tripMap = {};
                for (_d = 0, _e = trips !== null && trips !== void 0 ? trips : []; _d < _e.length; _d++) {
                    t = _e[_d];
                    tripMap[t.id] = t;
                }
                nudges = rows.map(function (r) {
                    var _a, _b, _c, _d, _e;
                    var sender = profileMap[r.sender_id];
                    var trip = tripMap[r.trip_id];
                    return {
                        id: r.id,
                        senderId: r.sender_id,
                        senderName: (_a = sender === null || sender === void 0 ? void 0 : sender.name) !== null && _a !== void 0 ? _a : null,
                        senderHandle: (_b = sender === null || sender === void 0 ? void 0 : sender.handle) !== null && _b !== void 0 ? _b : null,
                        senderAvatarUrl: (_c = sender === null || sender === void 0 ? void 0 : sender.avatar_url) !== null && _c !== void 0 ? _c : null,
                        tripId: r.trip_id,
                        tripTitle: (_d = trip === null || trip === void 0 ? void 0 : trip.title) !== null && _d !== void 0 ? _d : null,
                        destinationCity: (_e = trip === null || trip === void 0 ? void 0 : trip.destination_city) !== null && _e !== void 0 ? _e : null,
                        nudgeDate: r.nudge_date,
                        createdAt: r.created_at,
                    };
                });
                res.json({ nudges: nudges });
                return [2 /*return*/];
        }
    });
}); });
// ── GET /api/circles/:circleId/availability ──────────────────────────────────
// Returns quick statuses + weekly grid for all circle members
// circleId = circle owner's user_id
router.get("/circles/:circleId/availability", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, circleId, isOwner, mem, memRows, memberIds, _a, avRows, qsRows, profiles, now, avMap, _i, _b, r, qsMap, _c, _d, r, profileMap, _e, _f, p, result;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _g.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                circleId = req.params.circleId;
                if (!/^[0-9a-f-]{36}$/i.test(circleId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid circleId");
                    return [2 /*return*/];
                }
                isOwner = user.id === circleId;
                if (!!isOwner) return [3 /*break*/, 3];
                return [4 /*yield*/, client
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", circleId)
                        .eq("member_id", user.id)
                        .maybeSingle()];
            case 2:
                mem = (_g.sent()).data;
                if (!mem) {
                    (0, http_js_1.sendError)(res, "forbidden", "Not a circle member");
                    return [2 /*return*/];
                }
                _g.label = 3;
            case 3: return [4 /*yield*/, client
                    .from("circle_memberships")
                    .select("member_id")
                    .eq("owner_id", circleId)];
            case 4:
                memRows = (_g.sent()).data;
                memberIds = __spreadArray([circleId], ((memRows !== null && memRows !== void 0 ? memRows : []).map(function (r) { return r.member_id; })), true);
                return [4 /*yield*/, Promise.all([
                        client.from("user_availability").select("user_id, weekly_days, open_to_meet").in("user_id", memberIds),
                        client.from("quick_availability_status").select("user_id, status, expires_at").in("user_id", memberIds),
                        client.from("profiles").select("id, handle, name, avatar_url").in("id", memberIds),
                    ])];
            case 5:
                _a = _g.sent(), avRows = _a[0].data, qsRows = _a[1].data, profiles = _a[2].data;
                now = new Date().toISOString();
                avMap = {};
                for (_i = 0, _b = avRows !== null && avRows !== void 0 ? avRows : []; _i < _b.length; _i++) {
                    r = _b[_i];
                    avMap[r.user_id] = r;
                }
                qsMap = {};
                for (_c = 0, _d = qsRows !== null && qsRows !== void 0 ? qsRows : []; _c < _d.length; _c++) {
                    r = _d[_c];
                    if (r.expires_at > now)
                        qsMap[r.user_id] = r;
                }
                profileMap = {};
                for (_e = 0, _f = profiles !== null && profiles !== void 0 ? profiles : []; _e < _f.length; _e++) {
                    p = _f[_e];
                    profileMap[p.id] = p;
                }
                result = memberIds.map(function (uid) {
                    var _a, _b, _c, _d, _e;
                    var av = avMap[uid];
                    var qs = qsMap[uid];
                    var p = profileMap[uid];
                    return {
                        userId: uid,
                        handle: (_a = p === null || p === void 0 ? void 0 : p.handle) !== null && _a !== void 0 ? _a : null,
                        name: (_b = p === null || p === void 0 ? void 0 : p.name) !== null && _b !== void 0 ? _b : null,
                        avatarUrl: (_c = p === null || p === void 0 ? void 0 : p.avatar_url) !== null && _c !== void 0 ? _c : null,
                        weeklyDays: (_d = av === null || av === void 0 ? void 0 : av.weekly_days) !== null && _d !== void 0 ? _d : {},
                        openToMeet: (_e = av === null || av === void 0 ? void 0 : av.open_to_meet) !== null && _e !== void 0 ? _e : false,
                        quickStatus: qs ? { status: qs.status, expiresAt: qs.expires_at } : null,
                        isOwner: uid === circleId,
                    };
                });
                res.json({ members: result, circleId: circleId });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
