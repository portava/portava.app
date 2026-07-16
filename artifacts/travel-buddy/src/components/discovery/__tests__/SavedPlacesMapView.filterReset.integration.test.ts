/**
 * Integration tests — SavedPlacesMapView category-filter reset flow.
 *
 * These tests exercise the full mid-session removal chain that pure unit tests
 * cannot cover: the loop from "user selects a category" → "last place in that
 * category is removed" → "storage cleared" → "component remounts" → "chip
 * shows All, not the stale category".
 *
 * Each layer is exercised via its real function rather than a mock so that
 * a regression in any link of the chain causes a failure here.
 *
 * Layers exercised end-to-end:
 *   saveCategoryFilter      — persists the selected chip to storage
 *   toggleSave              — removes the place and clears the filter key
 *                             when the list empties (trip-scoped listId)
 *   readRawCategoryFilter   — the mount-restore read path
 *   resolveStoredCategory   — the useMemo that computes effectiveCategory
 *   uniqueCategories        — derives the live category list after removal
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/components/discovery/__tests__/SavedPlacesMapView.filterReset.integration.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { toggleSave, _setTestStorage } from '../../../services/discoveryBookmarks.ts';
import {
  categoryStorageKey,
  saveCategoryFilter,
  readRawCategoryFilter,
} from '../../savedPlacesMapFilterStorage.ts';
import {
  filterMappable,
  uniqueCategories,
  resolveStoredCategory,
} from '../../savedPlacesMapHelpers.ts';
import type { BookmarkedPlace } from '../../../services/discoveryBookmarks.ts';

// ── Fake storage ───────────────────────────────────────────────────────────────

interface FakeStorage {
  store: Map<string, string>;
  removedKeys: string[];
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function makeFakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const store = new Map<string, string>(Object.entries(initial));
  const removedKeys: string[] = [];
  return {
    store,
    removedKeys,
    getItem: (key) => Promise.resolve(store.get(key) ?? null),
    setItem: (key, value) => { store.set(key, value); return Promise.resolve(); },
    removeItem: (key) => { store.delete(key); removedKeys.push(key); return Promise.resolve(); },
  };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

const TRIP_ID = 'trip-integration-test-001';
const TRIP_FILTER_KEY = categoryStorageKey(TRIP_ID);
const BOOKMARKS_KEY = 'discovery_bookmarks_v1';

function makePlace(id: string, category: string, withCoords = true): BookmarkedPlace {
  return {
    id,
    name: `Place ${id}`,
    category,
    type: null,
    address: null,
    savedAt: Date.now(),
    lat: withCoords ? 48.8566 : null,
    lng: withCoords ? 2.3522 : null,
    // Entries saved from a trip screen are tagged with the trip's listId —
    // toggleSave matches by (id, listId), and untagged (legacy v1) entries
    // belong to the 'global' list, not the trip list.
    listId: TRIP_ID,
  };
}

// ── Flow 1: mid-session removal resets chip to "All" ──────────────────────────

describe('mid-session removal — effectiveCategory resets to null (All)', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = makeFakeStorage();
    _setTestStorage(storage);
  });

  it('removing the last place in the active category yields effectiveCategory=null', async () => {
    // Arrange: two places — one "Restaurants", one "food"
    const restaurantPlace = makePlace('r-1', 'Restaurants');
    const foodPlace = makePlace('f-1', 'food');
    storage.store.set(
      BOOKMARKS_KEY,
      JSON.stringify([restaurantPlace, foodPlace]),
    );

    // Simulate: user taps the "Restaurants" chip
    // (handleCategoryChange calls saveCategoryFilter)
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'Restaurants');
    // Give the fire-and-forget write a tick to settle
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.store.get(TRIP_FILTER_KEY), 'Restaurants');

    // Act: user removes the last "Restaurants" place
    // (useTripSavedPlaces.toggle calls toggleSave(place, tripId))
    await toggleSave(restaurantPlace, TRIP_ID);

    // The remaining list after removal
    const remaining = [foodPlace];
    const mappable = filterMappable(remaining);
    const newCategories = uniqueCategories(mappable);

    // "Restaurants" is gone from the live categories
    assert.ok(!newCategories.includes('Restaurants'), '"Restaurants" must not appear in categories after removal');
    assert.ok(newCategories.includes('food'), '"food" must still be in categories');

    // resolveStoredCategory is what SavedPlacesMapView uses in its useMemo
    // to compute effectiveCategory.  The activeCategory state still holds
    // 'Restaurants' (it hasn't been cleared by a re-render yet), but the
    // useMemo must resolve it to null because 'Restaurants' is no longer valid.
    const effectiveCategory = resolveStoredCategory('Restaurants', newCategories);
    assert.equal(effectiveCategory, null, 'effectiveCategory must be null — chip should show "All"');
  });

  it('storage key is cleared immediately after removing the last place', async () => {
    const restaurantPlace = makePlace('r-2', 'Restaurants');
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([restaurantPlace]));
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'Restaurants');
    await new Promise((r) => setImmediate(r));

    await toggleSave(restaurantPlace, TRIP_ID);

    assert.ok(
      storage.removedKeys.includes(TRIP_FILTER_KEY),
      `expected removeItem(${TRIP_FILTER_KEY}) — got: ${JSON.stringify(storage.removedKeys)}`,
    );
    assert.equal(storage.store.get(TRIP_FILTER_KEY), undefined, 'filter key must be absent from storage');
  });

  it('non-trip "global" key is not touched when a trip-scoped listId is used', async () => {
    const globalFilterKey = categoryStorageKey('global');
    const restaurantPlace = makePlace('r-3', 'Restaurants');
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([restaurantPlace]));
    storage.store.set(globalFilterKey, 'food');
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'Restaurants');
    await new Promise((r) => setImmediate(r));

    await toggleSave(restaurantPlace, TRIP_ID);

    assert.equal(
      storage.store.get(globalFilterKey),
      'food',
      'global filter key must be untouched when a trip listId is used',
    );
  });

  it('effectiveCategory stays at the selected value when other places in that category remain', async () => {
    const r1 = makePlace('r-4a', 'Restaurants');
    const r2 = makePlace('r-4b', 'Restaurants');
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([r1, r2]));
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'Restaurants');
    await new Promise((r) => setImmediate(r));

    // Remove only ONE of the two "Restaurants" places
    await toggleSave(r1, TRIP_ID);

    const remaining = [r2];
    const mappable = filterMappable(remaining);
    const newCategories = uniqueCategories(mappable);

    assert.ok(newCategories.includes('Restaurants'), '"Restaurants" must still be in categories');
    const effectiveCategory = resolveStoredCategory('Restaurants', newCategories);
    assert.equal(effectiveCategory, 'Restaurants', 'chip must remain on "Restaurants" while places exist');

    // Storage key must NOT be cleared because places remain
    assert.ok(
      !storage.removedKeys.includes(TRIP_FILTER_KEY),
      'filter key must not be cleared while places remain',
    );
  });
});

// ── Flow 2: remount after removal — storage cleared, chip restores to "All" ───

describe('remount after removal — mount-restore path returns null', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = makeFakeStorage();
    _setTestStorage(storage);
  });

  it('readRawCategoryFilter returns null after the key was cleared by removal', async () => {
    // Arrange: pre-seed as if user had "Restaurants" active before this session
    const restaurantPlace = makePlace('r-5', 'Restaurants');
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([restaurantPlace]));
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'Restaurants');
    await new Promise((r) => setImmediate(r));

    // Act: user removes the last place — this clears the storage key
    await toggleSave(restaurantPlace, TRIP_ID);

    // Simulate a component remount: the useEffect calls readRawCategoryFilter
    // on the now-empty storage
    const raw = await readRawCategoryFilter(storage, TRIP_FILTER_KEY);
    assert.equal(raw, null, 'mount-restore path must return null after key was cleared');

    // resolveStoredCategory with null raw → effectiveCategory = null → chip = "All"
    const effectiveCategory = resolveStoredCategory(raw, []);
    assert.equal(effectiveCategory, null, 'effectiveCategory must be null on remount after removal');
  });

  it('stale category in storage (from a previous session) is rejected by resolveStoredCategory on remount', async () => {
    // Simulate: a category key lingered in storage from an old session but the
    // place no longer exists in the current list (e.g., the user cleared the
    // wishlist on another device).  The mount-restore path must NOT apply it.
    storage.store.set(TRIP_FILTER_KEY, 'Restaurants'); // stale

    const raw = await readRawCategoryFilter(storage, TRIP_FILTER_KEY);
    assert.equal(raw, 'Restaurants'); // raw value is present…

    // …but the categories list has no "Restaurants" (list was cleared elsewhere)
    const currentCategories: string[] = ['food'];
    const effectiveCategory = resolveStoredCategory(raw, currentCategories);
    assert.equal(effectiveCategory, null, 'stale category from storage must be rejected on remount');
  });

  it('valid category survives remount when places in that category still exist', async () => {
    const foodPlace = makePlace('f-6', 'food');
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([foodPlace]));
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'food');
    await new Promise((r) => setImmediate(r));

    // Remount: categories are loaded from the (unchanged) list
    const remaining = [foodPlace];
    const mappable = filterMappable(remaining);
    const currentCategories = uniqueCategories(mappable);

    const raw = await readRawCategoryFilter(storage, TRIP_FILTER_KEY);
    assert.equal(raw, 'food');

    const effectiveCategory = resolveStoredCategory(raw, currentCategories);
    assert.equal(effectiveCategory, 'food', '"food" chip must be restored on remount when places still exist');
  });
});

// ── Flow 3: multi-category list — only the removed category resets ─────────────

describe('multi-category list — removing one category does not disturb the other', () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = makeFakeStorage();
    _setTestStorage(storage);
  });

  it('switching to "food" chip then removing all "Restaurants" leaves food chip intact', async () => {
    const restaurantPlace = makePlace('r-7', 'Restaurants');
    const foodPlace = makePlace('f-7', 'food');
    storage.store.set(BOOKMARKS_KEY, JSON.stringify([restaurantPlace, foodPlace]));

    // User initially selected "Restaurants" then switched to "food"
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'Restaurants');
    await new Promise((r) => setImmediate(r));
    saveCategoryFilter(storage, TRIP_FILTER_KEY, 'food');
    await new Promise((r) => setImmediate(r));
    assert.equal(storage.store.get(TRIP_FILTER_KEY), 'food');

    // User removes the "Restaurants" place while "food" chip is active
    await toggleSave(restaurantPlace, TRIP_ID);

    const remaining = [foodPlace];
    const mappable = filterMappable(remaining);
    const newCategories = uniqueCategories(mappable);

    // "food" chip must still be active
    const effectiveCategory = resolveStoredCategory('food', newCategories);
    assert.equal(effectiveCategory, 'food', '"food" chip must remain active after "Restaurants" place is removed');

    // Storage key must NOT be cleared (list still has the "food" place)
    assert.ok(
      !storage.removedKeys.includes(TRIP_FILTER_KEY),
      'filter key must not be cleared when the list still has places',
    );
  });
});
