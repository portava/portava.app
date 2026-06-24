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
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseIntent = parseIntent;
/**
 * Telegraph Concierge Command Routes
 *
 * POST /api/telegraph/commands                          — submit a natural language command
 * GET  /api/telegraph/commands/:commandId               — get command result (own commands only)
 * POST /api/telegraph/commands/:commandId/confirm-action — confirm a proposed action (BOLA-checked)
 * POST /api/telegraph/commands/:commandId/decline-action — decline a proposed action (BOLA-checked)
 * GET  /api/trips/:tripId/telegraph/commands/history    — command history for a trip (member-gated)
 *
 * Security:
 *   - requireUser on every route.
 *   - commandStore entries include owner userId; GET/confirm/decline reject cross-user access (403).
 *   - ProposedActions all have requires_confirmation: true.
 *   - confirm-action re-verifies trip membership at execution time.
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var privacyResolver_js_1 = require("../lib/privacyResolver.js");
var venuesService_js_1 = require("../lib/venuesService.js");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
/** Maps a Telegraph intent to the preference category that should be boosted on confirm. */
var INTENT_CATEGORY = {
    find_food: "food",
    find_nightlife: "nightlife",
    plan_day: "activity",
    fill_free_time: "activity",
    create_meetup_draft: "social",
    fix_schedule_conflict: "planning",
    what_is_missing: "planning",
    add_to_plan: "activity",
};
/* ── In-memory command store ──────────────────────────────────────────────────
 * Each entry includes the owner's userId so cross-user lookups are rejected.
 * Replace with DB persistence if commands need to survive server restart.
 */
