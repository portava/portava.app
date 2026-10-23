/**
 * replyQuote — the quote a reply carries in the SENDER's own send response.
 *
 * POST /threads/:threadId/messages answered 201 with `replyToId` and no
 * `replyToBody`. The client replaces its optimistic bubble (which showed the
 * quote) with the server's message, so the quote vanished from the sender's own
 * reply until the next poll re-read the thread.
 *
 * The quote is retrieval by another name, so it is built under EXACTLY the rules
 * the thread reader (GET /threads/:threadId/messages) applies to a quoted row —
 * not the looser "the sender just saw it" assumption, because `replyToId` is
 * caller-supplied:
 *
 *   - same thread only (the send path already refused a foreign reference; the
 *     read repeats the predicate because it runs on the service client);
 *   - the §14.3 history window of the CALLER, judged on the quoted row's own
 *     sender (Q6): a pre-window message of someone else's is not quoted back;
 *   - a location withheld across a block, and a shared card as it is NOW (T448);
 *   - the quoted sender's name under the universal display-name rule, and no
 *     identity across a block (§45d.3);
 *   - a deleted or unsent message quotes as `null`, never its text (§7.2).
 *
 * The answer has the reader's wire shape: `{ replyToBody, replyToSenderName }`,
 * with `replyToBody: null` when the quoted row is not the caller's to see, and
 * `{ replyContext: 'unavailable' }` when a read failed — "not known" is never
 * sent as "quoted nothing".
 */
import {
  applyHistoryWindow,
  historyBoundEnabled,
  visibleFromOf,
  withinWindow,
} from "../groupChatHistoryBound.js";
import { withholdLocationAcrossBlocks } from "./locationAcrossBlocks.js";
import { applySharedCardTruth } from "./sharedCardTruth.js";
import { identityWithheldAcrossBlocks } from "./identityAcrossBlocks.js";
import { nameVisibilitySet, resolveHandle } from "../../lib/publicIdentity.js";

export type ReplyQuoteFields =
  | { replyToBody: string | null; replyToSenderName: string | null }
  | { replyContext: "unavailable" };

interface QuoteLog { warn?: (obj: unknown, msg?: string) => void }

export async function replyQuoteForSender(
  sc: any,
  args: { threadId: string; viewerId: string; replyToId: string; log?: QuoteLog },
): Promise<ReplyQuoteFields> {
  const { threadId, viewerId, replyToId, log } = args;
  const unavailable = (err: unknown, what: string): ReplyQuoteFields => {
    log?.warn?.({ err, threadId, replyToId }, `send response: ${what} — quote omitted, not invented`);
    return { replyContext: "unavailable" };
  };
  try {
    const boundOn = await historyBoundEnabled(sc);
    let visibleFrom: string | null = null;
    if (boundOn) {
      const { data: membership, error: membershipErr } = await sc
        .from("message_thread_members")
        .select("user_id, visible_from_at") // = membershipSelect("user_id", true), written out so check:write-path-columns verifies both columns live (a computed list is a blind spot)
        .eq("thread_id", threadId)
        .eq("user_id", viewerId)
        .maybeSingle();
      if (membershipErr) return unavailable(membershipErr, "history window unreadable");
      visibleFrom = visibleFromOf(membership as any, true);
    }

    let quotedQuery = sc
      .from("messages")
      .select("id, body, sender_id, created_at, deleted_at, msg_type, subtype, profile:profiles!messages_sender_id_fkey(name, handle, username, full_name)")
      .eq("thread_id", threadId)
      .in("id", [replyToId]);
    quotedQuery = applyHistoryWindow(quotedQuery, visibleFrom, viewerId);
    const { data: quotedRows, error: quotedErr } = await quotedQuery;
    if (quotedErr) return unavailable(quotedErr, "quoted message unreadable");

    const windowed = ((quotedRows as any[]) ?? []).filter((qr: any) =>
      withinWindow(qr.created_at, visibleFrom, { senderId: qr.sender_id, viewerId }));
    const located = (await withholdLocationAcrossBlocks(sc, viewerId, windowed)).rows;
    const quoted = (await applySharedCardTruth(sc, viewerId, located, { threadId, log: log as any })).rows;
    const qr: any = quoted.find((r: any) => r.id === replyToId);
    if (!qr) return { replyToBody: null, replyToSenderName: null };
    // A deleted (or unsent) message is a tombstone: its row is redacted in place,
    // and the quote of a tombstone is the reader's real `null`, never its text.
    if (qr.deleted_at) return { replyToBody: null, replyToSenderName: null };

    const allowed = await nameVisibilitySet(sc, [qr.sender_id]);
    const identity = await identityWithheldAcrossBlocks(sc, viewerId, [qr.sender_id]);
    const nameOk = !identity.withhold(qr.sender_id) && (qr.sender_id === viewerId || allowed.has(qr.sender_id as string));
    const handle = identity.withhold(qr.sender_id) ? null : resolveHandle(qr.profile);
    return {
      replyToBody: (qr.body as string | null) ?? "",
      replyToSenderName: nameOk ? (qr.profile?.name ?? qr.profile?.full_name ?? null) : (handle ? `@${handle}` : null),
    };
  } catch (err) {
    return unavailable(err, "quote read threw");
  }
}
