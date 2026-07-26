/**
 * Cross-instance realtime fan-out for the Telegraph event bus.
 *
 * Uses Supabase Realtime broadcast on a *private* channel so that only
 * server-side clients (using the service role key, which bypasses RLS) can
 * join. Mobile clients that hold the public anon key cannot subscribe to
 * private channels without an explicit Realtime authorization policy — and
 * we create none for this channel.
 *
 * Every outbound payload is signed with HMAC-SHA256 (key derived from the
 * service role secret). Incoming payloads are verified before delivery.
 * This means even if a client somehow subscribes, they cannot inject events
 * without the service role secret.
 *
 * Each instance:
 *   1. Generates a unique INSTANCE_ID at startup.
 *   2. Subscribes to the private 'telegraph:events' channel with self: false.
 *   3. Signs outgoing payloads; tags them with INSTANCE_ID.
 *   4. On receipt, verifies the HMAC and ignores its own payloads (via INSTANCE_ID).
 *   5. Delivers verified remote events only via publishToUsersLocal to avoid
 *      re-broadcasting and infinite loops.
 *
 * initTelegraphBroadcast() is a no-op when credentials are absent (local dev
 * / tests) — local-only delivery continues to work.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { logger } from "./logger";
import {
  setBroadcastHook,
  setTerminateBroadcastHook,
  publishToUsersLocal,
  terminateUserConnectionsLocal,
  type TelegraphEvent,
} from "./telegraphEvents";

const CHANNEL_NAME = "telegraph:events";
const BROADCAST_EVENT = "publish";
/** Broadcast event name for cross-instance connection termination signals. */
const TERMINATE_EVENT = "terminate";
/** Versioned prefix so a schema change automatically invalidates old signatures. */
const HMAC_CONTEXT = "telegraph-broadcast-v1";

/** Opaque identifier for this process instance. */
const INSTANCE_ID: string = (() => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
})();

// ── HMAC helpers ──────────────────────────────────────────────────────────────

/**
 * Derive a channel-specific signing secret from the service role key.
 * We never use the raw key as an HMAC secret directly.
 */
function deriveSecret(serviceKey: string): string {
  return createHmac("sha256", serviceKey).update(HMAC_CONTEXT).digest("hex");
}

/**
 * Produce a deterministic, canonical signature for the fields that matter for
 * delivery integrity. We sort userIds so ordering differences don't affect the
 * signature.
 */
