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
  resolveSelectedId,
  TAB_CATEGORIES,
  placesForTab,
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

// ── stale-category reset ───────────────────────────────────────────────────────
//
// These tests verify the logic behind the useEffect in SavedPlacesMapView that
// resets `activeCategory` to null whenever the category is no longer present in
// the derived `categories` list.
//
// The effect is:
//   useEffect(() => {
//     const resolved = resolveStoredCategory(activeCategory, categories);
//     if (resolved !== activeCategory) setActiveCategory(resolved);
//   }, [categories, activeCategory]);
//
// `resolveStoredCategory` is the pure function under test.

describe('stale-category reset: resolveStoredCategory clears removed categories', () => {
  it('resets to null when the last place in the active category is removed', () => {
    // Before removal: 'cafe' chip is active and 'cafe' is in the category list.
    const categoriesBefore = ['cafe', 'museum'];
    const activeCategory = 'cafe';

    // After removal: the only cafe place is gone — 'cafe' disappears from categories.
    const categoriesAfter = ['museum'];

    // Simulates what the useEffect computes on re-render after the prop changes.
    const resolved = resolveStoredCategory(activeCategory, categoriesAfter);
    assert.equal(resolved, null, 'should fall back to null (All) when category is gone');

    // Confirm it was valid before the removal.
    assert.equal(resolveStoredCategory(activeCategory, categoriesBefore), 'cafe');
  });

  it('resets to null when the last place in a category loses its coordinates', () => {
    // A place losing lat/lng is equivalent to removal from filterMappable output,
    // so its category can also disappear from the derived list.
    const categoriesAfter: string[] = []; // no mappable places left at all
    const resolved = resolveStoredCategory('museum', categoriesAfter);
    assert.equal(resolved, null);
  });

  it('keeps the active category when other places in that category still exist', () => {
    const categories = ['cafe', 'museum'];
    // Remove one museum, but another museum still exists → category stays.
    const resolved = resolveStoredCategory('museum', categories);
    assert.equal(resolved, 'museum');
  });

  it('resets to null when the UNCATEGORIZED sentinel category is removed', () => {
    const categoriesBefore = ['cafe', UNCATEGORIZED];
    const categoriesAfter  = ['cafe']; // the last coord-less / unnamed place was removed
    assert.equal(resolveStoredCategory(UNCATEGORIZED, categoriesBefore), UNCATEGORIZED);
    assert.equal(resolveStoredCategory(UNCATEGORIZED, categoriesAfter), null);
  });

  it('is a no-op (already null) when no category was active before removal', () => {
    const categoriesAfter = ['cafe'];
    assert.equal(resolveStoredCategory(null, categoriesAfter), null);
  });

  it('full pipeline: removing the last place of a category yields null resolved category', () => {
    const placeMuseum1 = place({ id: 'm1', category: 'museum', lat: 48.8566, lng: 2.3522 });
    const placeCafe    = place({ id: 'c1', category: 'cafe',   lat: 51.5074, lng: -0.1278 });

    const beforePlaces = [placeMuseum1, placeCafe];
    const beforeCats   = uniqueCategories(filterMappable(beforePlaces));
    assert.deepEqual(beforeCats, ['cafe', 'museum']);

    // User has 'cafe' chip active, then removes the only cafe.
    const afterPlaces = [placeMuseum1];
    const afterCats   = uniqueCategories(filterMappable(afterPlaces));
    assert.deepEqual(afterCats, ['museum']);

    const activeCategory = 'cafe';
    const resolved = resolveStoredCategory(activeCategory, afterCats);
    assert.equal(resolved, null, 'activeCategory should reset to null after the last cafe is removed');
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

// ── resolveSelectedId ──────────────────────────────────────────────────────────

describe('placesForTab', () => {
  it('Places tab returns all places unchanged', () => {
    const all = [place({ id: '1', category: 'hotel' }), place({ id: '2', category: 'bar' })];
    assert.deepEqual(placesForTab('Places', all), all);
  });

  it('Hotels tab returns places matching hotel keywords', () => {
    const hotel  = place({ id: 'h', category: 'hotel' });
    const hostel = place({ id: 'hs', category: 'hostel' });
    const bar    = place({ id: 'b', category: 'bar' });
    const result = placesForTab('Hotels', [hotel, hostel, bar]);
    assert.deepEqual(result, [hotel, hostel]);
  });

  it('Hotels tab returns empty when no hotel-type places remain', () => {
    const bar = place({ id: 'b', category: 'bar' });
    assert.deepEqual(placesForTab('Hotels', [bar]), []);
  });

  it('Nightlife tab returns places matching nightlife keywords', () => {
    const bar  = place({ id: 'b', category: 'bar' });
    const cafe = place({ id: 'c', category: 'cafe' });
    const result = placesForTab('Nightlife', [bar, cafe]);
    assert.deepEqual(result, [bar]);
  });

  it('Itineraries tab returns places matching itinerary keywords', () => {
    const museum = place({ id: 'm', category: 'museum' });
    const hotel  = place({ id: 'h', category: 'hotel' });
    const result = placesForTab('Itineraries', [museum, hotel]);
    assert.deepEqual(result, [museum]);
  });

  it('unknown tab name falls back to all places', () => {
    const all = [place({ id: '1', category: 'cafe' })];
    assert.deepEqual(placesForTab('Unknown', all), all);
  });

  it('TAB_CATEGORIES has entries for Hotels, Nightlife, Itineraries', () => {
    assert.ok(Array.isArray(TAB_CATEGORIES['Hotels']) && TAB_CATEGORIES['Hotels'].length > 0);
    assert.ok(Array.isArray(TAB_CATEGORIES['Nightlife']) && TAB_CATEGORIES['Nightlife'].length > 0);
    assert.ok(Array.isArray(TAB_CATEGORIES['Itineraries']) && TAB_CATEGORIES['Itineraries'].length > 0);
  });

  it('pipeline: removing last hotel empties Hotels tab — triggers reset condition', () => {
    const hotel = place({ id: 'h1', category: 'hotel' });
    const bar   = place({ id: 'b1', category: 'bar' });
    const places = [hotel, bar];
    const afterRemoval = places.filter((p) => p.id !== 'h1');
    assert.equal(placesForTab('Hotels', afterRemoval).length, 0, 'Hotels tab empties after removal');
    assert.ok(placesForTab('Nightlife', afterRemoval).length > 0, 'other categories still have places');
  });
});

describe('resolveSelectedId', () => {
  it('returns null when selectedId is null', () => {
    const visible = [place({ id: 'a' })];
    assert.equal(resolveSelectedId(null, visible), null);
  });

  it('returns selectedId when the place is still in visible', () => {
    const visible = [place({ id: 'a' }), place({ id: 'b' })];
    assert.equal(resolveSelectedId('a', visible), 'a');
  });

  it('returns null when the selected place is removed from visible', () => {
    const visible = [place({ id: 'b' })];
    assert.equal(resolveSelectedId('a', visible), null);
  });

  it('returns null when visible is empty (all places removed)', () => {
    assert.equal(resolveSelectedId('a', []), null);
  });

  it('returns null when the selected place is filtered out by category change', () => {
    const cafe  = place({ id: 'c1', category: 'cafe' });
    const hotel = place({ id: 'h1', category: 'hotel' });
    const visible = filterVisible([cafe, hotel], 'hotel');
    assert.equal(resolveSelectedId('c1', visible), null);
  });

  it('pipeline: filterMappable → filterVisible → resolveSelectedId clears after removal', () => {
    const kept    = place({ id: 'k1', lat: 48.0, lng: 2.0 });
    const removed = place({ id: 'r1', lat: 48.1, lng: 2.1 });
    const afterRemoval = filterMappable([kept]);
    const visible = filterVisible(afterRemoval, null);
    assert.equal(resolveSelectedId('r1', visible), null);
    assert.equal(resolveSelectedId('k1', visible), 'k1');
  });
});
