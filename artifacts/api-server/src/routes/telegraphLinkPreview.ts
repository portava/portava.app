/**
 * Telegraph §30A.8 link previews — the two doors (census-telegraph T404 / T446;
 * migration 3825; flag `telegraph_link_previews_enabled`, seeded FALSE).
 *
 *   POST /api/threads/:threadId/messages/:messageId/link-preview
 *        The SENDER, right after sending (or editing), asks the server to make
 *        the preview for that message. The server reads the stored body itself,
 *        takes its first external https link, fetches it once through
 *        `lib/outboundPreviewFetch.ts` and stores the text-only result. There is
 *        no URL in the request: an E2EE thread's body is not on the server, so
 *        it can never be previewed, and no client can make Portava fetch a URL
 *        that is not in a message it sent and can read.
 *
 *   GET  /api/threads/:threadId/link-previews?ids=<uuid>,…   (at most 50)
 *        Any member reads the stored previews of messages they may read now.
 *        THIS DOOR NEVER FETCHES. It does not import the fetcher's network and
 *        reads only `message_link_previews`, so a recipient opening a thread
 *        makes no request to any linked site — neither from their device nor,
 *        on their behalf, from Portava's server — and a sender cannot time a
 *        recipient's read with a per-recipient URL (T446).
 *
 * WHAT THE GET SERVES, AND THE ORDER IT DECIDES IN. The caller must be an active
 * member; the thread must not be E2EE (a thread that became E2EE serves
 * nothing); each message must be in the caller's §14.3 history window
 * (`groupChatHistoryBound`), not deleted or unsent, a plain text message, and
 * not from someone in a block with the caller either way (an unreadable block
 * state answers 503, never the page); and the stored row's `source_digest` must
 * be the sha256 of the body as it is now — an edited message serves nothing.
 *
 * FAIL CLOSED, EVERYWHERE. supabase-js resolves on a database error, so every
 * read binds `error`; an unreadable membership, thread, message, block or
 * preview read is a 503 `degraded_unavailable`, never "no preview" and never a
 * preview served without its check. The flag is read through `isFlagEnabled`,
 * whose error answer is OFF.
 *
 * Every default here is an OWNER QUESTION (b58/PLAN-telegraph-media.md §4,
 * Q-LP1…Q-LP9), implemented fail-closed and not represented as approved.
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { isUuid } from "../lib/followDecisions.js";
import {
  createPreviewService,
  normalizePreviewUrl,
  OutboundFetchGate,
  type PreviewResult,
  type PreviewService,
} from "../lib/outboundPreviewFetch.js";
import {
  applyHistoryWindow,
  historyBoundEnabled,
  visibleFromOf,
  withinWindow,
} from "../services/groupChatHistoryBound.js";
import { dropBlockedSenders } from "../services/telegraphReliability.js";
import {
  LINK_PREVIEW_BATCH_MAX,
  LINK_PREVIEW_RATE,
  LINK_PREVIEW_SEND_WINDOW_MS,
  bodyWrittenAt,
  firstExternalUrl,
  isPreviewableKind,
  isStoreOutcome,
  servablePreview,
  sourceDigest,
  type StoredPreviewRow,
  type WirePreview,
} from "../services/telegraph/linkPreviews.js";

const PREVIEW_ROW_COLUMNS = "message_id, status, url, host, title, description, site_name, source_digest";

type NoPreviewReason =
  | "disabled"
  | "not_text"
  | "no_link"
  | "unsupported_link"
  | "window_closed"
  | "none"
  | "stale"
  | "message_gone";

type PostAnswer = { kind: "preview"; preview: WirePreview } | { kind: "no_preview"; reason: NoPreviewReason };

export interface LinkPreviewDeps {
  /** The outbound fetch. Only the POST reaches it. */
  preview: PreviewService;
  /** The process-wide in-flight ceiling. */
  gate: OutboundFetchGate;
  now: () => number;
}

const noPreview = (reason: NoPreviewReason): PostAnswer => ({ kind: "no_preview", reason });

