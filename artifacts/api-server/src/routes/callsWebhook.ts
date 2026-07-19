/**
 * LiveKit webhook endpoint — verified reconciliation input.
 *
 * MUST be mounted in app.ts BEFORE the global express.json() so the raw body
 * survives for signature verification (makeWebhookVerifier hashes the exact
 * bytes LiveKit signed). Unsigned/invalid payloads are rejected with 401 and
 * never processed. Duplicate deliveries are no-ops (reconciler idempotency).
 */
import express, { type RequestHandler } from "express";
import { getServiceClient } from "../lib/supabase";
import { logger } from "../lib/logger";
import {
  livekitEnvStatus, makeRoomAdmin, makeWebhookVerifier, readLivekitEnv,
} from "../lib/calls/livekitService";
import { reconcileWebhookEvent, type CallStore, type RoomAdminPort } from "../lib/calls/callReconciler";
import { makeCallStore } from "../lib/calls/callStoreAdapter";

export interface WebhookDeps {
  verifier: { receive(rawBody: string, authHeader: string | undefined): Promise<any> };
  store: () => CallStore | null;
  admin: () => RoomAdminPort;
}

let _testDeps: WebhookDeps | null = null;
export function _setTestWebhookDeps(deps: WebhookDeps | null): void {
  _testDeps = deps;
}

function realDeps(): WebhookDeps | null {
  if (!livekitEnvStatus().ok) return null;
  const env = readLivekitEnv();
  return {
    verifier: makeWebhookVerifier(env),
    store: () => {
      const sc = getServiceClient();
      return sc ? makeCallStore(sc) : null;
    },
    admin: () => makeRoomAdmin(env),
  };
}

export const callsWebhookHandler: RequestHandler = async (req, res) => {
  const deps = _testDeps ?? realDeps();
  if (!deps) return res.status(503).json({ error: "call_service_unavailable" });

  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
  let evt: { event: string; room?: { name?: string }; participant?: { identity?: string } };
  try {
    evt = await deps.verifier.receive(raw, req.get("Authorization"));
  } catch {
    return res.status(401).json({ error: "invalid_webhook_signature" });
  }

  try {
    const store = deps.store();
    if (!store) return res.status(503).json({ error: "service_unavailable" });
    await reconcileWebhookEvent(store, deps.admin(), evt, new Date().toISOString());
  } catch (err) {
    logger.error({ err, event: evt?.event }, "call webhook reconciliation failed");
    // 200 anyway: LiveKit retries are not useful for a processing bug and the
    // periodic sweep self-heals state.
  }
  return res.status(200).json({ ok: true });
};

/** Raw-body parser for the webhook path — mount ahead of express.json(). */
export const callsWebhookRawParser: RequestHandler = express.raw({ type: () => true, limit: "1mb" });
