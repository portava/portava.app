/**
 * Admin trust routes — all protected by admin role.
 *
 * Mounted at /api (so full paths are /api/admin/trust/...).
 *
 * GET    /admin/trust/reviews                      — paginated review queue
 * GET    /admin/trust/events/pending               — events awaiting confirm/dismiss
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
 *                                                     (value bounded per key — see SETTING_BOUNDS)
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
  getPendingEvents,
} from "../services/trust/TrustAdminService.js";
import { getTrustProfile, recalculateTrustScore } from "../services/trust/TrustScoreService.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { getActiveCaps, liftCap } from "../services/trust/TrustCapService.js";
import type { RestrictionType } from "../services/trust/TrustRestrictionService.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Structural bounds for each trust setting. These are NOT policy: the numbers
 * an operator picks inside a range are theirs. They are the ranges outside of
 * which the engine stops computing rather than computes something different:
 *
 *   - weights are fractions of the overall score (TrustScoreService multiplies
 *     each category by its weight and sums); a negative weight inverts a
 *     category and a weight above 1 lets one category exceed the 0–100 scale.
 *   - decay_half_life_days is the divisor in 2^(-age/halfLife): 0 makes every
 *     weight 2^-∞ = 0, so every score collapses to the neutral 50 and evidence
 *     weight reads 0 for everyone; a negative value makes OLDER events count
 *     MORE. The column is INTEGER, so a fraction is rejected by the database
 *     anyway — rejected here with a message instead of a 500.
 *   - level_* thresholds are compared against a 0–100 score.
 *   - the caps and gaming_checkin_cluster_limit are INTEGER counts.
 *   - gaming_mutual_rate_threshold is a rate (count / total) in [0, 1].
 *   - gaming_rapid_jump_points is compared against a 24-hour delta sum.
 *
 * The previous validator was `z.number()` — any finite number, including all
 * of the above — and the PUT's audit row would faithfully record the moment
 * the engine was zeroed.
 */
type SettingBound = { min: number; max: number; integer?: boolean; exclusiveMin?: boolean };
const WEIGHT: SettingBound = { min: 0, max: 1 };
const LEVEL: SettingBound = { min: 0, max: 100 };
const COUNT: SettingBound = { min: 0, max: 1_000_000, integer: true };
const SETTING_BOUNDS: Record<string, SettingBound> = {
  weight_plan_attendance: WEIGHT, weight_host_quality: WEIGHT, weight_communication: WEIGHT,
  weight_respect_safety: WEIGHT, weight_location_honesty: WEIGHT, weight_content_quality: WEIGHT,
  weight_community_value: WEIGHT, weight_guide_accuracy: WEIGHT, weight_passport_auth: WEIGHT,
  decay_half_life_days: { min: 1, max: 3650, integer: true },
  level_building_trust: LEVEL, level_reliable: LEVEL, level_trusted: LEVEL,
  level_highly_trusted: LEVEL, level_city_trusted: LEVEL,
  daily_cap_plan_attend: COUNT, daily_cap_guide_verify: COUNT, daily_cap_gem_save: COUNT,
  weekly_cap_plan_attend: COUNT, weekly_cap_guide_verify: COUNT, weekly_cap_gem_save: COUNT,
  gaming_checkin_cluster_limit: { min: 1, max: 1_000_000, integer: true },
  gaming_mutual_rate_threshold: { min: 0, max: 1 },
  gaming_rapid_jump_points: { min: 0, max: 1000, exclusiveMin: true },
};

const TRUST_SETTING_KEYS = new Set(Object.keys(SETTING_BOUNDS));

/** Exported for tests. Returns null when `value` is acceptable for `key`, else the reason. */
export function trustSettingRejection(key: string, value: unknown): string | null {
  const b = SETTING_BOUNDS[key];
  if (!b) return `Unknown trust setting key: ${key}`;
  if (typeof value !== "number" || !Number.isFinite(value)) return "value must be a finite number";
  if (b.integer && !Number.isInteger(value)) return `${key} must be an integer`;
  if (b.exclusiveMin ? value <= b.min : value < b.min) return `${key} must be ${b.exclusiveMin ? "greater than" : "at least"} ${b.min}`;
  if (value > b.max) return `${key} must be at most ${b.max}`;
  return null;
}

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

// ── GET /admin/trust/events/pending ──────────────────────────────────────────
//
// The events an admin can confirm or dismiss. TrustAdminService.getPendingEvents
// existed from the start and no route called it, so the only way to find a
// pending_review event was to already know which user to open. Pending events
// now also get a trust_reviews row (TrustEventService.queueEventForReview), so
// /admin/trust/reviews lists them; this endpoint is the direct view of the
// ledger itself, and the one that shows an event queued before that change.

router.get("/admin/trust/events/pending", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query.limit) || 50);
  // getPendingEvents THROWS on a read failure (it used to return []): an
  // unreachable ledger is reported as an error, never as an empty queue.
  let events: any[];
  try {
    events = await getPendingEvents(sc, limit);
  } catch (err: any) {
    sendError(res, "db_error", err?.message ?? "Could not read pending events");
    return;
  }
  void logAdminAccess(sc, admin.userId, "profile", "list", "view", accessReason(req));
  res.json({ events, total: events.length });
});

// ── GET /admin/trust/users/:userId ───────────────────────────────────────────

router.get("/admin/trust/users/:userId", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { userId } = req.params;
  if (!UUID.test(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  const [profile, caps, restrictionsRes, eventsRes, reviewsRes] = await Promise.all([
    getTrustProfile(sc, userId),
    getActiveCaps(sc, userId),
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

  // `trust_restrictions` is an EXCLUSION table: a row means this user is
  // restricted, and emptiness means they are not. supabase-js RESOLVES on a DB
  // error, so `restrictionsRes.data ?? []` rendered the identical empty array
  // for "this user has no restrictions" and for "the restrictions table could
  // not be read" — and this dossier is the screen a moderator decides on. A
  // fabricated clean record is the one answer that must never be served here:
  // it invites lifting a sanction that is still in force, or closing a review
  // on a user who is under one.
  //
  // There is no narrower honest answer than refusing. Shape 2 of
  // lib/exclusionSet.ts (empty just the block-scoped part) is exactly what the
  // defect already did; shape 3 applies — the restrictions ARE the finding, so
  // the response is refused with `degraded_unavailable` (503, retryable), the
  // code this codebase already uses for "the check could not be PERFORMED".
  // The PostgREST message is logged, never sent.
  if (restrictionsRes.error) {
    req.log?.error?.(
      { reason: restrictionsRes.error.message, subjectUserId: userId },
      "trust_restrictions unreadable — refusing rather than showing an admin a clean record",
    );
    sendError(res, "degraded_unavailable", "Trust restrictions could not be read. Please try again.");
    return;
  }

  void logAdminAccess(sc, admin.userId, "profile", userId, "expand", accessReason(req));
  res.json({
    userId,
    profile:      profile ?? null,
    caps,
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
  const rejection = trustSettingRejection(key, parsed.data.value);
  if (rejection) { sendError(res, "invalid_payload", rejection); return; }

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
