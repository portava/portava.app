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
 * Daily Trip Brief Routes
 *
 * GET  /api/trips/:tripId/daily-brief?date=YYYY-MM-DD  — fetch brief for a date
 * POST /api/trips/:tripId/daily-brief/refresh           — force refresh (clears cache)
 * POST /api/trips/:tripId/daily-brief/actions/:actionId — execute a quick action
 * POST /api/trips/:tripId/daily-brief/dismiss/:recommendationId — dismiss a suggestion
 *
 * Access: accepted trip members only. Non-members get access_denied, not 403.
 *
 * Personalisation:
 *   - fetchActiveTripForUser finds the user's active trip by checking trip_members
 *     (covers both owned trips and accepted-member trips) for in_progress status or
 *     upcoming trips starting within 3 days. Returns the actual trip record.
 *   - When an active trip is found, its destination/dates/plan/meetups drive the
 *     trip_context brief — even if that trip is not the same as :tripId.
 *   - When no active trip exists, a general inspiration brief is generated using
 *     only preference profile + past destinations; no trip-specific data is used.
 *
 * Caching (two layers):
 *   - L1: 24-hour in-memory cache keyed by userId:tripId:date.
 *   - L2: daily_briefs table in Supabase (see migration 0012_daily_briefs.sql).
 *         Provides durable once-per-calendar-day storage across server restarts.
 *         Route reads from DB before regenerating; writes after generation via upsert.
 *         DB errors are caught and degrade gracefully to in-memory behaviour.
 *   Smart invalidation: if plan items, meetups, or RSVPs were modified after the
 *   brief was built, it is rebuilt regardless of cache freshness.
 */
var express_1 = require("express");
var zod_1 = require("zod");
var http_js_1 = require("../lib/http.js");
var privacyResolver_js_1 = require("../lib/privacyResolver.js");
var dailyBriefEngine_js_1 = require("../lib/dailyBriefEngine.js");
var preferenceLearning_js_1 = require("../lib/preferenceLearning.js");
var weatherCache_js_1 = require("../lib/weatherCache.js");
var localContext_js_1 = require("../lib/localContext.js");
var eventsCache_js_1 = require("../lib/eventsCache.js");
var router = (0, express_1.Router)();
var UUID = /^[0-9a-f-]{36}$/i;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/* ── L1: In-memory cache ───────────────────────────────────────────────────
 * Key: `${userId}:${date}`   TTL: 24 h
 * Keyed per-user-per-day — the brief content is driven by the user's active
 * trip, not the requested :tripId, so a single daily brief per user is correct.
 */
var BRIEF_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
var briefCache = new Map();
function briefCacheKey(userId, date) {
    return "".concat(userId, ":").concat(date);
}
function getCachedBrief(userId, date) {
    var _a;
    return (_a = briefCache.get(briefCacheKey(userId, date))) !== null && _a !== void 0 ? _a : null;
}
function setCachedBrief(userId, date, brief, builtAt) {
    briefCache.set(briefCacheKey(userId, date), { brief: brief, builtAt: builtAt !== null && builtAt !== void 0 ? builtAt : Date.now() });
}
function invalidateBriefCache(userId, date) {
    briefCache.delete(briefCacheKey(userId, date));
}
function isCacheStale(cached) {
    return Date.now() - cached.builtAt > BRIEF_CACHE_TTL_MS;
}
/* ── L2: DB-backed daily_briefs table ──────────────────────────────────────
 * Requires migration 0012_daily_briefs.sql to be applied.
 * Keyed per-user-per-day: (user_id, brief_date) UNIQUE.
 * trip_id stored for informational purposes only (which active trip drove it).
 * All operations degrade gracefully if the table is absent.
 */
