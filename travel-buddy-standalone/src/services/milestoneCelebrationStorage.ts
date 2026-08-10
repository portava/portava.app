/**
 * milestoneCelebrationStorage — pure storage-key resolution for
 * useMilestoneCelebration's "already celebrated this milestone" markers.
 *
 * Extracted out of the hook's file (which imports 'react-native' for
 * Animated/Easing and cannot load under node:test) so the account-scoping
 * logic is directly unit testable. useMilestoneCelebration.ts delegates to
 * this module.
 */
import { isAccountScopedStorageEnabled } from '../config/accountScopedStorageFlag.ts';
import { getCurrentAccountId } from './accountId.ts';

/** Minimal subset of AsyncStorage needed by this module. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type MilestoneLevel = 100 | 1000 | 10000;

export const legacyMilestoneStorageKey = (level: MilestoneLevel): string =>
  `@portava/stamp_milestone_v1_${level}`;

/**
 * Per-account key, used only when isAccountScopedStorageEnabled() is true.
 * legacyMilestoneStorageKey() above stays the sole key while the flag is off.
 *
 * This is account-specific: whether the CURRENT account has personally been
 * shown the 100/1K/10K stamp-count celebration. Left unscoped, a shared
 * device leaks it across accounts — once account A hits a milestone and
 * clears the marker, account B silently never gets their own celebration
 * when they later cross the same threshold. It's an invisible miss, not an
 * obviously broken behavior, which is exactly why it's worth closing.
 */
export function scopedMilestoneStorageKey(level: MilestoneLevel, accountId: string): string {
  return `@portava/stamp_milestone_scoped_v1_${level}:${accountId}`;
}

const migratedAccountLevelPairs = new Set<string>();

/** Test seam — clear the migration-attempted cache between test cases. */
export function _resetMigratedMilestoneAccountLevelPairs(): void {
  migratedAccountLevelPairs.clear();
}

/**
 * One-time migration (per level): attribute the existing unscoped "seen"
 * marker for this milestone level to whichever account is currently signed
 * in, then delete the legacy key for that level.
 *
 * THIS IS A ONE-TIME BEST GUESS — the legacy key has no account field. If
 * two accounts previously shared this device, the "already celebrated"
 * state is attributed to whichever one happens to be signed in the first
 * time this runs post-upgrade for that level. The marker carries no
 * sensitive content (just a boolean "seen" flag), so there is no side
 * effect to clean up beyond moving the key — worst case a wrongly-attributed
 * migration means the celebration is skipped once for the actual reaching
 * account, which they can't tell happened (same class of risk as leaving it
 * unscoped, but bounded to a single occurrence instead of indefinitely).
 */
async function migrateLegacyMilestoneIfNeeded(
  storage: StorageLike,
  level: MilestoneLevel,
  accountId: string,
): Promise<void> {
  const pairKey = `${level}::${accountId}`;
  if (migratedAccountLevelPairs.has(pairKey)) return;
  migratedAccountLevelPairs.add(pairKey);

  const scoped = scopedMilestoneStorageKey(level, accountId);
  const existingScoped = await storage.getItem(scoped);
  if (existingScoped !== null) return; // already migrated, or this account already has its own marker

  const legacyRaw = await storage.getItem(legacyMilestoneStorageKey(level));
  if (!legacyRaw) return; // nothing to migrate

  await storage.setItem(scoped, legacyRaw);
  await storage.removeItem(legacyMilestoneStorageKey(level));
}

/**
 * Resolves which key to read/write for this milestone level.
 *  - Flag off: always the legacy unscoped key (unchanged behavior).
 *  - Flag on, account resolvable: the per-account-per-level scoped key
 *    (running the one-time migration first if needed).
 *  - Flag on, no account resolvable: null. Callers must treat this as
 *    "not yet celebrated" for reads and skip the write — never fall back to
 *    the unscoped legacy key.
 */
export async function resolveMilestoneStorageKey(
  storage: StorageLike,
  level: MilestoneLevel,
): Promise<string | null> {
  if (!isAccountScopedStorageEnabled()) return legacyMilestoneStorageKey(level);
  const accountId = await getCurrentAccountId();
  if (!accountId) return null;
  await migrateLegacyMilestoneIfNeeded(storage, level, accountId);
  return scopedMilestoneStorageKey(level, accountId);
}
