/**
 * Cross-instance realtime fan-out for the Telegraph event bus.
 *
 * Uses Supabase Realtime broadcast to propagate events from one API server
 * instance to all other instances.  Each instance:
 *
 *   1. Generates a unique INSTANCE_ID at startup.
 *   2. Subscribes to the shared 'telegraph:events' Realtime channel.
 *   3. Tags outgoing broadcasts with its INSTANCE_ID.
 *   4. Ignores incoming broadcasts that originated from itself.
 *   5. Delivers remote events only to local subscribers (via publishToUsersLocal),
 *      not via publishToUsers, to avoid re-broadcasting in an infinite loop.
 *
 * The mobile client always retains polling as a fallback, so if the Realtime
 * channel is temporarily unavailable the only impact is slightly stale push
 * delivery — correctness is never compromised.
 *
 * initTelegraphBroadcast() is a no-op when SUPABASE_URL or
 * SUPABASE_SERVICE_ROLE_KEY are absent, allowing the server to start
 * without credentials (local dev / tests).
 */

import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger";
import { setBroadcastHook, publishToUsersLocal, type TelegraphEvent } from "./telegraphEvents";

const CHANNEL_NAME = "telegraph:events";
const BROADCAST_EVENT = "publish";

/** Opaque identifier for this process. */
const INSTANCE_ID: string = (() => {
  // crypto.randomUUID() is available in Node 14.17+ / v16+.
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
})();

interface BroadcastPayload {
  sourceInstanceId: string;
  userIds: string[];
  event: TelegraphEvent;
}

/**
 * Initialise the cross-instance broadcast channel.  Must be called once after
 * the server starts listening (e.g. inside app.listen callback).
 *
 * Safe to call in environments without Supabase credentials — logs a warning
 * and returns without throwing.
 */
export function initTelegraphBroadcast(): void {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    logger.warn(
      "telegraphBroadcast: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set " +
        "— cross-instance broadcast disabled, falling back to local-only delivery",
    );
    return;
  }

  logger.info(
    { instanceId: INSTANCE_ID, channel: CHANNEL_NAME },
    "telegraphBroadcast: initialising",
  );

  // Dedicated client for the persistent Realtime WebSocket.  Not shared with
  // the per-request service client (which is short-lived and has no Realtime).
  const realtimeClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      params: {
        // Allow up to 100 events/second from this server.
        eventsPerSecond: 100,
      },
    },
  });

  const channel = realtimeClient.channel(CHANNEL_NAME, {
    config: {
      broadcast: {
        // Do not echo our own messages back to us — the sender already
        // delivered locally.  We still use sourceInstanceId as a belt-
        // and-suspenders guard for future flexibility.
        self: false,
        ack: false,
      },
    },
  });

  // Receive broadcasts from other instances and deliver to local subscribers.
  channel.on(
    "broadcast",
    { event: BROADCAST_EVENT },
    ({ payload }: { payload: BroadcastPayload }) => {
      if (!payload) return;
      // Double-check: ignore our own messages if 'self: false' isn't honoured.
      if (payload.sourceInstanceId === INSTANCE_ID) return;
      if (!Array.isArray(payload.userIds) || !payload.event) return;

      logger.debug(
        { sourceInstance: payload.sourceInstanceId, type: payload.event.type, count: payload.userIds.length },
        "telegraphBroadcast: received remote event",
      );

      publishToUsersLocal(payload.userIds, payload.event);
    },
  );

  channel.subscribe((status, err) => {
    if (status === "SUBSCRIBED") {
      logger.info(
        { instanceId: INSTANCE_ID, channel: CHANNEL_NAME },
        "telegraphBroadcast: subscribed — multi-instance fan-out active",
      );
    } else if (status === "CHANNEL_ERROR") {
      logger.warn({ err }, "telegraphBroadcast: channel error — remote delivery degraded");
    } else if (status === "TIMED_OUT") {
      logger.warn("telegraphBroadcast: subscription timed out — Realtime will retry");
    } else if (status === "CLOSED") {
      logger.info("telegraphBroadcast: channel closed");
    }
  });

  // Wire the broadcast hook into the event bus so publishToUsers() fans out
  // to other instances automatically.
  setBroadcastHook((userIds, event) => {
    // channel.send returns a Promise — we fire-and-forget but log failures.
    channel
      .send({
        type: "broadcast",
        event: BROADCAST_EVENT,
        payload: { sourceInstanceId: INSTANCE_ID, userIds, event } satisfies BroadcastPayload,
      })
      .then((result) => {
        if (result === "rate limited") {
          logger.warn(
            { type: event.type, recipientCount: userIds.length },
            "telegraphBroadcast: rate limited — event not delivered to remote instances",
          );
        } else if (result === "timed out") {
          logger.warn(
            { type: event.type },
            "telegraphBroadcast: send timed out — remote delivery may be delayed",
          );
        }
      })
      .catch((err: unknown) => {
        logger.warn({ err, type: event.type }, "telegraphBroadcast: send threw");
      });
  });
}
