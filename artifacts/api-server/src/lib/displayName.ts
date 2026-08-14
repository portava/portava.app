/**
 * Server-side display-name length rules.
 *
 * Mirrors the mobile client's identity helpers
 * (travel-buddy-standalone/src/utils/identity.ts): onboarding and the identity
 * editor enforce a 40-character display-name limit, but legacy accounts
 * created before the limit may still have longer names stored in the DB.
 * Any server-composed text that interpolates a user's display name — push
 * notification titles/bodies, share-page OG metadata — must cap it with this
 * helper so legacy names can't bloat banners or link previews.
 */

/** Maximum display-name length enforced by onboarding and the identity editor. */
export const DISPLAY_NAME_MAX_LENGTH = 40;

/** Truncate a display name to the 40-character limit with an ellipsis. */
export function truncateDisplayName(name: string, max: number = DISPLAY_NAME_MAX_LENGTH): string {
  if (name.length <= max) return name;
  return `${name.slice(0, max).trimEnd()}…`;
}

/**
 * Compose a Circle group-chat thread title from an owner's display name,
 * capping legacy >40-char names so they can't bloat thread lists.
 */
export function circleThreadTitle(displayName: string): string {
  return `${truncateDisplayName(displayName)}'s Circle`;
}
