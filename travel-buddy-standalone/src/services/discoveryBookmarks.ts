/**
 * Discovery bookmarks — persists saved places locally via AsyncStorage.
 * Each saved place is stored by its OSM id so duplicates are prevented.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StorageLike } from '../components/savedPlacesMapFilterStorage';

const STORAGE_KEY = 'discovery_bookmarks_v1';

// The per-list category filter key for the global bookmark list.
// Must stay in sync with CATEGORY_STORAGE_PREFIX + 'global' in
// savedPlacesMapFilterStorage.ts.
const GLOBAL_FILTER_KEY = 'saved_places_map_cat_v1_global';

export interface BookmarkedPlace {
  id: string;
  name: string;
  category: string;
  type: string | null;
  address: string | null;
  savedAt: number;
  lat?: number | null;
  lng?: number | null;
}

// ── Test seam ──────────────────────────────────────────────────────────────────
// Production code always uses AsyncStorage. Tests call _setTestStorage() to
// inject a fake so the native module is never required.
let _storage: StorageLike = AsyncStorage;
export function _setTestStorage(s: StorageLike): void {
  _storage = s;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function readAll(): Promise<BookmarkedPlace[]> {
  try {
    const raw = await _storage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BookmarkedPlace[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(items: BookmarkedPlace[]): Promise<void> {
  try {
    await _storage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // silently fail — non-critical
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function isSaved(id: string): Promise<boolean> {
  const all = await readAll();
  return all.some((b) => b.id === id);
}

export async function toggleSave(place: BookmarkedPlace): Promise<boolean> {
  const all = await readAll();
  const idx = all.findIndex((b) => b.id === place.id);
  if (idx >= 0) {
    // remove
    all.splice(idx, 1);
    await writeAll(all);
    return false; // now unsaved
  } else {
    // add
    all.unshift({ ...place, savedAt: Date.now() });
    await writeAll(all);
    return true; // now saved
  }
}

export async function listSaved(): Promise<BookmarkedPlace[]> {
  const all = await readAll();
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

export async function removeSaved(id: string): Promise<void> {
  // Read and write directly — bypassing the silent-catch helpers — so that
  // any AsyncStorage failure propagates to the caller. The saved.tsx
  // handleRemove relies on a rejected promise to trigger its optimistic
  // rollback and error toast.
  const raw = await _storage.getItem(STORAGE_KEY);
  const all: BookmarkedPlace[] = raw ? (JSON.parse(raw) as BookmarkedPlace[]) : [];
  const remaining = all.filter((b) => b.id !== id);
  await _storage.setItem(STORAGE_KEY, JSON.stringify(remaining));

  // When the last place is removed, the category-filter key for the global
  // bookmark list becomes stale. Clear it as a fire-and-forget cleanup so
  // keys don't accumulate across place-by-place removals.
  if (remaining.length === 0) {
    _storage.removeItem(GLOBAL_FILTER_KEY).catch(() => {});
  }
}
