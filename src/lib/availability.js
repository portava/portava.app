"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATUS_LABEL = void 0;
exports.isWithinAvailability = isWithinAvailability;
exports.resolveStatus = resolveStatus;
exports.blockOf = blockOf;
var WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function weekdayOf(iso) {
    return WEEKDAYS[new Date(iso).getDay()];
}
function withinTrip(trip, citySlug, iso) {
    if (trip.citySlug !== citySlug)
        return false;
    var d = new Date(iso).getTime();
    return d >= new Date(trip.startDate).getTime() && d <= new Date(trip.endDate + 'T23:59:59').getTime();
}
/**
 * Is a given event inside the user's availability?
 * Returns:
 *  - true  : explicitly inside a trip window or weekly block
 *  - false : explicitly outside a window that DOES cover this city/date
 *  - null  : no relevant window set -> "unknown", don't penalize
 */
function isWithinAvailability(av, ev) {
    if (!av)
        return null;
    // 1. Trip-specific window for this city/date overrides everything.
    var trip = av.trips.find(function (t) { return withinTrip(t, ev.citySlug, ev.startAt); });
    if (trip)
        return trip.blocks.includes(ev.block);
    // 2. Recurring weekly.
    if (av.weekly) {
        var wd = weekdayOf(ev.startAt);
        var blocks = av.weekly.days[wd];
        if (blocks && blocks.length)
            return blocks.includes(ev.block);
    }
    // 3. Nothing relevant set -> unknown.
    return null;
}
/** Friendly status label for the Availability card. Honest about "not set". */
function resolveStatus(av, nowISO, citySlug) {
    if (!av)
        return 'not_set';
    if (citySlug) {
        var trip = av.trips.find(function (t) { return withinTrip(t, citySlug, nowISO); });
        if (trip)
            return 'trip_active';
    }
    var block = blockOf(nowISO);
    if (av.weekly) {
        var wd = weekdayOf(nowISO);
        var blocks = av.weekly.days[wd];
        if (blocks === null || blocks === void 0 ? void 0 : blocks.includes(block)) {
            return block === 'evening' || block === 'late' ? 'open_tonight' : 'usually_free';
        }
        if (Object.keys(av.weekly.days).length > 0)
            return 'flexible_week';
    }
    if (av.openToMeet)
        return 'open_to_meet';
    return 'not_set';
}
function blockOf(iso) {
    var h = new Date(iso).getHours();
    if (h < 12)
        return 'morning';
    if (h < 17)
        return 'afternoon';
    if (h < 22)
        return 'evening';
    return 'late';
}
exports.STATUS_LABEL = {
    open_tonight: 'Open tonight',
    usually_free: 'Usually free now',
    flexible_week: 'Flexible this week',
    trip_active: 'Trip window active',
    not_available: 'Not available',
    open_to_meet: 'Open to meet',
    not_set: 'Availability not set',
};