function signPayload(
  instanceId: string,
  userIds: string[],
  event: TelegraphEvent,
  secret: string,
): string {
  const canonical = `${instanceId}|${[...userIds].sort().join(",")}|${event.type}|${event.ts}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

/** Constant-time HMAC verification to prevent timing attacks. */
function verifySignature(
  payload: BroadcastPayload,
  secret: string,
): boolean {
  if (!payload.sig) return false;
  const expected = signPayload(
    payload.sourceInstanceId,
    payload.userIds,
    payload.event,
    secret,
  );
  const a = Buffer.from(payload.sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface BroadcastPayload {
  /** Which instance produced this payload — receivers ignore their own. */
  sourceInstanceId: string;
  /** User IDs the event should be delivered to. */
  userIds: string[];
  /** The event to relay. */
  event: TelegraphEvent;
  /** HMAC-SHA256 authenticity signature. */
  sig: string;
}

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Initialise the cross-instance broadcast channel.  Must be called once after
 * the server starts listening.  Safe to call without credentials — logs a
 * warning and returns without throwing.
 */
export function initTelegraphBroadcast(): void {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    logger.warn(
      "telegraphBroadcast: credentials absent — cross-instance broadcast disabled, " +
        "falling back to local-only delivery",
    );
    return;
  }

  const secret = deriveSecret(serviceKey);

  logger.info(
    { instanceId: INSTANCE_ID, channel: CHANNEL_NAME },
    "telegraphBroadcast: initialising",
  );

  // Dedicated long-lived client for the persistent Realtime WebSocket.
  // Not shared with the per-request service client (which is short-lived).
  const realtimeClient = createClient<Database>(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      params: {
        // Allow up to 100 events/second from this server instance.
        eventsPerSecond: 100,
      },
    },
  });

  // Private channel: only service-role clients (which bypass RLS) can join.
  // Anon-key clients require an explicit Realtime authorization policy, which
  // we never create for this channel — so they are denied.
  const channel = realtimeClient.channel(CHANNEL_NAME, {
    config: {
      private: true,
      broadcast: {
        // Do not echo our own messages; INSTANCE_ID check is belt-and-suspenders.
        self: false,
        ack: false,
      },
    },
  });

  // ── Receive remote events ───────────────────────────────────────────────────

  channel.on(
    "broadcast",
    { event: BROADCAST_EVENT },
    ({ payload }: { payload: BroadcastPayload }) => {
      // Basic shape guard before touching the payload.
      if (
        !payload ||
        typeof payload.sourceInstanceId !== "string" ||
        !Array.isArray(payload.userIds) ||
        typeof payload.event !== "object" ||
        payload.event === null ||
        typeof payload.sig !== "string"
      ) {
        logger.warn("telegraphBroadcast: malformed payload — rejected");
        return;
      }

      // Ignore our own broadcasts (redundant given self: false, but defensive).
      if (payload.sourceInstanceId === INSTANCE_ID) return;

      // Verify authenticity — reject forged or tampered payloads.
      if (!verifySignature(payload, secret)) {
        logger.warn(
          { sourceInstance: payload.sourceInstanceId, type: payload.event?.type },
          "telegraphBroadcast: HMAC verification failed — payload rejected",
        );
        return;
      }

      logger.debug(
        {
          sourceInstance: payload.sourceInstanceId,
          type: payload.event.type,
          recipientCount: payload.userIds.length,
        },
        "telegraphBroadcast: received verified remote event",
      );

      // Deliver to local subscribers without re-broadcasting (avoids loops).
      publishToUsersLocal(payload.userIds, payload.event);
    },
  );

  // ── Receive remote terminate signals ────────────────────────────────────────
  // Mirror of the publish receive handler, but calls terminateUserConnectionsLocal
  // instead of publishToUsersLocal, so revocations issued on other instances
  // immediately close matching connections here without re-broadcasting.

  channel.on(
    "broadcast",
    { event: TERMINATE_EVENT },
    ({ payload }: { payload: BroadcastPayload }) => {
      if (
        !payload ||
        typeof payload.sourceInstanceId !== "string" ||
        !Array.isArray(payload.userIds) ||
        typeof payload.event !== "object" ||
        payload.event === null ||
        typeof payload.sig !== "string"
      ) {
        logger.warn("telegraphBroadcast: malformed terminate payload — rejected");
        return;
      }
      if (payload.sourceInstanceId === INSTANCE_ID) return;
      if (!verifySignature(payload, secret)) {
        logger.warn(
          { sourceInstance: payload.sourceInstanceId },
          "telegraphBroadcast: terminate HMAC verification failed — rejected",
        );
        return;
      }
      logger.debug(
        { sourceInstance: payload.sourceInstanceId, count: payload.userIds.length },
        "telegraphBroadcast: received verified terminate signal",
      );
      for (const uid of payload.userIds) {
        if (typeof uid === "string" && uid) terminateUserConnectionsLocal(uid);
      }
    },
  );

  // ── Channel status ──────────────────────────────────────────────────────────

  channel.subscribe((status, err) => {
    if (status === "SUBSCRIBED") {
      logger.info(
        { instanceId: INSTANCE_ID, channel: CHANNEL_NAME },
        "telegraphBroadcast: subscribed to private channel — multi-instance fan-out active",
      );
    } else if (status === "CHANNEL_ERROR") {
      logger.warn(
        { err },
        "telegraphBroadcast: channel error — remote delivery degraded",
      );
    } else if (status === "TIMED_OUT") {
      logger.warn(
        "telegraphBroadcast: subscription timed out — Realtime will retry",
      );
    } else if (status === "CLOSED") {
      logger.info("telegraphBroadcast: channel closed");
    }
  });

  // ── Register the broadcast hook ─────────────────────────────────────────────

  // Wire into the event bus so publishToUsers() automatically fans out to other
  // instances after delivering locally.
  setBroadcastHook((userIds, event) => {
    const payload: BroadcastPayload = {
      sourceInstanceId: INSTANCE_ID,
      userIds,
      event,
      sig: signPayload(INSTANCE_ID, userIds, event, secret),
    };

    channel
      .send({
        type: "broadcast",
        event: BROADCAST_EVENT,
        payload,
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

  // ── Register the terminate hook ──────────────────────────────────────────────

  // Wire terminateUserConnections() into the cross-instance channel so that
  // revocation (e.g. after a block) reaches SSE connections on other instances.
  setTerminateBroadcastHook((userId) => {
    const event: TelegraphEvent = {
      type: "access.revoked",
      ts: new Date().toISOString(),
    };
    const payload: BroadcastPayload = {
      sourceInstanceId: INSTANCE_ID,
      userIds: [userId],
      event,
      sig: signPayload(INSTANCE_ID, [userId], event, secret),
    };

    channel
      .send({ type: "broadcast", event: TERMINATE_EVENT, payload })
      .then((result) => {
        if (result === "rate limited") {
          logger.warn({ userId }, "telegraphBroadcast: terminate rate limited — remote close delayed");
        } else if (result === "timed out") {
          logger.warn({ userId }, "telegraphBroadcast: terminate send timed out");
        }
      })
      .catch((err: unknown) => {
        logger.warn({ err, userId }, "telegraphBroadcast: terminate send threw");
      });
  });
}
