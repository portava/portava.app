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
 */

import { Router } from "express";
import { getServiceClient } from "../lib/supabase";
import { requireUser, sendError } from "../lib/http";
import {
  subscribe,
  registerTerminator,
  publishToThread,
  type TelegraphEvent,
} from "../lib/telegraphEvents";

const router = Router();

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
  res.write(`event: connected\ndata: ${JSON.stringify({ userId, ts: new Date().toISOString() })}\n\n`);

  const send = (evt: TelegraphEvent) => {
    try {
      res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
    } catch {
      // Socket is closing; cleanup handlers will run.
    }
  };

  const unsubscribe = subscribe(userId, send);

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
  const { data: membership } = await client
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .eq("user_id", user.id)
    .is("left_at", null)
    .maybeSingle();

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
