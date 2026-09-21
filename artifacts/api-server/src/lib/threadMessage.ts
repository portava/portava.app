/**
 * threadMessage — write ONE plain-text message into an existing thread.
 *
 * WHY THIS EXISTS. `POST /airport/sessions/:id/telegraph` classified a layover
 * suggestion, resolved the trip's chat thread, emitted a
 * `telegraph_suggestion_sent` event carrying that thread id — and never wrote
 * the message. The client then navigated the traveller into that chat, where
 * their own text was not. census-layover L271: "the message is discarded". The
 * event said a message had been sent; the thread said otherwise, and the thread
 * was right.
 *
 * WHY IT IS NOT `POST /threads/:id/messages`. That endpoint carries E2EE
 * ciphertext, sender language resolution, reply references, off-app
 * solicitation scanning and translation fan-out, all driven off `req`/`res`.
 * None of it can be reached from another route without an HTTP request to
 * forge. What a second caller actually needs is the part that is a DATABASE
 * CONTRACT rather than a request contract: refuse an E2EE thread, insert,
 * move `last_message_at`, publish to the members. That is this function, and
 * it says in its result which of those happened.
 *
 * WHAT IT DELIBERATELY DOES NOT DO, so no caller assumes it:
 *   - it does NOT authorize. The caller proves the sender may post to this
 *     thread (the layover route checks accepted trip membership first). A
 *     helper that both authorizes and writes invites a caller to skip the
 *     first half by forgetting to think about it.
 *   - it does NOT translate, scan for off-app solicitation, or resolve reply
 *     references. A caller that needs those wants the endpoint, not this.
 *   - it does NOT accept ciphertext. An E2EE thread is REFUSED, never
 *     downgraded to plaintext: the whole point of the flag is that the server
 *     cannot read the conversation, and a second write path that ignores it
 *     would be the one place that quietly can.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { publishToThread } from "./telegraphEvents.js";
import { logger } from "./logger.js";

export type PostPlainThreadMessageResult =
  | { ok: true; messageId: string; createdAt: string }
  /** The thread is end-to-end encrypted. Nothing was written. */
  | { ok: false; reason: "e2ee" }
  /** The `is_e2ee` read failed, so it is not known whether it is safe. Nothing was written. */
  | { ok: false; reason: "unverifiable" }
  /** The thread row is absent. Nothing was written. */
  | { ok: false; reason: "no_thread" }
  /** The insert itself was rejected. Nothing was written. */
  | { ok: false; reason: "insert_failed" };

/**
 * Insert a plain-text message into `threadId` as `senderId`.
 *
 * FAILS CLOSED ON AN UNREADABLE FLAG. `is_e2ee` decides whether storing this
 * body is allowed at all, and supabase-js RESOLVES on a database error — so an
 * unchecked read gives `data: null`, which reads as `is_e2ee: false`, which
 * admits plaintext to an E2EE thread during exactly the minute the database is
 * unhappy. `unverifiable` is a separate answer from `e2ee` because the caller
 * should tell the user different things: one is "this conversation does not
 * take this kind of message", the other is "try again".
 */
export async function postPlainThreadMessage(
  sc: SupabaseClient,
  params: { threadId: string; senderId: string; body: string; subtype?: string | null },
): Promise<PostPlainThreadMessageResult> {
  const { threadId, senderId, body } = params;

  let isE2ee: boolean;
  try {
    const { data: meta, error: metaErr } = await sc
      .from("message_threads")
      .select("is_e2ee")
      .eq("id", threadId)
      .maybeSingle();
    if (metaErr) {
      logger.error({ err: metaErr, threadId }, "postPlainThreadMessage: is_e2ee read failed — refusing rather than risking plaintext in an E2EE thread");
      return { ok: false, reason: "unverifiable" };
    }
    if (!meta) return { ok: false, reason: "no_thread" };
    isE2ee = (meta as { is_e2ee?: unknown }).is_e2ee === true;
  } catch (err) {
    logger.error({ err, threadId }, "postPlainThreadMessage: is_e2ee read threw — refusing");
    return { ok: false, reason: "unverifiable" };
  }
  if (isE2ee) return { ok: false, reason: "e2ee" };

  const now = new Date().toISOString();
  const { data: msg, error: msgErr } = await sc
    .from("messages")
    .insert({
      thread_id: threadId,
      sender_id: senderId,
      body,
      created_at: now,
      msg_type: "text",
      subtype: params.subtype ?? null,
    })
    .select("id, created_at")
    .single();

  if (msgErr || !msg) {
    logger.error({ err: msgErr, threadId }, "postPlainThreadMessage: insert failed");
    return { ok: false, reason: "insert_failed" };
  }

  // Best-effort from here: the message IS in the thread. A failed
  // `last_message_at` bump sorts the thread list wrongly; a failed publish
  // means members see it on their next fetch rather than immediately. Neither
  // un-sends the message, so neither may turn a success into a failure.
  try {
    await sc.from("message_threads").update({ last_message_at: now }).eq("id", threadId);
  } catch (err) {
    logger.warn({ err, threadId }, "postPlainThreadMessage: last_message_at bump failed (non-fatal)");
  }

  try {
    // NO BODY IN THE PAYLOAD, and the sender is excluded — the shape the text
    // send path in routes/messaging.ts uses, and the one `TelegraphEvent.payload`
    // documents ("Never include message bodies or other PII"). The MEDIA path in
    // that same file publishes `body` instead; that divergence is that path's to
    // answer for, and copying it here would make it two places instead of one.
    await publishToThread(
      sc,
      threadId,
      {
        type: "message.created",
        payload: {
          messageId: (msg as { id: string }).id,
          senderId,
          msgType: "text",
          subtype: params.subtype ?? null,
          createdAt: (msg as { created_at: string }).created_at,
        },
      },
      { excludeUserId: senderId },
    );
    await publishToThread(sc, threadId, { type: "thread.updated", payload: { lastMessageAt: now } });
  } catch (err) {
    logger.warn({ err, threadId }, "postPlainThreadMessage: realtime publish failed (non-fatal)");
  }

  return { ok: true, messageId: (msg as { id: string }).id, createdAt: (msg as { created_at: string }).created_at };
}