function getStoredBrief(client, userId, date) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, data, error, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, client
                            .from("daily_briefs")
                            .select("brief_json,generated_at")
                            .eq("user_id", userId)
                            .eq("brief_date", date)
                            .maybeSingle()];
                case 1:
                    _a = _c.sent(), data = _a.data, error = _a.error;
                    if (error || !data)
                        return [2 /*return*/, null];
                    return [2 /*return*/, {
                            brief: JSON.parse(data.brief_json),
                            generatedAt: new Date(data.generated_at).getTime(),
                        }];
                case 2:
                    _b = _c.sent();
                    return [2 /*return*/, null];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function storeBriefInDB(client, userId, tripId, date, briefType, brief) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, client.from("daily_briefs").upsert({
                            user_id: userId,
                            trip_id: tripId,
                            brief_date: date,
                            brief_type: briefType,
                            brief_json: JSON.stringify(brief),
                            generated_at: new Date().toISOString(),
                        }, { onConflict: "user_id,brief_date" })];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function invalidateStoredBrief(client, userId, date) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, client
                            .from("daily_briefs")
                            .delete()
                            .eq("user_id", userId)
                            .eq("brief_date", date)];
                case 1:
                    _b.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _a = _b.sent();
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/* ── Preference profile ─────────────────────────────────────────────────── */
function getPreferenceProfile(client, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, prefRes, profileRes, explicit, inferred, p;
        var _b, _c, _d, _e, _f, _g, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0: return [4 /*yield*/, Promise.all([
                        client
                            .from("user_preference_profiles")
                            .select("explicit_preferences_json,inferred_preferences_json,updated_at")
                            .eq("user_id", userId)
                            .maybeSingle(),
                        client
                            .from("profiles")
                            .select("spoken_languages,default_language,travel_styles,travel_pace,budget_style,travel_group_style,looking_for,comfort_level,availability_tags,planning_style")
                            .eq("id", userId)
                            .maybeSingle(),
                    ])];
                case 1:
                    _a = _j.sent(), prefRes = _a[0], profileRes = _a[1];
                    explicit = (function () {
                        var _a;
                        try {
                            return JSON.parse((_a = prefRes.data) === null || _a === void 0 ? void 0 : _a.explicit_preferences_json);
                        }
                        catch (_b) {
                            return (0, preferenceLearning_js_1.defaultExplicit)();
                        }
                    })();
                    inferred = (function () {
                        var _a;
                        try {
                            return JSON.parse((_a = prefRes.data) === null || _a === void 0 ? void 0 : _a.inferred_preferences_json);
                        }
                        catch (_b) {
                            return (0, preferenceLearning_js_1.defaultInferred)();
                        }
                    })();
                    p = profileRes.data;
                    if (p) {
                        if (p.travel_pace)
                            explicit.pace = p.travel_pace;
                        if ((_b = p.travel_styles) === null || _b === void 0 ? void 0 : _b.length)
                            explicit.travelStyles = p.travel_styles;
                        if (p.budget_style)
                            explicit.budgetStyle = p.budget_style;
                        if ((_c = p.travel_group_style) === null || _c === void 0 ? void 0 : _c.length)
                            explicit.groupStyle = p.travel_group_style.join(", ");
                        if ((_d = p.looking_for) === null || _d === void 0 ? void 0 : _d.length)
                            explicit.lookingFor = p.looking_for;
                        if ((_e = p.availability_tags) === null || _e === void 0 ? void 0 : _e.length)
                            explicit.preferredActivityTimes = p.availability_tags;
                        if ((_f = p.spoken_languages) === null || _f === void 0 ? void 0 : _f.length)
                            explicit.spokenLanguages = p.spoken_languages;
                        if (p.default_language)
                            explicit.defaultLanguage = p.default_language;
                        if (p.comfort_level)
                            explicit.comfortLevel = p.comfort_level;
                        if (p.planning_style)
                            explicit.planningStyle = p.planning_style;
                    }
                    return [2 /*return*/, { userId: userId, explicit: explicit, inferred: inferred, lastUpdatedAt: (_h = (_g = prefRes.data) === null || _g === void 0 ? void 0 : _g.updated_at) !== null && _h !== void 0 ? _h : null }];
            }
        });
    });
}
function fetchActiveTripForUser(client, userId, today) {
    return __awaiter(this, void 0, void 0, function () {
        var memberRows, tripIds, inProgress, in3Days, in3DaysStr, upcomingRows, upcoming, _a;
        var _b, _c, _d, _e, _f, _g, _h;
        return __generator(this, function (_j) {
            switch (_j.label) {
                case 0:
                    _j.trys.push([0, 4, , 5]);
                    return [4 /*yield*/, client
                            .from("trip_members")
                            .select("trip_id")
                            .eq("user_id", userId)
                            .in("role", ["owner", "member"])];
                case 1:
                    memberRows = (_j.sent()).data;
                    tripIds = (memberRows !== null && memberRows !== void 0 ? memberRows : []).map(function (r) { return r.trip_id; });
                    if (tripIds.length === 0)
                        return [2 /*return*/, null];
                    return [4 /*yield*/, client
                            .from("trips")
                            .select("id,destination_city,destination_country,start_date,end_date")
                            .in("id", tripIds)
                            .eq("status", "in_progress")
                            .order("start_date", { ascending: true })
                            .limit(1)
                            .maybeSingle()];
                case 2:
                    inProgress = (_j.sent()).data;
                    if (inProgress) {
                        return [2 /*return*/, {
                                tripId: inProgress.id,
                                destinationCity: inProgress.destination_city,
                                destinationCountry: (_b = inProgress.destination_country) !== null && _b !== void 0 ? _b : null,
                                startDate: (_c = inProgress.start_date) !== null && _c !== void 0 ? _c : null,
                                endDate: (_d = inProgress.end_date) !== null && _d !== void 0 ? _d : null,
                            }];
                    }
                    in3Days = new Date(today + "T00:00:00Z");
                    in3Days.setUTCDate(in3Days.getUTCDate() + 3);
                    in3DaysStr = in3Days.toISOString().slice(0, 10);
                    return [4 /*yield*/, client
                            .from("trips")
                            .select("id,destination_city,destination_country,start_date,end_date")
                            .in("id", tripIds)
                            .eq("status", "upcoming")
                            .gte("start_date", today)
                            .lte("start_date", in3DaysStr)
                            .order("start_date", { ascending: true })
                            .limit(1)];
                case 3:
                    upcomingRows = (_j.sent()).data;
                    upcoming = (_e = (upcomingRows !== null && upcomingRows !== void 0 ? upcomingRows : [])[0]) !== null && _e !== void 0 ? _e : null;
                    if (upcoming) {
                        return [2 /*return*/, {
                                tripId: upcoming.id,
                                destinationCity: upcoming.destination_city,
                                destinationCountry: (_f = upcoming.destination_country) !== null && _f !== void 0 ? _f : null,
                                startDate: (_g = upcoming.start_date) !== null && _g !== void 0 ? _g : null,
                                endDate: (_h = upcoming.end_date) !== null && _h !== void 0 ? _h : null,
                            }];
                    }
                    return [2 /*return*/, null];
                case 4:
                    _a = _j.sent();
                    // Degrade gracefully — return null so the route falls back to general brief
                    return [2 /*return*/, null];
                case 5: return [2 /*return*/];
            }
        });
    });
}
/* ── Past destinations (for general briefs) ────────────────────────────── */
function fetchPastDestinations(client, userId) {
    return __awaiter(this, void 0, void 0, function () {
        var data, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, client
                            .from("trips")
                            .select("destination_city,destination_country")
                            .eq("owner_id", userId)
                            .in("status", ["completed", "cancelled"])
                            .order("end_date", { ascending: false })
                            .limit(6)];
                case 1:
                    data = (_b.sent()).data;
                    if (!data || data.length === 0)
                        return [2 /*return*/, []];
                    return [2 /*return*/, data
                            .filter(function (t) { return Boolean(t.destination_city); })
                            .map(function (t) {
                            return t.destination_country
                                ? "".concat(t.destination_city, ", ").concat(t.destination_country)
                                : t.destination_city;
                        })
                            .slice(0, 3)];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/* ── Upcoming meetups within 24 h ───────────────────────────────────────── */
function fetchUpcomingMeetups24h(client, userId, tripId, now) {
    return __awaiter(this, void 0, void 0, function () {
        var in24h, rsvpRows, rsvpMeetupIds, meetupRows;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
                    return [4 /*yield*/, client
                            .from("meetup_invites")
                            .select("meetup_id")
                            .eq("user_id", userId)
                            .in("status", ["going", "maybe"])];
                case 1:
                    rsvpRows = (_a.sent()).data;
                    rsvpMeetupIds = (rsvpRows !== null && rsvpRows !== void 0 ? rsvpRows : []).map(function (r) { return r.meetup_id; });
                    if (rsvpMeetupIds.length === 0)
                        return [2 /*return*/, []];
                    return [4 /*yield*/, client
                            .from("meetups")
                            .select("id,title,proposed_time,location_name")
                            .eq("trip_id", tripId)
                            .in("id", rsvpMeetupIds)
                            .eq("status", "confirmed")
                            .gte("proposed_time", now.toISOString())
                            .lte("proposed_time", in24h.toISOString())
                            .order("proposed_time", { ascending: true })];
                case 2:
                    meetupRows = (_a.sent()).data;
                    return [2 /*return*/, (meetupRows !== null && meetupRows !== void 0 ? meetupRows : []).map(function (m) {
                            var _a;
                            return ({
                                id: m.id,
                                title: m.title,
                                proposedTime: m.proposed_time,
                                locationName: (_a = m.location_name) !== null && _a !== void 0 ? _a : null,
                            });
                        })];
            }
        });
    });
}
/* ── Recommendation generators ─────────────────────────────────────────── */
/**
 * Generate trip-context recommendations: destination-aware suggestions for
 * today, enriched with live weather forecasts and local OSM POIs, plus
 * gap-day nudges for unplanned trip days.
 *
 * Weather context: injects weather-aware suggestions (indoor alternatives on
 * rain days, outdoor boosts on sunny days). Gracefully skipped if null.
 *
 * Local context: enriches the pool with specific named POIs from OSM
 * (museums, parks, restaurants) when available. Gracefully skipped if null.
 */
