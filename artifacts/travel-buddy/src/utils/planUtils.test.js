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
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Unit tests for planUtils pure functions.
 * Run with:  node --import tsx/esm --test src/utils/planUtils.test.ts
 */
var node_test_1 = require("node:test");
var strict_1 = require("node:assert/strict");
var planUtils_ts_1 = require("./planUtils.ts");
// ── Minimal TripPlanItem factory ──────────────────────────────────────────────
function makeItem(overrides) {
    return __assign({ tripId: 'trip1', creatorId: 'user1', title: 'Item', category: 'activity', status: 'confirmed', sourceType: 'manual', sourceId: null, dayDate: null, startsAt: null, endsAt: null, locationName: null, notes: null, sortOrder: 0, visibility: 'members', lat: null, lng: null, locationIsPrivate: false, warnings: [], createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }, overrides);
}
// ── dayChipLabel ──────────────────────────────────────────────────────────────
(0, node_test_1.describe)('dayChipLabel', function () {
    (0, node_test_1.it)('returns Unscheduled for __unscheduled__', function () {
        strict_1.default.equal((0, planUtils_ts_1.dayChipLabel)('__unscheduled__', null), 'Unscheduled');
    });
    (0, node_test_1.it)('returns Today for today date', function () {
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var key = today.toISOString().slice(0, 10);
        strict_1.default.equal((0, planUtils_ts_1.dayChipLabel)(key, null, today), 'Today');
    });
    (0, node_test_1.it)('returns Tomorrow for tomorrow date', function () {
        var now = new Date('2026-06-20T00:00:00');
        strict_1.default.equal((0, planUtils_ts_1.dayChipLabel)('2026-06-21', null, now), 'Tomorrow');
    });
    (0, node_test_1.it)('returns Day N relative to trip start', function () {
        var now = new Date('2026-01-01T00:00:00');
        strict_1.default.equal((0, planUtils_ts_1.dayChipLabel)('2026-03-10', '2026-03-08', now), 'Day 3');
    });
    (0, node_test_1.it)('returns formatted date when no tripStartDate', function () {
        var now = new Date('2026-01-01T00:00:00');
        var label = (0, planUtils_ts_1.dayChipLabel)('2026-06-15', null, now);
        strict_1.default.match(label, /Jun 15/);
    });
    (0, node_test_1.it)('returns key as-is for invalid date', function () {
        strict_1.default.equal((0, planUtils_ts_1.dayChipLabel)('not-a-date', null), 'not-a-date');
    });
});
// ── buildBuckets ──────────────────────────────────────────────────────────────
(0, node_test_1.describe)('buildBuckets', function () {
    (0, node_test_1.it)('returns empty array for empty items', function () {
        strict_1.default.deepEqual((0, planUtils_ts_1.buildBuckets)([], null, null), []);
    });
    (0, node_test_1.it)('groups items by dayDate in ascending order', function () {
        var items = [
            makeItem({ id: '1', dayDate: '2026-03-10' }),
            makeItem({ id: '2', dayDate: '2026-03-08' }),
            makeItem({ id: '3', dayDate: '2026-03-10' }),
        ];
        var buckets = (0, planUtils_ts_1.buildBuckets)(items, '2026-03-08', '2026-03-10');
        strict_1.default.equal(buckets.length, 2);
        strict_1.default.equal(buckets[0].key, '2026-03-08');
        strict_1.default.equal(buckets[0].items.length, 1);
        strict_1.default.equal(buckets[1].key, '2026-03-10');
        strict_1.default.equal(buckets[1].items.length, 2);
    });
    (0, node_test_1.it)('puts items without dayDate into __unscheduled__ bucket at end', function () {
        var items = [
            makeItem({ id: '1', dayDate: '2026-03-08' }),
            makeItem({ id: '2', dayDate: null }),
        ];
        var buckets = (0, planUtils_ts_1.buildBuckets)(items, null, null);
        strict_1.default.equal(buckets.length, 2);
        strict_1.default.equal(buckets[1].key, '__unscheduled__');
    });
    (0, node_test_1.it)('only creates __unscheduled__ bucket when there are unscheduled items', function () {
        var items = [makeItem({ id: '1', dayDate: '2026-03-08' })];
        var buckets = (0, planUtils_ts_1.buildBuckets)(items, null, null);
        strict_1.default.equal(buckets.length, 1);
        strict_1.default.equal(buckets[0].key, '2026-03-08');
    });
    (0, node_test_1.it)('handles all unscheduled items', function () {
        var items = [makeItem({ id: '1', dayDate: null }), makeItem({ id: '2', dayDate: null })];
        var buckets = (0, planUtils_ts_1.buildBuckets)(items, null, null);
        strict_1.default.equal(buckets.length, 1);
        strict_1.default.equal(buckets[0].key, '__unscheduled__');
        strict_1.default.equal(buckets[0].items.length, 2);
    });
});
// ── filterByDay ───────────────────────────────────────────────────────────────
(0, node_test_1.describe)('filterByDay', function () {
    var items = [
        makeItem({ id: '1', dayDate: '2026-03-08' }),
        makeItem({ id: '2', dayDate: '2026-03-09' }),
        makeItem({ id: '3', dayDate: null }),
    ];
    (0, node_test_1.it)('returns all items for "all"', function () {
        strict_1.default.equal((0, planUtils_ts_1.filterByDay)(items, 'all').length, 3);
    });
    (0, node_test_1.it)('filters by specific date', function () {
        var result = (0, planUtils_ts_1.filterByDay)(items, '2026-03-08');
        strict_1.default.equal(result.length, 1);
        strict_1.default.equal(result[0].id, '1');
    });
    (0, node_test_1.it)('returns unscheduled items for __unscheduled__', function () {
        var result = (0, planUtils_ts_1.filterByDay)(items, '__unscheduled__');
        strict_1.default.equal(result.length, 1);
        strict_1.default.equal(result[0].id, '3');
    });
    (0, node_test_1.it)('returns empty array when no items match', function () {
        strict_1.default.equal((0, planUtils_ts_1.filterByDay)(items, '2025-01-01').length, 0);
    });
});
