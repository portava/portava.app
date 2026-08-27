/**
 * KeyPackages — E-1 MLS key package pool management.
 *
 * KeyPackages are one-shot: each is consumed when a new MLS group is created
 * with this device as a recipient. The client maintains a pool (default 10)
 * and refills when inventory drops below a threshold.
 *
 * Routes:
 *   POST /me/devices/:deviceId/key-packages        — upload a batch
 *   GET  /me/devices/:deviceId/key-packages/inventory — check pool size
 *   GET  /users/:userId/key-packages/consume        — consume one KP (for group creation)
 *
 * The stored KeyPackage is PUBLIC material (the private leaf key never leaves
 * the client). Consuming a KeyPackage is a destructive server operation — the
 * consumer gets back the bytes needed to add the device to an MLS group.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isUuid } from "../lib/followDecisions.js";

const router = Router();

// ── POST /me/devices/:deviceId/key-packages ───────────────────────────────────
// Upload a batch of KeyPackages (base64url-encoded TLS bytes, public material only).
// Body: { keyPackages: string[] }   (max 50 per upload)
router.post("/me/devices/:deviceId/key-packages", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const deviceId = req.params.deviceId;
  if (!isUuid(deviceId)) {
    sendError(res, "invalid_payload", "Invalid device id");
    return;
  }

  const keyPackages: unknown = req.body?.keyPackages;
  if (!Array.isArray(keyPackages) || keyPackages.length === 0 || keyPackages.length > 50) {
    sendError(res, "invalid_payload", "keyPackages must be a non-empty array of at most 50 items");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  // Verify device belongs to this user
  const { data: device } = await sc
    .from("devices")
    .select("id, key_package_count")
    .eq("id", deviceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!device) {
    sendError(res, "not_found", "Device not found");
    return;
  }

  // Insert each KeyPackage
  const rows = (keyPackages as string[]).map((kpB64) => ({
    device_id: deviceId,
    key_package_b64: kpB64,
  }));

  const { error: insertError } = await sc.from("key_packages").insert(rows);
  if (insertError) {
    req.log.error({ err: insertError }, "key-packages: insert failed");
    sendError(res, "db_error", "Failed to store KeyPackages", { exposeDetail: true });
    return;
  }

  // Update pool count on the device row
  const newCount = ((device as any).key_package_count ?? 0) + keyPackages.length;
  await sc
    .from("devices")
    .update({ key_package_count: newCount })
    .eq("id", deviceId);

  res.status(201).json({ uploaded: keyPackages.length, totalPool: newCount });
});

// ── GET /me/devices/:deviceId/key-packages/inventory ─────────────────────────
// Check how many KeyPackages remain in the pool for this device.
router.get("/me/devices/:deviceId/key-packages/inventory", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const deviceId = req.params.deviceId;
  if (!isUuid(deviceId)) {
    sendError(res, "invalid_payload", "Invalid device id");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  const { data, error } = await sc
    .from("devices")
    .select("key_package_count")
    .eq("id", deviceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) {
    sendError(res, "not_found", "Device not found");
    return;
  }

  res.json({ count: (data as any).key_package_count ?? 0 });
});

// ── GET /users/:userId/key-packages/consume ───────────────────────────────────
// Consume one KeyPackage from the target user's most-recently-seen device.
// Used when creating a new E2EE thread: the initiator needs one KP per recipient device.
//
// Returns the consumed KP bytes (base64) and the device ID it came from.
// The KP is DELETED from the pool — this operation is not reversible.
router.get("/users/:userId/key-packages/consume", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const targetUserId = req.params.userId;
  if (!isUuid(targetUserId)) {
    sendError(res, "invalid_payload", "Invalid user id");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "service client unavailable"); return; }

  // Find target user's most recently active device that has pool inventory
  const { data: device } = await sc
    .from("devices")
    .select("id")
    .eq("user_id", targetUserId)
    .gt("key_package_count", 0)
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!device) {
    sendError(res, "no_key_package", "No KeyPackages available for this user");
    return;
  }

  // Consume one KeyPackage ATOMICALLY (oldest first) + decrement the pool count.
  // A prior SELECT-then-DELETE let two concurrent consumers receive the SAME
  // one-shot key (MLS key reuse); consume_key_package (migration 2177) claims a
  // single row with FOR UPDATE SKIP LOCKED so concurrent callers never collide.
  const { data: consumed, error: consumeErr } = await sc.rpc("consume_key_package", {
    p_device_id: (device as any).id,
  });
  const row = Array.isArray(consumed) ? consumed[0] : consumed;
  if (consumeErr || !row) {
    sendError(res, "no_key_package", "No KeyPackages available");
    return;
  }

  res.json({
    keyPackageB64: (row as any).key_package_b64,
    deviceId: (device as any).id,
  });
});

export default router;
