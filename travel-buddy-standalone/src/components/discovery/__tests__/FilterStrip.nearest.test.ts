/**
 * Regression tests for the Nearest sort guard in FilterStrip.
 *
 * Root cause (task-1265): when userLat/userLng were null the sort silently fell
 * back to destination-centre coordinates, producing wrong distance ordering.
 * The fix: tapping Nearest with no user location calls onNearestUnavailable and
 * does NOT propagate the sort change to onChange.
 *
 * These tests target the extracted pure function `handleNearestChipPress` which
 * the FilterStrip component delegates its Nearest onPress to, so any regression
 * that removes or bypasses the guard will be caught here.
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/components/discovery/__tests__/FilterStrip.nearest.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleNearestChipPress } from '../filterStripNearest.ts';
import type { NearestPressFilters as DiscoveryFilters } from '../filterStripNearest.ts';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_FILTERS: DiscoveryFilters = {
  radiusKm: 10,
  openNow: false,
  minRating: null,
  sortBy: null,
};

const FILTERS_NEAREST_ACTIVE: DiscoveryFilters = {
  ...BASE_FILTERS,
  sortBy: 'nearest',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build simple call-count trackers that also capture the last argument
 * so assertions can stay in the test body.
 */
function makeTrackers() {
  let onChangeCallCount = 0;
  let onChangeLastFilters: DiscoveryFilters | null = null;
  let onNearestUnavailableCallCount = 0;

  const onChange = (f: DiscoveryFilters) => {
    onChangeCallCount++;
    onChangeLastFilters = f;
  };

  const onNearestUnavailable = () => {
    onNearestUnavailableCallCount++;
  };

  return {
    onChange,
    onNearestUnavailable,
    get onChangeCallCount() { return onChangeCallCount; },
    get onChangeLastFilters() { return onChangeLastFilters; },
    get onNearestUnavailableCallCount() { return onNearestUnavailableCallCount; },
  };
}

// ── Guard path: location unavailable ─────────────────────────────────────────

describe('handleNearestChipPress — no user location (hasUserLocation=false)', () => {
  it('calls onNearestUnavailable when location is unavailable', () => {
    const t = makeTrackers();
    handleNearestChipPress(false, false, BASE_FILTERS, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onNearestUnavailableCallCount, 1);
  });

  it('does NOT call onChange when location is unavailable', () => {
    const t = makeTrackers();
    handleNearestChipPress(false, false, BASE_FILTERS, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onChangeCallCount, 0);
  });

  it('does NOT call onChange even when Nearest chip is already active', () => {
    const t = makeTrackers();
    handleNearestChipPress(false, true, FILTERS_NEAREST_ACTIVE, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onChangeCallCount, 0);
  });

  it('does not throw when onNearestUnavailable is omitted', () => {
    const t = makeTrackers();
    assert.doesNotThrow(() => {
      handleNearestChipPress(false, false, BASE_FILTERS, t.onChange, undefined);
    });
    assert.equal(t.onChangeCallCount, 0);
  });

  it('does not call onChange when onNearestUnavailable is omitted', () => {
    const t = makeTrackers();
    handleNearestChipPress(false, false, BASE_FILTERS, t.onChange);
    assert.equal(t.onChangeCallCount, 0);
  });
});

// ── Happy path: location available ───────────────────────────────────────────

describe('handleNearestChipPress — location available (hasUserLocation=true)', () => {
  it('calls onChange when location is available', () => {
    const t = makeTrackers();
    handleNearestChipPress(true, false, BASE_FILTERS, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onChangeCallCount, 1);
  });

  it('sets sortBy to "nearest" when Nearest is not yet active', () => {
    const t = makeTrackers();
    handleNearestChipPress(true, false, BASE_FILTERS, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onChangeLastFilters?.sortBy, 'nearest');
  });

  it('sets sortBy to null (toggle off) when Nearest is already active', () => {
    const t = makeTrackers();
    handleNearestChipPress(true, true, FILTERS_NEAREST_ACTIVE, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onChangeLastFilters?.sortBy, null);
  });

  it('preserves other filter fields when activating Nearest', () => {
    const t = makeTrackers();
    const filters: DiscoveryFilters = { radiusKm: 25, openNow: true, minRating: 4, sortBy: null };
    handleNearestChipPress(true, false, filters, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onChangeLastFilters?.radiusKm, 25);
    assert.equal(t.onChangeLastFilters?.openNow, true);
    assert.equal(t.onChangeLastFilters?.minRating, 4);
    assert.equal(t.onChangeLastFilters?.sortBy, 'nearest');
  });

  it('preserves other filter fields when deactivating Nearest', () => {
    const t = makeTrackers();
    const filters: DiscoveryFilters = { radiusKm: 25, openNow: true, minRating: 4, sortBy: 'nearest' };
    handleNearestChipPress(true, true, filters, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onChangeLastFilters?.radiusKm, 25);
    assert.equal(t.onChangeLastFilters?.openNow, true);
    assert.equal(t.onChangeLastFilters?.minRating, 4);
    assert.equal(t.onChangeLastFilters?.sortBy, null);
  });

  it('does NOT call onNearestUnavailable when location is available', () => {
    const t = makeTrackers();
    handleNearestChipPress(true, false, BASE_FILTERS, t.onChange, t.onNearestUnavailable);
    assert.equal(t.onNearestUnavailableCallCount, 0);
  });
});
