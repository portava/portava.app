/**
 * Pure follow decisions. The route calls these; tests call these directly. A
 * follow is purely a social edge — these functions never reference posts, trips,
 * circles, or locations, which is itself part of the guarantee that a follow
 * grants nothing sensitive.
 */

export type FollowDecision =
  | { ok: true }
  | { ok: false; code: 'unauthenticated' | 'invalid_payload' | 'cannot_follow_self' | 'not_found' | 'blocked' };

/**
 * Can `followerId` follow `targetId`?
 * - must be authenticated
 * - target must be a valid uuid that exists (existence checked by caller)
 * - cannot follow self
 * - cannot follow if blocked (block relationship checked by caller; no block
 *   table yet, so `blocked` defaults false)
 */
export function decideFollow(
  followerId: string | null,
  targetId: string,
  facts: { targetExists: boolean; blocked?: boolean },
): FollowDecision {
  if (!followerId) return { ok: false, code: 'unauthenticated' };
  if (!isUuid(targetId)) return { ok: false, code: 'invalid_payload' };
  if (followerId === targetId) return { ok: false, code: 'cannot_follow_self' };
  if (!facts.targetExists) return { ok: false, code: 'not_found' };
  if (facts.blocked) return { ok: false, code: 'blocked' };
  return { ok: true };
}

/** Unfollow: must be authenticated and a valid target. (Idempotent at DB level.) */
export function decideUnfollow(followerId: string | null, targetId: string): FollowDecision {
  if (!followerId) return { ok: false, code: 'unauthenticated' };
  if (!isUuid(targetId)) return { ok: false, code: 'invalid_payload' };
  return { ok: true };
}

export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
