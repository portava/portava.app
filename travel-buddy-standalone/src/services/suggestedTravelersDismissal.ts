/**
 * suggestedTravelersDismissal — pure storage-key resolution for
 * PeopleYouMayKnow's "dismissed suggestion" list.
 *
 * Extracted out of the component (which imports 'react-native' and cannot
 * load under node:test) so the account-scoping logic is directly unit
 * testable. PeopleYouMayKnow.tsx delegates to this module.
 */
import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';
import { getCurrentAccountId } from './accountId.ts';

/** Minimal subset of AsyncStorage needed by this module. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const DISMISSED_STORAGE_KEY = 'people_you_may_know_dismissed';

/**
 * Per-account key, used only when isAccountScopedStorageEnabled() is true.
 * DISMISSED_STORAGE_KEY above stays the sole key while the flag is off.
 *
 * This is account-specific: which people the CURRENT account personally
 * dismissed from suggestions. Left unscoped, a shared device leaks it
 * across accounts — account B would never see people account A dismissed,
 * even though B has never seen or judged those suggestions.
 */
export function scopedDismissedKey(accountId: string): string {
  return `people_you_may_know_dismissed_scoped_v1:${accountId}`;
}

const migratedAccountIds = new Set<string>();

/** Test seam — clear the migration-attempted cache between test cases. */
export function _resetMigratedSuggestedTravelersAccountIds(): void {
  migratedAccountIds.clear();
}

/**
 * One-time migration: attribute the existing unscoped dismissal list to
 * whichever account is currently signed in, then delete the legacy key.
 *
 * THIS IS A ONE-TIME BEST GUESS — the legacy list has no account field. If
 * two accounts previously shared this device, the dismissals are attributed
 * to whichever one happens to be signed in the first time this runs
 * post-upgrade. The list only holds other users' ids and dismissal
 * timestamps, so there is no side effect to clean up beyond moving the key.
 */
async function migrateLegacyDismissedIfNeeded(storage: StorageLike, accountId: string): Promise<void> {
  if (migratedAccountIds.has(accountId)) return;
  migratedAccountIds.add(accountId);

  const scoped = scopedDismissedKey(accountId);
  const existingScoped = await storage.getItem(scoped);
  if (existingScoped !== null) return; // already migrated, or this account already has its own list

  const legacyRaw = await storage.getItem(DISMISSED_STORAGE_KEY);
  if (!legacyRaw) return; // nothing to migrate

  await storage.setItem(scoped, legacyRaw);
  await storage.removeItem(DISMISSED_STORAGE_KEY);
}

/**
 * Resolves which key to read/write for the dismissed-suggestions list.
 *  - Flag off: always the legacy unscoped key (unchanged behavior).
 *  - Flag on, account resolvable: the per-account scoped key (running the
 *    one-time migration first if needed).
 *  - Flag on, no account resolvable: null. Callers must treat this as
 *    "nothing dismissed" for reads and skip the write — never fall back to
 *    the unscoped legacy key.
 */
export async function resolveSuggestedTravelersDismissedKey(storage: StorageLike): Promise<string | null> {
  if (!isAccountScopedStorageEnabled()) return DISMISSED_STORAGE_KEY;
  const accountId = await getCurrentAccountId();
  if (!accountId) return null;
  await migrateLegacyDismissedIfNeeded(storage, accountId);
  return scopedDismissedKey(accountId);
}
