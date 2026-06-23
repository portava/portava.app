"use strict";
/**
 * Telegraph Chat Suggestions — privacy resolver + suggestion builder.
 *
 * TelegraphChatPrivacyVerdict determines what context is safe to use for
 * a given (userId, threadId) pair. The suggestion builder assembles up to
 * 2 suggestion cards per tray using only the gated context.
 *
 * Hard rules (mirrors product spec):
 *   - No exact GPS or live location returned in any suggestion
 *   - Trip context only available if user is an accepted trip member
 *   - Circle context only available if user is an accepted circle member
 *   - Non-members get canShowRecommendation: false
 */
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
exports.resolvePrivacyVerdict = resolvePrivacyVerdict;
exports.buildSuggestions = buildSuggestions;
exports.checkRateLimit = checkRateLimit;
exports.checkCooldown = checkCooldown;
exports.checkCategoryDeclineCooldown = checkCategoryDeclineCooldown;
var CATEGORY_FOR_INTENT = {
    food: "food",
    nightlife: "nightlife",
    beach: "beach",
    attraction: "attraction",
    transport: "transport",
    find_place: "activity",
    suggest_activity: "activity",
    create_meetup: "meetup",
    add_to_plan: "plan",
    time_poll: "poll",
    availability_match: "availability",
    general_plan: "activity",
};
var ACTION_FOR_INTENT = {
    food: "view_place",
    nightlife: "view_place",
    beach: "view_place",
    attraction: "view_place",
    transport: "view_place",
    find_place: "view_place",
    suggest_activity: "view_place",
    create_meetup: "create_meetup",
    add_to_plan: "add_to_plan",
    time_poll: "start_time_poll",
    availability_match: "start_time_poll",
    general_plan: "add_to_plan",
};
/**
 * Resolve what context is safe to use for generating suggestions.
 */
function resolvePrivacyVerdict(client, userId, threadId) {
    return __awaiter(this, void 0, void 0, function () {
        var thread, threadType, tripId, circleOwnerId, canUseTripContext, tripDestination, membership, trip, canUseCircleContext, cm, profile, settingKey, telegraphEnabled;
        var _a, _b, _c, _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0: return [4 /*yield*/, client
                        .from("message_threads")
                        .select("id, thread_type, trip_id, circle_owner_id")
                        .eq("id", threadId)
                        .maybeSingle()];
                case 1:
                    thread = (_f.sent()).data;
                    if (!thread) {
                        return [2 /*return*/, {
                                canUseTripContext: false,
                                canUseCircleContext: false,
                                canUseAvailability: false,
                                canShowRecommendation: false,
                                reason: "thread_not_found",
                                tripId: null,
                                circleOwnerId: null,
                                tripDestination: null,
                                threadType: "direct",
                            }];
                    }
                    threadType = (_a = thread.thread_type) !== null && _a !== void 0 ? _a : "direct";
                    tripId = (_b = thread.trip_id) !== null && _b !== void 0 ? _b : null;
                    circleOwnerId = (_c = thread.circle_owner_id) !== null && _c !== void 0 ? _c : null;
                    canUseTripContext = false;
                    tripDestination = null;
                    if (!(threadType === "trip" && tripId)) return [3 /*break*/, 4];
                    return [4 /*yield*/, client
                            .from("trip_members")
                            .select("role")
                            .eq("trip_id", tripId)
                            .eq("user_id", userId)
                            .in("role", ["owner", "member"])
                            .maybeSingle()];
                case 2:
                    membership = (_f.sent()).data;
                    canUseTripContext = Boolean(membership);
                    if (!canUseTripContext) return [3 /*break*/, 4];
                    return [4 /*yield*/, client
                            .from("trips")
                            .select("destination_city, destination_country")
                            .eq("id", tripId)
                            .maybeSingle()];
                case 3:
                    trip = (_f.sent()).data;
                    tripDestination =
                        (_e = (_d = trip === null || trip === void 0 ? void 0 : trip.destination_city) !== null && _d !== void 0 ? _d : trip === null || trip === void 0 ? void 0 : trip.destination_country) !== null && _e !== void 0 ? _e : null;
                    _f.label = 4;
                case 4:
                    canUseCircleContext = false;
                    if (!(threadType === "circle" && circleOwnerId)) return [3 /*break*/, 7];
                    if (!(userId === circleOwnerId)) return [3 /*break*/, 5];
                    canUseCircleContext = true;
                    return [3 /*break*/, 7];
                case 5: return [4 /*yield*/, client
                        .from("circle_memberships")
                        .select("member_id")
                        .eq("owner_id", circleOwnerId)
                        .eq("member_id", userId)
                        .maybeSingle()];
                case 6:
                    cm = (_f.sent()).data;
                    canUseCircleContext = Boolean(cm);
                    _f.label = 7;
                case 7: return [4 /*yield*/, client
                        .from("profiles")
                        .select("show_telegraph_dm, show_telegraph_trip, show_telegraph_circle")
                        .eq("id", userId)
                        .maybeSingle()];
                case 8:
                    profile = (_f.sent()).data;
                    settingKey = threadType === "trip"
                        ? "show_telegraph_trip"
                        : threadType === "circle"
                            ? "show_telegraph_circle"
                            : "show_telegraph_dm";
                    telegraphEnabled = (profile === null || profile === void 0 ? void 0 : profile[settingKey]) !== false;
                    // Non-members of trip/circle chats cannot see suggestions
                    if (threadType === "trip" && !canUseTripContext) {
                        return [2 /*return*/, {
                                canUseTripContext: false,
                                canUseCircleContext: false,
                                canUseAvailability: false,
                                canShowRecommendation: false,
                                reason: "not_trip_member",
                                tripId: tripId,
                                circleOwnerId: circleOwnerId,
                                tripDestination: null,
                                threadType: threadType,
                            }];
                    }
                    if (threadType === "circle" && !canUseCircleContext) {
                        return [2 /*return*/, {
                                canUseTripContext: false,
                                canUseCircleContext: false,
                                canUseAvailability: false,
                                canShowRecommendation: false,
                                reason: "not_circle_member",
                                tripId: tripId,
                                circleOwnerId: circleOwnerId,
                                tripDestination: null,
                                threadType: threadType,
                            }];
                    }
                    return [2 /*return*/, {
                            canUseTripContext: canUseTripContext,
                            canUseCircleContext: canUseCircleContext,
                            canShowRecommendation: telegraphEnabled,
                            canUseAvailability: false, // availability feature gated in future
                            reason: telegraphEnabled ? "ok" : "telegraph_disabled",
                            tripId: tripId,
                            circleOwnerId: circleOwnerId,
                            tripDestination: tripDestination,
                            threadType: threadType,
                        }];
            }
        });
    });
}
/**
 * Build up to 2 suggestion cards for a given intent + privacy verdict.
 * Returns empty array if verdict blocks suggestions.
 */
