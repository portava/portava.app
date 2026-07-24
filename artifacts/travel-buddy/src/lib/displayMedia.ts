/**
 * displayMedia — shared resolver for display images across every card surface.
 *
 * Provides a single priority-ordered URL resolver and an avatar helper that
 * delegates to the canonical identity utilities in src/utils/identity.ts.
 * Use these instead of ad-hoc `uri ? <Image> : <View/>` patterns so that
 * every surface degrades consistently and never shows a blank rectangle.
 */

import {
  resolveAvatarUrl,
  fallbackInitials,
  type IdentityInput,
} from '../utils/identity.ts';

export type MediaSource = string | null | undefined;

export interface DisplayMediaOptions {
  /** Hint passed to callers for Supabase width transform (not applied here). */
  width?: number;
}

/**
 * Walk the priority chain and return the first non-empty URL, or null when
 * every source is null / empty / whitespace.
 *
 * Sources are tried left-to-right, so callers should order them from most
 * specific to least specific:
 *   user photo → official photo → provider photo → community photo
 *   → related image → map preview → category artwork → null (designed fallback)
 */
export function resolveDisplayMedia(
  sources: MediaSource[],
  _options?: DisplayMediaOptions,
): string | null {
  for (const src of sources) {
    const clean = src?.trim();
    if (clean) return clean;
  }
  return null;
}

/** Result returned by avatarFallback(). */
export interface AvatarFallbackResult {
  /** Resolved avatar URL, or null when none is set / reachable. */
  url: string | null;
  /** 1–2 initials for rendering in a circle when url is null or broken. */
  initials: string;
}

/**
 * Resolve avatar URL and initials for a user in one call.
 * Delegates to resolveAvatarUrl / fallbackInitials from identity.ts.
 */
export function avatarFallback(user: IdentityInput): AvatarFallbackResult {
  return {
    url: resolveAvatarUrl(user.avatarUrl),
    initials: fallbackInitials(user),
  };
}