function generateTripContextRecommendations(preferenceProfile, destination, gapDays, weatherContext, localContext, eventsContext) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o;
    var dest = destination ? " in ".concat(destination) : "";
    var interests = (_b = (_a = preferenceProfile === null || preferenceProfile === void 0 ? void 0 : preferenceProfile.explicit) === null || _a === void 0 ? void 0 : _a.interests) !== null && _b !== void 0 ? _b : [];
    var foodPrefs = (_d = (_c = preferenceProfile === null || preferenceProfile === void 0 ? void 0 : preferenceProfile.explicit) === null || _c === void 0 ? void 0 : _c.foodPreferences) !== null && _d !== void 0 ? _d : [];
    var nightlifePrefs = (_f = (_e = preferenceProfile === null || preferenceProfile === void 0 ? void 0 : preferenceProfile.explicit) === null || _e === void 0 ? void 0 : _e.nightlifePreferences) !== null && _f !== void 0 ? _f : [];
    var avoidList = (_h = (_g = preferenceProfile === null || preferenceProfile === void 0 ? void 0 : preferenceProfile.explicit) === null || _g === void 0 ? void 0 : _g.avoidList) !== null && _h !== void 0 ? _h : [];
    // Determine weather character for this trip
    var forecasts = (_j = weatherContext === null || weatherContext === void 0 ? void 0 : weatherContext.forecasts) !== null && _j !== void 0 ? _j : [];
    var rainyDays = forecasts.filter(function (f) { return f.precipMm > 2 || f.weatherCode >= 51; });
    var sunnyDays = forecasts.filter(function (f) { return f.weatherCode <= 3; });
    var isRainy = rainyDays.length > 0;
    var isSunny = sunnyDays.length === forecasts.length && forecasts.length > 0;
    // Weather reason prefix for relevant suggestions
    var weatherReason = (weatherContext === null || weatherContext === void 0 ? void 0 : weatherContext.briefSummary)
        ? " (".concat(weatherContext.briefSummary.split("—")[0].trim(), ")")
        : "";
    var pool = [
        {
            id: "rec_culture",
            title: "Local cultural experience".concat(dest),
            category: "culture",
            reason: "Immerse yourself in the local scene",
            estimatedTime: "2–3 hours",
            priceLevel: "$$",
        },
        {
            id: "rec_food_market",
            title: "Street food market".concat(dest),
            category: "food",
            reason: "Authentic local flavours at great value",
            estimatedTime: "1–2 hours",
            priceLevel: "$",
        },
        {
            id: "rec_outdoor",
            title: "Outdoor activity".concat(dest),
            category: "outdoor",
            reason: isSunny
                ? "Perfect weather for it".concat(weatherReason)
                : "Fresh air and local scenery",
            estimatedTime: "2–4 hours",
            priceLevel: "$",
        },
        {
            id: "rec_nightlife",
            title: "Evening bar or lounge".concat(dest),
            category: "nightlife",
            reason: "Wind down with the local night scene",
            estimatedTime: "2–3 hours",
            priceLevel: "$$",
        },
        {
            id: "rec_hidden_gem",
            title: "Off-the-beaten-path spot".concat(dest),
            category: "activity",
            reason: "A local favourite most tourists miss",
            estimatedTime: "1.5 hours",
            priceLevel: "$",
        },
        {
            id: "rec_restaurant",
            title: "Top-rated restaurant".concat(dest),
            category: "food",
            reason: "Highly recommended by fellow travellers",
            estimatedTime: "1–1.5 hours",
            priceLevel: "$$",
        },
        {
            id: "rec_wellness",
            title: "Spa or wellness session".concat(dest),
            category: "wellness",
            reason: "Recharge after a busy day of travel",
            estimatedTime: "1.5–2 hours",
            priceLevel: "$$$",
        },
        {
            id: "rec_market",
            title: "Local artisan market".concat(dest),
            category: "shopping",
            reason: "Browse unique local crafts and souvenirs",
            estimatedTime: "1–2 hours",
            priceLevel: "$",
        },
    ];
    // Weather-aware additions: if rain is forecast, add indoor alternatives
    if (isRainy) {
        pool.push({
            id: "rec_indoor_rain",
            title: "Indoor alternatives".concat(dest),
            category: "culture",
            reason: (_k = weatherContext === null || weatherContext === void 0 ? void 0 : weatherContext.briefSummary) !== null && _k !== void 0 ? _k : "Rain in the forecast — stay dry with an indoor activity",
            estimatedTime: "2–3 hours",
            priceLevel: "$$",
        });
    }
    // Weather-aware additions: sunny days are great for outdoor spots
    if (isSunny && !isRainy) {
        pool.push({
            id: "rec_sunny_outdoor",
            title: "Scenic outdoor spot".concat(dest),
            category: "outdoor",
            reason: (_l = weatherContext === null || weatherContext === void 0 ? void 0 : weatherContext.briefSummary) !== null && _l !== void 0 ? _l : "Clear skies — perfect for exploring outside",
            estimatedTime: "1–3 hours",
            priceLevel: "free",
        });
    }
    // Local POI enrichment: add up to 3 specific named places from OSM
    if ((_m = localContext === null || localContext === void 0 ? void 0 : localContext.tips) === null || _m === void 0 ? void 0 : _m.length) {
        var museums = localContext.tips.filter(function (t) { return t.category === "museum" || t.category === "art"; });
        var parks = localContext.tips.filter(function (t) { return t.category === "park"; });
        var restaurants = localContext.tips.filter(function (t) { return t.category === "restaurant"; });
        if (museums[0]) {
            pool.push({
                id: "rec_poi_museum_".concat(museums[0].name.slice(0, 20).replace(/\s/g, "_")),
                title: museums[0].name,
                category: "culture",
                reason: "Popular local museum in ".concat(destination !== null && destination !== void 0 ? destination : "the area"),
                estimatedTime: "1.5–3 hours",
                priceLevel: "$$",
            });
        }
        if (parks[0]) {
            pool.push({
                id: "rec_poi_park_".concat(parks[0].name.slice(0, 20).replace(/\s/g, "_")),
                title: parks[0].name,
                category: "outdoor",
                reason: isRainy
                    ? "A local park \u2014 check back on sunny days"
                    : "One of the top green spaces in ".concat(destination !== null && destination !== void 0 ? destination : "the area"),
                estimatedTime: "1–2 hours",
                priceLevel: "free",
            });
        }
        if (restaurants[0]) {
            pool.push({
                id: "rec_poi_restaurant_".concat(restaurants[0].name.slice(0, 20).replace(/\s/g, "_")),
                title: restaurants[0].name,
                category: "food",
                reason: "Highly visited dining spot in ".concat(destination !== null && destination !== void 0 ? destination : "the area"),
                estimatedTime: "1–1.5 hours",
                priceLevel: "$$",
            });
        }
    }
    // Events enrichment: add up to 3 nearby events as activity suggestions
    if ((_o = eventsContext === null || eventsContext === void 0 ? void 0 : eventsContext.events) === null || _o === void 0 ? void 0 : _o.length) {
        for (var _i = 0, _p = eventsContext.events.slice(0, 3); _i < _p.length; _i++) {
            var event_1 = _p[_i];
            var safeId = "rec_event_".concat(event_1.id.slice(0, 24).replace(/[^a-z0-9_]/gi, "_"));
            var category = event_1.category.toLowerCase().includes("music")
                ? "nightlife"
                : event_1.category.toLowerCase().includes("sport")
                    ? "outdoor"
                    : "activity";
            var venueText = event_1.venueName ? " at ".concat(event_1.venueName) : "";
            pool.push({
                id: safeId,
                title: event_1.name.slice(0, 120),
                category: category,
                reason: "Live ".concat(event_1.category, " event").concat(venueText, " on ").concat(event_1.localDate),
                estimatedTime: "2–4 hours",
                priceLevel: "$$",
            });
        }
    }
    // Filter out anything on the user's avoid list
    var filtered = avoidList.length
        ? pool.filter(function (r) { return !avoidList.some(function (a) { return r.category.toLowerCase().includes(a.toLowerCase()); }); })
        : pool;
    var preferredCategories = new Set(__spreadArray(__spreadArray(__spreadArray(__spreadArray(__spreadArray([], interests.map(function (i) { return i.toLowerCase(); }), true), (foodPrefs.length ? ["food"] : []), true), (nightlifePrefs.length ? ["nightlife"] : []), true), (isSunny ? ["outdoor"] : []), true), (isRainy ? ["culture", "wellness"] : []), true));
    var boosted = filtered.filter(function (r) { return preferredCategories.has(r.category); });
    var rest = filtered.filter(function (r) { return !preferredCategories.has(r.category); });
    var base = __spreadArray(__spreadArray([], boosted, true), rest, true).slice(0, 4);
    var gapRecs = gapDays.slice(0, 2).map(function (gapDay, i) {
        var _a, _b, _c, _d;
        var dayLabel = formatGapDayLabel(gapDay);
        return {
            id: "rec_gap_".concat(i),
            title: "Nothing planned ".concat(dayLabel).concat(dest, " \u2014 explore ideas"),
            category: (_d = (_c = ((_b = (_a = boosted[i % Math.max(boosted.length, 1)]) !== null && _a !== void 0 ? _a : rest[0]) !== null && _b !== void 0 ? _b : filtered[0])) === null || _c === void 0 ? void 0 : _c.category) !== null && _d !== void 0 ? _d : "activity",
            reason: destination
                ? "".concat(dayLabel, " in ").concat(destination, " is wide open. Here are some ideas.")
                : "".concat(dayLabel, " has no plans yet. Here are some ideas."),
            estimatedTime: "Half day",
            priceLevel: "$",
            forGapDay: gapDay,
        };
    });
    return __spreadArray(__spreadArray([], base, true), gapRecs, true);
}
function generateGeneralRecommendations(preferenceProfile, pastDestinations) {
    var _a, _b, _c, _d;
    var interests = (_b = (_a = preferenceProfile === null || preferenceProfile === void 0 ? void 0 : preferenceProfile.explicit) === null || _a === void 0 ? void 0 : _a.interests) !== null && _b !== void 0 ? _b : [];
    var avoidList = (_d = (_c = preferenceProfile === null || preferenceProfile === void 0 ? void 0 : preferenceProfile.explicit) === null || _c === void 0 ? void 0 : _c.avoidList) !== null && _d !== void 0 ? _d : [];
    var destHint = pastDestinations.length > 0
        ? " (like ".concat(pastDestinations.slice(0, 2).join(" or "), ")")
        : "";
    var pool = [
        { id: "rec_gen_plan", title: "Start planning your next adventure", category: "planning", reason: "Get inspired by destinations".concat(destHint, " you've loved"), estimatedTime: "15 min", priceLevel: "$" },
        { id: "rec_gen_culture", title: "Discover cultural hotspots worldwide", category: "culture", reason: "Broaden your horizons with art, history and local traditions", estimatedTime: "2–3 hours", priceLevel: "$$" },
        { id: "rec_gen_food", title: "Explore world food trails", category: "food", reason: "Great travel often starts with great food", estimatedTime: "1–2 hours", priceLevel: "$" },
        { id: "rec_gen_outdoor", title: "Plan an outdoor adventure", category: "outdoor", reason: "From city parks to mountain hikes — get moving", estimatedTime: "Half day", priceLevel: "$" },
        { id: "rec_gen_bucket", title: "Add a dream destination to your bucket list", category: "planning", reason: "Trip ideas based on where travellers like you go next", estimatedTime: "10 min", priceLevel: "$" },
        { id: "rec_gen_wellness", title: "Recharge with a wellness retreat", category: "wellness", reason: "Between trips is the best time to plan the next reset", estimatedTime: "Weekend", priceLevel: "$$$" },
    ];
    var filtered = avoidList.length
        ? pool.filter(function (r) { return !avoidList.some(function (a) { return r.category.toLowerCase().includes(a.toLowerCase()); }); })
        : pool;
    var preferredCategories = new Set(interests.map(function (i) { return i.toLowerCase(); }));
    var boosted = filtered.filter(function (r) { return preferredCategories.has(r.category); });
    var rest = filtered.filter(function (r) { return !preferredCategories.has(r.category); });
    return __spreadArray(__spreadArray([], boosted, true), rest, true).slice(0, 4);
}
function formatGapDayLabel(dateStr) {
    return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}
