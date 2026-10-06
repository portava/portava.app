/**
 * Telegraph §24 — the two conversation facts the thread screen used to read
 * from raw tables.
 *
 * §24's closing rule: "Mobile clients consume server-built projections instead
 * of independently joining raw tables and reimplementing authorization/business
 * logic." census-telegraph T295 found three client bypass sites left on the
 * conversation screen (`app/messages/[id].tsx`): a head count of
 * `message_thread_members`, a read of the caller's own membership row used as
 * the "accepted member" gate, and `message_threads.is_e2ee`. The gate is now
 * the server's `canSendMessage` (the §14.1 projection the same route already
 * serves); the two FACTS are this module.
 *
 * ── DISCLOSED ONLY TO AN ACTIVE MEMBER ──────────────────────────────────────
 * The capabilities route answers 200 with every capability false for a
 * non-member so that it cannot be used as a thread-existence oracle. These
 * facts follow the same rule: a viewer who is not an active member gets
 * `null` for both, exactly the answer a thread that does not exist gets.
 *
 * ── A FAILED READ IS NOT A FACT ─────────────────────────────────────────────
 * supabase-js RESOLVES a PostgREST failure. An unreadable count is `null`, not
 * `0` ("nobody is here"); an unreadable `is_e2ee` is `null`, not `false` ("this
 * thread is not encrypted") — and `degraded` says which happened, so the
 * client can treat an unknown encryption state as the one that withholds the
 * edit affordance rather than the one that offers it.
 *
 * The count is an EXACT count (`head: true`), not the length of a roster page,
 * so a thread with more members than PostgREST's row cap is not reported at
 * the cap.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ConversationFacts {
  /** Active members, the viewer included. Null when unknown or not disclosed. */
  memberCount: number | null;
  /** Whether the thread is end-to-end encrypted. Null when unknown or not disclosed. */
  isE2ee: boolean | null;
  /** True when a read this answer rests on failed. */
  degraded: boolean;
}

const UNDISCLOSED: ConversationFacts = { memberCount: null, isE2ee: null, degraded: false };

export async function readConversationFacts(
  sc: SupabaseClient,
  conversationId: string,
  viewerId: string,
): Promise<ConversationFacts> {
  const { data: own, error: ownErr } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", conversationId)
    .eq("user_id", viewerId)
    .is("left_at", null)
    .maybeSingle();
  if (ownErr) return { memberCount: null, isE2ee: null, degraded: true };
  if (!own) return UNDISCLOSED;

  let degraded = false;

  const { count, error: countErr } = await sc
    .from("message_thread_members")
    .select("user_id", { count: "exact", head: true })
    .eq("thread_id", conversationId)
    .is("left_at", null);
  let memberCount: number | null = null;
  if (countErr || typeof count !== "number") degraded = true;
  else memberCount = count;

  const { data: thread, error: threadErr } = await sc
    .from("message_threads")
    .select("is_e2ee")
    .eq("id", conversationId)
    .maybeSingle();
  let isE2ee: boolean | null = null;
  if (threadErr || !thread) degraded = true;
  else isE2ee = (thread as { is_e2ee?: unknown }).is_e2ee === true;

  return { memberCount, isE2ee, degraded };
}
