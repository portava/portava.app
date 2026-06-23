"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dayChipLabel = dayChipLabel;
exports.buildBuckets = buildBuckets;
exports.filterByDay = filterByDay;
// ── Day chip label ────────────────────────────────────────────────────────────
function dayChipLabel(key, tripStartDate, now) {
    if (now === void 0) { now = new Date(); }
    if (key === '__unscheduled__')
        return 'Unscheduled';
    var d = new Date(key + 'T00:00:00');
    if (isNaN(d.getTime()))
        return key;
    var today = new Date(now);
    today.setHours(0, 0, 0, 0);
    var tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    var ms = d.getTime();
    if (ms === today.getTime())
        return 'Today';
    if (ms === tomorrow.getTime())
        return 'Tomorrow';
    if (tripStartDate) {
        var start = new Date(tripStartDate + 'T00:00:00');
        if (!isNaN(start.getTime())) {
            var dayNum = Math.round((ms - start.getTime()) / 86400000) + 1;
            if (dayNum >= 1)
                return "Day ".concat(dayNum);
        }
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// ── Day bucket builder ────────────────────────────────────────────────────────
function buildBuckets(items, _tripStartDate, _tripEndDate) {
    var byDay = new Map();
    var unscheduled = [];
    for (var _i = 0, items_1 = items; _i < items_1.length; _i++) {
        var item = items_1[_i];
        if (item.dayDate) {
            if (!byDay.has(item.dayDate))
                byDay.set(item.dayDate, []);
            byDay.get(item.dayDate).push(item);
        }
        else {
            unscheduled.push(item);
        }
    }
    var sorted = Array.from(byDay.entries())
        .sort(function (_a, _b) {
        var a = _a[0];
        var b = _b[0];
        return a.localeCompare(b);
    })
        .map(function (_a) {
        var key = _a[0], dayItems = _a[1];
        return ({ key: key, items: dayItems });
    });
    if (unscheduled.length > 0) {
        sorted.push({ key: '__unscheduled__', items: unscheduled });
    }
    return sorted;
}
// ── Active day filter ─────────────────────────────────────────────────────────
function filterByDay(items, activeDay) {
    if (activeDay === 'all')
        return items;
    if (activeDay === '__unscheduled__')
        return items.filter(function (i) { return !i.dayDate; });
    return items.filter(function (i) { return i.dayDate === activeDay; });
}
