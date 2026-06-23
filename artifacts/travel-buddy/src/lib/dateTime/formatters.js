"use strict";
/**
 * Date / time formatting helpers used across GlobalCalendarPicker,
 * GlobalTimePicker, DurationPicker, and all forms that store ISO dates.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDisplayDate = formatDisplayDate;
exports.formatDisplayDateRange = formatDisplayDateRange;
exports.toISODate = toISODate;
exports.fromISODate = fromISODate;
exports.formatDisplayTime = formatDisplayTime;
exports.toHHmm = toHHmm;
exports.fromHHmm = fromHHmm;
exports.formatDuration = formatDuration;
exports.toMidnight = toMidnight;
exports.isSameDay = isSameDay;
exports.isBeforeDay = isBeforeDay;
exports.isAfterDay = isAfterDay;
exports.isBetweenDays = isBetweenDays;
exports.monthName = monthName;
/** Format a Date for human display: "Jun 22, 2026" */
function formatDisplayDate(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
/** Format a Date range for display: "Jun 22–26, 2026" or "Jun 22 – Jul 4, 2026" */
function formatDisplayDateRange(start, end) {
    var sameYear = start.getFullYear() === end.getFullYear();
    var sameMonth = sameYear && start.getMonth() === end.getMonth();
    if (sameMonth) {
        var month = start.toLocaleDateString('en-US', { month: 'short' });
        return "".concat(month, " ").concat(start.getDate(), "\u2013").concat(end.getDate(), ", ").concat(start.getFullYear());
    }
    if (sameYear) {
        var s = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        var e = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return "".concat(s, " \u2013 ").concat(e, ", ").concat(start.getFullYear());
    }
    return "".concat(formatDisplayDate(start), " \u2013 ").concat(formatDisplayDate(end));
}
/** Format a Date as ISO date string: "2026-06-22" */
function toISODate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return "".concat(y, "-").concat(m, "-").concat(day);
}
/** Parse an ISO date string "YYYY-MM-DD" into a local Date (midnight). */
function fromISODate(s) {
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s))
        return null;
    var _a = s.split('-').map(Number), y = _a[0], m = _a[1], d = _a[2];
    var date = new Date(y, m - 1, d);
    return isNaN(date.getTime()) ? null : date;
}
/** Format a local time: "6:30 PM" */
function formatDisplayTime(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
/** Format local HH:mm string: "18:30" */
function toHHmm(d) {
    return "".concat(String(d.getHours()).padStart(2, '0'), ":").concat(String(d.getMinutes()).padStart(2, '0'));
}
/** Parse "HH:mm" → Date (today's date at that time) */
function fromHHmm(s) {
    if (!s || !/^\d{2}:\d{2}$/.test(s))
        return null;
    var _a = s.split(':').map(Number), h = _a[0], m = _a[1];
    var d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
}
/** Format a duration in seconds into a human label: "3 h", "30 min", "1 h 30 min" */
function formatDuration(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h === 0)
        return "".concat(m, " min");
    if (m === 0)
        return "".concat(h, " h");
    return "".concat(h, " h ").concat(m, " min");
}
/** Strip time off a Date to midnight local time */
function toMidnight(d) {
    var n = new Date(d);
    n.setHours(0, 0, 0, 0);
    return n;
}
/** Compare two dates ignoring time */
function isSameDay(a, b) {
    return (a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate());
}
/** Return true if `d` is before `ref` (date only, ignoring time) */
function isBeforeDay(d, ref) {
    return toMidnight(d) < toMidnight(ref);
}
/** Return true if `d` is after `ref` (date only, ignoring time) */
function isAfterDay(d, ref) {
    return toMidnight(d) > toMidnight(ref);
}
/** Return true if `d` is between `start` and `end` (inclusive, date only) */
function isBetweenDays(d, start, end) {
    var dn = toMidnight(d).getTime();
    return dn >= toMidnight(start).getTime() && dn <= toMidnight(end).getTime();
}
var MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
function monthName(month) { var _a; return (_a = MONTHS[month]) !== null && _a !== void 0 ? _a : ''; }
