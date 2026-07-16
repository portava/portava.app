import { useBlockedIds } from '../context/BlockedIdsContext';
import type { InteractionContext } from '../services/interactionContext';

export function useCanMessageUser(userId: string, ctx?: InteractionContext | null): boolean {
  const { blockedIds } = useBlockedIds();
  if (blockedIds.has(userId)) return false;
  if (!ctx) return false;
  if (ctx.theyBlockedMe || ctx.iBlocked) return false;
  return ctx.canMessage;
}
