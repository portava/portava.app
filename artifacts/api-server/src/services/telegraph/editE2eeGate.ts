/**
 * Telegraph — the E2EE gate on EVERY message-edit route (WP-08, lane tm-telegraph).
 *
 * Two routes can overwrite `messages.body`:
 *   - PATCH /threads/:threadId/messages/:messageId (routes/messaging.ts), the
 *     canonical one the client calls, which also keeps version history; and
 *   - PATCH /messages/:messageId (routes/groupChat.ts), the legacy one, which
 *     the client no longer calls but any authenticated caller still can.
 *
 * Neither read `message_threads.is_e2ee` before this gate, while every other
 * write that can put text on the server does (the send, the media send, the
 * translate retry). An edit on an encrypted thread would have written the new
 * text in the clear — and on the canonical route, copied the previous body into
 * `message_edits` as well — on a thread whose whole contract is that the server
 * never holds its words.
 *
 * Same posture as the send path: an unreadable flag is NOT a false one, so it
 * refuses with the retryable `degraded_unavailable`. Call it AFTER the
 * membership and sender checks, so an outsider learns nothing about the thread
 * from it.
 *
 * Returns true when it has already answered the request.
 */
import { sendError } from "../../lib/http.js";

interface GateLog { error: (obj: unknown, msg?: string) => void }

export async function refuseEditOnEncryptedThread(
  sc: { from: (table: string) => any },
  req: { log: GateLog },
  res: unknown,
  threadId: string,
  messageId: string,
): Promise<boolean> {
  const { data: threadMeta, error: threadMetaErr } = await sc
    .from("message_threads")
    .select("is_e2ee")
    .eq("id", threadId)
    .maybeSingle();
  if (threadMetaErr) {
    req.log.error({ err: threadMetaErr, threadId, messageId },
      "thread E2EE flag read failed on edit — refusing rather than risking a plaintext edit in an E2EE thread");
    sendError(res as never, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
    return true;
  }
  if ((threadMeta as { is_e2ee?: unknown } | null)?.is_e2ee === true) {
    sendError(res as never, "e2ee_thread", "Editing is unavailable for end-to-end encrypted messages");
    return true;
  }
  return false;
}