function logOf(req: Request) {
  const l = (req as any).log;
  return l && typeof l.error === "function" ? l : { error: () => {}, warn: () => {}, info: () => {} };
}

function unavailable(req: Request, res: Response, what: string, err: unknown, ctx: Record<string, unknown>) {
  logOf(req).error({ err, ...ctx }, `link preview: ${what} unreadable — refusing rather than guessing`);
  sendError(res, "degraded_unavailable", "We could not check this conversation right now. Please try again shortly.");
}

/**
 * The POST, as a factory so a suite can inject the network, the gate and the
 * clock. One in-flight fetch per message per process: a second POST for the
 * same message while the first is fetching waits for that one and fetches
 * nothing (`inflight`).
 */
export function linkPreviewPostHandler(deps: LinkPreviewDeps) {
  const inflight = new Map<string, Promise<PostAnswer | "unavailable">>();

  return async (req: Request, res: Response): Promise<void> => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const threadId = String(req.params.threadId ?? "");
    const messageId = String(req.params.messageId ?? "");
    if (!isUuid(threadId) || !isUuid(messageId)) { sendError(res, "invalid_payload", "Invalid thread or message id"); return; }

    // Q-LP1: OFF (the seed) reads nothing else and fetches nothing.
    if (!(await isFlagEnabled(client, "telegraph_link_previews_enabled"))) { res.json(noPreview("disabled")); return; }

    if (!checkRateLimit("telegraph-link-preview", user.id, LINK_PREVIEW_RATE.limit, LINK_PREVIEW_RATE.windowMs).allowed) {
      res.setHeader("Retry-After", "60");
      sendError(res, "rate_limited", "Too many preview requests. Please wait a moment.");
      return;
    }

    const { data: membership, error: membershipErr } = await client
      .from("message_thread_members")
      .select("user_id, left_at")
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .is("left_at", null)
      .maybeSingle();
    if (membershipErr) { unavailable(req, res, "membership", membershipErr, { threadId }); return; }
    if (!membership) { sendError(res, "forbidden", "Not a member of this thread"); return; }

    // Q-LP3: an E2EE thread never has a preview. Unreadable is not "plaintext".
    const { data: thread, error: threadErr } = await client
      .from("message_threads")
      .select("id, is_e2ee")
      .eq("id", threadId)
      .maybeSingle();
    if (threadErr) { unavailable(req, res, "thread", threadErr, { threadId }); return; }
    if (!thread) { sendError(res, "not_found", "Conversation not found"); return; }
    if ((thread as any).is_e2ee !== false) { sendError(res, "e2ee_thread", "Encrypted conversations have no link previews."); return; }

    const { data: message, error: messageErr } = await client
      .from("messages")
      .select("id, thread_id, sender_id, body, msg_type, subtype, created_at, edited_at, deleted_at")
      .eq("id", messageId)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (messageErr) { unavailable(req, res, "message", messageErr, { threadId, messageId }); return; }
    if (!message) { sendError(res, "not_found", "Message not found"); return; }
    const m = message as Record<string, unknown>;
    // The SENDER only — decided before anything about the message's state, so a
    // member cannot use this door to probe someone else's message.
    if (m.sender_id !== user.id) { sendError(res, "forbidden", "Only the sender can request a preview for a message."); return; }
    if (m.deleted_at) { sendError(res, "gone", "That message is gone."); return; }
    if (!isPreviewableKind(m.msg_type, m.subtype)) { res.json(noPreview("not_text")); return; }
    const body = typeof m.body === "string" ? m.body : "";
    if (!body) { res.json(noPreview("no_link")); return; }

    // A send-time act: past the window it is refused, never fetched later.
    const writtenAt = bodyWrittenAt(m.created_at, m.edited_at);
    if (Number.isNaN(writtenAt) || deps.now() - writtenAt > LINK_PREVIEW_SEND_WINDOW_MS) { res.json(noPreview("window_closed")); return; }

    const digest = sourceDigest(body);
    const existing = await readStoredPreview(client, messageId);
    if (existing.kind === "unavailable") { unavailable(req, res, "stored preview", existing.err, { messageId }); return; }
    if (existing.kind === "row") { res.json(answerForRow(existing.row, body)); return; }

    const link = firstExternalUrl(body);
    if (!link) { res.json(noPreview("no_link")); return; }
    let host: string;
    try { host = normalizePreviewUrl(link).hostname; } catch { res.json(noPreview("unsupported_link")); return; }

    let pending = inflight.get(messageId);
    if (!pending) {
      const ticket = deps.gate.tryAcquire(user.id, host);
      if (!ticket.ok) {
        res.setHeader("Retry-After", "5");
        sendError(res, "rate_limited", "Previews are busy right now. Please retry shortly.");
        return;
      }
      pending = (async () => {
        try {
          const result = await deps.preview(link);
          return await store(client, { messageId, threadId, digest, result, body, log: logOf(req) });
        } finally {
          ticket.release();
        }
      })();
      inflight.set(messageId, pending);
      void pending.finally(() => inflight.delete(messageId)).catch(() => {});
    }
    const answer = await pending;
    if (answer === "unavailable") {
      sendError(res, "degraded_unavailable", "We could not save this preview right now. Please try again shortly.");
      return;
    }
    res.json(answer);
  };
}

