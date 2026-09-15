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
 * POST   /admin/trust/users/:userId/score/override — set a category CEILING
 * POST   /admin/trust/users/:userId/cap/override   — remove a score-override ceiling
 * GET    /admin/trust/gaming-flags                 — suspected gaming rings
 * POST   /admin/trust/gaming-flags/:id/mark-reviewed — dismiss a gaming flag
 * GET    /admin/trust/settings                     — read trust settings
 * PUT    /admin/trust/settings/:key                — update one trust setting + async recalc
 *                                                     (value bounded per key — see SETTING_BOUNDS)
 * GET    /admin/trust/maintenance/health          — trust maintenance scheduler health
 */
import { Router } from "express";
import { logAdminAccess, accessReason } from "../lib/adminAudit.js";
import { z } from "zod";
import { sendError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import {
  confirmEvent,
  dismissEvent,
  adminApplyRestriction,
  adminLiftRestriction,
  adminResolveReview,
  adminOverrideScore,
  adminRemoveOverride,
  getPendingEvents,
} from "../services/trust/TrustAdminService.js";
import { ALL_CATEGORIES, getTrustProfileResult, recalculateTrustScore } from "../services/trust/TrustScoreService.js";
import type { TrustCategory } from "../services/trust/TrustEventService.js";
import { listRestrictionsForAudit } from "../services/trust/TrustRestrictionService.js";
import { invalidate as invalidateCompassCache } from "../compass/CompassCacheEngine.js";
import { getActiveCaps, getCapForUser } from "../services/trust/TrustCapService.js";
import type { RestrictionType } from "../services/trust/TrustRestrictionService.js";

import { requireAdmin } from "../lib/requireAdmin.js";
import {
  getTrustMaintenanceStatus,
  MAINTENANCE_INTERVAL_MS,
  STARTUP_DELAY_MS,
  MAX_USERS_PER_PASS,
  STALE_DAYS,
} from "../lib/trustMaintenanceScheduler.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/** The nine scored categories, as a membership test for admin input. */
const TRUST_CATEGORIES = new Set<string>(ALL_CATEGORIES);

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

  const [profileRead, caps, restrictionsRes, eventsRes, reviewsRes] = await Promise.all([
    // getTrustProfileResult, not getTrustProfile. The lossy wrapper returns null
    // for "this user has no profile" and for "trust_profiles could not be read"
    // alike, and this dossier is the screen a moderator decides on — the same
    // reason the restrictions read below refuses rather than showing an empty
    // array. A missing profile is a fact about the user; an unreadable one is a
    // fact about the database, and a moderator must not be shown the first when
    // the truth is the second.
    getTrustProfileResult(sc, userId),
    getActiveCaps(sc, userId),
    // Through the service's audit read (census-trust C15/A17): route code names
    // no trust table. Mapped back into { data, error } so the refusal below is
    // unchanged — an unreadable EXCLUSION table must never render as a clean
    // record on a moderator's screen.
    listRestrictionsForAudit(sc, userId).then((r) =>
      r.state === "ok" ? { data: r.rows, error: null } : { data: null, error: { message: r.reason } },
    ),
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

  if (profileRead.state === "unavailable") {
    req.log?.error?.(
      { reason: profileRead.reason, subjectUserId: userId },
      "trust_profiles unreadable — refusing rather than showing an admin a user with no trust profile",
    );
    sendError(res, "degraded_unavailable", "The trust profile could not be read. Please try again.");
    return;
  }

  void logAdminAccess(sc, admin.userId, "profile", userId, "expand", accessReason(req));
  res.json({
    userId,
    profile:      profileRead.state === "ok" ? profileRead.profile : null,
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

// ── POST /admin/trust/users/:userId/score/override ───────────────────────────
//
// The apply half of the owner's ruling — CAP NOW, PIN LATER BEHIND A FLAG —
// and, until this route existed, a capability nobody had. `adminOverrideScore`
// has been the only admin-initiated ceiling writer in the product and had NO
// caller outside its own tests, so no admin could set a ceiling at all and the
// ruling governed an unreachable function.
//
// An override is a MAXIMUM. Events may still move the category below it; it
// cannot raise a score, and it does not take precedence over a moderation
// ceiling. The service reports which of those actually happened
// (`ceilingBinding`) rather than answering `{ ok: true }` to both, and this
// route passes that through unedited: an upward override that withheld nothing
// must not read to an admin like one that did.
//
// PIN semantics, expiry and two-admin precedence are NOT here. The flag they
// are meant to sit behind does not exist yet.

const ScoreOverrideSchema = z.object({
  category: z.string().min(1).max(64),
  score:    z.number().min(0).max(100),
  reason:   z.string().min(1).max(500),
});

router.post("/admin/trust/users/:userId/score/override", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminId } = admin;

  const { userId } = req.params;
  if (!UUID.test(userId)) { sendError(res, "invalid_payload", "Invalid userId"); return; }

  const parsed = ScoreOverrideSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  if (!TRUST_CATEGORIES.has(parsed.data.category)) {
    sendError(res, "invalid_payload", `Unknown trust category: ${parsed.data.category}`);
    return;
  }

  try {
    // Awaited, not fire-and-forget: `adminOverrideScore` throws unless the
    // ceiling is READ BACK from trust_profiles, so awaiting it is what makes
    // this route's `ok` a report of a persisted ceiling rather than a receipt
    // for a request.
    const result = await adminOverrideScore(
      sc, adminId, userId, parsed.data.category as TrustCategory, parsed.data.score, parsed.data.reason,
    );
    // Await so the affected user's compass cache is cleared before we respond
    await invalidateCompassCache(sc, userId, "trust_score_override");
    res.json(result);
  } catch (err: any) {
    sendError(res, "db_error", err?.message ?? "Could not apply score override", { exposeDetail: true });
  }
});

// ── POST /admin/trust/users/:userId/cap/override ─────────────────────────────
//
// The REMOVAL half. Despite its name this route has always lifted a cap rather
// than applying one, and it did so outside the service that owns the semantics.
// Four separate defects, all of them the same family — reporting success
// without confirming it:
//
//  1. NO TYPE CHECK. It lifted ANY cap by id, `behavior_confirmed` included.
//     That is relief from a moderation ceiling, which is recorded as
//     deliberately NOT built and gated on an unanswered authority question, and
//     an admin could grant it through a route named "override". Only an
//     `admin_override` ceiling is liftable here now; anything else is refused
//     with the reason said out loud.
//
//  2. NO USER SCOPING — the worst of the four and the one nobody had written
//     down. `liftCap` filtered on the cap id alone. `:userId` was used for the
//     audit row and the cache invalidation and NOT for the update, so an admin
//     could lift a cap belonging to user B through user A's URL: B's ceiling
//     gone, the audit trail recording it against A, and B's compass cache never
//     invalidated. The cap is now looked up by (id, user) BEFORE anything is
//     written, so a mismatched pair is a 404 and the audit row is true by
//     construction.
//
//  3. NOTHING DISTINGUISHED "LIFTED ONE" FROM "LIFTED NOTHING". The update
//     carried no `.select()`, so a nonexistent, already-lifted or someone
//     else's cap all resolved and this route answered `ok`.
//
//  4. FIRE-AND-FORGET RECALCULATION WITH THE ERROR SWALLOWED, then
//     `{ ok: true }`. `recalculateTrustScore` is fail-closed and THROWS on an
//     unreadable settings/events/caps table, so the ceiling could be lifted
//     with the score never recalculated while the caller was told it worked.
//
// All four are answered by doing the work in `adminRemoveOverride`, which lifts
// with scoping, awaits the recalculation, re-reads the caps and the profile,
// and refuses to audit a removal it cannot observe.

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

  // Scoped read FIRST, through the Trust seam — `services/trust/` owns
  // `trust_caps`, and `getCapForUser` keeps the three answers three: an
  // unreadable table must not be answered as "no such cap for this user",
  // which is the shape that turns a transient outage into a confident 404.
  const lookup = await getCapForUser(sc, { capId: parsed.data.capId, userId });
  if (lookup.state === "unavailable") {
    sendError(res, "db_error", `Could not read cap: ${lookup.reason}`);
    return;
  }
  if (lookup.state === "not_found") {
    sendError(res, "not_found", "No cap with that id belongs to this user.");
    return;
  }
  const cap = lookup.cap;
  if (cap.liftedAt) {
    sendError(res, "conflict", "That cap has already been lifted.");
    return;
  }
  const reasonCode = String(cap.reasonCode ?? "");
  if (reasonCode !== "admin_override") {
    sendError(res, "forbidden",
      `Cap ${parsed.data.capId} is a '${reasonCode}' ceiling, not an admin override. ` +
      "Relief from a moderation ceiling is not built: lifting it here would grant, through a " +
      "score-override endpoint, standing that an admin does not have the authority to restore.");
    return;
  }

  try {
    const result = await adminRemoveOverride(
      sc, adminId, userId, cap.category as TrustCategory, parsed.data.reason, parsed.data.capId,
    );
    // Await so the affected user's compass cache is cleared before we respond —
    // and for the user whose cap was actually lifted, which is now the same user
    // by construction rather than by hope.
    await invalidateCompassCache(sc, userId, "trust_cap_lifted");
    res.json({ ...result, capId: parsed.data.capId });
  } catch (err: any) {
    sendError(res, "db_error", err?.message ?? "Could not lift cap", { exposeDetail: true });
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

  // AUDIT — `update_setting`, not `score_override`. IDF-53.
  //
  // This filed a SETTINGS edit under the score-override action type, so a query
  // for "who overrode a user's score" answered with settings edits. It was
  // visible in the row's own data: `target_user` is `adminId`, the admin
  // auditing themselves, because a settings edit has no target user — a
  // `score_override` row whose target is its own author is a contradiction the
  // schema stored without complaint. `update_setting` is admitted by
  // `trust_admin_actions_action_type_check` as of migration 2940; renaming the
  // literal without that migration would have produced a 23514 and, because
  // supabase-js RESOLVES on a DB error, NO AUDIT ROW AT ALL — silently.
  //
  // AND THE FAILURE IS NO LONGER DISCARDED. `.catch(() => {})` over a supabase
  // call is worse than it looks: the rejection path is not the failure path
  // here, so that catch never even ran, and a refused insert was
  // indistinguishable from a written one. That is exactly how the wrong
  // action_type survived long enough to become a checklist row. The insert is
  // still fire-and-forget — a settings edit must not fail because its audit row
  // did — but a failure is now READ and logged at error, so the next one is
  // visible instead of silent.
  await (async () => {
    const { error: auditError } = await sc.from("trust_admin_actions").insert({
      admin_id:    adminId,
      target_user: adminId,
      action_type: "update_setting",
      reason:      `Updated trust setting ${key} to ${parsed.data.value}`,
      metadata:    { key, value: parsed.data.value },
    });
    if (auditError) {
      logger.error(
        { key, adminId, code: (auditError as any)?.code, message: (auditError as any)?.message },
        "trust setting updated but its audit row was REFUSED — the change is live and unrecorded",
      );
    }
  })();

  // Fire-and-forget: recalculate all users' scores so the new weights/decay take effect.
  // Read all user_ids from trust_profiles in one query, then recalc each sequentially.
  setImmediate(() => {
    // The one read of trust_profiles that is NOT a display or a gate: it is the
    // recalculation sweep enumerating who to recompute. It stays a direct read
    // and is declared Trust-owned in the guard, because a "give me every user id
    // with a profile" seam would exist for exactly one caller and would hide
    // that this loop is unbounded at 1000.
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

// ── GET /admin/trust/maintenance/health ──────────────────────────────────────

/**
 * The trust maintenance scheduler's health, read out loud.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * lib/trustMaintenanceScheduler maintains `consecutiveFailures`,
 * `lastSkippedReason`, `lastEventsSeen`, `lastRecalcFailures` and
 * `lastReviewsStuck`, and exports `getTrustMaintenanceStatus()` — which had NO
 * CALLER anywhere in the repository. Every one of those counters was computed
 * and then dropped on the floor. A maintenance pass could fail on every tick
 * for weeks and the only trace was a log line, in a job whose whole purpose is
 * that trust scores stay computed: `trust_profiles.overall_score` gates event
 * RSVPs, ranks the buddy marketplace and ranks Pulse. Health nobody can read is
 * health nobody has.
 *
 * ── THE VERDICT IS THE STATUS CODE ──────────────────────────────────────────
 * A health endpoint that answers 200 while the job is failing has moved the
 * defect rather than fixed it, so the verdict is load-bearing:
 *
 *   ok        200  a pass genuinely succeeded recently
 *   pending   200  the process is still inside its startup delay and no pass is
 *                  due yet — "has not run yet" is not "broken", but it is also
 *                  not "healthy", so it is named rather than rounded to either
 *   degraded  503  no pass has run well past the startup delay, or the last
 *                  attempt is older than two intervals (the timer is gone)
 *   failing   503  the last pass did not fully succeed
 *
 * The full status object is returned in BOTH directions: an operator reading a
 * 503 needs the counters more than anyone.
 *
 * `skipped: "flag_off"` is NOT a failure. The trust engine being deliberately
 * off is a configured state, and reporting it as breakage would train an
 * operator to ignore this endpoint. It is surfaced as `lastSkippedReason` so
 * the difference between "off" and "on and broken" is one field, not a guess.
 */
router.get("/admin/trust/maintenance/health", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  void logAdminAccess(sc, admin.userId, "profile", "list", "view", accessReason(req));

  const status = getTrustMaintenanceStatus();
  const nowMs = Date.now();

  const lastRunMs = status.lastRunAt ? Date.parse(status.lastRunAt) : null;
  const lastSuccessMs = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : null;

  // Two intervals of slack: one pass may legitimately still be in flight when
  // the next is due, and a single late tick is not an outage.
  const staleAfterMs = MAINTENANCE_INTERVAL_MS * 2;
  // Startup grace: the first pass is deliberately delayed, and a process that
  // has been up for less than that has not failed to do anything yet.
  const withinStartupGrace = process.uptime() * 1_000 < STARTUP_DELAY_MS + MAINTENANCE_INTERVAL_MS;

  let verdict: "ok" | "pending" | "degraded" | "failing";
  let detail: string;

  if (status.consecutiveFailures > 0) {
    verdict = "failing";
    detail = `last pass did not fully succeed (${status.consecutiveFailures} consecutive)`;
  } else if (lastRunMs === null) {
    if (withinStartupGrace) {
      verdict = "pending";
      detail = "no pass yet — process is still inside the scheduler's startup delay";
    } else {
      verdict = "degraded";
      detail = "no maintenance pass has EVER run in this process, well past the startup delay";
    }
  } else if (nowMs - lastRunMs > staleAfterMs) {
    verdict = "degraded";
    detail = `last attempt was ${Math.round((nowMs - lastRunMs) / 60_000)} minutes ago, more than two intervals`;
  } else {
    verdict = "ok";
    detail = status.lastSkippedReason
      ? `running; last pass skipped (${status.lastSkippedReason})`
      : "running";
  }

  const httpStatus = verdict === "ok" || verdict === "pending" ? 200 : 503;

  res.status(httpStatus).json({
    verdict,
    detail,
    status: {
      lastRunAt:               status.lastRunAt,
      lastSuccessAt:           status.lastSuccessAt,
      /** null means the trust_events read FAILED — it is not a count of zero. */
      lastEventsSeen:          status.lastEventsSeen,
      lastUsersRecalculated:   status.lastUsersRecalculated,
      lastRecalcFailures:      status.lastRecalcFailures,
      lastCapsExpired:         status.lastCapsExpired,
      lastRestrictionsExpired: status.lastRestrictionsExpired,
      lastProbationCleared:    status.lastProbationCleared,
      lastGamingFlagged:       status.lastGamingFlagged,
      lastGamingInputs:        status.lastGamingInputs,
      /** null means the pending_review scan could not be performed. */
      lastReviewsStuck:        status.lastReviewsStuck,
      lastSkippedReason:       status.lastSkippedReason,
      lastFailures:            status.lastFailures,
      consecutiveFailures:     status.consecutiveFailures,
    },
    // The cadence the verdict was judged against, so a reader can check the
    // arithmetic rather than trust it.
    schedule: {
      intervalMs:      MAINTENANCE_INTERVAL_MS,
      startupDelayMs:  STARTUP_DELAY_MS,
      staleAfterMs,
      maxUsersPerPass: MAX_USERS_PER_PASS,
      staleDays:       STALE_DAYS,
    },
  });
});

export default router;