/* ── Plan + meetup fetch ─────────────────────────────────────────────────── */
function fetchBriefData(client, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, planResult, meetupsResult;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, Promise.all([
                        client
                            .from("trip_plan_items")
                            .select("id,title,starts_at,ends_at,category,status,location_name,day_date")
                            .eq("trip_id", tripId)
                            .is("removed_at", null),
                        client
                            .from("meetups")
                            .select("id,title,proposed_time,attendee_count,status")
                            .eq("trip_id", tripId)
                            .then(function (r) { return r; }, function () { return ({ data: [] }); }),
                    ])];
                case 1:
                    _a = _d.sent(), planResult = _a[0], meetupsResult = _a[1];
                    return [2 /*return*/, { planItems: (_b = planResult.data) !== null && _b !== void 0 ? _b : [], meetups: (_c = meetupsResult.data) !== null && _c !== void 0 ? _c : [] }];
            }
        });
    });
}
/* ── Gap-day computation ─────────────────────────────────────────────────── */
function computeTripGapDays(tripStartDate, tripEndDate, daysWithItems, today) {
    if (!tripStartDate || !tripEndDate)
        return [];
    var start = new Date(tripStartDate + "T00:00:00Z");
    var end = new Date(tripEndDate + "T00:00:00Z");
    var gaps = [];
    var cursor = new Date(start);
    while (cursor <= end && gaps.length < 5) {
        var isoDate = cursor.toISOString().slice(0, 10);
        if (isoDate !== today && !daysWithItems.has(isoDate))
            gaps.push(isoDate);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return gaps;
}
/** Cap the weather end date to at most `maxDays` ahead of `todayDate`, clamped to tripEndDate. */
function capForecastEnd(todayDate, tripEndDate, maxDays) {
    var maxEnd = new Date(todayDate + "T00:00:00Z");
    maxEnd.setUTCDate(maxEnd.getUTCDate() + maxDays - 1);
    var maxEndStr = maxEnd.toISOString().slice(0, 10);
    if (!tripEndDate)
        return maxEndStr;
    return tripEndDate < maxEndStr ? tripEndDate : maxEndStr;
}
function buildBriefContext(client, userId, requestedTripId, date, activeTrip) {
    return __awaiter(this, void 0, void 0, function () {
        var _a, preferenceProfile_1, pastDestinations, activeTripId, destination, now, _b, _c, planItems, meetups, preferenceProfile, upcomingMeetups24h, weatherContext, localContext, eventsContext, daysWithItems, _i, planItems_1, item, gapDays, recommendations;
        var _d, _e;
        return __generator(this, function (_f) {
            switch (_f.label) {
                case 0:
                    if (!!activeTrip) return [3 /*break*/, 2];
                    return [4 /*yield*/, Promise.all([
                            getPreferenceProfile(client, userId),
                            fetchPastDestinations(client, userId),
                        ])];
                case 1:
                    _a = _f.sent(), preferenceProfile_1 = _a[0], pastDestinations = _a[1];
                    return [2 /*return*/, {
                            briefType: "general",
                            activeTripId: null,
                            destination: null,
                            tripStartDate: null,
                            tripEndDate: null,
                            planItems: [],
                            meetups: [],
                            gapDays: [],
                            upcomingMeetups24h: [],
                            recommendations: generateGeneralRecommendations(preferenceProfile_1, pastDestinations),
                            preferenceProfile: preferenceProfile_1,
                            weatherSummary: null,
                            weatherForecasts: [],
                        }];
                case 2:
                    activeTripId = activeTrip.tripId;
                    destination = activeTrip.destinationCity
                        ? activeTrip.destinationCountry
                            ? "".concat(activeTrip.destinationCity, ", ").concat(activeTrip.destinationCountry)
                            : activeTrip.destinationCity
                        : null;
                    now = new Date();
                    return [4 /*yield*/, Promise.all([
                            fetchBriefData(client, activeTripId),
                            getPreferenceProfile(client, userId),
                            fetchUpcomingMeetups24h(client, userId, activeTripId, now),
                            destination ? (0, weatherCache_js_1.getWeatherContext)(destination, date, capForecastEnd(date, activeTrip.endDate, 7)) : Promise.resolve(null),
                            destination ? (0, localContext_js_1.getLocalContext)(destination) : Promise.resolve(null),
                            destination ? (0, eventsCache_js_1.getEventsNearDestination)(destination, date, date) : Promise.resolve(null),
                        ])];
                case 3:
                    _b = _f.sent(), _c = _b[0], planItems = _c.planItems, meetups = _c.meetups, preferenceProfile = _b[1], upcomingMeetups24h = _b[2], weatherContext = _b[3], localContext = _b[4], eventsContext = _b[5];
                    daysWithItems = new Set();
                    for (_i = 0, planItems_1 = planItems; _i < planItems_1.length; _i++) {
                        item = planItems_1[_i];
                        if (item.day_date)
                            daysWithItems.add(item.day_date);
                    }
                    gapDays = computeTripGapDays(activeTrip.startDate, activeTrip.endDate, daysWithItems, date);
                    recommendations = generateTripContextRecommendations(preferenceProfile, destination, gapDays, weatherContext, localContext, eventsContext);
                    return [2 /*return*/, {
                            briefType: "trip_context",
                            activeTripId: activeTripId,
                            destination: destination,
                            tripStartDate: activeTrip.startDate,
                            tripEndDate: activeTrip.endDate,
                            planItems: planItems,
                            meetups: meetups,
                            gapDays: gapDays,
                            upcomingMeetups24h: upcomingMeetups24h,
                            recommendations: recommendations,
                            preferenceProfile: preferenceProfile,
                            weatherSummary: (_d = weatherContext === null || weatherContext === void 0 ? void 0 : weatherContext.briefSummary) !== null && _d !== void 0 ? _d : null,
                            weatherForecasts: (_e = weatherContext === null || weatherContext === void 0 ? void 0 : weatherContext.forecasts) !== null && _e !== void 0 ? _e : [],
                        }];
            }
        });
    });
}
/* ── Staleness check for smart invalidation ──────────────────────────────── */
function getLastModifiedTs(client, tripId) {
    return __awaiter(this, void 0, void 0, function () {
        var tripMeetupRows, meetupIds, latestMeetupUpdatedAt, _a, planItemRow, rsvpRow;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, client
                        .from("meetups")
                        .select("id,updated_at")
                        .eq("trip_id", tripId)
                        .order("updated_at", { ascending: false })];
                case 1:
                    tripMeetupRows = (_d.sent()).data;
                    meetupIds = (tripMeetupRows !== null && tripMeetupRows !== void 0 ? tripMeetupRows : []).map(function (m) { return m.id; });
                    latestMeetupUpdatedAt = (_c = (_b = tripMeetupRows === null || tripMeetupRows === void 0 ? void 0 : tripMeetupRows[0]) === null || _b === void 0 ? void 0 : _b.updated_at) !== null && _c !== void 0 ? _c : null;
                    return [4 /*yield*/, Promise.all([
                            client
                                .from("trip_plan_items")
                                .select("updated_at")
                                .eq("trip_id", tripId)
                                .is("removed_at", null)
                                .order("updated_at", { ascending: false })
                                .limit(1)
                                .maybeSingle()
                                .then(function (r) { return r.data; }),
                            meetupIds.length > 0
                                ? client
                                    .from("meetup_invites")
                                    .select("updated_at")
                                    .in("meetup_id", meetupIds)
                                    .order("updated_at", { ascending: false })
                                    .limit(1)
                                    .maybeSingle()
                                    .then(function (r) { return r.data; })
                                : Promise.resolve(null),
                        ])];
                case 2:
                    _a = _d.sent(), planItemRow = _a[0], rsvpRow = _a[1];
                    return [2 /*return*/, Math.max((planItemRow === null || planItemRow === void 0 ? void 0 : planItemRow.updated_at) ? new Date(planItemRow.updated_at).getTime() : 0, latestMeetupUpdatedAt ? new Date(latestMeetupUpdatedAt).getTime() : 0, (rsvpRow === null || rsvpRow === void 0 ? void 0 : rsvpRow.updated_at) ? new Date(rsvpRow.updated_at).getTime() : 0)];
            }
        });
    });
}
/* ===========================================================================
 * GET /trips/:tripId/daily-brief
 * ===========================================================================
 */
