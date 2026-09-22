/**
 * Telegraph realtime delivery — Server-Sent Events (SSE) transport.
 *
 * GET  /api/telegraph/stream   — long-lived SSE connection; pushes per-user
 *                                events from the in-memory bus (telegraphEvents).
 * POST /api/threads/:threadId/typing — typing relay (no persistence); fans out
 *                                typing.started / typing.stopped to other members.
 *
 * Auth: SSE clients (EventSource) cannot set Authorization headers, so the
 * stream accepts the bearer token either in the Authorization header OR a
 * `?token=` query param. The token is verified via Supabase Auth getUser()
 * (Auth endpoint, not PostgREST) exactly like requireUser().
 *
 * The mobile client always retains polling as a fallback, so this transport is
 * an enhancement, never a hard dependency.
 *
 * RECONNECT RESUME (§17.3)
 * ========================
 * census-telegraph T233 recorded this stream as carrying no cursor: it closed
 * at thirty minutes and the client re-authenticated from scratch, with gap
 * recovery delegated entirely to polling. It now carries one.
 *
 * WHAT IS RESUMED IS THE CONVERSATION, NOT THE EVENT LOG. The bus is in-memory
 * and lossy by design (census T369) — there is no durable event log to replay,
 * and pretending otherwise would mean inventing one. What IS durable is
 * `messages`, so a resume re-reads the rows that landed in the caller's live
 * threads while they were away and replays them as `message.created` frames
 * marked `replay: true`. Transient events — typing, presence — are NOT replayed
 * and cannot be: a typing indicator from four minutes ago is a false statement
 * about the present, not a recovered fact about the past.
 *
 * THE CURSOR IS A TIMESTAMP AND IT IS INCLUSIVE. `messages` has no sequence
 * column on this tree (census T228: `messages.sequence` exists only in
 * migration 2810, which no database has), so the cursor is expressed in
 * `created_at` coordinates — the same convention migration 2400 used for the
 * §14.3 visibility bound, and for the same reason. `created_at` is not unique,
 * so the comparison is `>=` rather than `>`: the boundary row is re-sent rather
 * than risked. A duplicate is something the client already absorbs — every
 * replayed frame carries a messageId and a `replay` marker — and a gap is
 * recoverable by nothing.
 *
 * A RESUME THAT DID NOT HAPPEN SAYS SO. `stream.resumed` is emitted on every
 * connection, whether or not a cursor was supplied and whether or not the read
 * worked, and `resumed: false` is the instruction to fall back to a full poll.
 * This matters most in the failure case: supabase-js resolves `{data: null,
 * error}` on a database error, so an unchecked read would make "nothing arrived
 * while you were away" byte-identical to "we could not look", and a client that
 * believed the first would stop polling and lose the conversation.
 */

import { Router } from "express";
import { getServiceClient } from "../lib/supabase";
import { requireUser, sendError } from "../lib/http";
import { logger as rootLogger } from "../lib/logger.js";
import {
  subscribe,
  registerTerminator,
  publishToThread,
  type TelegraphEvent,
} from "../lib/telegraphEvents";
import {
  historyBoundEnabled,
  membershipSelect,
  visibleFromOf,
  withinWindow,
} from "../services/groupChatHistoryBound.js";

const router = Router();

const log = rootLogger.child({ route: "telegraphStream" });

const UUID = /^[0-9a-f-]{36}$/i;

/** Heartbeat keeps proxies from closing the idle socket and detects dead peers. */
const HEARTBEAT_MS = 25_000;

/**
 * Maximum lifetime for a single SSE connection.  After this interval the
 * server sends a `reconnect` event and closes the socket so the client
 * re-authenticates.  This ensures revoked sessions (blocked user, privacy
 * change) cannot hold open an indefinite connection.
 */
const MAX_CONNECTION_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How far back a resume cursor may reach.
 *
 * Beyond this the answer is a refusal rather than a truncated replay, because a
 * truncated replay is the one outcome a client cannot tell from a complete one.
 * Twenty-four hours is chosen so that a phone that spent a night offline
 * resumes; a device gone longer than that syncs from the list endpoint, which
 * is paginated and cheaper than fanning a week of history down a socket.
 */