var commandStore = new Map();
function genId() {
    return "cmd_".concat(Date.now(), "_").concat(Math.random().toString(36).slice(2, 8));
}
/* ── Intent parser ── */
function parseIntent(text) {
    var t = text.toLowerCase();
    var word = function (w) { return new RegExp("\\b".concat(w, "\\b")).test(t); };
    if (t.includes("meetup") || t.includes("meet up"))
        return "create_meetup_draft";
    if (t.includes("plan") && (t.includes("day") || t.includes("today") || t.includes("tonight")))
        return "plan_day";
    if (t.includes("conflict") || t.includes("overlap") || t.includes("clash") || t.includes("fix schedule"))
        return "fix_schedule_conflict";
    if (t.includes("free time") || t.includes("fill") || t.includes("gap") || t.includes("empty"))
        return "fill_free_time";
    if (t.includes("nightlife") || t.includes("bar") || t.includes("club") || t.includes("night out"))
        return "find_nightlife";
    if (word("food") || word("eat") || word("eating") || t.includes("restaurant") || t.includes("lunch") || t.includes("dinner") || t.includes("breakfast"))
        return "find_food";
    if (t.includes("missing") || t.includes("what else") || t.includes("what am i"))
        return "what_is_missing";
    if (t.includes("add") && t.includes("plan"))
        return "add_to_plan";
    return "unknown";
}
function buildResponse(commandId, intent, userText, tripId, accessLevel, destination, meetupContext, nearbyVenues) {
    var _a;
    // Build meetup-aware context for food suggestions
    var hasMeetupCtx = !!(meetupContext === null || meetupContext === void 0 ? void 0 : meetupContext.meetupId);
    var meetupTimeStr = (meetupContext === null || meetupContext === void 0 ? void 0 : meetupContext.meetupTime) ? formatMeetupTime(meetupContext.meetupTime) : "";
    var meetupLoc = (_a = meetupContext === null || meetupContext === void 0 ? void 0 : meetupContext.meetupLocation) !== null && _a !== void 0 ? _a : null;
    var nearbyRef = meetupLoc
        ? " near ".concat(meetupLoc)
        : destination
            ? " in ".concat(destination)
            : "";
    var timeRef = meetupTimeStr ? " at ".concat(meetupTimeStr) : "";
    var meal = getMealLabel(meetupContext === null || meetupContext === void 0 ? void 0 : meetupContext.meetupTime);
    var mealCap = meal === "breakfast" ? "Breakfast" : meal === "lunch" ? "Lunch" : "Dinner";
    var hasRealVenues = nearbyVenues && nearbyVenues.length > 0;
    var findFoodSummary = hasMeetupCtx
        ? "".concat(mealCap, " options").concat(nearbyRef).concat(timeRef, ", before your meetup. Tap to add one to your plan.")
        : "Food recommendations".concat(destination ? " for ".concat(destination) : "", ". Tap to add to your trip plan.");
    var mealVenueLabel = meal === "breakfast" ? "café or bakery" : meal === "lunch" ? "café or bistro" : "restaurant";
    var mealEstimate = meal === "breakfast" ? "30–45 min" : meal === "lunch" ? "45 min–1 hour" : "1–1.5 hours";
    // Build suggestions from real venue data when available; fall back to templates
    var buildVenueSuggestions = function (venues) {
        return venues.map(function (v) { return ({
            title: v.name,
            reason: [
                (0, venuesService_js_1.formatDistance)(v.distanceM),
                v.cuisine,
                meetupLoc ? "\u2014 easy to reach before your meetup" : null,
            ]
                .filter(Boolean)
                .join(" · "),
            category: "food",
            estimatedTime: v.priceLevel === "$" ? "30–45 min" : "45 min–1 hour",
            priceLevel: v.priceLevel,
        }); });
    };
    var findFoodSuggestions = hasRealVenues
        ? buildVenueSuggestions(nearbyVenues)
        : hasMeetupCtx
            ? [
                {
                    title: "".concat(mealCap, " spot").concat(nearbyRef),
                    reason: meetupLoc
                        ? "Close to ".concat(meetupLoc, " \u2014 easy to reach before your meetup")
                        : "Good option before your meetup".concat(timeRef),
                    category: "food",
                    estimatedTime: mealEstimate,
                    priceLevel: "$$",
                },
                {
                    title: "Quick pre-meetup bite",
                    reason: "Something light and fast so you're ready".concat(timeRef),
                    category: "food",
                    estimatedTime: "30–45 min",
                    priceLevel: "$",
                },
                {
                    title: "Local ".concat(mealVenueLabel).concat(nearbyRef),
                    reason: "Traveler favourite for the area",
                    category: "food",
                    estimatedTime: "1 hour",
                    priceLevel: "$$",
                },
            ]
            : [
                { title: "Local street food market", reason: "Authentic flavours at budget prices", category: "food", estimatedTime: "1–2 hours", priceLevel: "$" },
                { title: "Highly-rated restaurant nearby", reason: "Traveler favourite for the area", category: "food", estimatedTime: "1–1.5 hours", priceLevel: "$$" },
                { title: "Late-night food spots", reason: "Great for after-activities eating", category: "food", estimatedTime: "45 min", priceLevel: "$" },
            ];
    var templates = {
        plan_day: {
            summary: "Here's a suggested plan for today".concat(destination ? " in ".concat(destination) : "", ". Tap any action to add it to your trip or create a meetup."),
            suggestions: [
                { title: "Morning beach or market visit", reason: "Best time for beach or local market before the crowd", category: "beach", estimatedTime: "2–3 hours", priceLevel: "$" },
                { title: "Lunch at a local favourite", reason: "Midday fuel with local flavour", category: "food", estimatedTime: "1 hour", priceLevel: "$$" },
                { title: "Evening activity or nightlife", reason: "Wind down the day with the city's evening scene", category: "nightlife", estimatedTime: "2–4 hours", priceLevel: "$$" },
            ],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Add morning to plan", kind: "add_to_plan", params: { title: "Morning beach visit" }, requires_confirmation: true },
                { id: "".concat(commandId, "_a2"), label: "Create a meetup for this", kind: "create_meetup", params: { title: "Day plan meetup" }, requires_confirmation: true },
            ],
        },
        find_food: {
            summary: findFoodSummary,
            suggestions: findFoodSuggestions,
            actions: [
                {
                    id: "".concat(commandId, "_a1"),
                    label: "Add to plan",
                    kind: "add_to_plan",
                    params: hasMeetupCtx && (meetupContext === null || meetupContext === void 0 ? void 0 : meetupContext.meetupId)
                        ? { category: "dining", meetupId: meetupContext.meetupId }
                        : { category: "dining" },
                    requires_confirmation: true,
                },
            ],
        },
        find_nightlife: {
            summary: "Nightlife picks".concat(destination ? " for ".concat(destination) : "", ". Confirm before adding to your plan."),
            suggestions: [
                { title: "Rooftop bar with views", reason: "Popular evening spot with great atmosphere", category: "nightlife", estimatedTime: "2–3 hours", priceLevel: "$$" },
                { title: "Live music venue", reason: "Local bands, authentic night out", category: "nightlife", estimatedTime: "3–4 hours", priceLevel: "$$" },
                { title: "Night market walk", reason: "Street food meets social scene", category: "nightlife", estimatedTime: "1–2 hours", priceLevel: "$" },
            ],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Add nightlife to plan", kind: "add_to_plan", params: { category: "activity" }, requires_confirmation: true },
                { id: "".concat(commandId, "_a2"), label: "Create a meetup for tonight", kind: "create_meetup", params: { title: "Tonight's meetup" }, requires_confirmation: true },
            ],
        },
        create_meetup_draft: {
            summary: "I've drafted a meetup. Review the details and confirm to create it — nothing will be saved until you confirm.",
            suggestions: [],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Create meetup", kind: "create_meetup", params: { title: "Trip meetup" }, requires_confirmation: true },
            ],
        },
        fill_free_time: {
            summary: "Suggestions to fill your free windows".concat(destination ? " in ".concat(destination) : "", ". Confirm to add any to your plan."),
            suggestions: [
                { title: "Hidden gem nearby", reason: "Off-the-beaten-path spot during your free window", category: "activity", estimatedTime: "1–2 hours", priceLevel: "$" },
                { title: "Local experience", reason: "Something unique to the destination", category: "culture", estimatedTime: "1.5 hours", priceLevel: "$$" },
            ],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Add to free window", kind: "add_to_plan", params: { category: "activity" }, requires_confirmation: true },
            ],
        },
        fix_schedule_conflict: {
            summary: "I found a time conflict in your plan. Here's how to resolve it — confirm before any changes are made.",
            suggestions: [],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Reschedule conflicting item", kind: "add_to_plan", params: { action: "reschedule" }, requires_confirmation: true },
                { id: "".concat(commandId, "_a2"), label: "Create a poll to decide", kind: "open_poll", params: { context: "conflict_resolution" }, requires_confirmation: true },
            ],
        },
        what_is_missing: {
            summary: "Based on your plan, here's what Telegraph suggests adding to make it complete.",
            suggestions: [
                { title: "Airport transfer or transport plan", reason: "No transport item found in your plan", category: "transport", estimatedTime: "variable", priceLevel: "$" },
                { title: "Accommodation check-in reminder", reason: "No accommodation entry found", category: "accommodation", estimatedTime: "30 min", priceLevel: "$$$$" },
            ],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Add missing items", kind: "add_to_plan", params: { category: "transport" }, requires_confirmation: true },
            ],
        },
        add_to_plan: {
            summary: "Tap confirm to add the suggested item to your trip plan.",
            suggestions: [],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Confirm add to plan", kind: "add_to_plan", params: { title: userText.slice(0, 80) }, requires_confirmation: true },
            ],
        },
        unknown: {
            summary: "I'm not sure what you're asking. Try: 'Plan tonight', 'Find food', 'Fill free time', 'Fix conflicts', or 'Create a meetup'.",
            suggestions: [],
            actions: [
                { id: "".concat(commandId, "_a1"), label: "Ask Telegraph something else", kind: "ask_followup", params: {}, requires_confirmation: true },
            ],
        },
    };
    var tpl = templates[intent];
    return {
        commandId: commandId,
        intent: intent,
        summary: tpl.summary,
        suggestions: tpl.suggestions,
        proposedActions: tpl.actions,
        accessLevel: accessLevel,
        tripId: tripId,
        createdAt: new Date().toISOString(),
    };
}
/** Format an ISO datetime string to a human-readable time like "7:30 PM". */
function formatMeetupTime(iso) {
    try {
        var d = new Date(iso);
        return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    }
    catch (_a) {
        return "";
    }
}
/** Return the appropriate meal label based on the meetup hour. */
function getMealLabel(iso) {
    if (!iso)
        return "dinner";
    try {
        var h = new Date(iso).getHours();
        if (h >= 7 && h < 11)
            return "breakfast";
        if (h >= 11 && h < 14)
            return "lunch";
        return "dinner";
    }
    catch (_a) {
        return "dinner";
    }
}
var CommandSchema = zod_1.z.object({
    text: zod_1.z.string().min(1).max(500),
    tripId: zod_1.z.string().optional().nullable(),
    destination: zod_1.z.string().max(100).optional(),
    /** Structured meetup context forwarded from the Daily Brief "Find dinner nearby" quick action. */
    meetupId: zod_1.z.string().max(36).optional(),
    meetupTime: zod_1.z.string().max(50).optional(),
    meetupLocation: zod_1.z.string().max(200).optional(),
});
/* ===========================================================================
 * POST /telegraph/commands
 * ===========================================================================
 */
