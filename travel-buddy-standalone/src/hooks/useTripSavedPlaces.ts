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
 *
 * WP-10 (census-trips §77): the list is the TRIP's, not the device's. When
 * signed in, each load merges this device's saves for the trip into
 * /api/trips/:id/saved-places by decision WP10-D1 (features/trips/savedPlaces/
 * tripSavedPlacesSync.ts: pending until acknowledged, union only, never a
 * lost save) and shows the crew's list. `syncLabel` says when what is shown
 * is less than that: "this device only" when the trip's list could not be
 * read, "N waiting to sync" while saves are pending. Signed out or not
 * configured, the device list is used exactly as before.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  listSaved,
  listLocalSaved,
  toggleSave,
  removeSavedFromList,
  clearAllSaved,
  type BookmarkedPlace,
} from '../services/discoveryBookmarks.ts';
import {
  syncTripSavedPlaces,
  removeTripSavedPlace,
  applyTripSaveToggle,
  type TripSavedPlace,
  type TripSavesSync,
} from '../features/trips/savedPlaces/tripSavedPlacesSync.ts';

export interface UseTripSavedPlacesResult {
  places: BookmarkedPlace[];
  loading: boolean;
  /** Non-null when the saved-places read FAILED. `places: []` alone means the
   *  list is empty; it may not be used to mean the read did not answer. */
  error: string | null;
  toggle: (place: BookmarkedPlace) => Promise<boolean>;
  refresh: () => void;
  /** Optimistically removes a single place from the list immediately.
   *  Rolls back and rethrows as 'remove_failed' if removeSaved fails,
   *  so the caller can show an error to the user. */
  remove: (place: BookmarkedPlace) => Promise<void>;
  /** Optimistically clears all saved places. Rolls back and throws if the
   *  storage call fails so the caller can surface an error to the user. */
  clearAll: () => Promise<void>;
  /** Null when the list shown is the trip's, complete. Otherwise what it is short of, in words. */
  syncLabel: string | null;
}

function isTripSave(p: BookmarkedPlace): p is TripSavedPlace {
  return typeof (p as TripSavedPlace).mine === 'boolean';
}

export function useTripSavedPlaces(tripId: string): UseTripSavedPlacesResult {
  const [places, setPlaces] = useState<BookmarkedPlace[]>([]);
  const [loading, setLoading] = useState(true);
  // `places: []` with `loading: false` is what every consumer renders as "you
  // have not saved anything on this trip". The catch below used to produce
  // exactly that state from a storage read that failed, so a user whose saved
  // places could not be read was told they had none. `error` is the third
  // state, and it is distinct from both.
  const [error, setError] = useState<string | null>(null);

  const [syncLabel, setSyncLabel] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // Read the device's own copy FIRST: listSaved() replaces it with the
    // wishlist server's list, which does not carry a trip save that is still
    // pending (WP10-D1 rule 1).
    listLocalSaved(tripId)
      .catch(() => [] as BookmarkedPlace[])
      .then(async (deviceOnly) => {
        const all = await listSaved(tripId);
        const byId = new Map<string, BookmarkedPlace>();
        for (const p of [...deviceOnly, ...all]) byId.set(p.id, p);
        const sync: TripSavesSync = await syncTripSavedPlaces(tripId, [...byId.values()])
          .catch((e: any) => ({ state: 'unavailable', detail: String(e?.message ?? 'sync failed') }) as TripSavesSync);
        if (sync.state === 'ok') {
          setPlaces(sync.places);
          setSyncLabel(sync.pending > 0 ? `${sync.pending} waiting to sync` : null);
        } else {
          setPlaces(all);
          setSyncLabel(sync.state === 'unavailable' ? 'this device only' : null);
        }
        setLoading(false);
      })
      .catch((e: any) => {
        setPlaces([]);
        setError(e?.message ?? "Couldn't load your saved places.");
        setLoading(false);
      });
  }, [tripId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const toggle = useCallback(
    async (place: BookmarkedPlace): Promise<boolean> => {
      // Pass tripId as the listId so that when the last saved place is removed,
      // categoryStorageKey(tripId) is cleared instead of the default 'global' key.
      const { added: nowSaved } = await toggleSave(place, tripId);
      // Carry it to the trip's list; a save that cannot reach it stays pending.
      await applyTripSaveToggle(tripId, place, nowSaved);
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
      // A save on the trip's list is removed THERE first (own, or any as the
      // owner); the server's refusal rolls back like a storage failure.
      if (isTripSave(place) && place.entryId) {
        const w = await removeTripSavedPlace(tripId, place);
        if (w.state !== 'done') throw new Error(w.state === 'refused' ? w.reason : w.detail);
      }
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
      // This member's saves on the trip's list go too; a crewmate's are theirs.
      for (const p of snapshot) {
        if (isTripSave(p) && p.mine && p.entryId) {
          const w = await removeTripSavedPlace(tripId, p);
          if (w.state !== 'done') throw new Error('clear_failed');
        }
      }
      await clearAllSaved();
    } catch {
      // Rollback so the caller can surface an error.
      setPlaces(snapshot);
      throw new Error('clear_failed');
    }
  }, [places, tripId]);

  return { places, loading, error, toggle, remove, refresh: load, clearAll, syncLabel };
}
