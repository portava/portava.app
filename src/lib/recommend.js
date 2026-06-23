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
    var availability = opts.availability, currentCitySlug = opts.currentCitySlug, _a = opts.interests, interests = _a === void 0 ? [] : _a;
    // 1. City scope: current city first. Other cities still allowed but after.
    var inCity = function (e) { return !currentCitySlug || e.citySlug === currentCitySlug; };
    // soft interest affinity: 1 if category matches a user interest, else 0.
    var interestMatch = function (e) { return (interests.includes(e.category) ? 1 : 0); };
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
    // deterministic sort: in-city first, then interest match, then soonest start.
    var sorter = function (a, b) {
        var city = Number(inCity(b)) - Number(inCity(a));
        if (city !== 0)
            return city;
        var interest = interestMatch(b) - interestMatch(a);
        if (interest !== 0)
            return interest;
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
