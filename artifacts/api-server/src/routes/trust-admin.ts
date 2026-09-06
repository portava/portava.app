/**
 * Admin trust routes — all protected by admin role.
 *
 * Mounted at /api (so full paths are /api/admin/trust/...).
 *
 * GET    /admin/trust/reviews                      — paginated review queue
 * GET    /admin/trust/users/:userId                — full admin trust view
 * POST   /admin/trust/events/:eventId/confirm      — confirm pending event
 * POST   /admin/trust/events/:eventId/dismiss      — dismiss pending event
 * POST   /admin/trust/users/:userId/restrict       — apply restriction
 * POST   /admin/trust/restrictions/:id/remove      — lift restriction (POST + body)
 * POST   /admin/trust/users/:userId/cap/override   — lift a cap early
 * GET    /admin/trust/gaming-flags                 — suspected gaming rings
 * POST   /admin/trust/gaming-flags/:id/mark-reviewed — dismiss a gaming flag
 * GET    /admin/trust/settings                     — read trust settings
 * PUT    /admin/trust/settings/:key                — update one trust setting + async recalc
 */
import { Router } from "express";
import { logAdminAccess, accessReason } from "../lib/adminAudit.js";
import { z } from "zod";
import { sendError } from "../lib/http.js";
import {
  confirmEvent,
  dismissEvent,
  adminApplyRestriction,
  adminLiftRestriction,
  adminResolveReview,
} from "../services/trust/TrustAdminService.js";
import { getTrustProfile, recalculateTrustScore } from "../services/trust/TrustScoreService.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { getActiveCapsResult, liftCap } from "../services/trust/TrustCapService.js";
import type { RestrictionType } from "../services/trust/TrustRestrictionService.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

const TRUST_SETTING_KEYS = new Set([
  "weight_plan_attendance", "weight_host_quality", "weight_communication",
  "weight_respect_safety", "weight_location_honesty", "weight_content_quality",
  "weight_community_value", "weight_guide_accuracy", "weight_passport_auth",
  "decay_half_life_days",
  "level_building_trust", "level_reliable", "level_trusted",
  "level_highly_trusted", "level_city_trusted",
  "daily_cap_plan_attend", "daily_cap_guide_verify", "daily_cap_gem_save",
  "weekly_cap_plan_attend", "weekly_cap_guide_verify", "weekly_cap_gem_save",
  "gaming_checkin_cluster_limit", "gaming_mutual_rate_threshold", "gaming_rapid_jump_points",
]);

// ── GET /admin/trust/reviews ─────────────────────────────────────────────────

router.get("/admin/trust/reviews", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page       = Math.max(1, Number(req.query.page) || 1);
  const limit      = Math.min(100, Number(req.query.limit) || 50);
  const type       = (req.query.type as string) || null;
  const status     = (req.query.status as string) || null;
  const assignedTo = (req.query.assigned_to as string) || null;

  let query = sc
    .from("trust_reviews")
    .select(
      "id, user_id, review_type, status, source_event_id, assigned_to, notes, metadata, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: true })
    .range((page - 1) * limit, page * limit - 1);

  if (type)       query = query.eq("review_type", type);
  if (status)     query = query.eq("status", status);
  else            query = query.in("status", ["open", "in_progress"]);
  if (assignedTo) query = query.eq("assigned_to", assignedTo);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  void logAdminAccess(sc, admin.userId, "profile", "list", "view", accessReason(req));
  res.json({ reviews: data ?? [], total: count ?? 0, page });
});

// ── GET /admin/trust/users/:userId ───────────────────────────────────────────

