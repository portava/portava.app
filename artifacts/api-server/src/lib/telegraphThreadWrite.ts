/**
 * The gates every Telegraph write into `messages` passes through.
 *
 * Extracted so the §5 share route and the §6.2 typed-kind route apply the
 * SAME four checks, in the same order, with the same posture as the ordinary
 * send path in `routes/messaging.ts`. A second write endpoint that skipped one
 * of them would be a weaker door into the same table — and the block guard is
 * the one that matters most, because blocking deliberately does not close an
 * existing thread and is re-checked per send instead.
 *
 * The four, in order:
 *   1. `disable_messaging` kill switch — fail CLOSED on a read error AND on
 *      an absent service client, which is the same fact (see
 *      `messagingStopUnknownRefusal`).
 *   2. ACTIVE membership (`left_at IS NULL`).
 *   3. 1:1 block guard. An unreadable roster must NOT read as "this is a group
 *      thread, skip the check": that is how a fail-closed guard becomes
 *      unreachable, and `routes/messaging.ts` records the day it happened.
 *   4. E2EE refusal. An E2EE thread's promise is that the server never stores
 *      plaintext; a structured envelope IS plaintext, so it is refused by name
 *      rather than quietly written.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "./supabase.js";
import { isKillSwitchEngaged } from "./featureFlags.js";
import { isBlockedBetween } from "./blockGuard.js";

export type ThreadWriteRefusal =
  | "feature_disabled"
  | "forbidden"
  | "degraded_unavailable"
  | "e2ee_thread";

export type ThreadWriteGuard =
  | { ok: true; otherMemberIds: string[] }
  | { ok: false; code: ThreadWriteRefusal; message: string };

/**
 * The refusal for a flag client we do not have.
 *
 * `if (flagSc && await isKillSwitchEngaged(...))` READS as fail-closed and is
 * not. Both operands of that `&&` are the same fact — the stop's state could not
 * be established — and only one of them was treated that way: an unreadable
 * `feature_flags` table engages the stop, while an absent service client
 * short-circuits the entire gate away and the write proceeds. That is the stop
 * disengaging at exactly the moment an operator is reaching for it.
 *
 * The upload door on `routes/telegraphVoice.ts` already refused this case with
 * `server_not_configured`; the send door did not, so a deployment missing
 * `SUPABASE_SERVICE_ROLE_KEY` could not upload a voice note but could write
 * every other typed message past a stop nobody could read.
 *
 * WHY `degraded_unavailable` AND NOT `feature_disabled`. "Messaging is
 * temporarily disabled" is a claim that an operator engaged a stop. Nobody did;
 * we could not look. The two are different sentences to the person holding the
 * phone — one is policy, the other is retryable — and this file's whole subject
 * is not collapsing sentences like that into one.
 *
 * THE COST, SAID OUT LOUD: a deployment with no service role key now refuses
 * every Telegraph typed / voice / share / coordination write instead of serving
 * them past an unreadable stop. That is a misconfiguration and not a supported
 * mode — but it is a behaviour change, and it belongs in the open rather than in
 * a changelog nobody reads.
 *
 * Exported as a predicate rather than inlined because it is a RULE, and a rule
 * that only exists inside an `if` cannot be asserted without standing up a
 * process with the environment stripped.
 */
export function messagingStopUnknownRefusal(
  flagSc: unknown,
): { ok: false; code: ThreadWriteRefusal; message: string } | null {
  if (flagSc) return null;
  return {
    ok: false,
    code: "degraded_unavailable",
    message: "We could not check whether messaging is available right now. Please try again shortly.",
  };
}

export async function guardTelegraphThreadWrite(
  client: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<ThreadWriteGuard> {
  const flagSc = getServiceClient();
  const stopUnknown = messagingStopUnknownRefusal(flagSc);
  if (stopUnknown) return stopUnknown;
  if (await isKillSwitchEngaged(flagSc, "disable_messaging")) {
    return { ok: false, code: "feature_disabled", message: "Messaging is temporarily disabled" };
  }

  const { data: membership, error: mErr } = await client
    .from("message_thread_members")
    .select("user_id, left_at")
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .is("left_at", null)
    .maybeSingle();
  if (mErr) {
    return {
      ok: false,
      code: "degraded_unavailable",
      message: "We could not verify this conversation right now. Please try again shortly.",
    };
  }
  if (!membership) return { ok: false, code: "forbidden", message: "Not a member of this thread" };

  const { data: others, error: oErr } = await client
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .is("left_at", null)
    .neq("user_id", userId);
  if (oErr) {
    return {
      ok: false,
      code: "degraded_unavailable",
      message: "We could not verify this conversation right now. Please try again shortly.",
    };
  }
  const otherMemberIds = ((others as any[]) ?? []).map((m) => m.user_id as string).filter(Boolean);
  if (otherMemberIds.length === 1 && otherMemberIds[0]) {
    const blockSc = getServiceClient() ?? client;
    if (await isBlockedBetween(blockSc, userId, otherMemberIds[0])) {
      return { ok: false, code: "forbidden", message: "You cannot message this user" };
    }
  }

  const { data: meta, error: metaErr } = await client
    .from("message_threads")
    .select("is_e2ee")
    .eq("id", threadId)
    .maybeSingle();
  if (metaErr) {
    return {
      ok: false,
      code: "degraded_unavailable",
      message: "We could not verify this conversation right now. Please try again shortly.",
    };
  }
  if ((meta as any)?.is_e2ee === true) {
    return {
      ok: false,
      code: "e2ee_thread",
      message: "This conversation is end-to-end encrypted; structured messages cannot be sent into it yet",
    };
  }

  return { ok: true, otherMemberIds };
}
