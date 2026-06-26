/**
 * Discovery bookmarks — persists saved places locally via AsyncStorage.
 * Each saved place is stored by its OSM id so duplicates are prevented.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'discovery_bookmarks_v1';

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

async function readAll(): Promise<BookmarkedPlace[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BookmarkedPlace[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(items: BookmarkedPlace[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // silently fail — non-critical
  }
}

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
  const all = await readAll();
  await writeAll(all.filter((b) => b.id !== id));
}