const MAX_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Ceiling on replayed rows. A client that hits it is told `truncated: true` AND
 * `resumed: false` — a partial replay that reported success would leave a hole
 * the client had no reason to look for.
 */
const MAX_RESUME_MESSAGES = 200;

/** Threads scanned for a resume. A member of more is told to poll instead. */
const MAX_RESUME_THREADS = 200;

/** Why a resume did or did not close the gap. */
type ResumeReason =
  | "ok"
  | "no_cursor"
  | "cursor_invalid"
  | "cursor_too_old"
  | "read_failed"
  | "too_many_threads"
  | "truncated";

interface ResumeOutcome {
  resumed: boolean;
  reason: ResumeReason;
  since: string | null;
  replayed: number;
  truncated: boolean;
}

/** Parse and bound a client-supplied cursor. Returns null when unusable. */
function parseCursor(raw: unknown): { iso: string } | { bad: ResumeReason } {
  if (typeof raw !== "string" || raw.trim() === "") return { bad: "no_cursor" };
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return { bad: "cursor_invalid" };
  const now = Date.now();
  // A future cursor is not "too old"; it is not a cursor this server issued, so
  // it is refused as malformed rather than clamped into something plausible.
  if (t > now + 60_000) return { bad: "cursor_invalid" };
  if (now - t > MAX_RESUME_WINDOW_MS) return { bad: "cursor_too_old" };
  return { iso: new Date(t).toISOString() };
}

/**
 * Read the messages that landed in the caller's LIVE threads at or after the
 * cursor.
 *
 * Every read here binds its error. A roster that cannot be read admits NOTHING
 * — an empty audience and an unreadable one are different facts, and only one
 * of them means "you missed nothing".
 */
async function readResume(
  sc: ReturnType<typeof getServiceClient>,
  userId: string,
  since: string,
): Promise<
  | { rows: Array<Record<string, unknown>>; truncated: boolean }
  | { failed: ResumeReason }
> {
  if (!sc) return { failed: "read_failed" };

  // §14.3. The roster read is also where the caller's per-thread history bound
  // comes from, because the resume spans EVERY live thread and each one has its
  // own window. See the window comment below the message read.
  const boundOn = await historyBoundEnabled(sc);

  const { data: memberRows, error: memberErr } = await sc
    .from("message_thread_members")
    // Conditional: while the bound is off this is the byte-identical
    // `select('thread_id')` it has always been, so a database without 2400 is
    // never asked for the column.
    .select(membershipSelect("thread_id", boundOn))
    .eq("user_id", userId)
    .is("left_at", null)
    .limit(MAX_RESUME_THREADS + 1);

  if (memberErr) {
    log.error(
      { userId, code: (memberErr as any)?.code, err: memberErr },
      "stream resume: roster read FAILED — resuming nothing and telling the client to poll",
    );
    return { failed: "read_failed" };
  }

  const roster = (memberRows ?? []) as Array<{ thread_id?: string; visible_from_at?: string | null }>;
  const threadIds = roster
    .map((r) => r.thread_id)
    .filter((t): t is string => typeof t === "string");

  if (threadIds.length === 0) return { rows: [], truncated: false };
  if (threadIds.length > MAX_RESUME_THREADS) return { failed: "too_many_threads" };

  const windowByThread = new Map<string, string | null>();
  for (const r of roster) {
    if (typeof r.thread_id === "string") {
      windowByThread.set(r.thread_id, visibleFromOf(r, boundOn));
    }
  }

  const { data: msgRows, error: msgErr } = await sc
    .from("messages")
    .select("id,thread_id,sender_id,msg_type,subtype,created_at")
    .in("thread_id", threadIds)
    // INCLUSIVE — see the file header. `created_at` is not unique.
    .gte("created_at", since)
    // The caller's own sends are not a gap in their conversation; their client
    // wrote them optimistically and already holds them.
    .neq("sender_id", userId)
    .order("created_at", { ascending: true })
    .limit(MAX_RESUME_MESSAGES + 1);

  if (msgErr) {
    log.error(
      { userId, code: (msgErr as any)?.code, err: msgErr },
      "stream resume: message read FAILED — resuming nothing and telling the client to poll",
    );
    return { failed: "read_failed" };
  }

  const raw = (msgRows ?? []) as Array<Record<string, unknown>>;
  // A replay is a RETRIEVAL, so §14.3 applies to it exactly as it applies to
  // GET /threads/:id/messages.
  //
  // THE CURSOR IS THE CLIENT'S, AND THE BOUND IS NOT. `since` comes back from
  // the browser as Last-Event-ID (or `?since=`), and it is only clamped to the
  // 24h window — a member added to a trip thread ten minutes ago can present a
  // cursor from yesterday and, without this filter, be replayed the frames of
  // messages sent before they were added. The frames carry no body, but they
  // carry the message id, the sender and the timestamp: that is the existence
  // and the authorship of a pre-membership message, which is the metadata half
  // of the same disclosure, and the id is a handle for every other read.
  //
  // FILTERED PER THREAD, not by one global floor: each membership row has its
  // own `visible_from_at`, and a caller with ten threads has up to ten windows.
  // A NULL window (pre-2400 row, or a §14.1 grant) admits everything, so while
  // the flag is OFF every window is null and this loop is the identity.
  //
  // `truncated` is computed on the RAW read, not on the windowed set: the limit
  // was hit or it was not, and that fact decides whether the client is told to
  // poll. Deciding it after the filter could report a complete resume while
  // windowed rows sat beyond the limit — the one outcome the header says a
  // client cannot detect.
  const truncated = raw.length > MAX_RESUME_MESSAGES;
  const rows = raw.filter((r) =>
    withinWindow(
      typeof r.created_at === "string" ? r.created_at : null,
      windowByThread.get(String(r.thread_id)) ?? null,
    ),
  );

  return { rows, truncated };
}