router.get("/trips/:tripId/daily-brief", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, verdict, date, cached, cachedActiveTripId, membershipValid, _a, activeTripForStaleCheck, lastModified, isStale, stored, storedActiveTripId, membershipValid, _b, activeTripForStaleCheck, lastModified, isStale, activeTrip, ctx, brief, briefWithMeta, nowMs;
    var _c, _d, _e, _f;
    return __generator(this, function (_g) {
        switch (_g.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _g.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                tripId = req.params.tripId;
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, privacyResolver_js_1.resolveContext)(client, user.id, tripId)];
            case 2:
                verdict = _g.sent();
                if (verdict.access !== "full") {
                    res.status(200).json({ access: verdict.access, denialReason: (_c = verdict.denialReason) !== null && _c !== void 0 ? _c : "not_member", brief: null });
                    return [2 /*return*/];
                }
                date = (_d = req.query.date) !== null && _d !== void 0 ? _d : new Date().toISOString().slice(0, 10);
                if (!DATE_RE.test(date)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "date must be YYYY-MM-DD");
                    return [2 /*return*/];
                }
                cached = getCachedBrief(user.id, date);
                if (!(cached && !isCacheStale(cached))) return [3 /*break*/, 7];
                cachedActiveTripId = (_e = cached.brief.activeTripId) !== null && _e !== void 0 ? _e : null;
                _a = !cachedActiveTripId;
                if (_a) return [3 /*break*/, 4];
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, cachedActiveTripId, user.id)];
            case 3:
                _a = (_g.sent());
                _g.label = 4;
            case 4:
                membershipValid = _a;
                if (!!membershipValid) return [3 /*break*/, 5];
                invalidateBriefCache(user.id, date);
                return [3 /*break*/, 7];
            case 5:
                activeTripForStaleCheck = cachedActiveTripId !== null && cachedActiveTripId !== void 0 ? cachedActiveTripId : tripId;
                return [4 /*yield*/, getLastModifiedTs(client, activeTripForStaleCheck)];
            case 6:
                lastModified = _g.sent();
                isStale = lastModified > cached.builtAt;
                res.json({ access: "full", brief: __assign(__assign({}, cached.brief), { isStale: isStale, generatedAt: cached.builtAt }), fromCache: true });
                return [2 /*return*/];
            case 7: return [4 /*yield*/, getStoredBrief(client, user.id, date)];
            case 8:
                stored = _g.sent();
                if (!stored) return [3 /*break*/, 14];
                storedActiveTripId = (_f = stored.brief.activeTripId) !== null && _f !== void 0 ? _f : null;
                _b = !storedActiveTripId;
                if (_b) return [3 /*break*/, 10];
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, storedActiveTripId, user.id)];
            case 9:
                _b = (_g.sent());
                _g.label = 10;
            case 10:
                membershipValid = _b;
                if (!!membershipValid) return [3 /*break*/, 12];
                return [4 /*yield*/, invalidateStoredBrief(client, user.id, date)];
            case 11:
                _g.sent();
                return [3 /*break*/, 14];
            case 12:
                activeTripForStaleCheck = storedActiveTripId !== null && storedActiveTripId !== void 0 ? storedActiveTripId : tripId;
                return [4 /*yield*/, getLastModifiedTs(client, activeTripForStaleCheck)];
            case 13:
                lastModified = _g.sent();
                isStale = lastModified > stored.generatedAt;
                // DB brief may be stale — warm L1 preserving original generatedAt so
                // subsequent L1 hits compare against the real generation time, not now.
                setCachedBrief(user.id, date, stored.brief, stored.generatedAt);
                res.json({ access: "full", brief: __assign(__assign({}, stored.brief), { isStale: isStale, generatedAt: stored.generatedAt }), fromCache: true });
                return [2 /*return*/];
            case 14: return [4 /*yield*/, fetchActiveTripForUser(client, user.id, date)];
            case 15:
                activeTrip = _g.sent();
                return [4 /*yield*/, buildBriefContext(client, user.id, tripId, date, activeTrip)];
            case 16:
                ctx = _g.sent();
                brief = (0, dailyBriefEngine_js_1.buildDailyBrief)({
                    tripId: tripId,
                    userId: user.id,
                    date: date,
                    briefType: ctx.briefType,
                    destination: ctx.destination,
                    tripStartDate: ctx.tripStartDate,
                    tripEndDate: ctx.tripEndDate,
                    planItems: ctx.planItems,
                    meetups: ctx.meetups,
                    upcomingMeetups24h: ctx.upcomingMeetups24h,
                    recommendations: ctx.recommendations,
                    preferenceProfile: ctx.preferenceProfile,
                    weatherSummary: ctx.weatherSummary,
                    weatherForecasts: ctx.weatherForecasts,
                });
                briefWithMeta = __assign(__assign({}, brief), { activeTripId: ctx.activeTripId });
                nowMs = Date.now();
                setCachedBrief(user.id, date, briefWithMeta);
                return [4 /*yield*/, storeBriefInDB(client, user.id, tripId, date, ctx.briefType, briefWithMeta)];
            case 17:
                _g.sent();
                res.json({ access: "full", brief: __assign(__assign({}, briefWithMeta), { isStale: false, generatedAt: nowMs }) });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /trips/:tripId/daily-brief/refresh
 * ===========================================================================
 */
