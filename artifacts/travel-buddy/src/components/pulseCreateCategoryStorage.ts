/**
 * Pure helper — AsyncStorage read/write for the last-used category per post
 * type in PulseCreate.
 *
 * Extracted from PulseCreate so the persistence logic can be tested without a
 * native runtime or React.
 *
 * Storage key per type: `pulse_create_cat_{typeId}` (see lastCatKey).
 * Values are validated against VALID_CATEGORIES before being returned —
 * invalid or missing values produce null and the caller falls back to the
 * type default.
 */

import type { PostCategory } from '../types/models';

/** Minimal subset of AsyncStorage needed by these helpers. */
export interface StorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const VALID_CATEGORIES = new Set<string>([
  'hotel', 'food', 'nightlife', 'beach', 'activity',
  'transport', 'airport', 'visa', 'safety', 'tip', 'question',
]);

/**
 * Return the AsyncStorage key for the last-used category of a given post type.
 */
export function lastCatKey(typeId: string): string {
  return `pulse_create_cat_${typeId}`;
}

/**
 * Read the saved category for a post type from storage.
 * Returns null for any missing, invalid, or unreadable value.
 */
export async function loadLastCategory(
  storage: StorageLike,
  typeId: string,
): Promise<PostCategory | null> {
  try {
    const stored = await storage.getItem(lastCatKey(typeId));
    if (stored && VALID_CATEGORIES.has(stored)) return stored as PostCategory;
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the chosen category for a post type.
 * Errors are swallowed — this is fire-and-forget.
 */
export function saveLastCategory(
  storage: StorageLike,
  typeId: string,
  cat: PostCategory,
): void {
  storage.setItem(lastCatKey(typeId), cat).catch(() => {});
}

/**
 * Remove the saved category for a post type.
 * Call this when the user taps "Reset to default".
 * Errors are swallowed — fire-and-forget.
 */
export function clearLastCategory(storage: StorageLike, typeId: string): void {
  storage.removeItem(lastCatKey(typeId)).catch(() => {});
}
