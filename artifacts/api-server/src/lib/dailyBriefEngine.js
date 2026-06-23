"use strict";
/**
 * Trip Daily Brief Engine
 *
 * Assembles a TripDailyBrief for an accepted trip member for a given date.
 * Inputs: plan items, meetups, shared availability, Telegraph recommendations,
 * the user's preference profile. All assembled through the privacy resolver.
 *
 * Privacy: no exact GPS, no private availability of other users.
 * Degrades gracefully when optional data sources (meetups, availability) absent.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildDailyBrief = buildDailyBrief;
var preferenceLearning_js_1 = require("./preferenceLearning.js");
function buildDailyBrief(opts) {
    var _a, _b;
    var tripId = opts.tripId, userId = opts.userId, date = opts.date, briefType = opts.briefType, destination = opts.destination, tripStartDate = opts.tripStartDate, tripEndDate = opts.tripEndDate, planItems = opts.planItems, meetups = opts.meetups, recommendations = opts.recommendations, preferenceProfile = opts.preferenceProfile, _c = opts.weatherSummary, weatherSummary = _c === void 0 ? null : _c, _d = opts.weatherForecasts, weatherForecasts = _d === void 0 ? [] : _d;
    var upcomingMeetups24h = (_a = opts.upcomingMeetups24h) !== null && _a !== void 0 ? _a : [];
    // Filter plan items for the target date
    var dayItems = planItems.filter(function (i) { return i.day_date === date; });
    var planPreview = dayItems.map(function (i) {
        var _a;
        return ({
            id: i.id,
            title: i.title,
            startsAt: i.starts_at,
            endsAt: i.ends_at,
            category: i.category,
            status: i.status,
            locationName: i.location_name,
            warnings: (_a = i.warnings) !== null && _a !== void 0 ? _a : [],
        });
    });
    // Detect warnings
    var warnings = [];
    var hasOverlap = dayItems.some(function (i) { var _a; return (_a = i.warnings) === null || _a === void 0 ? void 0 : _a.includes("time_overlap"); });
    if (hasOverlap)
        warnings.push("time_overlap");
    var cancelledMeetups = meetups.filter(function (m) { return m.status === "cancelled"; });
    if (cancelledMeetups.length > 0)
        warnings.push("cancelled_meetup");
    // Compute open windows (simplified: before first item, between items, after last item)
    var openWindows = computeOpenWindows(dayItems, date);
    if (openWindows.length > 0 && dayItems.length === 0)
        warnings.push("free_window_unplanned");
    // Compute gap days — trip days with no plan items at all
    var gapDays = computeGapDays(planItems, tripStartDate, tripEndDate, date);
    // Score and sort suggestions against preference profile
    var scoredSuggestions = recommendations.map(function (r) {
        var score = preferenceProfile
            ? (0, preferenceLearning_js_1.scoreRecommendation)(r.category, preferenceProfile.explicit, preferenceProfile.inferred)
            : 0;
        return __assign({ id: r.id, title: r.title, category: r.category, reason: r.reason, estimatedTime: r.estimatedTime, priceLevel: r.priceLevel, score: score }, (r.forGapDay ? { forGapDay: r.forGapDay } : {}));
    });
    scoredSuggestions.sort(function (a, b) { return b.score - a.score; });
    // Meetup opportunities (active meetups only)
    var meetupOpportunities = meetups
        .filter(function (m) { return m.status !== "cancelled"; })
        .map(function (m) { return ({
        id: m.id,
        title: m.title,
        proposedTime: m.proposed_time,
        attendeeCount: m.attendee_count,
    }); });
    // Quick actions
    var quickActions = [
        { id: "qa_plan", label: "View plan", kind: "view_plan" },
        { id: "qa_telegraph", label: "Ask Telegraph", kind: "ask_telegraph" },
    ];
    if (openWindows.length > 0) {
        var dest = destination ? " in ".concat(destination) : "";
        quickActions.push({
            id: "qa_fill",
            label: "Fill free time",
            kind: "ask_telegraph",
            params: { prompt: "What should I do during my free time".concat(dest, "?") },
        });
    }
    if (dayItems.length === 0) {
        var dest = destination ? " in ".concat(destination) : "";
        quickActions.push({
            id: "qa_plan_day",
            label: "Plan today",
            kind: "ask_telegraph",
            params: { prompt: "Help me plan today".concat(dest) },
        });
    }
    // Upcoming meetup action: suggest nearby food if meetup is at breakfast (7–10), lunch (11–13), or dinner (17+)
    for (var _i = 0, _e = upcomingMeetups24h.slice(0, 1); _i < _e.length; _i++) {
        var m = _e[_i];
        var meetupHour = new Date(m.proposedTime).getHours();
        var isBreakfast = meetupHour >= 7 && meetupHour < 11;
        var isLunch = meetupHour >= 11 && meetupHour < 14;
        var isDinner = meetupHour >= 17;
        if (isBreakfast || isLunch || isDinner) {
            var meal = isBreakfast ? "breakfast" : isLunch ? "lunch" : "dinner";
            var dest = destination ? " in ".concat(destination) : "";
            var locationHint = (_b = m.locationName) !== null && _b !== void 0 ? _b : null;
            // Structured params let Telegraph generate location/time-aware food suggestions.
            // prompt is kept as a human-readable fallback for clients that ignore the structured fields.
            var params = {
                prompt: locationHint
                    ? "Find ".concat(meal, " options near ").concat(locationHint, " before my ").concat(m.title, " meetup")
                    : "Find ".concat(meal, " options before my ").concat(m.title, " meetup").concat(dest),
                meetupId: m.id,
                meetupTime: m.proposedTime,
            };
            if (locationHint)
                params.meetupLocation = locationHint;
            quickActions.push({
                id: "qa_premeetup_".concat(m.id),
                label: "Find ".concat(meal, " nearby"),
                kind: "ask_telegraph",
                params: params,
            });
        }
    }
    // Summary text
    var summaryText = buildSummaryText({
        planCount: dayItems.length,
        openWindowCount: openWindows.length,
        suggestionCount: scoredSuggestions.length,
        destination: destination,
        briefType: briefType,
        gapDays: gapDays,
        upcomingMeetups24h: upcomingMeetups24h,
    });
    return {
        tripId: tripId,
        userId: userId,
        date: date,
        briefType: briefType,
        destination: destination,
        summaryText: summaryText,
        weatherSummary: weatherSummary,
        weatherForecasts: weatherForecasts,
        planPreview: planPreview,
        openWindows: openWindows,
        suggestions: scoredSuggestions.slice(0, 4),
        meetupOpportunities: meetupOpportunities.slice(0, 2),
        gapDays: gapDays,
        warnings: warnings,
        quickActions: quickActions,
        generatedAt: new Date().toISOString(),
        isStale: false,
    };
}
/**
 * Compute gap days — calendar days within the trip date range that have no
 * plan items assigned to them. Excludes today (the date being briefed) since
 * the "today" section covers that. Returns at most 5 gap days.
 */
