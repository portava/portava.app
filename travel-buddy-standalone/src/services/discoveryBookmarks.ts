/**
 * Discovery bookmarks — persists saved places in Supabase (via the API server)
 * when the user is authenticated, with AsyncStorage as an offline fallback.
 *
 * Write path  : AsyncStorage is updated first (fast, offline-safe), then the
 *               API is called to persist the change to Supabase.
 * Read path   : API is tried first; on failure (network error, unauthenticated,
 *               server down) AsyncStorage is used instead.
 *
 * Storage shape (v2):
 *   Each entry carries a `listId` field so per-trip saves are independent.
 *   The same place can appear in multiple lists (trips); existence checks are
 *   scoped to (id, listId). Legacy v1 entries (no listId) are treated as
 *   belonging to the 'global' list.
 *
 * Test isolation: The supabase module is lazy-loaded inside getAuthToken() so
 * the native @supabase/supabase-js packages are never imported when running
 * node:test in a pure Node.js environment.  Tests that only exercise local
 * storage continue to work unchanged via _setTestStorage().  Tests that want
 * to exercise the API path can call _setTestToken(token) to bypass supabase.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { categoryStorageKey, resolveCategoryStorageKey, type StorageLike } from '../components/savedPlacesMapFilterStorage.ts';
import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';
import { getCurrentAccountId } from './accountId.ts';

const STORAGE_KEY = 'discovery_bookmarks_v1';

const GLOBAL_FILTER_KEY = categoryStorageKey('global');

/**
 * Per-account key, used only when isAccountScopedStorageEnabled() is true.
 * STORAGE_KEY above stays the sole key while the flag is off, so flag-off
 * behavior stays byte-identical.
 */
function scopedBookmarksKey(accountId: string): string {
  return `discovery_bookmarks_scoped_v1:${accountId}`;
}

const migratedAccountIds = new Set<string>();

/** Test seam — clear the migration-attempted cache between test cases. */
export function _resetMigratedBookmarksAccountIds(): void {
  migratedAccountIds.clear();
}

/**
 * One-time migration: attribute the existing unscoped bookmarks blob to
 * whichever account is currently signed in, then delete the legacy key.
 *
 * THIS IS A ONE-TIME BEST GUESS — the legacy storage format has no field
 * identifying which account saved each place, so if two different accounts
 * previously used this device the data is attributed to whichever one
 * happens to be signed in the first time this runs post-upgrade. There is no
 * field anywhere to do better. Unlike reminders, there is no OS-scheduled
 * side effect to clean up here — bookmarks are inert data.
 */
async function migrateLegacyBookmarksIfNeeded(accountId: string): Promise<void> {
  if (migratedAccountIds.has(accountId)) return;
  migratedAccountIds.add(accountId);

  const scopedKey = scopedBookmarksKey(accountId);
  const existingScoped = await _storage.getItem(scopedKey);
  if (existingScoped !== null) return; // already migrated, or already has its own scoped data

  const legacyRaw = await _storage.getItem(STORAGE_KEY);
  if (!legacyRaw) return; // nothing to migrate

  await _storage.setItem(scopedKey, legacyRaw);
  await _storage.removeItem(STORAGE_KEY);
}

/**
 * Resolves which key to read/write for this call.
 *  - Flag off: always the legacy unscoped key (unchanged behavior).
 *  - Flag on, account resolvable: the per-account scoped key (running the
 *    one-time migration first if needed).
 *  - Flag on, no account resolvable: null. Callers must treat this as "no
 *    data available" for reads and skip the write — never fall back to the
 *    unscoped legacy key.
 */
async function resolveKey(): Promise<string | null> {
  if (!isAccountScopedStorageEnabled()) return STORAGE_KEY;
  const accountId = await getCurrentAccountId();
  if (!accountId) return null;
  await migrateLegacyBookmarksIfNeeded(accountId);
  return scopedBookmarksKey(accountId);
}

