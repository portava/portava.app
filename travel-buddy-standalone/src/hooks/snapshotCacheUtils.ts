/**
 * snapshotCacheUtils.ts
 *
 * Pure helper functions extracted from `useSnapshotCache` so they can be unit-
 * tested under node:test without pulling in React Native or AsyncStorage.
 *
 * The hook (`useSnapshotCache.ts`) imports and re-exports these so call-sites
 * are unchanged.
 */

interface SnapshotEntry<T> {
  data: T;
  savedAt: number;
}

const DEFAULT_MAX_BYTES = 128 * 1024; // 128 KB

// ── Minimal storage interface ─────────────────────────────────────────────────

/** Minimal AsyncStorage-shaped interface accepted by the helpers below. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Build the namespaced storage key for a given hook name and userId.
 * Two different userIds always produce different keys — this is the
 * isolation guarantee that prevents one user's snapshot from leaking
 * to another after an account switch.
 */
export function _buildKey(name: string, userId: string): string {
  return `snap:v1:${name}:${userId}`;
}

/**
 * Read and parse a snapshot entry from storage.
 * Returns `{ data, isStale }` when the entry exists and is valid, or `null`
 * when absent / corrupt.  `now` is injectable so TTL checks are deterministic
 * in tests.
 */
export async function _loadSnapshot<T>(
  storage: StorageLike,
  storageKey: string,
  ttlMs: number,
  now: number,
): Promise<{ data: T; isStale: boolean } | null> {
  let raw: string | null;
  try {
    raw = await storage.getItem(storageKey);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const entry: SnapshotEntry<T> = JSON.parse(raw);
    const age = now - entry.savedAt;
    return { data: entry.data, isStale: age > ttlMs };
  } catch {
    return null; // Corrupt entry — ignore
  }
}

/**
 * Serialize `data` and write it to storage under the namespaced key for
 * `name`+`uid`.  Silently skips if the JSON representation exceeds
 * `maxBytes`.  `now` is injectable for deterministic tests.
 */
export function _saveSnapshot<T>(
  storage: StorageLike,
  name: string,
  uid: string,
  data: T,
  now: number,
  maxBytes: number = DEFAULT_MAX_BYTES,
): void {
  const sk = _buildKey(name, uid);
  const entry: SnapshotEntry<T> = { data, savedAt: now };
  let serialized: string;
  try {
    serialized = JSON.stringify(entry);
  } catch {
    return;
  }
  if (serialized.length > maxBytes) return; // Silently skip if too large
  storage.setItem(sk, serialized).catch(() => {});
}

/**
 * Remove the snapshot entry for `name`+`uid` from storage.
 */
export function _clearSnapshot(
  storage: StorageLike,
  name: string,
  uid: string,
): void {
  const sk = _buildKey(name, uid);
  storage.removeItem(sk).catch(() => {});
}