router.get("/admin/trust/users/:userId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { userId } = req.params;
  if (!UUID.test(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  const [profile, capsRes, restrictionsRes, eventsRes, reviewsRes] = await Promise.all([
    getTrustProfile(sc, userId),
    // Result form, not the array: an admin deciding whether a ceiling still
    // holds this account down must not read a failed trust_caps query as "no
    // ceilings". See getActiveCapsResult.
    getActiveCapsResult(sc, userId),
    sc
      .from("trust_restrictions")
      .select("id, restriction_type, reason, expires_at, created_at, lifted_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    sc
      .from("trust_events")
      .select("id, event_type, category, delta, severity, status, source_type, metadata, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    sc
      .from("trust_reviews")
      .select("id, review_type, status, metadata, created_at")
      .eq("user_id", userId)
      .in("status", ["open", "in_progress"])
      .limit(20),
  ]);

  void logAdminAccess(sc, admin.userId, "profile", userId, "expand", accessReason(req));
  res.json({
    userId,
    profile:      profile ?? null,
    caps:            capsRes.caps,
    /** True when `caps` is empty because the read failed, not because there are none. */
    capsUnavailable: capsRes.failed,
    restrictions: (restrictionsRes.data as any[]) ?? [],
    events:       (eventsRes.data as any[]) ?? [],
    openReviews:  (reviewsRes.data as any[]) ?? [],
  });
});

// ── POST /admin/trust/events/:eventId/confirm ────────────────────────────────

const ConfirmSchema = z.object({
  reason: z.string().min(1).max(500),
});

router.post("/admin/trust/events/:eventId/confirm", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const { eventId } = req.params;
  if (!UUID.test(eventId)) { sendError(res, "invalid_payload", "Invalid eventId"); return; }

  const parsed = ConfirmSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "reason required"); return; }

  try {
    const result = await confirmEvent(sc, userId, eventId, parsed.data.reason);
    res.json(result);
  } catch (err: any) {
    sendError(res, "invalid_payload", err?.message ?? "Could not confirm event");
  }
});

// ── POST /admin/trust/events/:eventId/dismiss ────────────────────────────────

router.post("/admin/trust/events/:eventId/dismiss", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const { eventId } = req.params;
  if (!UUID.test(eventId)) { sendError(res, "invalid_payload", "Invalid eventId"); return; }

  const parsed = ConfirmSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "reason required"); return; }

  try {
    const result = await dismissEvent(sc, userId, eventId, parsed.data.reason);
    res.json(result);
  } catch (err: any) {
    sendError(res, "invalid_payload", err?.message ?? "Could not dismiss event");
  }
});

// ── POST /admin/trust/users/:userId/restrict ─────────────────────────────────

const RestrictSchema = z.object({
  restrictionType: z.enum(["hosting", "private_plan_access", "messaging", "location_plan_join"]),
  reason:          z.string().min(1).max(500),
  expiresAt:       z.string().nullable().optional(),
});

router.post("/admin/trust/users/:userId/restrict", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { userId } = req.params;
  if (!UUID.test(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  const parsed = RestrictSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  try {
    const result = await adminApplyRestriction(
      sc, adminId, userId,
      parsed.data.restrictionType as RestrictionType,
      parsed.data.reason,
      parsed.data.expiresAt ?? null,
    );
    // Await so the restricted user's cache is stale before we respond
    await invalidateCompassCache(sc, userId, "admin_restrict");
    res.status(201).json(result);
  } catch (err: any) {
    sendError(res, "db_error", err?.message ?? "Could not apply restriction");
  }
});

// ── POST /admin/trust/restrictions/:id/remove ────────────────────────────────

const LiftSchema = z.object({
  reason:     z.string().min(1).max(500),
  targetUser: z.string().regex(UUID, "targetUser must be a valid UUID"),
});

router.post("/admin/trust/restrictions/:id/remove", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid restriction id"); return; }

  const parsed = LiftSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  try {
    const result = await adminLiftRestriction(sc, adminId, parsed.data.targetUser, id, parsed.data.reason);
    // Await so the affected user's compass cache is cleared before we respond
    await invalidateCompassCache(sc, parsed.data.targetUser, "trust_restriction_lifted");
    res.json(result);
  } catch (err: any) {
    sendError(res, "db_error", err?.message ?? "Could not lift restriction");
  }
});

// ── POST /admin/trust/users/:userId/cap/override ─────────────────────────────

