/**
 * telegraphSuggestionCache — pure key-resolution/migration logic for
 * TelegraphSuggestionTray's per-thread suggestion cache, split out so it can
 * be unit-tested under node:test without loading 'react-native'
 * (TelegraphSuggestionTray.tsx statically imports it and cannot run under
 * node:test — same wall documented for other component files in
 * scripts/run-node-tests.mjs's KNOWN_BROKEN list).
 */
import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';
import { getCurrentAccountId } from './accountId.ts';

/** Minimal AsyncStorage-like surface needed here. */
export interface TelegraphCacheStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function telegraphCacheKey(threadId: string): string {
  return `telegraph_suggestions_${threadId}`;
}

/**
 * Per-account key, used only when isAccountScopedStorageEnabled() is true.
 * telegraphCacheKey() above stays the sole key while the flag is off.
 */
export function scopedTelegraphCacheKey(threadId: string, accountId: string): string {
  return `telegraph_suggestions_scoped_v1_${threadId}_${accountId}`;
}

const migratedThreadAccountPairs = new Set<string>();

/** Test seam — clear the migration-attempted cache between test cases. */
export function _resetMigratedThreadAccountPairs(): void {
  migratedThreadAccountPairs.clear();
}

/**
 * One-time migration: attribute the existing unscoped per-thread cache to
 * whichever account is currently signed in, then delete the legacy key.
 *
 * THIS IS A ONE-TIME BEST GUESS — the legacy cache has no account field, so
 * if two accounts both belong to this thread and previously used this
 * device, whichever one opens the thread first post-upgrade claims the
 * cached suggestions. There is no field anywhere to do better. The cache is
 * inert (just suggestion cards), so unlike reminders there's no OS side
 * effect to clean up.
 */
export async function migrateLegacyTelegraphCacheIfNeeded(
  storage: TelegraphCacheStorageLike,
  threadId: string,
  accountId: string,
): Promise<void> {
  const pairKey = `${threadId}::${accountId}`;
  if (migratedThreadAccountPairs.has(pairKey)) return;
  migratedThreadAccountPairs.add(pairKey);

  const scoped = scopedTelegraphCacheKey(threadId, accountId);
  const existingScoped = await storage.getItem(scoped);
  if (existingScoped !== null) return; // already migrated, or already has its own scoped data

  const legacyRaw = await storage.getItem(telegraphCacheKey(threadId));
  if (!legacyRaw) return; // nothing to migrate

  await storage.setItem(scoped, legacyRaw);
  await storage.removeItem(telegraphCacheKey(threadId));
}

/**
 * Resolves which key to read/write for this thread's cache.
 *  - Flag off: always the legacy per-thread key (unchanged behavior).
 *  - Flag on, account resolvable: the per-thread-per-account scoped key
 *    (running the one-time migration first if needed).
 *  - Flag on, no account resolvable: null — treat as cache-miss for reads,
 *    skip the write. Never fall back to the unscoped legacy key.
 */
export async function resolveTelegraphCacheKey(
  storage: TelegraphCacheStorageLike,
  threadId: string,
): Promise<string | null> {
  if (!isAccountScopedStorageEnabled()) return telegraphCacheKey(threadId);
  const accountId = await getCurrentAccountId();
  if (!accountId) return null;
  await migrateLegacyTelegraphCacheIfNeeded(storage, threadId, accountId);
  return scopedTelegraphCacheKey(threadId, accountId);
}
