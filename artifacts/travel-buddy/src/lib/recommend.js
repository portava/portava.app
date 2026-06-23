"use strict";
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
exports.filterPulse = filterPulse;
exports.plainReason = plainReason;
exports.filterPulseFeed = filterPulseFeed;
exports.orderPulseFeed = orderPulseFeed;
var availability_1 = require("./availability");
function filterPulse(events, opts) {
    var availability = opts.availability, currentCitySlug = opts.currentCitySlug, _a = opts.interests, interests = _a === void 0 ? [] : _a, _b = opts.categoryAffinities, categoryAffinities = _b === void 0 ? {} : _b;
    // 1. City scope: current city first. Other cities still allowed but after.
    var inCity = function (e) { return !currentCitySlug || e.citySlug === currentCitySlug; };
    // Binary interest match (1 or 0 — explicit preferences set by the user).
    var interestMatch = function (e) { return (interests.includes(e.category) ? 1 : 0); };
    // Learned affinity score (0–1 normalised from the raw inferred score).
    // Raw scores are small floats; cap at 5 for normalisation to prevent outliers dominating.
    var affinityScore = function (e) {
        var _a;
        var raw = (_a = categoryAffinities[e.category]) !== null && _a !== void 0 ? _a : 0;
        return Math.min(raw, 5) / 5; // normalise to 0–1
    };
    var fitsAvailability = [];
    var openNearby = [];
    var flexible = [];
    for (var _i = 0, events_1 = events; _i < events_1.length; _i++) {
        var e = events_1[_i];
        var within = (0, availability_1.isWithinAvailability)(availability, e);
        if (within === true)
            fitsAvailability.push(e);
        else if (within === false)
            flexible.push(e);
        else
            openNearby.push(e); // unknown availability -> keep visible
    }
    // Preference-aware sort:
    //   1. In-city (boolean gate)
    //   2. Combined affinity = explicit interest match + learned affinity score (0–1)
    //      This means repeated feedback nudges rank order without a hard gate.
    //   3. Soonest start as tiebreaker.
    var combinedAffinity = function (e) { return interestMatch(e) + affinityScore(e); };
    var sorter = function (a, b) {
        var city = Number(inCity(b)) - Number(inCity(a));
        if (city !== 0)
            return city;
        var affinity = combinedAffinity(b) - combinedAffinity(a);
        if (affinity !== 0)
            return affinity;
        return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
    };
    fitsAvailability.sort(sorter);
    openNearby.sort(sorter);
    flexible.sort(sorter);
    return { fitsAvailability: fitsAvailability, openNearby: openNearby, flexible: flexible };
}
/** Honest reason string — only states what the simple filter actually proved. */
function plainReason(e, interests, currentCitySlug) {
    if (interests === void 0) { interests = []; }
    var bits = [];
    if (currentCitySlug && e.citySlug === currentCitySlug)
        bits.push('in your city');
    if (interests.includes(e.category))
        bits.push("matches ".concat(e.category));
    return bits.length ? "Shown because it\u2019s ".concat(bits.join(' and '), ".") : 'Open plan near you.';
}
/* ───────────────────────────────────────────────────────────────────────
 * Pulse Wall feed filtering + ordering. Deterministic, no fake scores.
 * Availability-first, then recency. Filters narrow the mixed feed by type/tag.
 * ─────────────────────────────────────────────────────────────────────── */
var TYPE_FOR_FILTER = {
    Posts: 'post', Questions: 'question', Plans: 'plan',
    'Hidden Gems': 'hidden_gem', Itineraries: 'itinerary', Circle: 'circle_activity',
};
var CATEGORY_FILTERS = ['Food', 'Nightlife', 'Beach', 'Culture'];
/** Filter the mixed feed by active filters (AND across filter groups). */
function filterPulseFeed(items, active) {
    if (!active.length || active.includes('All'))
        return orderPulseFeed(items);
    var out = items;
    // type filters (OR within type group)
    var typeFilters = active.filter(function (f) { return TYPE_FOR_FILTER[f]; });
    if (typeFilters.length) {
        var types_1 = new Set(typeFilters.map(function (f) { return TYPE_FOR_FILTER[f]; }));
        out = out.filter(function (it) { return types_1.has(it.type); });
    }
    // category tag filters (OR within category group)
    var catFilters = active.filter(function (f) { return CATEGORY_FILTERS.includes(f); });
    if (catFilters.length) {
        var tags_1 = catFilters.map(function (f) { return f.toLowerCase(); });
        out = out.filter(function (it) { return it.tags.some(function (tg) { return tags_1.includes(tg.toLowerCase()); }); });
    }
    // availability filters
    if (active.includes('Fits My Time') || active.includes('Open Now')) {
        out = out.filter(function (it) { return it.availabilityMatch; });
    }
    return orderPulseFeed(out);
}
/** Order: availability-match first, then most recent. No fabricated score. */
function orderPulseFeed(items) {
    return __spreadArray([], items, true).sort(function (a, b) {
        var am = a.availabilityMatch ? 1 : 0;
        var bm = b.availabilityMatch ? 1 : 0;
        if (am !== bm)
            return bm - am; // availability first
        // editorial/provisional sink lower
        var ap = a.isEditorial || a.isProvisional ? 1 : 0;
        var bp = b.isEditorial || b.isProvisional ? 1 : 0;
        if (ap !== bp)
            return ap - bp;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); // recency
    });
}