const CapOverrideSchema = z.object({
  capId:  z.string().regex(UUID, "capId must be a valid UUID"),
  reason: z.string().min(1).max(500),
});

router.post("/admin/trust/users/:userId/cap/override", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { userId } = req.params;
  if (!UUID.test(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  const parsed = CapOverrideSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }

  try {
    await liftCap(sc, parsed.data.capId, adminId);
    // Fire-and-forget score recalculation after cap is lifted
    recalculateTrustScore(sc, userId).catch(() => {});
    await sc.from("trust_admin_actions").insert({
      admin_id:    adminId,
      target_user: userId,
      action_type: "lift_cap",
      reason:      parsed.data.reason,
      source_id:   parsed.data.capId,
      metadata:    {},
    });
    // Await so the affected user's compass cache is cleared before we respond
    await invalidateCompassCache(sc, userId, "trust_cap_lifted");
    res.json({ ok: true, capId: parsed.data.capId });
  } catch (err: any) {
    sendError(res, "db_error", err?.message ?? "Could not lift cap");
  }
});

// ── GET /admin/trust/gaming-flags ────────────────────────────────────────────

router.get("/admin/trust/gaming-flags", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error } = await sc
    .from("trust_reviews")
    .select("id, user_id, review_type, status, metadata, created_at")
    .eq("review_type", "gaming_suspected")
    .in("status", ["open", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  void logAdminAccess(sc, admin.userId, "profile", "list", "view", accessReason(req));
  res.json({ flags: data ?? [], total: (data ?? []).length });
});

// ── POST /admin/trust/gaming-flags/:id/mark-reviewed ────────────────────────

router.post("/admin/trust/gaming-flags/:id/mark-reviewed", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { id } = req.params;
  if (!UUID.test(id)) { sendError(res, "invalid_payload", "Invalid review id"); return; }

  const parsed = z.object({ notes: z.string().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "Invalid body"); return; }

  try {
    const result = await adminResolveReview(sc, adminId, id, "dismissed", parsed.data?.notes);
    res.json(result);
  } catch (err: any) {
    sendError(res, "invalid_payload", err?.message ?? "Could not resolve review");
  }
});

// ── GET /admin/trust/settings ────────────────────────────────────────────────

router.get("/admin/trust/settings", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("trust_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ settings: data ?? {} });
});

// ── PUT /admin/trust/settings/:key ───────────────────────────────────────────

router.put("/admin/trust/settings/:key", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { key } = req.params;
  if (!TRUST_SETTING_KEYS.has(key)) {
    sendError(res, "invalid_payload", `Unknown trust setting key: ${key}`);
    return;
  }

  const parsed = z.object({ value: z.number() }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", "value must be a number"); return; }

  const { data, error } = await sc
    .from("trust_settings")
    .update({ [key]: parsed.data.value, updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select("*")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }

  // Audit log (fire-and-forget — wrap in real Promise so .catch() is available)
  Promise.resolve().then(() =>
    sc.from("trust_admin_actions").insert({
      admin_id:    adminId,
      target_user: adminId,
      action_type: "score_override",
      reason:      `Updated trust setting ${key} to ${parsed.data.value}`,
      metadata:    { key, value: parsed.data.value },
    }),
  ).catch(() => {});

  // Fire-and-forget: recalculate all users' scores so the new weights/decay take effect.
  // Read all user_ids from trust_profiles in one query, then recalc each sequentially.
  setImmediate(() => {
    sc.from("trust_profiles")
      .select("user_id")
      .limit(1000)
      .then(({ data: profiles }: { data: any[] | null }) => {
        if (!profiles?.length) return;
        const ids: string[] = profiles.map((p: any) => p.user_id);
        ids.reduce((chain: Promise<void>, uid: string) =>
          chain.then(() => recalculateTrustScore(sc, uid).then(() => {}).catch(() => {})),
          Promise.resolve(),
        );
      })
      .catch(() => {});
  });

  res.json({ settings: data ?? {}, updated: { key, value: parsed.data.value } });
});

export default router;