router.post("/trips/:tripId/daily-brief/refresh", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, tripId, verdict, dateParam, date, activeTrip, ctx, brief, briefWithMeta, refreshedAt;
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
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, privacyResolver_js_1.resolveContext)(client, user.id, tripId)];
            case 2:
                verdict = _b.sent();
                if (verdict.access !== "full") {
                    res.status(200).json({ access: verdict.access, brief: null });
                    return [2 /*return*/];
                }
                dateParam = zod_1.z.string().regex(DATE_RE).optional().safeParse((_a = req.body) === null || _a === void 0 ? void 0 : _a.date);
                date = dateParam.success && dateParam.data ? dateParam.data : new Date().toISOString().slice(0, 10);
                // Always invalidate both cache layers on explicit refresh (per-user-per-day keys)
                invalidateBriefCache(user.id, date);
                return [4 /*yield*/, invalidateStoredBrief(client, user.id, date)];
            case 3:
                _b.sent();
                return [4 /*yield*/, fetchActiveTripForUser(client, user.id, date)];
            case 4:
                activeTrip = _b.sent();
                return [4 /*yield*/, buildBriefContext(client, user.id, tripId, date, activeTrip)];
            case 5:
                ctx = _b.sent();
                brief = (0, dailyBriefEngine_js_1.buildDailyBrief)({
                    tripId: tripId,
                    userId: user.id,
                    date: date,
                    briefType: ctx.briefType,
                    destination: ctx.destination,
                    tripStartDate: ctx.tripStartDate,
                    tripEndDate: ctx.tripEndDate,
                    planItems: ctx.planItems,
                    meetups: ctx.meetups,
                    upcomingMeetups24h: ctx.upcomingMeetups24h,
                    recommendations: ctx.recommendations,
                    preferenceProfile: ctx.preferenceProfile,
                    weatherSummary: ctx.weatherSummary,
                    weatherForecasts: ctx.weatherForecasts,
                });
                briefWithMeta = __assign(__assign({}, brief), { activeTripId: ctx.activeTripId });
                refreshedAt = Date.now();
                setCachedBrief(user.id, date, briefWithMeta);
                return [4 /*yield*/, storeBriefInDB(client, user.id, tripId, date, ctx.briefType, briefWithMeta)];
            case 6:
                _b.sent();
                res.json({ access: "full", brief: __assign(__assign({}, briefWithMeta), { isStale: false, generatedAt: refreshedAt }), refreshed: true });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /trips/:tripId/daily-brief/actions/:actionId
 * ===========================================================================
 */
