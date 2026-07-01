/**
 * useTripSavedPlaces — trip-scoped wrapper around the discoveryBookmarks store.
 *
 * Exposes the full saved-places list and a `toggle` function that passes the
 * trip's id as the `listId` to `toggleSave`. This ensures that when the last
 * place is removed the category-filter key scoped to THIS trip is cleared,
 * rather than the default global key.
 *
 * Usage:
 *   const { places, toggle, loading, refresh } = useTripSavedPlaces(tripId);
 *   // In the map view:
 *   <SavedPlacesMapView places={places} listId={tripId} onPlanRoute={...} />
 *   // On remove:
 *   await toggle(place); // clears categoryStorageKey(tripId) when list empties
 */
import { useCallback, useEffect, useState } from 'react';
import {
  listSaved,
  toggleSave,
  clearAllSaved,
  type BookmarkedPlace,
} from '../services/discoveryBookmarks';

export interface UseTripSavedPlacesResult {
  places: BookmarkedPlace[];
  loading: boolean;
  toggle: (place: BookmarkedPlace) => Promise<boolean>;
  refresh: () => void;
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

  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(
    async (place: BookmarkedPlace): Promise<boolean> => {
      // Pass tripId as the listId so that when the last saved place is removed,
      // categoryStorageKey(tripId) is cleared instead of the default 'global' key.
      const nowSaved = await toggleSave(place, tripId);
      // Refresh the list so the UI reflects the new state.
      load();
      return nowSaved;
    },
    [tripId, load],
  );

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

  return { places, loading, toggle, refresh: load, clearAll };
}
