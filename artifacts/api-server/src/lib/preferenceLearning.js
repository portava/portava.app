"use strict";
/**
 * Telegraph Preference Learning Engine
 *
 * Scoring formula:
 *   interest_match + behavior_affinity + trip_context_fit
 *   - avoid_penalty - dismissed_recently_penalty
 *
 * Explicit preferences always override inferred signals.
 * Recency decay: events older than 30 days have half weight.
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
exports.applyEvent = applyEvent;
exports.scoreRecommendation = scoreRecommendation;
exports.defaultExplicit = defaultExplicit;
exports.defaultInferred = defaultInferred;
var SIGNAL_WEIGHT = {
    save: 0.8,
    add_to_plan: 1.0,
    more_like_this: 0.6,
    view: 0.1,
    share: 0.5,
    less_like_this: -0.6,
    not_for_me: -1.0,
    dismiss: -0.3,
};
var DECAY_HALF_LIFE_DAYS = 30;
function recencyWeight(createdAt) {
    var ageMs = Date.now() - new Date(createdAt).getTime();
    var ageDays = ageMs / (1000 * 60 * 60 * 24);
    return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}
/**
 * Apply a new preference event to update the inferred profile.
 * Returns updated InferredPreferences (pure function, no side effects).
 */
function applyEvent(inferred, event) {
    var _a;
    var _b, _c;
    var category = event.category, signal = event.signal, createdAt = event.createdAt;
    var weight = ((_b = SIGNAL_WEIGHT[signal]) !== null && _b !== void 0 ? _b : 0) * recencyWeight(createdAt !== null && createdAt !== void 0 ? createdAt : new Date().toISOString());
    var current = (_c = inferred.categoryAffinities[category]) !== null && _c !== void 0 ? _c : 0;
    var updated = Math.max(-1, Math.min(1, current + weight * 0.2));
    var newAffinities = __assign(__assign({}, inferred.categoryAffinities), (_a = {}, _a[category] = updated, _a));
    var dismissed = signal === "not_for_me" || signal === "less_like_this"
        ? Array.from(new Set(__spreadArray(__spreadArray([], inferred.dismissedCategories, true), [category], false)))
        : inferred.dismissedCategories;
    var saved = signal === "save"
        ? Array.from(new Set(__spreadArray(__spreadArray([], inferred.savedCategories, true), [category], false)))
        : inferred.savedCategories;
    var added = signal === "add_to_plan"
        ? Array.from(new Set(__spreadArray(__spreadArray([], inferred.addedToPlanCategories, true), [category], false)))
        : inferred.addedToPlanCategories;
    return {
        categoryAffinities: newAffinities,
        dismissedCategories: dismissed,
        savedCategories: saved,
        addedToPlanCategories: added,
    };
}
/**
 * Score a recommendation candidate against a user's preference profile.
 * Higher is better. Range: -2 .. 3
 */
function scoreRecommendation(category, explicit, inferred) {
    var _a, _b, _c, _d, _e, _f, _g;
    // Defensive: treat any missing/partial profile as empty defaults so this
    // function never throws, even if a profile was created with `{}`.
    var interests = (_a = explicit === null || explicit === void 0 ? void 0 : explicit.interests) !== null && _a !== void 0 ? _a : [];
    var foodPrefs = (_b = explicit === null || explicit === void 0 ? void 0 : explicit.foodPreferences) !== null && _b !== void 0 ? _b : [];
    var nightPrefs = (_c = explicit === null || explicit === void 0 ? void 0 : explicit.nightlifePreferences) !== null && _c !== void 0 ? _c : [];
    var avoidList = (_d = explicit === null || explicit === void 0 ? void 0 : explicit.avoidList) !== null && _d !== void 0 ? _d : [];
    var affinities = (_e = inferred === null || inferred === void 0 ? void 0 : inferred.categoryAffinities) !== null && _e !== void 0 ? _e : {};
    var dismissed = (_f = inferred === null || inferred === void 0 ? void 0 : inferred.dismissedCategories) !== null && _f !== void 0 ? _f : [];
    var score = 0;
    // Explicit interest match (strongest signal — overrides inferred)
    if (interests.includes(category))
        score += 1.5;
    if (foodPrefs.some(function (f) { return category.includes(f); }))
        score += 0.5;
    if (nightPrefs.some(function (n) { return category.includes(n); }))
        score += 0.5;
    // Behavior affinity from learning engine
    score += (_g = affinities[category]) !== null && _g !== void 0 ? _g : 0;
    // Avoid penalty (explicit trumps everything)
    if (avoidList.some(function (a) { return category.toLowerCase().includes(a.toLowerCase()); })) {
        score -= 2;
    }
    // Dismissed penalty (inferred)
    if (dismissed.includes(category))
        score -= 0.8;
    return score;
}
function defaultExplicit() {
    return {
        interests: [],
        foodPreferences: [],
        nightlifePreferences: [],
        pace: "balanced",
        groupStyle: "mixed",
        preferredActivityTimes: [],
        avoidList: [],
    };
}
function defaultInferred() {
    return {
        categoryAffinities: {},
        dismissedCategories: [],
        savedCategories: [],
        addedToPlanCategories: [],
    };
}