router.get("/telegraph/stream", async (req, res) => {
  // Token from Authorization header (preferred) or ?token= query (EventSource).
  const authHeader = req.headers.authorization;
  let token: string | null = null;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else if (typeof req.query.token === "string" && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    sendError(res, "unauthenticated", "Missing token");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const { data, error } = await sc.auth.getUser(token);
  if (error || !data?.user) {
    sendError(res, "unauthenticated", "Invalid token");
    return;
  }
  const userId = data.user.id;

  // Open the SSE stream.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering so events flush immediately.
    "X-Accel-Buffering": "no",
  });
  /**
   * One SSE frame, with an `id:` line.
   *
   * The id is the event's own timestamp, which is what makes resume work
   * WITHOUT any client change: a browser/React-Native EventSource records the
   * last id it saw and sends it back as `Last-Event-ID` on its automatic
   * reconnect, so the cursor round-trips through the transport rather than
   * through application state a client has to remember to keep.
   */
  const frame = (id: string | null, event: string, data: unknown) => {
    try {
      res.write(
        `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    } catch {
      // Socket is closing; cleanup handlers will run.
    }
  };

  const connectedAt = new Date().toISOString();
  frame(connectedAt, "connected", { userId, ts: connectedAt });

  const send = (evt: TelegraphEvent) => { frame(evt.ts ?? null, evt.type, evt); };

  const unsubscribe = subscribe(userId, send);

  // ── §17.3 resume ────────────────────────────────────────────────────────────
  // Runs BEFORE the live subscription is useful to the client but AFTER it is
  // registered, so an event arriving mid-replay is delivered rather than lost.
  // The client dedupes on messageId, which it must do anyway for the inclusive
  // cursor boundary.
  const cursor = parseCursor(
    typeof req.headers["last-event-id"] === "string" && req.headers["last-event-id"]
      ? req.headers["last-event-id"]
      : req.query.since,
  );

  let outcome: ResumeOutcome;
  if ("bad" in cursor) {
    outcome = { resumed: false, reason: cursor.bad, since: null, replayed: 0, truncated: false };
  } else {
    const result = await readResume(sc, userId, cursor.iso);
    if ("failed" in result) {
      outcome = { resumed: false, reason: result.failed, since: cursor.iso, replayed: 0, truncated: false };
    } else {
      // `truncated` is decided by readResume on the RAW read, before the §14.3
      // window filter, so a bound that removed rows cannot turn a truncated
      // replay into a reported-complete one.
      const truncated = result.truncated;
      const rows = result.rows.slice(0, MAX_RESUME_MESSAGES);
      for (const r of rows) {
        frame(String(r.created_at ?? ""), "message.created", {
          type: "message.created",
          threadId: r.thread_id ?? null,
          ts: r.created_at ?? cursor.iso,
          payload: {
            messageId: r.id,
            senderId: r.sender_id,
            msgType: r.msg_type ?? "text",
            subtype: r.subtype ?? null,
            createdAt: r.created_at,
            // A replayed frame is labelled. A client that cannot tell a replay
            // from a live arrival will re-notify for messages the person has
            // already been notified about.
            replay: true,
          },
        });
      }
      outcome = {
        // A truncated replay is NOT a resume. Reporting success here would
        // leave a hole the client has no reason to look for.
        resumed: !truncated,
        reason: truncated ? "truncated" : "ok",
        since: cursor.iso,
        replayed: rows.length,
        truncated,
      };
    }
  }

  frame(null, "stream.resumed", { type: "stream.resumed", ...outcome, ts: new Date().toISOString() });

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // ignore — cleanup will handle a dead socket
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    clearTimeout(maxAgeTimer);
    unregisterTerminator();
    unsubscribe();
  };

  /**
   * Terminator: called by terminateUserConnections() when access is revoked
   * (e.g. after a block).  Sends an access.revoked signal then closes.
   * The data payload includes `type` so the client parser can dispatch it
   * to registered listeners before the socket closes.
   */
  const terminate = () => {
    try {
      res.write(
        `event: access.revoked\ndata: ${JSON.stringify({ type: "access.revoked", code: 4403, ts: new Date().toISOString() })}\n\n`,
      );
    } catch { /* socket already gone */ }
    res.end();
  };
  const unregisterTerminator = registerTerminator(userId, terminate);

  /**
   * Maximum connection lifetime — forces a reconnect so the client
   * re-authenticates.  Ensures revoked sessions (block, privacy change) cannot
   * hold an SSE connection open indefinitely.
   * The data payload includes `type` so the client parser can react immediately
   * (reset failure count, reconnect with a fresh token).
   */
  const maxAgeTimer = setTimeout(() => {
    try {
      res.write(
        `event: reconnect\ndata: ${JSON.stringify({ type: "reconnect", reason: "max_age", ts: new Date().toISOString() })}\n\n`,
      );
    } catch { /* socket already gone */ }
    res.end();
  }, MAX_CONNECTION_AGE_MS);
  maxAgeTimer.unref?.();

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
});

/**
 * POST /api/threads/:threadId/typing
 * Body: { typing: boolean }
 * Relays a typing indicator to the other active members of the thread. Not
 * persisted — purely transient presence. Members-only.
 */
router.post("/threads/:threadId/typing", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const { threadId } = req.params;
  if (!UUID.test(threadId)) {
    sendError(res, "invalid_payload", "Invalid thread id");
    return;
  }

  const typing = req.body?.typing === true;

  // Members-only: verify active membership before relaying.
  //
  // census-telegraph §20.7: this read discarded its error. supabase-js resolves
  // `{ data: null, error }` on a database error rather than throwing, so an
  // unreadable `message_thread_members` was indistinguishable from a genuine
  // non-member and this route answered "Not a member of this thread" — a claim
  // about the caller's own membership that no read supports, and a 403 the
  // client will not retry.
  const { data: membership, error: membershipErr } = await client
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();

  if (membershipErr) {
    log.error(
      { threadId, userId: user.id, message: (membershipErr as any).message },
      "typing membership read failed",
    );
    sendError(
      res,
      "degraded_unavailable",
      "We could not check your membership of this conversation just now. Please try again shortly.",
    );
    return;
  }

  if (!membership) {
    sendError(res, "forbidden", "Not a member of this thread");
    return;
  }

  // Fire-and-forget fan-out; never block the response on delivery.
  void publishToThread(
    client,
    threadId,
    {
      type: typing ? "typing.started" : "typing.stopped",
      payload: { userId: user.id },
    },
    { excludeUserId: user.id },
  );

  res.status(200).json({ ok: true, typing });
});

export default router;
