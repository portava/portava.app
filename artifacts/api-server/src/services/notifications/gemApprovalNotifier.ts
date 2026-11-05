/**
 * gemApprovalNotifier — tell a gem's submitter that their gem was approved.
 *
 * Submitting a gem says "Your gem will be submitted for review. Once approved
 * it'll appear for the community" (travel-buddy-standalone/app/gems/submit.tsx),
 * and nothing ever said it had been: NotificationTemplateService carried
 * `hidden_gems.place_approved`, but no route created it. The admin verify route
 * (routes/hiddenGems.ts, POST /admin/hidden-gems/:id/verify) calls this only
 * for the pending -> approved step, so re-verifying a gem that is already live
 * sends nothing.
 *
 * It goes through NotificationService (dedup, privacy guard) and the router
 * (per-channel preferences, push), like socialActivityNotifier. Best-effort:
 * the approval has already been answered, so a failure is logged, not thrown.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { NotificationService } from "./NotificationService.js";
import { NotificationRouter } from "./NotificationRouter.js";

type Log = { warn?: (o: unknown, m: string) => void } | undefined;

/** Returns true when a notification row was written. */
export async function notifyGemApproved(
  sc: SupabaseClient,
  submitterId: string,
  gemId: string,
  gemName: string | null,
  log?: Log,
): Promise<boolean> {
  try {
    const row = await new NotificationService(sc).create({
      userId: submitterId,
      eventType: "hidden_gems.place_approved",
      sourceType: "hidden_gems",
      sourceId: gemId,
      params: { gemId, ...(gemName ? { placeName: gemName } : {}) },
    });
    if (!row) return false;
    await new NotificationRouter(sc).route(row);
    return true;
  } catch (err) {
    log?.warn?.({ err, gemId }, "gem approved: submitter notification failed");
    return false;
  }
}
