/**
 * census-telegraph T445 (lane TELEGRAPH batch 4) — §5.1 `getAvailableActions(viewerId, conversationId)`,
 * PER VIEWER.
 *
 * T445: "A source object shared in Telegraph cannot grant broader access than its authorized share
 * projection." The card half is closed (every reader serves only the projection). The remainder was the
 * action set: a resolved share offered the family's actions (narrowed by the object's live status,
 * T320/T411) to EVERY viewer of the conversation — a member who may not post here, or may not create a
 * plan, was still offered ADD_TO_TRIP, CREATE_PLAN, VOTE, SHARE_LOCATION… on the card. The offer was
 * broader than that viewer's own authorization in that conversation.
 *
 * THE RULE. An offered action survives only if the viewer holds, in THIS conversation, the §14.1
 * capability that governs it — the kernel's own table, `ACTION_GOVERNING_CAPABILITY`
 * (contextKernelPolicy.ts: plan-making → canCreatePlan, everything done INTO the conversation →
 * canSendMessage), so a card and the context kernel never disagree about what one person may do in one
 * thread. That table is a product reading of §14.1 the lead accepted for T439 ("owner may revisit");
 * this module adds no second reading of it.
 *
 * FAIL CLOSED. The capability set comes from `resolveConversationCapabilities`, which already answers a
 * FLOOR when an input is unreadable (a denied capability, never a confident grant). When the resolve
 * itself throws, the viewer is offered NOTHING; a card without buttons still opens its deep link.
 *
 * NOT A GATE. As with the messages page's `permissions` block, every action stays separately enforced
 * where it is performed; this only stops the card OFFERING what the act would refuse. No reason is put
 * on the wire for a narrowed offer: a reason would tell a blocked member they are blocked (§11.1).
 *
 * Called by both doors that resolve shares: POST /threads/:id/share-projections
 * (routes/telegraphShare.ts) and `resolveSharedCards` (services/telegraph/sharedCardTruth.ts), which
 * every reader that puts a card's truth on the wire goes through.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ConversationCapabilities } from "../../domain/telegraph/contracts/conversationCapabilities.js";
import { resolveConversationCapabilities } from "../../domain/telegraph/policies/conversationCapabilityPolicy.js";
import { ACTION_GOVERNING_CAPABILITY } from "./contextKernelPolicy.js";
import type { ResolvedShare, ShareLog } from "./shareables.js";
import type { TelegraphAction } from "./vocabulary.js";

/** One viewer's capabilities per conversation, resolved at most once per request. `null` = could not be resolved. */
export type ViewerCapabilityLookup = (conversationId: string) => Promise<ConversationCapabilities | null>;

export function viewerCapabilityLookup(sc: SupabaseClient, viewerId: string, log?: ShareLog): ViewerCapabilityLookup {
  const memo = new Map<string, Promise<ConversationCapabilities | null>>();
  return (conversationId) => {
    let p = memo.get(conversationId);
    if (!p) {
      p = resolveConversationCapabilities(sc, { viewerId, conversationId }).then(
        (r) => r.capabilities,
        (err) => {
          log?.error({ err, conversationId }, "share actions: capability resolve threw — no action offered");
          return null;
        },
      );
      memo.set(conversationId, p);
    }
    return p;
  };
}

/** The actions among `actions` whose governing capability the viewer holds. No capabilities → none. */
export function actionsTheViewerMayTake(
  actions: readonly TelegraphAction[],
  caps: ConversationCapabilities | null,
): TelegraphAction[] {
  if (!caps) return [];
  return actions.filter((a) => {
    const governing = ACTION_GOVERNING_CAPABILITY[a];
    return governing !== undefined && caps[governing] === true;
  });
}

/**
 * Narrow every live share's actions, IN PLACE, to what this viewer may take in `conversationId`. The
 * capability set is read only when some live share offers an action. Never throws: on any failure every
 * live share's actions are emptied (fail closed) — a caller that kept the un-narrowed set after a throw
 * would be the fail-open this exists to close.
 */
export async function narrowShareActions(
  lookup: ViewerCapabilityLookup,
  conversationId: string,
  resolved: ResolvedShare[],
): Promise<ResolvedShare[]> {
  const offering = resolved.filter((r) => r.available && r.actions.length > 0);
  if (offering.length === 0) return resolved;
  let caps: ConversationCapabilities | null = null;
  try {
    caps = await lookup(conversationId);
  } catch {
    caps = null;
  }
  for (const r of offering) {
    (r as { actions: TelegraphAction[] }).actions = actionsTheViewerMayTake(r.actions, caps);
  }
  return resolved;
}
