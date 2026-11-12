/**
 * KeyPackages — E-1 MLS key package pool management.
 *
 * KeyPackages are one-shot. Native clients retain one matching private pending
 * package and replenish after a Welcome has committed. Publication is atomic
 * and idempotent even after consumption (migration 4014).
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
import { checkRateLimit } from "../lib/rateLimit.js";

const router = Router();

/** Max KeyPackage consumes per requester per window (destructive one-shot op). */
const KEY_PACKAGE_CONSUME_LIMIT = parseInt(process.env["KEY_PACKAGE_CONSUME_LIMIT"] ?? "60", 10);
const KEY_PACKAGE_CONSUME_WINDOW_MS = 60 * 1_000; // 1 minute

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

  if (!keyPackages.every((value) => typeof value === "string" && value.length >= 4 && value.length <= 65536 && /^[A-Za-z0-9_+/=-]+$/.test(value))) {
    sendError(res, "invalid_payload", "KeyPackages must be base64-encoded public packages"); return;
  }
  const { data, error } = await sc.rpc("publish_key_packages", {
    p_owner_id: user.id, p_device_id: deviceId, p_packages: keyPackages,
  });
  if (error) {
    if (error.code === "42501") { sendError(res, "not_found", "Device not found"); return; }
    if (error.code === "22023" || error.code === "54000") { sendError(res, "invalid_payload", "Invalid key package batch or pool capacity exceeded"); return; }
    req.log.error({ code: error.code }, "key-packages: atomic publication failed");
    sendError(res, "db_error", "Failed to store KeyPackages"); return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !Number.isSafeInteger(row.uploaded) || !Number.isSafeInteger(row.total_pool) || row.uploaded < 0 || row.total_pool < 0) {
    sendError(res, "db_error", "KeyPackage publication was not confirmed"); return;
  }
  res.status(201).json({ uploaded: row.uploaded, totalPool: row.total_pool });
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

  // Rate limit per REQUESTER: consuming is a destructive one-shot operation (the
  // KeyPackage is deleted), so an authenticated caller could otherwise drain any
  // user's pool with a burst of requests, denying new E2EE threads until the
  // victim's client refills. A legitimate thread setup consumes one KP per
  // recipient device, so this cap is far above normal use.
  const rl = checkRateLimit(
    "key_package_consume", auth.user.id,
    KEY_PACKAGE_CONSUME_LIMIT, KEY_PACKAGE_CONSUME_WINDOW_MS,
  );
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    sendError(res, "rate_limited", "Too many key-package requests. Please slow down.");
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
  // device row before either publication or consumption; the ledger survives consumption.
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