function computeGapDays(planItems, tripStartDate, tripEndDate, today) {
    if (!tripStartDate || !tripEndDate)
        return [];
    var start = new Date(tripStartDate + "T00:00:00Z");
    var end = new Date(tripEndDate + "T00:00:00Z");
    // Build set of days that have at least one plan item
    var daysWithItems = new Set();
    for (var _i = 0, planItems_1 = planItems; _i < planItems_1.length; _i++) {
        var item = planItems_1[_i];
        if (item.day_date)
            daysWithItems.add(item.day_date);
    }
    var gaps = [];
    var cursor = new Date(start);
    while (cursor <= end && gaps.length < 5) {
        var isoDate = cursor.toISOString().slice(0, 10);
        if (isoDate !== today && !daysWithItems.has(isoDate)) {
            gaps.push(isoDate);
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return gaps;
}
function computeOpenWindows(items, date) {
    var windows = [];
    var timed = items
        .filter(function (i) { return i.starts_at; })
        .sort(function (a, b) { return new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime(); });
    if (timed.length === 0) {
        windows.push({ label: "All day open", startTime: "09:00", endTime: "22:00" });
        return windows;
    }
    var dayStart = new Date("".concat(date, "T09:00:00"));
    var firstStart = new Date(timed[0].starts_at);
    if (firstStart.getTime() - dayStart.getTime() >= 90 * 60 * 1000) {
        windows.push({
            label: "Free before first activity",
            startTime: "09:00",
            endTime: formatTime(timed[0].starts_at),
        });
    }
    for (var i = 0; i < timed.length - 1; i++) {
        var current = timed[i];
        var next = timed[i + 1];
        var currentEnd = current.ends_at
            ? new Date(current.ends_at)
            : new Date(new Date(current.starts_at).getTime() + 60 * 60 * 1000);
        var nextStart = new Date(next.starts_at);
        var gap = nextStart.getTime() - currentEnd.getTime();
        if (gap >= 90 * 60 * 1000) {
            windows.push({
                label: "Free window",
                startTime: formatTime(currentEnd.toISOString()),
                endTime: formatTime(next.starts_at),
            });
        }
    }
    var lastItem = timed[timed.length - 1];
    var lastEnd = lastItem.ends_at
        ? new Date(lastItem.ends_at)
        : new Date(new Date(lastItem.starts_at).getTime() + 60 * 60 * 1000);
    var dayEnd = new Date("".concat(date, "T22:00:00"));
    if (dayEnd.getTime() - lastEnd.getTime() >= 90 * 60 * 1000) {
        windows.push({
            label: "Free evening",
            startTime: formatTime(lastEnd.toISOString()),
            endTime: "22:00",
        });
    }
    return windows;
}
function formatTime(iso) {
    var d = new Date(iso);
    return "".concat(String(d.getHours()).padStart(2, "0"), ":").concat(String(d.getMinutes()).padStart(2, "0"));
}
function buildSummaryText(opts) {
    var _a;
    var planCount = opts.planCount, openWindowCount = opts.openWindowCount, suggestionCount = opts.suggestionCount, destination = opts.destination, briefType = opts.briefType, gapDays = opts.gapDays, upcomingMeetups24h = opts.upcomingMeetups24h;
    var dest = destination ? " in ".concat(destination) : "";
    // General brief (no active trip) — travel inspiration
    if (briefType === "general") {
        return suggestionCount > 0
            ? "No active trip right now — here's some travel inspiration to spark your next adventure."
            : "No active trip right now. Start planning your next trip to get personalised suggestions.";
    }
    // Trip-context brief
    // Upcoming meetup nudge (within 24 h)
    var nextMeetup = (_a = upcomingMeetups24h[0]) !== null && _a !== void 0 ? _a : null;
    var meetupNudge = nextMeetup
        ? " You have ".concat(nextMeetup.title, " at ").concat(formatTime(nextMeetup.proposedTime)).concat(nextMeetup.locationName ? " at ".concat(nextMeetup.locationName) : "", " \u2014 plan around it.")
        : "";
    if (planCount === 0 && openWindowCount > 0) {
        var gapHint = gapDays.length > 0
            ? " You also have ".concat(gapDays.length, " unplanned day").concat(gapDays.length > 1 ? "s" : "", " ahead.")
            : "";
        return "Your day".concat(dest, " is open \u2014 ").concat(suggestionCount > 0 ? "Telegraph has suggestions ready" : "add something to your plan", ".").concat(gapHint).concat(meetupNudge);
    }
    if (planCount > 0 && openWindowCount > 0) {
        return "".concat(planCount, " plan item").concat(planCount > 1 ? "s" : "", " today").concat(dest, " with ").concat(openWindowCount, " free window").concat(openWindowCount > 1 ? "s" : "", ".").concat(meetupNudge);
    }
    if (planCount > 0) {
        return "".concat(planCount, " plan item").concat(planCount > 1 ? "s" : "", " today").concat(dest, " \u2014 looking full.").concat(meetupNudge);
    }
    return "Today".concat(dest, " is unplanned \u2014 let Telegraph help.").concat(meetupNudge);
}