router.post("/telegraph/commands", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, parsed, _a, text, tripId, destination, meetupId, meetupTime, meetupLocation, accessLevel, verdict, commandId, intent, meetupContext, nearbyVenues, lookupLocation, response, _b, _omit, publicResponse;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                parsed = CommandSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", (_d = (_c = parsed.error.issues[0]) === null || _c === void 0 ? void 0 : _c.message) !== null && _d !== void 0 ? _d : "Invalid body");
                    return [2 /*return*/];
                }
                _a = parsed.data, text = _a.text, tripId = _a.tripId, destination = _a.destination, meetupId = _a.meetupId, meetupTime = _a.meetupTime, meetupLocation = _a.meetupLocation;
                accessLevel = "partial";
                if (!(tripId && UUID.test(tripId))) return [3 /*break*/, 3];
                return [4 /*yield*/, (0, privacyResolver_js_1.resolveContext)(client, user.id, tripId)];
            case 2:
                verdict = _e.sent();
                accessLevel = verdict.access;
                if (verdict.access === "unauthenticated") {
                    (0, http_js_1.sendError)(res, "unauthenticated", "Not authenticated");
                    return [2 /*return*/];
                }
                _e.label = 3;
            case 3:
                commandId = genId();
                intent = parseIntent(text);
                meetupContext = meetupId ? { meetupId: meetupId, meetupTime: meetupTime, meetupLocation: meetupLocation } : undefined;
                if (!(intent === "find_food")) return [3 /*break*/, 5];
                lookupLocation = meetupLocation !== null && meetupLocation !== void 0 ? meetupLocation : destination;
                if (!lookupLocation) return [3 /*break*/, 5];
                return [4 /*yield*/, (0, venuesService_js_1.getNearbyVenues)(lookupLocation).catch(function () { return undefined; })];
            case 4:
                nearbyVenues = _e.sent();
                _e.label = 5;
            case 5:
                response = buildResponse(commandId, intent, text, tripId !== null && tripId !== void 0 ? tripId : null, accessLevel, destination, meetupContext, nearbyVenues);
                // Store with owner userId — cross-user access rejected on all reads
                commandStore.set(commandId, __assign(__assign({}, response), { _userId: user.id }));
                _b = commandStore.get(commandId), _omit = _b._userId, publicResponse = __rest(_b, ["_userId"]);
                res.status(201).json(intent === "unknown" ? __assign(__assign({}, publicResponse), { suggestions: [] }) : publicResponse);
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /telegraph/commands/:commandId
 * Returns stored command; 403 if owned by a different user.
 * ===========================================================================
 */
