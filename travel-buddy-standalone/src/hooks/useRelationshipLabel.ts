import { useBlockedIds } from '../context/BlockedIdsContext';
import type { InteractionContext } from '../services/interactionContext';

export type RelationshipLabel =
  | 'blocked_by_you'
  | 'blocked_you'
  | 'mutual'
  | 'following'
  | 'follower'
  | 'friend'
  | 'restricted'
  | 'muted'
  | 'none';

export function useRelationshipLabel(
  userId: string,
  ctx?: InteractionContext | null,
): RelationshipLabel {
  const { blockedIds } = useBlockedIds();
  if (blockedIds.has(userId)) return 'blocked_by_you';
  if (!ctx) return 'none';
  if (ctx.theyBlockedMe) return 'blocked_you';
  if (ctx.iBlocked) return 'blocked_by_you';
  if (ctx.iRestricted) return 'restricted';
  if (ctx.iMuted) return 'muted';
  if (ctx.context.isFriend) return 'friend';
  if (ctx.context.areMutualFollowers) return 'mutual';
  if (ctx.canFollow === false) return 'following';
  return 'none';
}
