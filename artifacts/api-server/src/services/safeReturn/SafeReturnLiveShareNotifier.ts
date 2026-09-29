/**
 * SafeReturnLiveShareNotifier — tells a trusted contact that a live share to
 * them has started, and links the notice to the recipient screen
 * (`app/safe-return/[shareId].tsx` on the client, via the template's actionUrl).
 *
 * WHY IT EXISTS (WP-04, TRUST-F10). `location.live_share_started` had a
 * template and no emitter: a share started, and the person it was for was never
 * told. The answer this returns is reported back to the sharer, so a share
 * whose contact was NOT told is never presented as one they were.
 *
 * What it will not do:
 *   - notify a contact who is not a Portava account (`recipient_not_on_portava`);
 *   - notify across a block in either direction (`blocked`) — fail closed, an
 *     unreadable blocks table is a block (lib/blockGuard);
 *   - bypass the notification privacy guard: the notice goes through
 *     NotificationService.create with `isLiveShare` and the sharer as sender,
 *     so push previews never carry an area and a Ghost-Mode sharer's notice is
 *     suppressed (`suppressed`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isBlockedBetween } from "../../lib/blockGuard.js";
import { nameVisibilitySet, presentedName } from "../../lib/publicIdentity.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { NotificationRouter } from "../notifications/NotificationRouter.js";
import { logger } from "../../lib/logger.js";

export const LIVE_SHARE_NOTICE_EVENT_TYPE = "location.live_share_started";
export const LIVE_SHARE_NOTICE_SOURCE_TYPE = "safe_return_live_share";

export type LiveShareNoticeReason =
  | "recipient_not_on_portava"
  | "blocked"
  | "suppressed";

export interface LiveShareNoticeInput {
  shareId: string;
  sharerId: string;
  recipientUserId: string | null;
  expiresAt: string | null;
}

async function sharerLabel(db: SupabaseClient, sharerId: string): Promise<string> {
  const { data, error } = await db.from("profiles").select("id, handle, name").eq("id", sharerId).maybeSingle();
  if (error) logger.warn({ err: error, sharerId }, "live-share notice: sharer profile unreadable, label degrades to 'Someone'"); if (error || !data) return "Someone";
  const allowed = await nameVisibilitySet(db, [sharerId]);
  const name = presentedName(data as any, allowed.has(sharerId));
  if (name) return name;
  const handle = (data as any).handle as string | null;
  return handle ? `@${handle}` : "Someone";
}

export async function notifyLiveShareRecipient(
  db: SupabaseClient,
  input: LiveShareNoticeInput,
): Promise<{ notified: boolean; reason?: LiveShareNoticeReason }> {
  const { shareId, sharerId, recipientUserId, expiresAt } = input;
  if (!recipientUserId) return { notified: false, reason: "recipient_not_on_portava" };
  if (await isBlockedBetween(db, sharerId, recipientUserId)) return { notified: false, reason: "blocked" };

  const actor = await sharerLabel(db, sharerId);
  const row = await new NotificationService(db).create({
    userId: recipientUserId,
    eventType: LIVE_SHARE_NOTICE_EVENT_TYPE,
    params: { actor, shareId },
    sourceType: LIVE_SHARE_NOTICE_SOURCE_TYPE,
    sourceId: shareId,
    actorId: sharerId,
    senderId: sharerId,
    isLiveShare: true,
    metadata: { shareId },
    ...(expiresAt ? { expiresAt } : {}),
  });
  if (!row) return { notified: false, reason: "suppressed" };

  // The in-app row exists from here on; push is best-effort and never unsays it.
  try {
    await new NotificationRouter(db).route(row);
  } catch (err) {
    logger.warn({ err, shareId }, "live-share notice: push routing failed (in-app notice stands)");
  }
  return { notified: true };
}
