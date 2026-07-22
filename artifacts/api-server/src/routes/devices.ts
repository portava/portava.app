/**
 * Devices — E-0/E-1 per-install cryptographic device registration.
 *
 * E-0: clients register their platform and get a stable device ID back.
 *      public_key is nullable — populated in E-1 when OpenMLS keys are generated.
 *
 * E-1: PUT /:id/public-key populates the Ed25519 identity public key.
 *
 * These endpoints require authentication — anonymous callers are rejected.
 * The device list for a user is visible to the server (metadata only).
 * Private key material never leaves the client device.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isUuid } from "../lib/followDecisions.js";

const router = Router();

// ── POST /me/devices ─────────────────────────────────────────────────────────
// Register a new device entry. Returns the stable device ID to store in
// SecureStore on the client.
// Body: { platform: 'ios'|'android'|'web', deviceFingerprint?: string }
router.post("/me/devices", async (req, res) => {
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
    const { data: existing } = await sc
      .from("devices")
      .select("id, platform, public_key, key_package_count, created_at, last_seen_at")
      .eq("user_id", user.id)
      .eq("device_fingerprint", deviceFingerprint)
      .maybeSingle();

    if (existing) {
      // Update last_seen_at and return the existing record
      await sc
        .from("devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", (existing as any).id);
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

  res.status(201).json({ device: data });
});

// ── GET /me/devices ───────────────────────────────────────────────────────────
// List all registered devices for the authenticated user.
router.get("/me/devices", async (req, res) => {
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

// ── DELETE /me/devices/:id ────────────────────────────────────────────────────
// Deregister a device (called on sign-out or device removal).
router.delete("/me/devices/:id", async (req, res) => {
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

  const { error } = await sc
    .from("devices")
    .delete()
    .eq("id", deviceId)
    .eq("user_id", user.id); // RLS-equivalent guard: can only delete own devices

  if (error) {
    req.log.error({ err: error }, "devices: delete failed");
    sendError(res, "db_error", "Failed to deregister device");
    return;
  }

  res.status(200).json({ ok: true });
});

// ── PUT /me/devices/:id/public-key ────────────────────────────────────────────
// E-1: populate the Ed25519 identity public key for this device.
// Called once per install after key generation.
// Body: { publicKey: string (base64url, 32 bytes = 44 base64 chars) }
router.put("/me/devices/:id/public-key", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const deviceId = req.params.id;
  if (!isUuid(deviceId)) {
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

  res.status(200).json({ ok: true });
});

export default router;
