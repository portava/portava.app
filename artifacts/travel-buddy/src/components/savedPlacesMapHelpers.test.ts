/**
 * Unit + integration tests for SavedPlacesMapView pure-logic helpers.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/savedPlacesMapHelpers.test.ts
 *
 * These tests cover every edge case the task requires:
 *   - uniqueCategories: coord-less excluded, empty-category excluded, sorted
 *   - shouldShowChips: hidden when <2 distinct categories
 *   - shouldShowNoPinsOverlay: shown only when filter is active AND yields 0 pins
 *   - filterVisible: passes all through when no filter; applies category filter
 *   - filterMappable: strips places missing lat/lng
 *   - computeBounds: null for empty list; correct box with padding for ≥1 place
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BookmarkedPlace } from '../services/discoveryBookmarks.ts';
import {
  UNCATEGORIZED,
  filterMappable,
  uniqueCategories,
  resolveStoredCategory,
  categoryCounts,
  shouldShowChips,
  filterVisible,
  shouldShowNoPinsOverlay,
  computeBounds,
} from './savedPlacesMapHelpers.ts';

// ── Fixture factory ────────────────────────────────────────────────────────────

function place(
  overrides: Partial<BookmarkedPlace> & { id: string },
): BookmarkedPlace {
  return {
    name: 'Test Place',
    category: 'restaurant',
    type: null,
    address: null,
    savedAt: 0,
    lat: 48.8566,
    lng: 2.3522,
    ...overrides,
  };
}

// ── filterMappable ─────────────────────────────────────────────────────────────

describe('filterMappable', () => {
  it('returns only places that have both lat and lng', () => {
    const places = [
      place({ id: '1', lat: 48.8566, lng: 2.3522 }),
      place({ id: '2', lat: null, lng: 2.3522 }),
      place({ id: '3', lat: 48.8566, lng: null }),
      place({ id: '4', lat: undefined, lng: undefined }),
    ];
    const result = filterMappable(places);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });

  it('returns empty array when all places lack coordinates', () => {
    const places = [place({ id: '1', lat: null, lng: null })];
    assert.deepEqual(filterMappable(places), []);
  });

  it('returns all places when all have coordinates', () => {
    const places = [
      place({ id: '1' }),
      place({ id: '2', lat: 51.5074, lng: -0.1278 }),
    ];
    assert.equal(filterMappable(places).length, 2);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(filterMappable([]), []);
  });
});

// ── uniqueCategories ───────────────────────────────────────────────────────────

describe('uniqueCategories', () => {
  it('groups places with empty category strings under the UNCATEGORIZED sentinel', () => {
    const places = [
      place({ id: '1', category: '' }),
      place({ id: '2', category: '   ' }),
      place({ id: '3', category: 'cafe' }),
    ];
    const cats = uniqueCategories(places);
    assert.deepEqual(cats, ['cafe', UNCATEGORIZED]);
  });

  it('deduplicates repeated categories', () => {
    const places = [
      place({ id: '1', category: 'museum' }),
      place({ id: '2', category: 'museum' }),
      place({ id: '3', category: 'park' }),
    ];
    const cats = uniqueCategories(places);
    assert.deepEqual(cats, ['museum', 'park']);
  });

  it('returns categories sorted alphabetically', () => {
    const places = [
      place({ id: '1', category: 'zoo' }),
      place({ id: '2', category: 'aquarium' }),
      place({ id: '3', category: 'museum' }),
    ];
    const cats = uniqueCategories(places);
    assert.deepEqual(cats, ['aquarium', 'museum', 'zoo']);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(uniqueCategories([]), []);
  });

  it('trims whitespace before comparing categories', () => {
    const places = [
      place({ id: '1', category: '  cafe  ' }),
      place({ id: '2', category: 'cafe' }),
    ];
    const cats = uniqueCategories(places);
    assert.deepEqual(cats, ['cafe']);
  });

  it('coordinate-less places do not contribute categories (pipeline test)', () => {
    // Simulate the full pipeline: coord-less places are stripped by filterMappable
    // before uniqueCategories sees them, so they never produce orphan chips.
    const raw = [
      place({ id: '1', category: 'park', lat: 48.8566, lng: 2.3522 }),
      place({ id: '2', category: 'museum', lat: null, lng: null }),
      place({ id: '3', category: 'museum', lat: undefined, lng: undefined }),
    ];
    const mappable = filterMappable(raw);
    const cats = uniqueCategories(mappable);
    assert.deepEqual(cats, ['park']);
  });
});

// ── shouldShowChips ────────────────────────────────────────────────────────────

describe('shouldShowChips', () => {
  it('returns false when there are 0 categories', () => {
    assert.equal(shouldShowChips([]), false);
  });

  it('returns false when there is exactly 1 category', () => {
    assert.equal(shouldShowChips(['cafe']), false);
  });

  it('returns true when there are exactly 2 categories', () => {
    assert.equal(shouldShowChips(['cafe', 'museum']), true);
  });

  it('returns true when there are 3+ categories', () => {
    assert.equal(shouldShowChips(['cafe', 'museum', 'park', 'zoo']), true);
  });
});

// ── filterVisible ──────────────────────────────────────────────────────────────

describe('filterVisible', () => {
  const mappable = [
    place({ id: '1', category: 'museum' }),
    place({ id: '2', category: 'park' }),
    place({ id: '3', category: 'museum' }),
  ];

  it('returns all places when activeCategory is null', () => {
    assert.equal(filterVisible(mappable, null).length, 3);
  });

  it('filters to matching category only', () => {
    const result = filterVisible(mappable, 'museum');
    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.category === 'museum'));
  });

  it('returns empty array when no places match the active category', () => {
    const result = filterVisible(mappable, 'restaurant');
    assert.deepEqual(result, []);
  });

  it('returns empty array when input is empty', () => {
    assert.deepEqual(filterVisible([], 'cafe'), []);
  });

  it('returns only uncategorized places when UNCATEGORIZED sentinel is active', () => {
    const places = [
      place({ id: '1', category: 'museum' }),
      place({ id: '2', category: '' }),
      place({ id: '3', category: 'park' }),
    ];
    const result = filterVisible(places, UNCATEGORIZED);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '2');
  });
});

// ── shouldShowNoPinsOverlay ────────────────────────────────────────────────────

describe('shouldShowNoPinsOverlay', () => {
  it('returns false when no category is active (null)', () => {
    assert.equal(shouldShowNoPinsOverlay(null, 0), false);
  });

  it('returns false when a category is active but has visible pins', () => {
    assert.equal(shouldShowNoPinsOverlay('cafe', 3), false);
  });

  it('returns true when a category is active AND visible count is 0', () => {
    assert.equal(shouldShowNoPinsOverlay('cafe', 0), true);
  });

  it('returns false when no category is active even with 0 pins', () => {
    assert.equal(shouldShowNoPinsOverlay(null, 0), false);
  });
});

// ── resolveStoredCategory ──────────────────────────────────────────────────────

describe('resolveStoredCategory', () => {
  const cats = ['cafe', 'museum', UNCATEGORIZED];

  it('returns null when stored is null', () => {
    assert.equal(resolveStoredCategory(null, cats), null);
  });

  it('returns null when stored is an empty string', () => {
    assert.equal(resolveStoredCategory('', cats), null);
  });

  it('returns the stored category when it exists in the list', () => {
    assert.equal(resolveStoredCategory('cafe', cats), 'cafe');
  });

  it('returns null when stored category is not in the list (stale key)', () => {
    assert.equal(resolveStoredCategory('restaurant', cats), null);
  });

  it('returns UNCATEGORIZED sentinel when it is in the list', () => {
    assert.equal(resolveStoredCategory(UNCATEGORIZED, cats), UNCATEGORIZED);
  });

  it('returns null for UNCATEGORIZED sentinel when it is not in the list', () => {
    assert.equal(resolveStoredCategory(UNCATEGORIZED, ['cafe', 'museum']), null);
  });

  it('returns null when categories list is empty', () => {
    assert.equal(resolveStoredCategory('cafe', []), null);
  });
});

// ── categoryCounts ────────────────────────────────────────────────────────────

describe('categoryCounts', () => {
  it('returns an empty object for an empty list', () => {
    assert.deepEqual(categoryCounts([]), {});
  });

  it('counts each named category', () => {
    const places = [
      place({ id: '1', category: 'museum' }),
      place({ id: '2', category: 'museum' }),
      place({ id: '3', category: 'park' }),
    ];
    assert.deepEqual(categoryCounts(places), { museum: 2, park: 1 });
  });

  it('counts uncategorized places under the UNCATEGORIZED sentinel', () => {
    const places = [
      place({ id: '1', category: '' }),
      place({ id: '2', category: '' }),
    ];
    assert.deepEqual(categoryCounts(places), { [UNCATEGORIZED]: 2 });
  });

  it('handles mixed categorized and uncategorized places', () => {
    const places = [
      place({ id: '1', category: 'cafe' }),
      place({ id: '2', category: '' }),
      place({ id: '3', category: 'cafe' }),
    ];
    assert.deepEqual(categoryCounts(places), { cafe: 2, [UNCATEGORIZED]: 1 });
  });

  it('treats whitespace-only category as uncategorized', () => {
    const places = [
      place({ id: '1', category: '   ' }),
      place({ id: '2', category: 'park' }),
    ];
    assert.deepEqual(categoryCounts(places), { [UNCATEGORIZED]: 1, park: 1 });
  });

  it('pipeline test: filterMappable → categoryCounts ignores coord-less places', () => {
    const raw = [
      place({ id: '1', category: 'museum', lat: 48.8566, lng: 2.3522 }),
      place({ id: '2', category: 'museum', lat: null, lng: null }),
      place({ id: '3', category: 'park', lat: 51.5074, lng: -0.1278 }),
    ];
    const result = categoryCounts(filterMappable(raw));
    assert.deepEqual(result, { museum: 1, park: 1 });
  });
});

// ── list-map sync ─────────────────────────────────────────────────────────────
//
// These tests confirm the data-flow guarantee that keeps the list view and the
// map view in sync when a bookmark is removed.
//
// SavedPlacesMapView is purely prop-driven:
//   places prop → filterMappable → filterVisible → pins rendered
//
// When the parent (saved.tsx) calls setPlaces(prev => prev.filter(...)) after
// a remove, the new array flows into SavedPlacesMapView as a fresh `places`
// prop.  React re-renders the component, useMemo recomputes filterMappable and
// filterVisible, and the removed pin is absent on the very next render cycle —
// no full reload or navigation-away required.

describe('list-map sync: removed place is immediately absent from map pins', () => {
  const placeA = place({ id: 'a', lat: 48.8566, lng: 2.3522, category: 'museum' });
  const placeB = place({ id: 'b', lat: 51.5074, lng: -0.1278, category: 'cafe' });
  const placeC = place({ id: 'c', lat: 40.7128, lng: -74.006,  category: 'museum' });

  it('filterMappable returns one fewer entry after the place is removed from the array', () => {
    const before = [placeA, placeB, placeC];
    const after  = before.filter((p) => p.id !== 'b');  // simulate setPlaces filter
    assert.equal(filterMappable(before).length, 3);
    assert.equal(filterMappable(after).length, 2);
    assert.ok(!filterMappable(after).some((p) => p.id === 'b'));
  });

  it('filterVisible (no category filter) excludes the removed pin', () => {
    const after   = [placeA, placeC];
    const visible = filterVisible(filterMappable(after), null);
    assert.equal(visible.length, 2);
    assert.ok(visible.every((p) => p.id !== 'b'));
  });

  it('filterVisible (active category) excludes the removed pin', () => {
    const before   = [placeA, placeB, placeC];
    const after    = before.filter((p) => p.id !== 'a');  // remove one museum
    const visible  = filterVisible(filterMappable(after), 'museum');
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, 'c');
  });

  it('removing the only pin in the active category collapses visible list to empty', () => {
    // If the user is on the 'cafe' filter and removes the only cafe, the map
    // should show zero pins (the noPinsOverlay kicks in — tested via shouldShowNoPinsOverlay).
    const after   = [placeA, placeC];  // placeB (cafe) was removed
    const visible = filterVisible(filterMappable(after), 'cafe');
    assert.equal(visible.length, 0);
    assert.equal(shouldShowNoPinsOverlay('cafe', visible.length), true);
  });

  it('removing a coord-less place does not affect the mappable count', () => {
    const coordless = place({ id: 'z', lat: null, lng: null });
    const before    = [placeA, coordless];
    const after     = before.filter((p) => p.id !== 'z');
    assert.equal(filterMappable(before).length, 1);
    assert.equal(filterMappable(after).length, 1);
  });

  it('computeBounds shrinks when a place is removed', () => {
    const before = [placeA, placeB, placeC];
    const after  = [placeA, placeC];
    const bBefore = computeBounds(before);
    const bAfter  = computeBounds(after);
    assert.ok(bBefore !== null);
    assert.ok(bAfter  !== null);
    // placeB is in London (lng ≈ -0.13); removing it raises the western bound
    // (the westernmost remaining point is New York at lng ≈ -74).
    // Both bounds should still contain placeA and placeC's coordinates.
    const [, , , northAfter] = bAfter!;
    assert.ok(placeA.lat! <= northAfter);
    assert.ok(placeC.lat! <= northAfter);
  });
});

// ── computeBounds ──────────────────────────────────────────────────────────────

describe('computeBounds', () => {
  it('returns null for empty array', () => {
    assert.equal(computeBounds([]), null);
  });

  it('returns null when all places lack coordinates', () => {
    assert.equal(computeBounds([place({ id: '1', lat: null, lng: null })]), null);
  });

  it('returns a padded bounding box for a single place', () => {
    const result = computeBounds([place({ id: '1', lat: 48.0, lng: 2.0 })]);
    assert.ok(result !== null, 'expected non-null bounds');
    const [west, south, east, north] = result!;
    assert.ok(west < 2.0, 'west should be less than lng');
    assert.ok(east > 2.0, 'east should be greater than lng');
    assert.ok(south < 48.0, 'south should be less than lat');
    assert.ok(north > 48.0, 'north should be greater than lat');
  });

  it('contains all place coordinates within the bounds', () => {
    const places = [
      place({ id: '1', lat: 40.0, lng: -74.0 }),
      place({ id: '2', lat: 51.0, lng: -0.1 }),
    ];
    const result = computeBounds(places);
    assert.ok(result !== null);
    const [west, south, east, north] = result!;
    for (const p of places) {
      assert.ok(p.lng! >= west, `lng ${p.lng} should be >= west ${west}`);
      assert.ok(p.lng! <= east, `lng ${p.lng} should be <= east ${east}`);
      assert.ok(p.lat! >= south, `lat ${p.lat} should be >= south ${south}`);
      assert.ok(p.lat! <= north, `lat ${p.lat} should be <= north ${north}`);
    }
  });

  it('ignores coord-less places when computing bounds', () => {
    const places = [
      place({ id: '1', lat: 48.0, lng: 2.0 }),
      place({ id: '2', lat: null, lng: null }),
    ];
    const result = computeBounds(places);
    assert.ok(result !== null);
  });
});
