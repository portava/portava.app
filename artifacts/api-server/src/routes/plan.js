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
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterPlanItemForViewer = filterPlanItemForViewer;
exports.toCamel = toCamel;
/**
 * Plan helper routes — add place or meetup to a trip plan.
 *
 *   POST /api/meetups/:meetupId/add-to-trip-plan  { tripId }
 *   POST /api/places/:placeId/add-to-trip-plan    { tripId, dayDate?, startsAt? }
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
// ── POST /meetups/:meetupId/add-to-trip-plan ─────────────────────────────────
var AddMeetupSchema = zod_1.z.object({
    tripId: zod_1.z.string().regex(UUID, "tripId must be a valid UUID"),
});
router.post("/meetups/:meetupId/add-to-trip-plan", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, meetupId, parsed, tripId, member, permitted, meetup, existing, _a, item, error;
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
                parsed = AddMeetupSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_c = (_b = parsed.error.issues[0]) === null || _b === void 0 ? void 0 : _b.message) !== null && _c !== void 0 ? _c : "Invalid body");
                    return [2 /*return*/];
                }
                tripId = parsed.data.tripId;
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _f.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to add items");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 3:
                permitted = _f.sent();
                if (permitted === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!permitted) {
                    (0, http_js_1.sendError)(res, "forbidden", "You don't have permission to add items to this plan");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("meetups")
                        .select("id, title, starts_at, location_name")
                        .eq("id", meetupId)
                        .maybeSingle()];
            case 4:
                meetup = (_f.sent()).data;
                if (!meetup) {
                    (0, http_js_1.sendError)(res, "not_found", "Meetup not found");
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
            case 5:
                existing = (_f.sent()).data;
                if (existing) {
                    res.status(409).json({ error: "duplicate", message: "This meetup is already in your trip plan" });
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
            case 6:
                _a = _f.sent(), item = _a.data, error = _a.error;
                if (error) {
                    req.log.error({ err: error }, "add meetup to plan");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json(toCamel(item));
                return [2 /*return*/];
        }
    });
}); });
// ── POST /places/:placeId/add-to-trip-plan ───────────────────────────────────
var AddPlaceSchema = zod_1.z.object({
    tripId: zod_1.z.string().regex(UUID, "tripId must be a valid UUID"),
    dayDate: zod_1.z.string().optional(),
    startsAt: zod_1.z.string().optional(),
});
router.post("/places/:placeId/add-to-trip-plan", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var ctx, client, user, placeId, parsed, _a, tripId, dayDate, startsAt, member, permitted, place, existing, _b, item, error;
    var _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                ctx = _g.sent();
                if (!ctx)
                    return [2 /*return*/];
                client = ctx.client, user = ctx.user;
                placeId = req.params.placeId;
                parsed = AddPlaceSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid body");
                    return [2 /*return*/];
                }
                _a = parsed.data, tripId = _a.tripId, dayDate = _a.dayDate, startsAt = _a.startsAt;
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _g.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to add items");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.canEditPlan)(client, tripId, user.id)];
            case 3:
                permitted = _g.sent();
                if (permitted === null) {
                    (0, http_js_1.sendError)(res, "not_found", "Trip not found");
                    return [2 /*return*/];
                }
                if (!permitted) {
                    (0, http_js_1.sendError)(res, "forbidden", "You don't have permission to add items to this plan");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("places")
                        .select("id, name, category, location_name")
                        .eq("id", placeId)
                        .maybeSingle()];
            case 4:
                place = (_g.sent()).data;
                if (!place) {
                    (0, http_js_1.sendError)(res, "not_found", "Place not found");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .select("id")
                        .eq("trip_id", tripId)
                        .eq("source_type", "place")
                        .eq("source_id", placeId)
                        .is("removed_at", null)
                        .maybeSingle()];
            case 5:
                existing = (_g.sent()).data;
                if (existing) {
                    res.status(409).json({ error: "duplicate", message: "This place is already in your trip plan" });
                    return [2 /*return*/];
                }
                return [4 /*yield*/, client
                        .from("trip_plan_items")
                        .insert({
                        trip_id: tripId,
                        creator_id: user.id,
                        title: place.name,
                        category: (_e = place.category) !== null && _e !== void 0 ? _e : "activity",
                        status: "tentative",
                        source_type: "place",
                        source_id: placeId,
                        day_date: dayDate !== null && dayDate !== void 0 ? dayDate : null,
                        starts_at: startsAt !== null && startsAt !== void 0 ? startsAt : null,
                        location_name: (_f = place.location_name) !== null && _f !== void 0 ? _f : null,
                        sort_order: 0,
                        visibility: "members",
                    })
                        .select("*")
                        .single()];
            case 6:
                _b = _g.sent(), item = _b.data, error = _b.error;
                if (error) {
                    req.log.error({ err: error }, "add place to plan");
                    (0, http_js_1.sendError)(res, "db_error", error.message);
                    return [2 /*return*/];
                }
                res.status(201).json(toCamel(item));
                return [2 /*return*/];
        }
    });
}); });
// ── Viewer-based privacy filter ───────────────────────────────────────────────
function filterPlanItemForViewer(row) {
    var _a, _b, _c;
    var locationIsPrivate = (_a = row.location_is_private) !== null && _a !== void 0 ? _a : true;
    return {
        lat: locationIsPrivate ? null : ((_b = row.lat) !== null && _b !== void 0 ? _b : null),
        lng: locationIsPrivate ? null : ((_c = row.lng) !== null && _c !== void 0 ? _c : null),
        locationIsPrivate: locationIsPrivate,
    };
}
// ── snake_case → camelCase row mapper ────────────────────────────────────────
function toCamel(row, opts) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    if (opts === void 0) { opts = {}; }
    var coords = opts.stripCoords
        ? { lat: null, lng: null, locationIsPrivate: (_a = row.location_is_private) !== null && _a !== void 0 ? _a : true }
        : filterPlanItemForViewer(row);
    return __assign(__assign({ id: row.id, tripId: row.trip_id, creatorId: row.creator_id, title: row.title, category: row.category, status: row.status, sourceType: row.source_type, sourceId: (_b = row.source_id) !== null && _b !== void 0 ? _b : null, dayDate: (_c = row.day_date) !== null && _c !== void 0 ? _c : null, startsAt: (_d = row.starts_at) !== null && _d !== void 0 ? _d : null, endsAt: (_e = row.ends_at) !== null && _e !== void 0 ? _e : null, locationName: (_f = row.location_name) !== null && _f !== void 0 ? _f : null, notes: (_g = row.notes) !== null && _g !== void 0 ? _g : null, sortOrder: row.sort_order, visibility: row.visibility }, coords), { warnings: (_h = opts.warnings) !== null && _h !== void 0 ? _h : [], createdAt: row.created_at, updatedAt: row.updated_at });
}
exports.default = router;
