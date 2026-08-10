/**
 * checkpointArrivalQueue — pure key-resolution/migration logic for the
 * checkpoint-arrival pending queue, split out of checkpointArrivalTask.ts so
 * it can be unit-tested under node:test.
 *
 * checkpointArrivalTask.ts statically imports expo-task-manager, which
 * transitively requires expo-modules-core's native "sweet" runtime and
 * cannot load in a pure Node.js environment (MODULE_NOT_FOUND on
 * './sweet/setUpJsLogger.fx') — the same wall documented for other
 * native-module tests in scripts/run-node-tests.mjs's KNOWN_BROKEN list.
 * This file has no such import, so it (and its tests) load cleanly.
 */
import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';
import { getCurrentAccountId } from '../services/accountId.ts';

export const PENDING_ARRIVALS_STORE_KEY = '@travel_buddy/pending_checkpoint_arrivals';

/** Minimal AsyncStorage-like surface needed here (mirrors reminders.ts's StorageLike). */
export interface CheckpointStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Per-account key, used only when isAccountScopedStorageEnabled() is true.
 * PENDING_ARRIVALS_STORE_KEY above stays the sole key while the flag is off.
 */
export function scopedPendingArrivalsKey(accountId: string): string {
  return `@travel_buddy/pending_checkpoint_arrivals_scoped_v1:${accountId}`;
}

const migratedAccountIds = new Set<string>();

/** Test seam — clear the migration-attempted cache between test cases. */
export function _resetMigratedAccountIds(): void {
  migratedAccountIds.clear();
}

/**
 * One-time migration: attribute any already-queued (but not yet drained)
 * arrivals to whichever account is currently signed in, then delete the
 * legacy key.
 *
 * THIS IS A ONE-TIME BEST GUESS — the legacy queue has no account field, so
 * if a different account was signed in when the geofence fired than is
 * signed in now, this can misattribute a pending arrival. There is no field
 * anywhere to do better. Precise device coordinates are involved (see
 * SessionContext's PRIVATE_ASYNC_KEYS comment), which is exactly why this
 * queue was already treated as sensitive.
 */
export async function migrateLegacyCheckpointQueueIfNeeded(
  storage: CheckpointStorageLike,
  accountId: string,
): Promise<void> {
  if (migratedAccountIds.has(accountId)) return;
  migratedAccountIds.add(accountId);

  const scopedKey = scopedPendingArrivalsKey(accountId);
  const existingScoped = await storage.getItem(scopedKey);
  if (existingScoped !== null) return; // already migrated, or already has its own scoped data

  const legacyRaw = await storage.getItem(PENDING_ARRIVALS_STORE_KEY);
  if (!legacyRaw) return; // nothing to migrate

  await storage.setItem(scopedKey, legacyRaw);
  await storage.removeItem(PENDING_ARRIVALS_STORE_KEY);
}

/**
 * Resolves which key the background task/hook should read/write.
 *  - Flag off: always the legacy unscoped key (unchanged behavior).
 *  - Flag on, account resolvable: the per-account scoped key (running the
 *    one-time migration first if needed).
 *  - Flag on, no account resolvable: null. The caller must DEFER — do
 *    nothing — rather than guess an account or fall back to the unscoped
 *    legacy key. A missed single geofence ENTER event is preferable to
 *    attributing precise device coordinates to the wrong account; the
 *    geofence will typically still be registered and can fire again, or the
 *    foreground polling fallback in useRouteCheckpointMonitor will catch it.
 */
export async function resolveCheckpointQueueKey(storage: CheckpointStorageLike): Promise<string | null> {
  if (!isAccountScopedStorageEnabled()) return PENDING_ARRIVALS_STORE_KEY;
  const accountId = await getCurrentAccountId();
  if (!accountId) return null;
  await migrateLegacyCheckpointQueueIfNeeded(storage, accountId);
  return scopedPendingArrivalsKey(accountId);
}
