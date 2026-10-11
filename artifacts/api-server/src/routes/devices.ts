/**
 * Devices — E-0/E-1 per-install cryptographic device registration.
 *
 * E-0: clients register their platform and get a stable device ID back.
 *      public_key is nullable — populated in E-1 when OpenMLS keys are generated.
 *
 * E-1: POST/PUT /me/crypto-devices/:id/public-key populates the Ed25519
 *      identity public key.
 *
 * Routes live under /me/crypto-devices (renamed from /me/devices to avoid
 * colliding with the push-token routes in notifications.ts).
 *
 * These endpoints require authentication — anonymous callers are rejected.
 * The device list for a user is visible to the server (metadata only).
 * Private key material never leaves the client device.
 */

import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isUuid } from "../lib/followDecisions.js";
import { bearerToken, DeviceRegistryUnreadableError, recordDeviceSession, revokeDevice } from "../lib/deviceRevocation.js";
import { presentedDeviceId } from "../lib/preciseLocationDevice.js";
import { isFlagEnabled } from "../lib/featureFlags.js";

const router = Router();

// ── POST /me/crypto-devices ──────────────────────────────────────────────────
// Register a new device entry. Returns the stable device ID to store in
// SecureStore on the client.
// Body: { platform: 'ios'|'android'|'web', deviceFingerprint?: string }
router.post("/me/crypto-devices", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const platform = req.body?.platform;
  if (!platform || !["ios", "android", "web"].includes(platform)) {
    sendError(res, "invalid_payload", "platform must be 'ios', 'android', or 'web'");
    return;
  }

  const deviceFingerprint: string | null =
    typeof req.body?.deviceFingerprint === "string"
      ? req.body.deviceFingerprint.slice(0, 128)
      : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  // If a fingerprint is provided, check whether this device is already registered.
  // This prevents duplicate entries across app restarts.
  if (deviceFingerprint) {
    // supabase-js RESOLVES on a DB error, so an unbound `error` made an
    // unreadable devices table look like "this fingerprint is new" and fell
    // through to the INSERT — minting a SECOND device id for the same physical
    // device. The client stores the new id, and the original row keeps the
    // public_key and key_package_count the peers already trust, so the device's
    // crypto identity is orphaned. Refuse rather than fork it.
    const { data: existing, error: existingErr } = await sc
      .from("devices")
      .select("id, platform, public_key, key_package_count, created_at, last_seen_at")
      .eq("user_id", user.id)
      .eq("device_fingerprint", deviceFingerprint)
      .maybeSingle();

    if (existingErr) {
      req.log.error({ err: existingErr }, "devices: fingerprint lookup failed — refusing to register a duplicate device");
      sendError(res, "db_error", "Failed to register device");
      return;
    }

    if (existing) {
      // Update last_seen_at and return the existing record
      await sc
        .from("devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", (existing as any).id);
      await noteDeviceHeartbeat(req, sc, user.id, (existing as any).id);
      res.status(200).json({ device: existing });
      return;
    }
  }

  const { data, error } = await sc
    .from("devices")
    .insert({
      user_id: user.id,
      platform,
      device_fingerprint: deviceFingerprint,
      last_seen_at: new Date().toISOString(),
    })
    .select("id, platform, public_key, key_package_count, created_at, last_seen_at")
    .single();

  if (error || !data) {
    req.log.error({ err: error }, "devices: insert failed");
    sendError(res, "db_error", "Failed to register device");
    return;
  }

  await noteDeviceHeartbeat(req, sc, user.id, (data as any).id);
  res.status(201).json({ device: data });
});

// ── GET /me/crypto-devices ────────────────────────────────────────────────────
// List all registered devices for the authenticated user.
router.get("/me/crypto-devices", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  const { data, error } = await sc
    .from("devices")
    .select("id, platform, public_key, key_package_count, created_at, last_seen_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    req.log.error({ err: error }, "devices: list failed");
    sendError(res, "db_error", "Failed to list devices");
    return;
  }

  res.json({ devices: data ?? [] });
});

// ── DELETE /me/crypto-devices/:id ─────────────────────────────────────────────
// Revoke a device (called on sign-out or device removal). §30A.7 (census-
// telegraph T401): this used to delete the row and nothing else, leaving the
// revoked phone its auth session, its open stream and its push. It now runs
// lib/deviceRevocation.ts revokeDevice — auth session, push tokens, precise
// binding, realtime connections, then the row — and REPORTS each step:
//   200 { ok: true,  complete: true,  revocation }  every step done
//   200 { ok: true,  complete: false, revocation }  done, but a link revocation
//        needs was missing (revocation.gaps names it) — never reported as complete
//   503 degraded_unavailable + revocation            a step FAILED; retry (idempotent)
//   503 degraded_unavailable                         the registry could not be read; nothing changed
// Conversation history is never touched.
router.delete("/me/crypto-devices/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const deviceId = req.params.id;
  if (!isUuid(deviceId)) {
    sendError(res, "invalid_payload", "Invalid device id");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  let revocation;
  try {
    revocation = await revokeDevice(sc, {
      userId: user.id,
      deviceId,
      callerToken: bearerToken(req.headers.authorization),
      callerDeviceId: presentedDeviceId(req.headers as unknown as Record<string, unknown>),
    });
  } catch (err) {
    if (err instanceof DeviceRegistryUnreadableError) {
      req.log.error({ err }, "devices: registry unreadable — nothing revoked");
      sendError(res, "degraded_unavailable", "Could not read the device registry. Nothing was revoked; please try again.");
      return;
    }
    throw err;
  }

  if (revocation.failed.length > 0) {
    req.log.error({ deviceId, steps: revocation.steps, failed: revocation.failed }, "devices: revocation INCOMPLETE — a step failed");
    res.status(503).json({
      error: "degraded_unavailable",
      message: "The device was not fully revoked. Please try again.",
      retryable: true,
      revocation,
    });
    return;
  }
  if (!revocation.complete) {
    req.log.warn({ deviceId, steps: revocation.steps, gaps: revocation.gaps }, "devices: revocation done with gaps");
  }
  res.status(200).json({ ok: true, complete: revocation.complete, revocation });
});

