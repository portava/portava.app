/**
 * Unit tests for planUtils pure functions.
 * Run with:  node --import tsx/esm --test src/utils/planUtils.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBuckets, dayChipLabel, filterByDay } from './planUtils.ts';
import { localDateKey } from './localDate.ts';
import type { TripPlanItem } from '../types/models.ts';

// ── Minimal TripPlanItem factory ──────────────────────────────────────────────

function makeItem(overrides: Partial<TripPlanItem> & { id: string }): TripPlanItem {
  return {
    tripId: 'trip1',
    creatorId: 'user1',
    title: 'Item',
    category: 'activity',
    status: 'confirmed',
    sourceType: 'manual',
    sourceId: null,
    dayDate: null,
    startsAt: null,
    endsAt: null,
    locationName: null,
    notes: null,
    sortOrder: 0,
    visibility: 'members',
    lat: null,
    lng: null,
    locationIsPrivate: false,
    warnings: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── dayChipLabel ──────────────────────────────────────────────────────────────

describe('dayChipLabel', () => {
  it('returns Unscheduled for __unscheduled__', () => {
    assert.equal(dayChipLabel('__unscheduled__', null), 'Unscheduled');
  });

  it('returns Today for today date', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // LOCAL day key — toISOString() here gave the UTC date, so east of Greenwich
    // this test went red on a clean checkout (dayChipLabel is correct; the test
    // was feeding it yesterday's key).
    const key = localDateKey(today);
    assert.equal(dayChipLabel(key, null, today), 'Today');
  });

  it('returns Tomorrow for tomorrow date', () => {
    const now = new Date('2026-06-20T00:00:00');
    assert.equal(dayChipLabel('2026-06-21', null, now), 'Tomorrow');
  });

  it('returns Day N relative to trip start', () => {
    const now = new Date('2026-01-01T00:00:00');
    assert.equal(dayChipLabel('2026-03-10', '2026-03-08', now), 'Day 3');
  });

  it('returns formatted date when no tripStartDate', () => {
    const now = new Date('2026-01-01T00:00:00');
    const label = dayChipLabel('2026-06-15', null, now);
    assert.match(label, /Jun 15/);
  });

  it('returns key as-is for invalid date', () => {
    assert.equal(dayChipLabel('not-a-date', null), 'not-a-date');
  });
});

// ── buildBuckets ──────────────────────────────────────────────────────────────

describe('buildBuckets', () => {
  it('returns empty array for empty items', () => {
    assert.deepEqual(buildBuckets([], null, null), []);
  });

  it('groups items by dayDate in ascending order', () => {
    const items = [
      makeItem({ id: '1', dayDate: '2026-03-10' }),
      makeItem({ id: '2', dayDate: '2026-03-08' }),
      makeItem({ id: '3', dayDate: '2026-03-10' }),
    ];
    const buckets = buildBuckets(items, '2026-03-08', '2026-03-10');
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0].key, '2026-03-08');
    assert.equal(buckets[0].items.length, 1);
    assert.equal(buckets[1].key, '2026-03-10');
    assert.equal(buckets[1].items.length, 2);
  });

  it('puts items without dayDate into __unscheduled__ bucket at end', () => {
    const items = [
      makeItem({ id: '1', dayDate: '2026-03-08' }),
      makeItem({ id: '2', dayDate: null }),
    ];
    const buckets = buildBuckets(items, null, null);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[1].key, '__unscheduled__');
  });

  it('only creates __unscheduled__ bucket when there are unscheduled items', () => {
    const items = [makeItem({ id: '1', dayDate: '2026-03-08' })];
    const buckets = buildBuckets(items, null, null);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].key, '2026-03-08');
  });

  it('handles all unscheduled items', () => {
    const items = [makeItem({ id: '1', dayDate: null }), makeItem({ id: '2', dayDate: null })];
    const buckets = buildBuckets(items, null, null);
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].key, '__unscheduled__');
    assert.equal(buckets[0].items.length, 2);
  });
});

// ── filterByDay ───────────────────────────────────────────────────────────────

describe('filterByDay', () => {
  const items = [
    makeItem({ id: '1', dayDate: '2026-03-08' }),
    makeItem({ id: '2', dayDate: '2026-03-09' }),
    makeItem({ id: '3', dayDate: null }),
  ];

  it('returns all items for "all"', () => {
    assert.equal(filterByDay(items, 'all').length, 3);
  });

  it('filters by specific date', () => {
    const result = filterByDay(items, '2026-03-08');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });

  it('returns unscheduled items for __unscheduled__', () => {
    const result = filterByDay(items, '__unscheduled__');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '3');
  });

  it('returns empty array when no items match', () => {
    assert.equal(filterByDay(items, '2025-01-01').length, 0);
  });
});