function buildSuggestions(userId, threadId, intent, verdict) {
    var _a, _b, _c;
    if (!verdict.canShowRecommendation)
        return [];
    var intentType = intent.intent;
    var category = (_a = CATEGORY_FOR_INTENT[intentType]) !== null && _a !== void 0 ? _a : "activity";
    var actionType = (_b = ACTION_FOR_INTENT[intentType]) !== null && _b !== void 0 ? _b : "view_place";
    var dest = (_c = verdict.tripDestination) !== null && _c !== void 0 ? _c : "your destination";
    var cards = [];
    // Primary card based on intent
    var primary = buildPrimaryCard(intentType, category, actionType, dest, verdict);
    if (primary)
        cards.push(primary);
    // Secondary card — complementary action when applicable
    var secondary = buildSecondaryCard(intentType, dest, verdict);
    if (secondary && cards.length < 2)
        cards.push(secondary);
    return cards.map(function (c) { return (__assign(__assign({}, c), { id: "".concat(threadId, "_").concat(userId, "_").concat(intentType, "_").concat(Date.now(), "_").concat(Math.random().toString(36).slice(2, 6)) })); });
}
function buildPrimaryCard(intentType, category, actionType, dest, verdict) {
    var _a, _b;
    switch (intentType) {
        case "food":
            return {
                intent_type: intentType,
                title: "Find great food in ".concat(dest),
                reason: "Telegraph detected food planning in your conversation.",
                category: category,
                action_type: "view_place",
                location_context: dest !== "your destination" ? dest : null,
                time_context: null,
            };
        case "nightlife":
            return {
                intent_type: intentType,
                title: "Nightlife spots near ".concat(dest),
                reason: "Telegraph noticed you're planning a night out.",
                category: category,
                action_type: "view_place",
                location_context: dest !== "your destination" ? dest : null,
                time_context: "Evening",
            };
        case "beach":
            return {
                intent_type: intentType,
                title: "Best beaches near ".concat(dest),
                reason: "Telegraph detected beach planning in your chat.",
                category: category,
                action_type: "view_place",
                location_context: dest !== "your destination" ? dest : null,
                time_context: null,
            };
        case "attraction":
            return {
                intent_type: intentType,
                title: "Things to do in ".concat(dest),
                reason: "Telegraph noticed you're looking for activities.",
                category: category,
                action_type: "view_place",
                location_context: dest !== "your destination" ? dest : null,
                time_context: null,
            };
        case "transport":
            return {
                intent_type: intentType,
                title: "Getting around ".concat(dest),
                reason: "Telegraph detected a transport question in your chat.",
                category: category,
                action_type: "view_place",
                location_context: null,
                time_context: null,
            };
        case "create_meetup":
            return {
                intent_type: intentType,
                title: "Schedule a meetup",
                reason: "Telegraph detected meetup planning in your conversation.",
                category: "meetup",
                action_type: "create_meetup",
                location_context: (_a = verdict.tripDestination) !== null && _a !== void 0 ? _a : null,
                time_context: null,
            };
        case "time_poll":
        case "availability_match":
            return {
                intent_type: intentType,
                title: "Start a time poll",
                reason: "Telegraph detected availability discussion — find the best time for everyone.",
                category: "poll",
                action_type: "start_time_poll",
                location_context: null,
                time_context: null,
            };
        case "add_to_plan":
            return {
                intent_type: intentType,
                title: "Add idea to your trip plan",
                reason: "Telegraph noticed you might want to save something to your itinerary.",
                category: "plan",
                action_type: "add_to_plan",
                location_context: (_b = verdict.tripDestination) !== null && _b !== void 0 ? _b : null,
                time_context: null,
            };
        case "find_place":
        case "suggest_activity":
        case "general_plan":
        default:
            return {
                intent_type: intentType,
                title: "Activity ideas for ".concat(dest),
                reason: "Telegraph detected travel planning in your conversation.",
                category: "activity",
                action_type: "view_place",
                location_context: dest !== "your destination" ? dest : null,
                time_context: null,
            };
    }
}
function buildSecondaryCard(intentType, dest, verdict) {
    var _a;
    // Only add secondary card when trip context is available (more meaningful)
    if (!verdict.canUseTripContext && !verdict.canUseCircleContext)
        return null;
    if (intentType === "food" || intentType === "nightlife" || intentType === "attraction") {
        return {
            intent_type: "create_meetup",
            title: "Turn it into a meetup",
            reason: "Lock in a time and invite your travel crew.",
            category: "meetup",
            action_type: "create_meetup",
            location_context: (_a = verdict.tripDestination) !== null && _a !== void 0 ? _a : null,
            time_context: null,
        };
    }
    if (intentType === "create_meetup") {
        return {
            intent_type: "time_poll",
            title: "Start a time poll first",
            reason: "Not sure when? Let everyone vote on the best time.",
            category: "poll",
            action_type: "start_time_poll",
            location_context: null,
            time_context: null,
        };
    }
    return null;
}
/**
 * Check rate limits: max 3 suggestions shown per thread per hour.
 * Returns true if a new suggestion can be shown.
 */