// ── POST /me/crypto-devices/:id/public-key ────────────────────────────────────
// E-1: populate the Ed25519 identity public key for this device.
// Called once per install after key generation.
// Registered for both POST (current client) and PUT (legacy) methods.
// Body: { publicKey: string (base64url, 32 bytes = 44 base64 chars) }
async function handlePublicKeyUpdate(req: Request, res: Response) {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const deviceId = req.params.id;
  if (typeof deviceId !== "string" || !isUuid(deviceId)) {
    sendError(res, "invalid_payload", "Invalid device id");
    return;
  }

  const publicKey = req.body?.publicKey;
  if (typeof publicKey !== "string" || publicKey.length < 40 || publicKey.length > 100) {
    sendError(res, "invalid_payload", "publicKey must be a base64url-encoded Ed25519 public key");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  // Verify device belongs to this user before writing
  const { data: existing } = await sc
    .from("devices")
    .select("id")
    .eq("id", deviceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!existing) {
    sendError(res, "not_found", "Device not found");
    return;
  }

  const { error } = await sc
    .from("devices")
    .update({ public_key: publicKey, last_seen_at: new Date().toISOString() })
    .eq("id", deviceId);

  if (error) {
    req.log.error({ err: error }, "devices: public-key update failed");
    sendError(res, "db_error", "Failed to update public key");
    return;
  }

  await noteDeviceHeartbeat(req, sc, user.id, deviceId);
  res.status(200).json({ ok: true });
}

router.post("/me/crypto-devices/:id/public-key", handlePublicKeyUpdate);
router.put("/me/crypto-devices/:id/public-key", handlePublicKeyUpdate);

// ── GET /users/:userId/devices ────────────────────────────────────────────────
// S2: peer device listing for safety-number verification. Auth-required, but
// no ownership requirement — public key material is public by design here.
// Returns only public fields.
router.get("/users/:userId/devices", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const userId = req.params.userId;
  if (!isUuid(userId)) {
    sendError(res, "invalid_payload", "Invalid user id");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  const { data, error } = await sc
    .from("devices")
    .select("id, platform, public_key, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    req.log.error({ err: error }, "devices: peer list failed");
    sendError(res, "db_error", "Failed to list devices");
    return;
  }

  const devices = ((data as any[]) ?? []).map((d) => ({
    id: d.id,
    platform: d.platform,
    publicKey: d.public_key ?? null,
    createdAt: d.created_at,
  }));

  res.json({ devices });
});


// ── §30A.7 registry heartbeat (census-telegraph T399 / T401) ─────────────────

/** Gate for writing the §30A.7 capability fields. Seeded FALSE by 3743. */
export const DEVICE_REGISTRY_FLAG = "telegraph_device_registry_enabled";

/**
 * The capability fields §30A.7 names, as a client declares them. Only booleans
 * are accepted; anything else is "not declared" (left NULL).
 */
export function declaredCapabilities(body: unknown): Record<string, boolean> {
  const c = (body as any)?.capabilities;
  if (!c || typeof c !== "object") return {};
  const out: Record<string, boolean> = {};
  if (typeof c.push === "boolean") out.push_capable = c.push;
  if (typeof c.voiceVideo === "boolean") out.voice_video_capable = c.voiceVideo;
  if (typeof c.proximity === "boolean") out.proximity_capable = c.proximity;
  if (typeof c.backgroundLocation === "boolean") out.background_location_capable = c.backgroundLocation;
  return out;
}

/**
 * Called on register and on the public-key call every launch makes:
 *   - records the auth session the device is calling from (the link device
 *     revocation needs to end that session) — not flag-gated: it is the
 *     security half, and it writes nothing a reader acts on except revocation;
 *   - when `telegraph_device_registry_enabled` is ON, records the capability
 *     fields the client declared. OFF (the seed): nothing is written.
 * Never fails the request: a missing column (3743 unapplied) is logged at debug.
 */
async function noteDeviceHeartbeat(req: Request, sc: any, userId: string, deviceId: string): Promise<void> {
  const linked = await recordDeviceSession(sc, userId, deviceId, bearerToken(req.headers.authorization));
  if (linked === "failed") req.log?.warn?.({ deviceId }, "devices: session link write failed — revoking this device could not end its session");
  else if (linked === "column_absent") req.log?.debug?.({ deviceId }, "devices: session link column absent (3743 unapplied)");

  const caps = declaredCapabilities(req.body);
  if (Object.keys(caps).length === 0) return;
  if (!(await isFlagEnabled(sc, DEVICE_REGISTRY_FLAG))) return;
  const { error } = await sc.from("devices").update(caps).eq("id", deviceId).eq("user_id", userId);
  if (error) req.log?.warn?.({ err: error, deviceId }, "devices: capability write failed");
}

export default router;
