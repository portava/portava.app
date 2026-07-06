/**
 * Shared identity helpers — canonical display logic for user names, handles,
 * avatars, and initials used across Pulse cards, Telegraph rows, Discovery
 * traveler cards, Notification items, and Search results.
 *
 * Always use these functions instead of ad-hoc slicing/coalescing so that
 * every surface shows the same thing for the same user.
 */

export interface IdentityInput {
  displayName?: string | null;
  name?: string | null;
  username?: string | null;
  handle?: string | null;
  avatarUrl?: string | null;
}

/**
 * Return the best display name for a user.
 * Priority: displayName → name → username/handle → 'Traveler'
 */
export function resolveDisplayName(user: IdentityInput): string {
  return (
    user.displayName?.trim() ||
    user.name?.trim() ||
    user.username?.trim() ||
    user.handle?.trim() ||
    'Traveler'
  );
}

/**
 * Format a username/handle as a @-prefixed string.
 * Returns null when there is no username.
 */
export function formatHandle(username: string | null | undefined): string | null {
  if (!username) return null;
  const clean = username.replace(/^@+/, '').trim();
  return clean ? `@${clean}` : null;
}

/**
 * Return the avatar URL or null.
 * Centralises the "empty string is also null" normalisation.
 */
export function resolveAvatarUrl(url: string | null | undefined): string | null {
  if (!url || !url.trim()) return null;
  return url;
}

/**
 * Produce 1–2 initials for use as an avatar placeholder.
 * Uses displayName/name first, falls back to username/handle.
 *
 * Examples:
 *   "Maria Santos" → "MS"
 *   "alice"        → "A"
 *   null           → "?"
 */
export function fallbackInitials(user: IdentityInput): string {
  const name =
    user.displayName?.trim() ||
    user.name?.trim() ||
    user.username?.trim() ||
    user.handle?.trim();

  if (!name) return '?';

  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0]! + parts[1][0]!).toUpperCase();
  }
  return parts[0]!.slice(0, 2).toUpperCase();
}
