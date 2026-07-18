/**
 * discoveryLocalCache — AsyncStorage-backed cache for Discovery category counts.
 *
 * Goal: second open of the Discovery tab should paint tab badges in under 300 ms.
 * On first open the counts arrive from the network (~400-800 ms depending on cache
 * level).  After that they're written here.  On every subsequent open this module
 * provides the stale counts immediately, letting the tab bar render fully before
 * the network response even starts.  The network fetch still runs in the background
 * and replaces the counts once it resolves.
 *
 * TTL: 1 hour — counts change less often than place data but more than 2 hours
 * would make stale badges noticeable after a city switch.
 *
 * Key scheme: `discovery:counts:v1:<city_lower>` — version-prefixed so a future
 * schema change can purge old entries without a migration.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DiscoveryCategory } from './discovery.ts';

const TTL_MS    = 60 * 60 * 1_000; // 1 hour
const KEY_VER   = 'v1';

interface StoredCounts {
  counts:   Partial<Record<DiscoveryCategory, number>>;
  city:     string;
  cachedAt: number;
}

function storageKey(city: string): string {
  return `discovery:counts:${KEY_VER}:${city.toLowerCase().trim()}`;
}

/**
 * Load cached category counts for a city.
 *
 * Returns `null` on cache miss, expiry, or parse error.  Never throws.
 */
export async function loadCachedCounts(
  city: string,
): Promise<Partial<Record<DiscoveryCategory, number>> | null> {
  if (!city) return null;
  try {
    const raw = await AsyncStorage.getItem(storageKey(city));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCounts;
    if (!parsed?.counts || typeof parsed.cachedAt !== 'number') return null;
    if (Date.now() - parsed.cachedAt > TTL_MS) return null;
    return parsed.counts;
  } catch {
    return null;
  }
}

/**
 * Persist category counts for a city.  Never throws — cache errors are silent
 * so a failed write never breaks the UI.
 */
export async function saveCachedCounts(
  city:   string,
  counts: Partial<Record<DiscoveryCategory, number>>,
): Promise<void> {
  if (!city) return;
  try {
    const payload: StoredCounts = { counts, city, cachedAt: Date.now() };
    await AsyncStorage.setItem(storageKey(city), JSON.stringify(payload));
  } catch {
    // silent
  }
}

/**
 * Remove the cached counts for a city.  Useful when the user clears data or
 * explicitly switches cities — call this so stale counts don't resurface.
 */
export async function clearCachedCounts(city: string): Promise<void> {
  if (!city) return;
  try {
    await AsyncStorage.removeItem(storageKey(city));
  } catch {
    // silent
  }
}
