/**
 * Regression tests for the non-Nearest sort chips (rating, popular) in FilterStrip.
 *
 * These chips share the same onPress path as Nearest but must never be blocked
 * by the location guard.  If the branch logic in FilterStrip is rearranged and
 * the guard leaks into these chips, these tests catch it.
 *
 * The tests target the pure function `handleSortChipPress` which FilterStrip
 * delegates its non-Nearest onPress handlers to.
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/components/discovery/__tests__/FilterStrip.sort.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleSortChipPress } from '../filterStripSort.ts';
import type { SortChipFilters } from '../filterStripSort.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_FILTERS: SortChipFilters = {
  radiusKm: 10,
  openNow: false,
  minRating: null,
  sortBy: null,
};

const FILTERS_RATING_ACTIVE: SortChipFilters = {
  ...BASE_FILTERS,
  sortBy: 'rating',
};

const FILTERS_POPULAR_ACTIVE: SortChipFilters = {
  ...BASE_FILTERS,
  sortBy: 'popular',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrackers() {
  let onChangeCallCount = 0;
  let onChangeLastFilters: SortChipFilters | null = null;

  const onChange = (f: SortChipFilters) => {
    onChangeCallCount++;
    onChangeLastFilters = f;
  };

  return {
    onChange,
    get onChangeCallCount() { return onChangeCallCount; },
    get onChangeLastFilters() { return onChangeLastFilters; },
  };
}

// ── "rating" chip ─────────────────────────────────────────────────────────────

describe('handleSortChipPress — "rating" chip', () => {
  it('always calls onChange (no location guard)', () => {
    const t = makeTrackers();
    handleSortChipPress('rating', false, BASE_FILTERS, t.onChange);
    assert.equal(t.onChangeCallCount, 1);
  });

  it('sets sortBy to "rating" when the chip is not yet active', () => {
    const t = makeTrackers();
    handleSortChipPress('rating', false, BASE_FILTERS, t.onChange);
    assert.equal(t.onChangeLastFilters?.sortBy, 'rating');
  });

  it('sets sortBy to null (toggle off) when "rating" is already active', () => {
    const t = makeTrackers();
    handleSortChipPress('rating', true, FILTERS_RATING_ACTIVE, t.onChange);
    assert.equal(t.onChangeLastFilters?.sortBy, null);
  });

  it('preserves other filter fields when activating "rating"', () => {
    const t = makeTrackers();
    const filters: SortChipFilters = { radiusKm: 25, openNow: true, minRating: 4, sortBy: null };
    handleSortChipPress('rating', false, filters, t.onChange);
    assert.equal(t.onChangeLastFilters?.radiusKm, 25);
    assert.equal(t.onChangeLastFilters?.openNow, true);
    assert.equal(t.onChangeLastFilters?.minRating, 4);
    assert.equal(t.onChangeLastFilters?.sortBy, 'rating');
  });

  it('preserves other filter fields when deactivating "rating"', () => {
    const t = makeTrackers();
    const filters: SortChipFilters = { radiusKm: 25, openNow: true, minRating: 4, sortBy: 'rating' };
    handleSortChipPress('rating', true, filters, t.onChange);
    assert.equal(t.onChangeLastFilters?.radiusKm, 25);
    assert.equal(t.onChangeLastFilters?.openNow, true);
    assert.equal(t.onChangeLastFilters?.minRating, 4);
    assert.equal(t.onChangeLastFilters?.sortBy, null);
  });
});

// ── "popular" chip ────────────────────────────────────────────────────────────

describe('handleSortChipPress — "popular" chip', () => {
  it('always calls onChange (no location guard)', () => {
    const t = makeTrackers();
    handleSortChipPress('popular', false, BASE_FILTERS, t.onChange);
    assert.equal(t.onChangeCallCount, 1);
  });

  it('sets sortBy to "popular" when the chip is not yet active', () => {
    const t = makeTrackers();
    handleSortChipPress('popular', false, BASE_FILTERS, t.onChange);
    assert.equal(t.onChangeLastFilters?.sortBy, 'popular');
  });

  it('sets sortBy to null (toggle off) when "popular" is already active', () => {
    const t = makeTrackers();
    handleSortChipPress('popular', true, FILTERS_POPULAR_ACTIVE, t.onChange);
    assert.equal(t.onChangeLastFilters?.sortBy, null);
  });

  it('preserves other filter fields when activating "popular"', () => {
    const t = makeTrackers();
    const filters: SortChipFilters = { radiusKm: 15, openNow: false, minRating: 3, sortBy: null };
    handleSortChipPress('popular', false, filters, t.onChange);
    assert.equal(t.onChangeLastFilters?.radiusKm, 15);
    assert.equal(t.onChangeLastFilters?.openNow, false);
    assert.equal(t.onChangeLastFilters?.minRating, 3);
    assert.equal(t.onChangeLastFilters?.sortBy, 'popular');
  });

  it('preserves other filter fields when deactivating "popular"', () => {
    const t = makeTrackers();
    const filters: SortChipFilters = { radiusKm: 15, openNow: false, minRating: 3, sortBy: 'popular' };
    handleSortChipPress('popular', true, filters, t.onChange);
    assert.equal(t.onChangeLastFilters?.radiusKm, 15);
    assert.equal(t.onChangeLastFilters?.openNow, false);
    assert.equal(t.onChangeLastFilters?.minRating, 3);
    assert.equal(t.onChangeLastFilters?.sortBy, null);
  });
});

// ── Cross-chip: switching from one sort to another ────────────────────────────

describe('handleSortChipPress — switching between sort chips', () => {
  it('replaces "rating" with "popular" when "popular" is pressed while "rating" is active', () => {
    const t = makeTrackers();
    const filters: SortChipFilters = { ...BASE_FILTERS, sortBy: 'rating' };
    handleSortChipPress('popular', false, filters, t.onChange);
    assert.equal(t.onChangeLastFilters?.sortBy, 'popular');
  });

  it('replaces "popular" with "rating" when "rating" is pressed while "popular" is active', () => {
    const t = makeTrackers();
    const filters: SortChipFilters = { ...BASE_FILTERS, sortBy: 'popular' };
    handleSortChipPress('rating', false, filters, t.onChange);
    assert.equal(t.onChangeLastFilters?.sortBy, 'rating');
  });

  it('calls onChange exactly once per press when switching chips', () => {
    const t = makeTrackers();
    const filters: SortChipFilters = { ...BASE_FILTERS, sortBy: 'rating' };
    handleSortChipPress('popular', false, filters, t.onChange);
    assert.equal(t.onChangeCallCount, 1);
  });
});
