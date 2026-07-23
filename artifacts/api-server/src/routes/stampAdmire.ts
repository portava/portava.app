/**
 * Stamp Admire — Stamp Wave 2 (spec Part 13).
 *
 *   POST   /api/stamps/:userStampId/admire     — admire a visible stamp
 *   DELETE /api/stamps/:userStampId/admire     — remove own admire
 *   GET    /api/stamps/:userStampId/admirers   — admirer list + count + admiredByMe
 *
 * Rules:
 *   - Flag-gated by stamp_admire_enabled.
 *   - You cannot admire your own stamp.
 *   - The stamp must be admirable by the caller: not revoked AND
 *     (visibility='public' OR caller is the owner). friends_only/private
 *     stamps are not admirable by others in this wave.
 *   - Duplicate admires collapse silently (idempotent 200).
 *   - First-time admire notifies the owner (passport.stamp_admired) —
 *     fire-and-forget, never blocks the response.
 *   - Admirer list is visible to the stamp owner and to anyone the stamp is
 *     public to.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";

const FLAG = "stamp_admire_enabled";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = Router();

interface StampRow {
  id: string;
  user_id: string;
  visibility: string;
  is_revoked: boolean;
  city: string | null;
  country: string | null;
  title_override: string | null;
}

async function loadStamp(sc: any, id: string): Promise<StampRow | null> {
  const { data, error } = await sc
    .from("user_stamps")
    .select("id, user_id, visibility, is_revoked, city, country, title_override")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as StampRow;
}

function canSee(stamp: StampRow, viewerId: string): boolean {
  if (stamp.is_revoked) return false;
  if (stamp.user_id === viewerId) return true;
  return stamp.visibility === "public";
}

// ── POST /api/stamps/:userStampId/admire ─────────────────────────────────────

router.post("/stamps/:userStampId/admire", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    sendError(res, "feature_disabled", "Stamp admire is not enabled");
    return;
  }

  const id = String(req.params.userStampId ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid stamp id"); return; }

  const stamp = await loadStamp(sc, id);
  if (!stamp || !canSee(stamp, user.id)) {
    sendError(res, "not_found", "Stamp not found");
    return;
  }
  if (stamp.user_id === user.id) {
    sendError(res, "invalid_payload", "You cannot admire your own stamp");
    return;
  }

  // Idempotent: duplicate admires are a silent 200.
  const { data: existing } = await sc
    .from("stamp_admires")
    .select("id")
    .eq("user_stamp_id", id)
    .eq("admirer_id", user.id)
    .maybeSingle();
  if (existing) {
    res.json({ admired: true, duplicate: true });
    return;
  }

  const { error: insErr } = await sc
    .from("stamp_admires")
    .insert({ user_stamp_id: id, admirer_id: user.id });
  if (insErr) { sendError(res, "db_error", insErr.message); return; }

  // Notify the owner — fire-and-forget.
  void (async () => {
    try {
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const { NotificationRouter } = await import("../services/notifications/NotificationRouter.js");
      const label = stamp.title_override ?? stamp.city ?? stamp.country ?? "travel";
      const notifSvc = new NotificationService(sc);
      const notifRouter = new NotificationRouter(sc);
      const row = await notifSvc.create({
        userId: stamp.user_id,
        eventType: "passport.stamp_admired",
        actorId: user.id,
        sourceType: "stamp_admire",
        sourceId: id,
        params: { stamp: String(label), stampId: id },
      });
      if (row) await notifRouter.route(row);
    } catch {}
  })();

  res.status(201).json({ admired: true });
}));

// ── DELETE /api/stamps/:userStampId/admire ───────────────────────────────────

router.delete("/stamps/:userStampId/admire", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    sendError(res, "feature_disabled", "Stamp admire is not enabled");
    return;
  }

  const id = String(req.params.userStampId ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid stamp id"); return; }

  const { error } = await sc
    .from("stamp_admires")
    .delete()
    .eq("user_stamp_id", id)
    .eq("admirer_id", user.id);
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ admired: false });
}));

// ── GET /api/stamps/:userStampId/admirers ────────────────────────────────────

router.get("/stamps/:userStampId/admirers", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }
  if (!(await isFlagEnabled(sc, FLAG))) {
    res.json({ count: 0, admiredByMe: false, admirers: [], enabled: false });
    return;
  }

  const id = String(req.params.userStampId ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid stamp id"); return; }

  const stamp = await loadStamp(sc, id);
  if (!stamp || !canSee(stamp, user.id)) {
    sendError(res, "not_found", "Stamp not found");
    return;
  }

  const { data, error } = await sc
    .from("stamp_admires")
    .select("admirer_id, created_at, profiles:admirer_id ( id, username, display_name, avatar_url )")
    .eq("user_stamp_id", id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) { sendError(res, "db_error", error.message); return; }

  const rows = (data ?? []) as any[];
  res.json({
    count: rows.length,
    admiredByMe: rows.some((r) => r.admirer_id === user.id),
    admirers: rows.map((r) => ({
      userId: r.admirer_id,
      admiredAt: r.created_at,
      username: r.profiles?.username ?? null,
      displayName: r.profiles?.display_name ?? null,
      avatarUrl: r.profiles?.avatar_url ?? null,
    })),
    enabled: true,
  });
}));

export default router;
