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
exports.PLAN_GROUP_LABEL = exports.TRIP_GROUP_LABEL = exports.attachPlanTargets = exports.attachTripTargets = void 0;
var tripDetail_1 = require("./tripDetail");
/** Trips the user can add to. Active trip first, then upcoming/planning. */
exports.attachTripTargets = [
    {
        id: tripDetail_1.mockTripDetail.id, type: 'trip', title: tripDetail_1.mockTripDetail.title,
        subtitle: "".concat(tripDetail_1.mockTripDetail.destinationCity, " \u00B7 ").concat(tripDetail_1.mockTripDetail.status),
        group: 'active',
    },
    { id: 'trip_tokyo', type: 'trip', title: 'Tokyo Spring', subtitle: 'Japan · upcoming', group: 'upcoming' },
    { id: 'trip_bali', type: 'trip', title: 'Bali Escape', subtitle: 'Indonesia · planning', group: 'planning' },
];
/** Plans the user can add to. Trip-linked plans first. */
exports.attachPlanTargets = __spreadArray(__spreadArray([], tripDetail_1.tripPlans
    .filter(function (p) { return p.status === 'joined' || p.status === 'hosting'; })
    .map(function (p) { return ({ id: p.id, type: 'plan', title: p.title, subtitle: p.time, group: 'trip_plans' }); }), true), [
    { id: 'plan_draft1', type: 'plan', title: 'Weekend in Moalboal', subtitle: 'Draft', group: 'draft' },
], false);
exports.TRIP_GROUP_LABEL = {
    active: 'Active trip', upcoming: 'Upcoming', planning: 'Planning',
};
exports.PLAN_GROUP_LABEL = {
    trip_plans: 'Plans on this trip', open: 'Your plans', draft: 'Drafts',
};