export interface BookmarkedPlace {
  id: string;
  name: string;
  category: string;
  type: string | null;
  address: string | null;
  savedAt: number;
  lat?: number | null;
  lng?: number | null;
  /** Which list (trip id or 'global') this entry belongs to. */
  listId?: string;
}

// ── Test seams ─────────────────────────────────────────────────────────────────
// Production code uses AsyncStorage and real supabase auth.
// Tests call _setTestStorage() to inject a fake storage and optionally
// _setTestToken() to control the auth token without loading supabase.

let _storage: StorageLike = AsyncStorage;
export function _setTestStorage(s: StorageLike): void {
  _storage = s;
  // Reset the write queue so tests start with a clean serial chain
  _writeQueue = Promise.resolve();
}

// undefined  = use real supabase auth (default)
// null       = unauthenticated (skip API calls)
// '<token>'  = authenticated, use this token
let _testToken: string | null | undefined = undefined;
export function _setTestToken(t: string | null | undefined): void {
  _testToken = t;
}

// ── Write queue ────────────────────────────────────────────────────────────────
// Serialises concurrent toggleSave calls so a rapid save→unsave pair cannot
// both read stale state and both try to remove the same item (which would call
// removeItem for the category-filter key twice and leave the UI with a stale
// filter).  The queue is reset in _setTestStorage so each test starts clean.