function checkRateLimit(client, userId, threadId) {
    return __awaiter(this, void 0, void 0, function () {
        var cutoff, count;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
                    return [4 /*yield*/, client
                            .from("telegraph_chat_suggestions")
                            .select("id", { count: "exact", head: true })
                            .eq("user_id", userId)
                            .eq("thread_id", threadId)
                            .gte("created_at", cutoff)];
                case 1:
                    count = (_a.sent()).count;
                    return [2 /*return*/, (count !== null && count !== void 0 ? count : 0) < 3];
            }
        });
    });
}
/**
 * Check cooldown: has this intent already been shown/dismissed in the last
 * 30 minutes for this (user, thread)?  Prevents instant re-surfacing.
 */
function checkCooldown(client, userId, threadId, intentType) {
    return __awaiter(this, void 0, void 0, function () {
        var cutoff, data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
                    return [4 /*yield*/, client
                            .from("telegraph_chat_suggestions")
                            .select("id, status")
                            .eq("user_id", userId)
                            .eq("thread_id", threadId)
                            .eq("intent_type", intentType)
                            .gte("created_at", cutoff)
                            .maybeSingle()];
                case 1:
                    data = (_a.sent()).data;
                    return [2 /*return*/, !data]; // true = no cooldown, safe to show
            }
        });
    });
}
/**
 * Check 24-hour decline cooldown: has the user dismissed a suggestion in this
 * category within the last 24 hours?  Returns true when safe to show (no
 * recent decline), false when the category should be suppressed.
 *
 * Uses limit(1) instead of maybeSingle() so multiple matching rows don't
 * collapse to data=null and accidentally clear the cooldown.
 */
function checkCategoryDeclineCooldown(client, userId, category) {
    return __awaiter(this, void 0, void 0, function () {
        var cutoff, data;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
                    return [4 /*yield*/, client
                            .from("user_preference_events")
                            .select("user_id")
                            .eq("user_id", userId)
                            .eq("category", category)
                            .eq("signal", "dismiss")
                            .gte("created_at", cutoff)
                            .limit(1)];
                case 1:
                    data = (_a.sent()).data;
                    return [2 /*return*/, !data || data.length === 0]; // true = no recent decline, safe to show
            }
        });
    });
}