type StoredRead = { kind: "absent" } | { kind: "row"; row: StoredPreviewRow } | { kind: "unavailable"; err: unknown };

async function readStoredPreview(client: any, messageId: string): Promise<StoredRead> {
  const { data, error } = await client
    .from("message_link_previews")
    .select(PREVIEW_ROW_COLUMNS)
    .eq("message_id", messageId)
    .maybeSingle();
  if (error) return { kind: "unavailable", err: error };
  return data ? { kind: "row", row: data as StoredPreviewRow } : { kind: "absent" };
}

function answerForRow(row: StoredPreviewRow, body: string): PostAnswer {
  const wire = servablePreview(row, body);
  if (wire) return { kind: "preview", preview: wire };
  return noPreview(row.status === "none" && row.source_digest === sourceDigest(body) ? "none" : "stale");
}

/** Hand the fetched result to 3825's writer and translate its outcome. */
async function store(
  client: any,
  input: { messageId: string; threadId: string; digest: string; result: PreviewResult; body: string; log: { error: (...a: unknown[]) => void } },
): Promise<PostAnswer | "unavailable"> {
  const p = input.result.kind === "preview" ? input.result.preview : null;
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await client.rpc("telegraph_store_link_preview", {
      p_message_id: input.messageId,
      p_thread_id: input.threadId,
      p_source_digest: input.digest,
      p_status: p ? "ok" : "none",
      p_url: p ? p.url : null,
      p_host: p ? p.host : null,
      p_title: p ? p.title : null,
      p_description: p ? p.description : null,
      p_site_name: p ? p.siteName : null,
    }));
  } catch (err) {
    error = err;
  }
  if (error || !isStoreOutcome(data)) {
    input.log.error({ err: error, outcome: data, messageId: input.messageId }, "link preview: store failed or answered an unknown outcome");
    return "unavailable";
  }
  switch (data) {
    case "stored":
      return p
        ? { kind: "preview", preview: { messageId: input.messageId, url: p.url, host: p.host, title: p.title, description: p.description, siteName: p.siteName } }
        : noPreview("none");
    case "exists": {
      // Another process stored first; serve what it stored, never this fetch.
      const again = await readStoredPreview(client, input.messageId);
      if (again.kind === "unavailable") return "unavailable";
      return again.kind === "row" ? answerForRow(again.row, input.body) : noPreview("message_gone");
    }
    case "stale":
      return noPreview("stale");
    case "message_gone":
    case "e2ee":
      return noPreview("message_gone");
  }
}

/** `ids=a,b,c` → distinct uuids, or null when malformed / empty / over the cap. */
export function parseIds(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > LINK_PREVIEW_BATCH_MAX || !ids.every(isUuid)) return null;
  return ids;
}