let _writeQueue: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _writeQueue.then(() => fn());
  // Absorb errors so a rejected fn() doesn't poison the queue for future callers
  _writeQueue = next.then(
    () => {},
    () => {},
  );
  return next;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function readAll(): Promise<BookmarkedPlace[]> {
  try {
    const key = await resolveKey();
    if (key === null) return []; // flag on, no signed-in account — never fall back to the legacy key
    const raw = await _storage.getItem(key);
    return raw ? (JSON.parse(raw) as BookmarkedPlace[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(items: BookmarkedPlace[]): Promise<void> {
  try {
    const key = await resolveKey();
    if (key === null) return; // flag on, no signed-in account — silently skip (matches this file's existing best-effort contract)
    await _storage.setItem(key, JSON.stringify(items));
  } catch {
    // silently fail — non-critical
  }
}

// ── API helpers (only used when Supabase is configured) ────────────────────────

const apiBase = (): string => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

/**
 * Returns a valid bearer token, or null when unauthenticated / not configured.
 *
 * Supabase is lazy-imported so the native @supabase/supabase-js packages are
 * never required in a pure Node.js test environment.  If the import fails for
 * any reason the function silently returns null (treated as unauthenticated).
 */
async function getAuthToken(): Promise<string | null> {
  // Test seam: bypass supabase entirely
  if (_testToken !== undefined) return _testToken;

  // Guard: no API base URL — skip all remote calls
  if (!apiBase()) return null;

  try {
    // Dynamic import keeps native Expo/RN modules out of the test bundle
    const { isSupabaseConfigured } = await import('../lib/supabase.ts');
    if (!isSupabaseConfigured) return null;
    // Shared refresh-first token helper (also dynamically imported — it pulls in supabase).
    const { freshToken } = await import('./apiToken.ts');
    return freshToken();
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function isSaved(id: string): Promise<boolean> {
  const all = await readAll();
  return all.some((b) => b.id === id);
}

/**
 * Result of a toggleSave call.
 * `added`  — true when the place was added, false when removed.
 * `synced` — true when the API call succeeded (or auth is absent so local is canonical).
 *            false means the change is local-only and will reconcile on next listSaved().
 */
export interface ToggleSaveResult {
  added: boolean;
  synced: boolean;
}

/**
 * Toggle a place in/out of a specific list (trip id or 'global').
 * Existence is checked by (place.id, listId) so the same place can be saved
 * independently to multiple trips without interfering.
 *
 * Returns { added, synced } — callers can surface a "saved offline" indicator
 * when synced is false.
 */
export function toggleSave(place: BookmarkedPlace, listId = 'global'): Promise<ToggleSaveResult> {
  // Wrap the storage read+write in the write queue so concurrent calls (e.g. a
  // rapid save→unsave tap) are serialised.  Without this, both calls could read
  // the same stale list, both decide to remove the item, and both fire
  // removeItem for the category-filter key — leaving a stale filter in storage.
  return withWriteLock(async () => {
    // 1. Update AsyncStorage first — fast, works offline
    const all = await readAll();
    const idx = all.findIndex((b) => b.id === place.id && (b.listId ?? 'global') === listId);
    const removing = idx >= 0;
    if (removing) {
      // remove just this (place, list) pair — other trips keep their copy
      all.splice(idx, 1);
      await writeAll(all);
      // When the last place for this list is removed, the category-filter key
      // becomes stale. Clear it as a fire-and-forget cleanup.
      const remaining = all.filter((b) => (b.listId ?? 'global') === listId);
      if (remaining.length === 0) {
        resolveCategoryStorageKey(_storage, listId)
          .then((filterKey) => { if (filterKey) return _storage.removeItem(filterKey); })
          .catch(() => {});
      }
    } else {
      // add, tagging with listId so per-trip filtering works
      all.unshift({ ...place, listId, savedAt: Date.now() });
      await writeAll(all);
    }

    // 2. Sync to Supabase via API (best-effort; failure does not revert local state)
    const token = await getAuthToken();
    if (!token) {
      // Unauthenticated — local storage is canonical; treat as synced
      return { added: !removing, synced: true };
    }

    const base = apiBase();
    try {
      const res = removing
        ? await fetch(
            `${base}/api/wishlist/${encodeURIComponent(place.id)}?list=${encodeURIComponent(listId)}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
          )
        : await fetch(`${base}/api/wishlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ placeId: place.id, placeData: place, listId }),
          });
      // Local state already updated; Supabase will reconcile on the next listSaved() call.
      return { added: !removing, synced: res.ok };
    } catch {
      // Network error — local state already updated
      return { added: !removing, synced: false };
    }
  });
}

/**
 * Return all saved places, optionally scoped to a specific list.
 * When no listId is given, returns every entry across all lists sorted newest first.
 *
 * Tries Supabase first (authoritative when online & authenticated); falls back
 * to AsyncStorage on network error or when unauthenticated.
 */
export async function listSaved(listId?: string): Promise<BookmarkedPlace[]> {
  // Try Supabase first — authoritative source when online & authenticated
  const token = await getAuthToken();
  if (token) {
    const base = apiBase();
    try {
      const res = await fetch(`${base}/api/wishlist`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = (await res.json()) as { places: BookmarkedPlace[] };
        const places = json.places ?? [];
        // Keep local cache in sync with the authoritative Supabase list
        await writeAll(places);
        const filtered = listId
          ? places.filter((b) => (b.listId ?? 'global') === listId)
          : places;
        return filtered.sort((a, b) => b.savedAt - a.savedAt);
      }
    } catch {
      // Network error — fall through to AsyncStorage
    }
  }

  // Fallback: local AsyncStorage
  const all = await readAll();
  const filtered = listId
    ? all.filter((b) => (b.listId ?? 'global') === listId)
    : all;
  return filtered.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Return the set of list IDs (trip ids or 'global') that already contain the
 * given place id. Used by TripWishlistPicker to pre-populate saved state.
 */
export async function getSavedListIds(placeId: string): Promise<Set<string>> {
  const all = await readAll();
  const ids = new Set<string>();
  for (const b of all) {
    if (b.id === placeId) {
      ids.add(b.listId ?? 'global');
    }
  }
  return ids;
}

export async function clearAllSaved(): Promise<void> {
  // Clear local storage
  const key = await resolveKey();
  if (key !== null) await _storage.removeItem(key);
  const globalFilterKey = await resolveCategoryStorageKey(_storage, 'global');
  if (globalFilterKey !== null) await _storage.removeItem(globalFilterKey);
  // Also drop the legacy unscoped global filter key so it never lingers
  // once every account has migrated away from it.
  if (globalFilterKey !== GLOBAL_FILTER_KEY) {
    await _storage.removeItem(GLOBAL_FILTER_KEY).catch(() => {});
  }

  // Sync to Supabase (best-effort)
  const token = await getAuthToken();
  if (token) {
    const base = apiBase();
    try {
      await fetch(`${base}/api/wishlist`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Network error — local is already cleared
    }
  }
}

/**
 * Remove a saved place from one specific list (trip id or 'global').
 *
 * Reads and writes directly — bypassing the silent-catch helpers — so that any
 * AsyncStorage failure propagates to the caller.  The caller can then roll back
 * optimistic UI state and show an error to the user.
 *
 * Unlike toggleSave (which swallows write errors) and removeSaved (which removes
 * the place from every list it appears in), this function is both error-throwing
 * and list-scoped: it removes only the (id, listId) pair and leaves all other
 * (id, otherList) entries intact.
 */
export async function removeSavedFromList(id: string, listId: string): Promise<void> {
  const key = await resolveKey();
  if (key === null) {
    // Matches this function's existing "propagate failures to the caller"
    // contract (see doc comment above) rather than the silent-catch used by
    // readAll/writeAll — an optimistic-UI caller must know the write did not
    // happen so it can roll back.
    throw new Error('Cannot remove saved place: account-scoped storage is enabled but no account is signed in.');
  }
  const raw = await _storage.getItem(key);
  const all: BookmarkedPlace[] = raw ? (JSON.parse(raw) as BookmarkedPlace[]) : [];
  const remaining = all.filter(
    (b) => !(b.id === id && (b.listId ?? 'global') === listId),
  );
  await _storage.setItem(key, JSON.stringify(remaining));

  // When the last place for this list is removed the category-filter key
  // becomes stale. Clear it as a fire-and-forget cleanup.
  const listRemaining = remaining.filter((b) => (b.listId ?? 'global') === listId);
  if (listRemaining.length === 0) {
    resolveCategoryStorageKey(_storage, listId)
      .then((filterKey) => { if (filterKey) return _storage.removeItem(filterKey); })
      .catch(() => {});
  }

  // Sync to Supabase (best-effort — failure does not revert the local remove)
  const token = await getAuthToken();
  if (token) {
    const base = apiBase();
    try {
      await fetch(
        `${base}/api/wishlist/${encodeURIComponent(id)}?list=${encodeURIComponent(listId)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
    } catch {
      // Network error — local state is already removed
    }
  }
}

export async function removeSaved(id: string): Promise<void> {
  // Read and write directly — bypassing the silent-catch helpers — so that
  // any AsyncStorage failure propagates to the caller. The saved.tsx
  // handleRemove relies on a rejected promise to trigger its optimistic
  // rollback and error toast.
  const key = await resolveKey();
  if (key === null) {
    throw new Error('Cannot remove saved place: account-scoped storage is enabled but no account is signed in.');
  }
  const raw = await _storage.getItem(key);
  const all: BookmarkedPlace[] = raw ? (JSON.parse(raw) as BookmarkedPlace[]) : [];
  const remaining = all.filter((b) => b.id !== id);
  await _storage.setItem(key, JSON.stringify(remaining));

  // When the last place is removed, the category-filter key for the global
  // bookmark list becomes stale. Clear it as a fire-and-forget cleanup so
  // keys don't accumulate across place-by-place removals.
  if (remaining.length === 0) {
    resolveCategoryStorageKey(_storage, 'global')
      .then((filterKey) => { if (filterKey) return _storage.removeItem(filterKey); })
      .catch(() => {});
  }

  // Sync to Supabase (best-effort — failure does not revert the local remove)
  const token = await getAuthToken();
  if (token) {
    const base = apiBase();
    try {
      await fetch(
        `${base}/api/wishlist/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      );
    } catch {
      // Network error — local state is already removed
    }
  }
}
