"use strict";
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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initTelegraphBroadcast = initTelegraphBroadcast;
var node_crypto_1 = require("node:crypto");
var supabase_js_1 = require("@supabase/supabase-js");
var logger_1 = require("./logger");
var telegraphEvents_1 = require("./telegraphEvents");
var CHANNEL_NAME = "telegraph:events";
var BROADCAST_EVENT = "publish";
/** Versioned prefix so a schema change automatically invalidates old signatures. */
var HMAC_CONTEXT = "telegraph-broadcast-v1";
/** Opaque identifier for this process instance. */
var INSTANCE_ID = (function () {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return "".concat(Date.now(), "-").concat(Math.random().toString(36).slice(2));
})();
// ── HMAC helpers ──────────────────────────────────────────────────────────────
/**
 * Derive a channel-specific signing secret from the service role key.
 * We never use the raw key as an HMAC secret directly.
 */
function deriveSecret(serviceKey) {
    return (0, node_crypto_1.createHmac)("sha256", serviceKey).update(HMAC_CONTEXT).digest("hex");
}
/**
 * Produce a deterministic, canonical signature for the fields that matter for
 * delivery integrity. We sort userIds so ordering differences don't affect the
 * signature.
 */
function signPayload(instanceId, userIds, event, secret) {
    var canonical = "".concat(instanceId, "|").concat(__spreadArray([], userIds, true).sort().join(","), "|").concat(event.type, "|").concat(event.ts);
    return (0, node_crypto_1.createHmac)("sha256", secret).update(canonical).digest("hex");
}
/** Constant-time HMAC verification to prevent timing attacks. */
function verifySignature(payload, secret) {
    if (!payload.sig)
        return false;
    var expected = signPayload(payload.sourceInstanceId, payload.userIds, payload.event, secret);
    var a = Buffer.from(payload.sig, "hex");
    var b = Buffer.from(expected, "hex");
    if (a.length !== b.length || a.length === 0)
        return false;
    try {
        return (0, node_crypto_1.timingSafeEqual)(a, b);
    }
    catch (_a) {
        return false;
    }
}
// ── Initialisation ────────────────────────────────────────────────────────────
/**
 * Initialise the cross-instance broadcast channel.  Must be called once after
 * the server starts listening.  Safe to call without credentials — logs a
 * warning and returns without throwing.
 */
function initTelegraphBroadcast() {
    var supabaseUrl = process.env.SUPABASE_URL;
    var serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
        logger_1.logger.warn("telegraphBroadcast: credentials absent — cross-instance broadcast disabled, " +
            "falling back to local-only delivery");
        return;
    }
    var secret = deriveSecret(serviceKey);
    logger_1.logger.info({ instanceId: INSTANCE_ID, channel: CHANNEL_NAME }, "telegraphBroadcast: initialising");
    // Dedicated long-lived client for the persistent Realtime WebSocket.
    // Not shared with the per-request service client (which is short-lived).
    var realtimeClient = (0, supabase_js_1.createClient)(supabaseUrl, serviceKey, {
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
    var channel = realtimeClient.channel(CHANNEL_NAME, {
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
    channel.on("broadcast", { event: BROADCAST_EVENT }, function (_a) {
        var _b;
        var payload = _a.payload;
        // Basic shape guard before touching the payload.
        if (!payload ||
            typeof payload.sourceInstanceId !== "string" ||
            !Array.isArray(payload.userIds) ||
            typeof payload.event !== "object" ||
            payload.event === null ||
            typeof payload.sig !== "string") {
            logger_1.logger.warn("telegraphBroadcast: malformed payload — rejected");
            return;
        }
        // Ignore our own broadcasts (redundant given self: false, but defensive).
        if (payload.sourceInstanceId === INSTANCE_ID)
            return;
        // Verify authenticity — reject forged or tampered payloads.
        if (!verifySignature(payload, secret)) {
            logger_1.logger.warn({ sourceInstance: payload.sourceInstanceId, type: (_b = payload.event) === null || _b === void 0 ? void 0 : _b.type }, "telegraphBroadcast: HMAC verification failed — payload rejected");
            return;
        }
        logger_1.logger.debug({
            sourceInstance: payload.sourceInstanceId,
            type: payload.event.type,
            recipientCount: payload.userIds.length,
        }, "telegraphBroadcast: received verified remote event");
        // Deliver to local subscribers without re-broadcasting (avoids loops).
        (0, telegraphEvents_1.publishToUsersLocal)(payload.userIds, payload.event);
    });
    // ── Channel status ──────────────────────────────────────────────────────────
    channel.subscribe(function (status, err) {
        if (status === "SUBSCRIBED") {
            logger_1.logger.info({ instanceId: INSTANCE_ID, channel: CHANNEL_NAME }, "telegraphBroadcast: subscribed to private channel — multi-instance fan-out active");
        }
        else if (status === "CHANNEL_ERROR") {
            logger_1.logger.warn({ err: err }, "telegraphBroadcast: channel error — remote delivery degraded");
        }
        else if (status === "TIMED_OUT") {
            logger_1.logger.warn("telegraphBroadcast: subscription timed out — Realtime will retry");
        }
        else if (status === "CLOSED") {
            logger_1.logger.info("telegraphBroadcast: channel closed");
        }
    });
    // ── Register the broadcast hook ─────────────────────────────────────────────
    // Wire into the event bus so publishToUsers() automatically fans out to other
    // instances after delivering locally.
    (0, telegraphEvents_1.setBroadcastHook)(function (userIds, event) {
        var payload = {
            sourceInstanceId: INSTANCE_ID,
            userIds: userIds,
            event: event,
            sig: signPayload(INSTANCE_ID, userIds, event, secret),
        };
        channel
            .send({
            type: "broadcast",
            event: BROADCAST_EVENT,
            payload: payload,
        })
            .then(function (result) {
            if (result === "rate limited") {
                logger_1.logger.warn({ type: event.type, recipientCount: userIds.length }, "telegraphBroadcast: rate limited — event not delivered to remote instances");
            }
            else if (result === "timed out") {
                logger_1.logger.warn({ type: event.type }, "telegraphBroadcast: send timed out — remote delivery may be delayed");
            }
        })
            .catch(function (err) {
            logger_1.logger.warn({ err: err, type: event.type }, "telegraphBroadcast: send threw");
        });
    });
}
