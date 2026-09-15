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
 *   1. `disable_messaging` kill switch — fail CLOSED on a read error.
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

export async function guardTelegraphThreadWrite(
  client: SupabaseClient,
  threadId: string,
  userId: string,
): Promise<ThreadWriteGuard> {
  const flagSc = getServiceClient();
  if (flagSc && (await isKillSwitchEngaged(flagSc, "disable_messaging"))) {
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
