/**
 * useTripSavedPlaces — trip-scoped wrapper around the discoveryBookmarks store.
 *
 * Exposes the full saved-places list and a `toggle` function that passes the
 * trip's id as the `listId` to `toggleSave`. This ensures that when the last
 * place is removed the category-filter key scoped to THIS trip is cleared,
 * rather than the default global key.
 *
 * Usage:
 *   const { places, toggle, remove, loading, refresh } = useTripSavedPlaces(tripId);
 *   // In the map view:
 *   <SavedPlacesMapView places={places} listId={tripId} onPlanRoute={...} />
 *   // Optimistic single-item remove (X button):
 *   await remove(place); // throws 'remove_failed' on storage error
 *   // Full toggle:
 *   await toggle(place); // clears categoryStorageKey(tripId) when list empties
 */
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  listSaved,
  toggleSave,
  removeSavedFromList,
  clearAllSaved,
  type BookmarkedPlace,
} from '../services/discoveryBookmarks';

export interface UseTripSavedPlacesResult {
  places: BookmarkedPlace[];
  loading: boolean;
  toggle: (place: BookmarkedPlace) => Promise<boolean>;
  refresh: () => void;
  /** Optimistically removes a single place from the list immediately.
   *  Rolls back and rethrows as 'remove_failed' if removeSaved fails,
   *  so the caller can show an error to the user. */
  remove: (place: BookmarkedPlace) => Promise<void>;
  /** Optimistically clears all saved places. Rolls back and throws if the
   *  storage call fails so the caller can surface an error to the user. */
  clearAll: () => Promise<void>;
}

export function useTripSavedPlaces(tripId: string): UseTripSavedPlacesResult {
  const [places, setPlaces] = useState<BookmarkedPlace[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    listSaved()
      .then((all) => { setPlaces(all); setLoading(false); })
      .catch(() => { setLoading(false); });
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggle = useCallback(
    async (place: BookmarkedPlace): Promise<boolean> => {
      // Pass tripId as the listId so that when the last saved place is removed,
      // categoryStorageKey(tripId) is cleared instead of the default 'global' key.
      const { added: nowSaved } = await toggleSave(place, tripId);
      // Refresh the list so the UI reflects the new state.
      load();
      return nowSaved;
    },
    [tripId, load],
  );

  const remove = useCallback(async (place: BookmarkedPlace): Promise<void> => {
    const snapshot = places;
    // Optimistic: drop the place from the list immediately so the UI responds
    // before the storage write completes.
    setPlaces((prev) => prev.filter((p) => p.id !== place.id));
    try {
      // removeSavedFromList reads/writes directly (no silent-catch helpers) so
      // any AsyncStorage failure propagates here and triggers the rollback.
      // It is also scoped to tripId so it leaves the same place intact in other
      // trip lists (unlike the global removeSaved).
      await removeSavedFromList(place.id, tripId);
    } catch {
      // Rollback so the item reappears and the caller can surface an error.
      setPlaces(snapshot);
      throw new Error('remove_failed');
    }
  }, [places, tripId]);

  const clearAll = useCallback(async (): Promise<void> => {
    const snapshot = places;
    // Optimistic: empty the list immediately so the UI responds instantly.
    setPlaces([]);
    try {
      await clearAllSaved();
    } catch {
      // Rollback so the caller can surface an error.
      setPlaces(snapshot);
      throw new Error('clear_failed');
    }
  }, [places]);

  return { places, loading, toggle, remove, refresh: load, clearAll };
}