router.get("/telegraph/commands/:commandId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, commandId, stored, _omit, cmd;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                commandId = req.params.commandId;
                stored = commandStore.get(commandId);
                if (!stored) {
                    (0, http_js_1.sendError)(res, "not_found", "Command not found");
                    return [2 /*return*/];
                }
                if (stored._userId !== user.id) {
                    (0, http_js_1.sendError)(res, "not_member", "You do not own this command");
                    return [2 /*return*/];
                }
                _omit = stored._userId, cmd = __rest(stored, ["_userId"]);
                res.json(cmd);
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /telegraph/commands/:commandId/confirm-action
 * Ownership check + re-verify trip membership at execution time.
 * ===========================================================================
 */
router.post("/telegraph/commands/:commandId/confirm-action", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, commandId, stored, ActionSchema, parsed, actionId, action, isMember, category, _a;
    var _b, _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                commandId = req.params.commandId;
                stored = commandStore.get(commandId);
                if (!stored) {
                    (0, http_js_1.sendError)(res, "not_found", "Command not found");
                    return [2 /*return*/];
                }
                if (stored._userId !== user.id) {
                    (0, http_js_1.sendError)(res, "not_member", "You do not own this command");
                    return [2 /*return*/];
                }
                ActionSchema = zod_1.z.object({ actionId: zod_1.z.string() });
                parsed = ActionSchema.safeParse(req.body);
                if (!parsed.success) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "actionId required");
                    return [2 /*return*/];
                }
                actionId = parsed.data.actionId;
                action = stored.proposedActions.find(function (a) { return a.id === actionId; });
                if (!action) {
                    (0, http_js_1.sendError)(res, "not_found", "Action ".concat(actionId, " not found"));
                    return [2 /*return*/];
                }
                if (!(stored.tripId && UUID.test(stored.tripId))) return [3 /*break*/, 3];
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, stored.tripId, user.id)];
            case 2:
                isMember = _e.sent();
                if (!isMember) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to confirm this action");
                    return [2 /*return*/];
                }
                _e.label = 3;
            case 3:
                _e.trys.push([3, 5, , 6]);
                category = (_c = (_b = action.params.category) !== null && _b !== void 0 ? _b : INTENT_CATEGORY[stored.intent]) !== null && _c !== void 0 ? _c : "unknown";
                return [4 /*yield*/, client.from("user_preference_events").insert({
                        user_id: user.id,
                        recommendation_id: "".concat(commandId, ":").concat(actionId),
                        category: category,
                        signal: "tap",
                        trip_id: (_d = stored.tripId) !== null && _d !== void 0 ? _d : null,
                        created_at: new Date().toISOString(),
                    })];
            case 4:
                _e.sent();
                return [3 /*break*/, 6];
            case 5:
                _a = _e.sent();
                return [3 /*break*/, 6];
            case 6:
                res.json({
                    ok: true,
                    commandId: commandId,
                    actionId: actionId,
                    kind: action.kind,
                    params: action.params,
                    confirmed: true,
                    message: "Action '".concat(action.label, "' confirmed. Proceeding\u2026"),
                });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /telegraph/commands/:commandId/decline-action
 * Ownership check before allowing decline.
 * ===========================================================================
 */
router.post("/telegraph/commands/:commandId/decline-action", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, user, commandId, stored;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                user = auth.user;
                commandId = req.params.commandId;
                stored = commandStore.get(commandId);
                if (!stored) {
                    (0, http_js_1.sendError)(res, "not_found", "Command not found");
                    return [2 /*return*/];
                }
                if (stored._userId !== user.id) {
                    (0, http_js_1.sendError)(res, "not_member", "You do not own this command");
                    return [2 /*return*/];
                }
                res.json({ ok: true, commandId: commandId, declined: true });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * GET /trips/:tripId/telegraph/commands/history
 * Returns trip-scoped commands belonging to the requesting user only.
 * ===========================================================================
 */
router.get("/trips/:tripId/telegraph/commands/history", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, member, history;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _a.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _a.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member to view command history");
                    return [2 /*return*/];
                }
                history = Array.from(commandStore.values())
                    .filter(function (c) { return c.tripId === tripId && c._userId === user.id; })
                    .sort(function (a, b) { return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); })
                    .slice(0, 20)
                    .map(function (_a) {
                    var _omit = _a._userId, cmd = __rest(_a, ["_userId"]);
                    return cmd;
                });
                res.json({ tripId: tripId, history: history });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
