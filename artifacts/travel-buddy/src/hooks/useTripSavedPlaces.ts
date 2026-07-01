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
  type BookmarkedPlace,
} from '../services/discoveryBookmarks';

export interface UseTripSavedPlacesResult {
  places: BookmarkedPlace[];
  loading: boolean;
  toggle: (place: BookmarkedPlace) => Promise<boolean>;
  refresh: () => void;
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

  return { places, loading, toggle, refresh: load };
}