router.post("/trips/:tripId/daily-brief/actions/:actionId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, tripId, actionId, member, VALID_ACTIONS;
    return __generator(this, function (_b) {
        switch (_b.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _b.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                _a = req.params, tripId = _a.tripId, actionId = _a.actionId;
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _b.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member");
                    return [2 /*return*/];
                }
                VALID_ACTIONS = ["view_plan", "ask_telegraph", "add_to_plan", "create_meetup", "open_poll"];
                if (!VALID_ACTIONS.includes(actionId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Unknown action: ".concat(actionId));
                    return [2 /*return*/];
                }
                res.json({ ok: true, actionId: actionId, tripId: tripId, requiresConfirmation: actionId !== "view_plan" && actionId !== "ask_telegraph" });
                return [2 /*return*/];
        }
    });
}); });
/* ===========================================================================
 * POST /trips/:tripId/daily-brief/dismiss/:recommendationId
 * ===========================================================================
 */
router.post("/trips/:tripId/daily-brief/dismiss/:recommendationId", function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var auth, client, user, _a, tripId, recommendationId, member, _b;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0: return [4 /*yield*/, (0, http_js_1.requireUser)(req, res)];
            case 1:
                auth = _e.sent();
                if (!auth)
                    return [2 /*return*/];
                client = auth.client, user = auth.user;
                _a = req.params, tripId = _a.tripId, recommendationId = _a.recommendationId;
                if (!UUID.test(tripId)) {
                    (0, http_js_1.sendError)(res, "invalid_payload", "Invalid tripId");
                    return [2 /*return*/];
                }
                return [4 /*yield*/, (0, http_js_1.isAcceptedTripMember)(client, tripId, user.id)];
            case 2:
                member = _e.sent();
                if (!member) {
                    (0, http_js_1.sendError)(res, "not_member", "You must be an accepted trip member");
                    return [2 /*return*/];
                }
                _e.label = 3;
            case 3:
                _e.trys.push([3, 5, , 6]);
                return [4 /*yield*/, client.from("user_preference_events").insert({
                        user_id: user.id,
                        recommendation_id: recommendationId,
                        category: (_d = (_c = req.body) === null || _c === void 0 ? void 0 : _c.category) !== null && _d !== void 0 ? _d : "unknown",
                        signal: "dismiss",
                        trip_id: tripId,
                        created_at: new Date().toISOString(),
                    })];
            case 4:
                _e.sent();
                return [3 /*break*/, 6];
            case 5:
                _b = _e.sent();
                return [3 /*break*/, 6];
            case 6:
                res.json({ ok: true, dismissed: recommendationId });
                return [2 /*return*/];
        }
    });
}); });
exports.default = router;