/** The GET. It takes no network dependency at all: it cannot fetch. */
export function linkPreviewGetHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const threadId = String(req.params.threadId ?? "");
    if (!isUuid(threadId)) { sendError(res, "invalid_payload", "Invalid thread id"); return; }
    const ids = parseIds(req.query.ids);
    if (!ids) { sendError(res, "invalid_payload", `ids must be 1–${LINK_PREVIEW_BATCH_MAX} message ids, comma-separated`); return; }
    res.setHeader("Cache-Control", "private, no-store");

    if (!(await isFlagEnabled(client, "telegraph_link_previews_enabled"))) { res.json({ previews: [] }); return; }

    const boundOn = await historyBoundEnabled(client);
    // Two literal column lists rather than `membershipSelect(...)` (telegraphForward.ts's reason):
    // check:write-path-columns resolves literals only, and `visible_from_at` must not be named on a
    // database without 2400 (bound flag OFF).
    const members = boundOn
      ? client.from("message_thread_members").select("user_id, left_at, visible_from_at")
      : client.from("message_thread_members").select("user_id, left_at");
    const { data: membership, error: membershipErr } = await members
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .is("left_at", null)
      .maybeSingle();
    if (membershipErr) { unavailable(req, res, "membership", membershipErr, { threadId }); return; }
    if (!membership) { sendError(res, "forbidden", "Not a member of this thread"); return; }
    const visibleFrom = visibleFromOf(membership as any, boundOn);

    const { data: thread, error: threadErr } = await client
      .from("message_threads")
      .select("id, is_e2ee")
      .eq("id", threadId)
      .maybeSingle();
    if (threadErr) { unavailable(req, res, "thread", threadErr, { threadId }); return; }
    if (!thread || (thread as any).is_e2ee !== false) { res.json({ previews: [] }); return; }

    const { data: messages, error: messagesErr } = await applyHistoryWindow(
      client
        .from("messages")
        .select("id, sender_id, body, msg_type, subtype, created_at, deleted_at")
        .eq("thread_id", threadId)
        .in("id", ids),
      visibleFrom,
      user.id,
    );
    if (messagesErr) { unavailable(req, res, "messages", messagesErr, { threadId }); return; }

    const readable = ((messages ?? []) as Array<Record<string, unknown>>).filter((m) =>
      !m.deleted_at &&
      isPreviewableKind(m.msg_type, m.subtype) &&
      withinWindow(m.created_at as string | null, visibleFrom, { senderId: m.sender_id as string, viewerId: user.id }));
    const kept = await dropBlockedSenders(client, user.id, readable);
    if (!kept.ok) { unavailable(req, res, "block state", null, { threadId }); return; }
    if (kept.rows.length === 0) { res.json({ previews: [] }); return; }

    const bodyById = new Map(kept.rows.map((m) => [String(m.id), m.body]));
    const { data: rows, error: rowsErr } = await client
      .from("message_link_previews")
      .select(PREVIEW_ROW_COLUMNS)
      .eq("thread_id", threadId)
      .in("message_id", [...bodyById.keys()]);
    if (rowsErr) { unavailable(req, res, "stored previews", rowsErr, { threadId }); return; }

    const previews: WirePreview[] = [];
    for (const row of (rows ?? []) as StoredPreviewRow[]) {
      if (!bodyById.has(row.message_id)) continue;
      const wire = servablePreview(row, bodyById.get(row.message_id));
      if (wire) previews.push(wire);
    }
    res.json({ previews });
  };
}

/** The router, with the real network and one process-wide gate unless a suite injects its own. */
export function createLinkPreviewRouter(deps: Partial<LinkPreviewDeps> = {}): Router {
  const full: LinkPreviewDeps = {
    preview: deps.preview ?? createPreviewService(),
    gate: deps.gate ?? new OutboundFetchGate(),
    now: deps.now ?? (() => Date.now()),
  };
  const router = Router();
  router.post("/threads/:threadId/messages/:messageId/link-preview", asyncHandler(linkPreviewPostHandler(full)));
  router.get("/threads/:threadId/link-previews", asyncHandler(linkPreviewGetHandler()));
  return router;
}

export default createLinkPreviewRouter();
