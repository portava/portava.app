/**
 * Admin Compass routes — Phase 6 Admin & Ops cockpit.
 *
 * All routes require `requireAdmin` (profiles.role = 'admin').
 * All mutations write an audit row to compass_admin_actions.
 *
 * Dashboard:
 *   GET  /api/admin/compass/dashboard
 *
 * Weight sets:
 *   POST  /api/admin/compass/weights
 *   PATCH /api/admin/compass/weights/:id
 *
 * Algorithm versioning:
 *   POST /api/admin/compass/version
 *   POST /api/admin/compass/rollback
 *
 * Cache & controls:
 *   POST  /api/admin/compass/rebuild-cache
 *   PATCH /api/admin/compass/frontload-rules
 *
 * Boost eligibility:
 *   POST /api/admin/compass/users/:userId/remove-boost-eligibility
 *   POST /api/admin/compass/users/:userId/restore-boost-eligibility
 *
 * Observability:
 *   GET /api/admin/compass/abuse-flags
 *   GET /api/admin/compass/safety-filters
 *   GET /api/admin/compass/active-rewards
 *
 * Testing sandbox:
 *   GET  /api/admin/compass/testing-sandbox
 *   POST /api/admin/compass/testing-sandbox/preview
 */
import { Router } from "express";
import { z } from "zod";
import { sendError } from "../lib/http.js";
import { logAdminAccess, accessReason } from "../lib/adminAudit.js";
import { clearL1Cache, invalidate } from "../compass/CompassCacheEngine.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { runSandbox, type TestUserType } from "../compass/CompassTestingSandbox.js";
import { SECTION_NAMES } from "../compass/CompassFeedBuilder.js";
import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

// ── Audit logger ──────────────────────────────────────────────────────────────

async function logAdminAction(
  sc:         any,
  adminId:    string,
  actionType: string,
  targetId?:  string | null,
  payload?:   Record<string, unknown>,
): Promise<void> {
  // non-fatal
  try {
    const { error } = await sc.from("compass_admin_actions").insert({
      admin_id:    adminId,
      action_type: actionType,
      target_id:   targetId ?? null,
      payload:     payload ?? null,
    });
    if (error) console.warn("compass admin action log failed (non-fatal):", error.message ?? error);
  } catch (err) {
    console.warn("compass admin action log threw (non-fatal):", err);
  }
}

// ── Global cache invalidation helper ─────────────────────────────────────────

/**
 * Invalidate the Compass cache for every user who currently has a cached
 * entry, with full per-user audit logging via CompassCacheEngine.invalidate().
 * Also clears the in-process L1 cache.
 *
 * Processes users in batches of 50 to avoid overwhelming the DB.
 * Each invalidate() call writes a compass_cache_invalidations audit row.
 */
async function invalidateAllUserCaches(sc: any, reason: string): Promise<number> {
  let affected = 0;
  try {
    const { data: cacheRows } = await sc
      .from("compass_feed_cache")
      .select("user_id");

    const uniqueUserIds = [...new Set(
      ((cacheRows as any[]) ?? []).map((r: any) => r.user_id as string),
    )];

    affected = uniqueUserIds.length;

    const BATCH = 50;
    for (let i = 0; i < uniqueUserIds.length; i += BATCH) {
      await Promise.allSettled(
        uniqueUserIds.slice(i, i + BATCH).map((uid) => invalidate(sc, uid, reason)),
      );
    }
  } catch { /* non-fatal — L1 clear still happens */ }

  clearL1Cache();
  return affected;
}

// ── GET /api/admin/compass/dashboard ─────────────────────────────────────────

router.get("/admin/compass/dashboard", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  try {
    const nowMs         = Date.now();
    const thirtyDaysAgo = new Date(nowMs - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const now           = new Date(nowMs).toISOString();

    const [
      abuseFlagsRes,
      safetyLogRes,
      cacheValidRes,
      cacheExpiredRes,
      rewardRes,
      notifRes,
      versionRes,
      feedbackRes,
      locationRes,
      delayedPostsRes,
      totalPostsRes,
      boostOverexposedRes,
      newUsersRes,
      buddyProfilesRes,
      completedEventsRes,
      upcomingEventsRes,
    ] = await Promise.allSettled([
      // Abuse flags (last 30 days)
      sc.from("compass_abuse_flags")
        .select("severity, status")
        .gte("created_at", thirtyDaysAgo),

      // Safety filter fires (last 30 days)
      sc.from("compass_safety_filter_logs")
        .select("block_reason")
        .gte("created_at", thirtyDaysAgo),

      // Valid (non-expired) cache entries
      sc.from("compass_feed_cache")
        .select("entry_type, user_id", { count: "exact" })
        .gt("expires_at", now),

      // Expired cache entries (gives us total - valid = expired)
      sc.from("compass_feed_cache")
        .select("user_id", { count: "exact", head: true })
        .lte("expires_at", now),

      // Top active user scores (top boosted)
      sc.from("compass_active_user_scores")
        .select("user_id, active_user_score, trust_multiplier, boost_eligible, boost_visibility_enabled")
        .order("active_user_score", { ascending: false })
        .limit(10),

      // Notification outcome breakdown (last 30 days)
      sc.from("compass_notification_decisions")
        .select("notification_type, outcome, suppression_reason")
        .gte("created_at", thirtyDaysAgo),

      // Current active algorithm version
      sc.from("compass_algorithm_versions")
        .select("id, version_tag, rollout_status, launched_at")
        .eq("rollout_status", "active")
        .order("launched_at", { ascending: false })
        .limit(1),

      // Feedback events (last 30 days) — source for click/save/join/book/hide/report rates
      sc.from("compass_feedback_events")
        .select("action")
        .gte("created_at", thirtyDaysAgo),

      // User location state — city supply/demand breakdown
      sc.from("user_location_state")
        .select("city, country")
        .not("city", "is", null)
        .limit(500),

      // Delayed posts not yet published (pending publish).
      //
      // This used to say `.eq("post_status", "delayed_post")`. `delayed_post` is
      // not a label of the `delayed_post_status` enum that types
      // posts.post_status — the labels are draft / private /
      // pending_location_exit / pending_delay / pending_safety_review /
      // published / canceled / expired (migration 0049) — so the predicate could
      // never match: the metric reported 0 pending posts forever, or PostgREST
      // rejected the literal 22P02 and this Promise.allSettled entry rejected,
      // which the reader below reads as 0 just the same. Not a leak (the count
      // is admin-only and discloses no row), but a dead query: the one dashboard
      // number that would have shown the delayed-publish backlog was flat zero
      // whatever the backlog was. The real pending states are the three the
      // sweeper (lib/delayedPostPublisher) picks up plus the moderation hold.
      sc.from("posts")
        .select("id", { count: "exact", head: true })
        .in("post_status", ["pending_location_exit", "pending_delay", "pending_safety_review"])
        .gt("publish_eligible_at", now),

      // Total posts in window (for delayed publish rate denominator)
      sc.from("posts")
        .select("id", { count: "exact", head: true })
        .gte("created_at", thirtyDaysAgo),

      // Overexposed: boost_visibility_enabled but low trust multiplier
      sc.from("compass_active_user_scores")
        .select("user_id, active_user_score, trust_multiplier")
        .eq("boost_visibility_enabled", true)
        .lt("trust_multiplier", 0.7)
        .order("active_user_score", { ascending: false })
        .limit(20),

      // New users (low active_user_score → limited organic reach)
      sc.from("compass_active_user_scores")
        .select("user_id, active_user_score")
        .lte("active_user_score", 5)
        .order("active_user_score", { ascending: true })
        .limit(20),

      // Active buddy profiles (rent_a_buddy section supply)
      sc.from("rent_buddy_profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("status", "active"),

      // Location-verified event posts created in the last 30 days (completed proxy).
      // The live posts table has no event start time, so the creation window
      // stands in for "already started".
      sc.from("posts")
        .select("id", { count: "exact", head: true })
        .eq("category", "event")
        .eq("location_verified", true)
        .lte("created_at", now)
        .gte("created_at", thirtyDaysAgo),

      // Upcoming events (not yet started) — start times live on the events
      // table, not posts.
      sc.from("events")
        .select("id", { count: "exact", head: true })
        .gt("starts_at", now)
        .not("state", "in", "(draft,cancelled,archived)"),
    ]);

    // ── Abuse flags ──────────────────────────────────────────────────────────
    const abuseRows: any[] = abuseFlagsRes.status === "fulfilled"
      ? ((abuseFlagsRes.value as any).data as any[] ?? []) : [];
    const abuseBySeverity: Record<string, number> = {};
    const abuseByStatus:   Record<string, number> = {};
    for (const r of abuseRows) {
      abuseBySeverity[r.severity] = (abuseBySeverity[r.severity] ?? 0) + 1;
      abuseByStatus[r.status]     = (abuseByStatus[r.status]     ?? 0) + 1;
    }

    // ── Safety filter ────────────────────────────────────────────────────────
    const safetyRows: any[] = safetyLogRes.status === "fulfilled"
      ? ((safetyLogRes.value as any).data as any[] ?? []) : [];
    const safetyByReason: Record<string, number> = {};
    for (const r of safetyRows) {
      safetyByReason[r.block_reason] = (safetyByReason[r.block_reason] ?? 0) + 1;
    }

    // ── Cache metrics ────────────────────────────────────────────────────────
    const validCacheRows: any[] = cacheValidRes.status === "fulfilled"
      ? ((cacheValidRes.value as any).data as any[] ?? []) : [];
    const validCacheCount   = validCacheRows.length;
    const expiredCacheCount = cacheExpiredRes.status === "fulfilled"
      ? ((cacheExpiredRes.value as any).count ?? 0) : 0;
    const totalCacheCount   = validCacheCount + expiredCacheCount;
    const cacheHitRate      = totalCacheCount > 0
      ? Math.round((validCacheCount / totalCacheCount) * 1_000) / 10
      : 0; // percentage (0–100)

    // Cache entry type breakdown
    const cacheByType: Record<string, number> = {};
    for (const r of validCacheRows) {
      cacheByType[r.entry_type] = (cacheByType[r.entry_type] ?? 0) + 1;
    }
    const uniqueCachedUsers = new Set(validCacheRows.map((r) => r.user_id)).size;

    // ── Top boosted users ────────────────────────────────────────────────────
    const topRewardUsers: any[] = rewardRes.status === "fulfilled"
      ? ((rewardRes.value as any).data as any[] ?? []) : [];

    // ── Notification outcomes ────────────────────────────────────────────────
    const notifRows: any[] = notifRes.status === "fulfilled"
      ? ((notifRes.value as any).data as any[] ?? []) : [];
    const notifByOutcome: Record<string, number>          = {};
    const notifByType:    Record<string, number>          = {};
    const notifSuppressReason: Record<string, number>     = {};
    for (const r of notifRows) {
      notifByOutcome[r.outcome]                           = (notifByOutcome[r.outcome] ?? 0) + 1;
      notifByType[r.notification_type]                    = (notifByType[r.notification_type] ?? 0) + 1;
      if (r.suppression_reason) {
        notifSuppressReason[r.suppression_reason]         = (notifSuppressReason[r.suppression_reason] ?? 0) + 1;
      }
    }
    const notifTotal   = notifRows.length;
    const notifSent    = notifByOutcome["sent"]       ?? 0;
    const notifMuted   = notifByOutcome["suppressed"] ?? 0;
    const openRate     = notifTotal > 0 ? Math.round((notifSent  / notifTotal) * 1_000) / 10 : 0;
    const muteRate     = notifTotal > 0 ? Math.round((notifMuted / notifTotal) * 1_000) / 10 : 0;

    // ── Active version ───────────────────────────────────────────────────────
    const activeVersion = versionRes.status === "fulfilled"
      ? (((versionRes.value as any).data as any[] ?? [])[0] ?? null) : null;

    // ── Feedback action rates (click / save / join / book / hide / report) ──
    const feedbackRows: any[] = feedbackRes.status === "fulfilled"
      ? ((feedbackRes.value as any).data as any[] ?? []) : [];
    const feedbackByAction: Record<string, number> = {};
    for (const r of feedbackRows) {
      feedbackByAction[r.action] = (feedbackByAction[r.action] ?? 0) + 1;
    }
    const feedbackTotal       = feedbackRows.length;
    const rateOf = (action: string) =>
      feedbackTotal > 0 ? Math.round(((feedbackByAction[action] ?? 0) / feedbackTotal) * 1_000) / 10 : 0;

    // ── City supply / demand ─────────────────────────────────────────────────
    const locationRows: any[] = locationRes.status === "fulfilled"
      ? ((locationRes.value as any).data as any[] ?? []) : [];
    const cityDemand: Record<string, number> = {};
    for (const r of locationRows) {
      const key = r.city as string;
      cityDemand[key] = (cityDemand[key] ?? 0) + 1;
    }
    // Top 10 cities by demand
    const topCities = Object.entries(cityDemand)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([city, count]) => ({ city, activeUsers: count }));

    // ── Delayed post publish rate ────────────────────────────────────────────
    const delayedCount = delayedPostsRes.status === "fulfilled"
      ? ((delayedPostsRes.value as any).count ?? 0) : 0;
    const totalPosts   = totalPostsRes.status === "fulfilled"
      ? ((totalPostsRes.value as any).count ?? 0) : 0;
    const delayedPublishRate = totalPosts > 0
      ? Math.round((delayedCount / totalPosts) * 1_000) / 10 : 0;

    // ── Overexposed / new user exposure ─────────────────────────────────────
    const overexposedUsers: any[] = boostOverexposedRes.status === "fulfilled"
      ? ((boostOverexposedRes.value as any).data as any[] ?? []) : [];
    const newUserRows: any[] = newUsersRes.status === "fulfilled"
      ? ((newUsersRes.value as any).data as any[] ?? []) : [];

    // ── Buddy exposure (rent_a_buddy section supply) ─────────────────────────
    const activeBuddyCount = buddyProfilesRes.status === "fulfilled"
      ? ((buddyProfilesRes.value as any).count ?? 0) : 0;

    // ── Event completion ─────────────────────────────────────────────────────
    const completedEventCount = completedEventsRes.status === "fulfilled"
      ? ((completedEventsRes.value as any).count ?? 0) : 0;
    const upcomingEventCount  = upcomingEventsRes.status === "fulfilled"
      ? ((upcomingEventsRes.value as any).count ?? 0) : 0;
    const totalEventsInScope  = completedEventCount + upcomingEventCount;
    const eventCompletionRatePct = totalEventsInScope > 0
      ? Math.round((completedEventCount / totalEventsInScope) * 1_000) / 10 : 0;

    // ── Preload hit rate (valid frontload entries / all valid cache entries) ─
    // "Hit" = frontload entry is still valid when a user arrives (proxy metric;
    // true request-level hit/miss requires client-side instrumentation).
    const preloadValidCount = cacheByType["frontload"] ?? 0;
    const preloadHitRatePct = validCacheCount > 0
      ? Math.round((preloadValidCount / validCacheCount) * 1_000) / 10 : 0;

    // ── Click rate proxy (any positive engagement / total feedback events) ───
    // "Click" encompasses save, join, book, and show_more actions — the
    // positive-signal set. Hides/reports are negative signals tracked separately.
    const positiveEngagementCount =
      (feedbackByAction["save"]         ?? 0) +
      (feedbackByAction["joined"]       ?? 0) +
      (feedbackByAction["booked"]       ?? 0) +
      (feedbackByAction["show_more"]    ?? 0) +
      (feedbackByAction["profile_view"] ?? 0);
    const clickRatePct = feedbackTotal > 0
      ? Math.round((positiveEngagementCount / feedbackTotal) * 1_000) / 10 : 0;

    void logAdminAccess(sc, admin.userId, "profile", "list", "view", accessReason(req));
    res.json({
      generatedAt:    new Date(nowMs).toISOString(),
      windowDays:     30,

      // Algorithm
      activeVersion,

      // Feed categories — all sections currently served by the Compass pipeline
      categoriesShown: {
        total:    SECTION_NAMES.length,
        sections: SECTION_NAMES,
      },

      // Feed performance
      feedPerformance: {
        // Feed load time is measured client-side (Expo perf marks). The server
        // does not record per-request build durations in this schema version.
        feedLoadTimeMsNote: "client_measured_not_tracked_server_side",
        preloadHitRatePct,
        preloadValidEntries: preloadValidCount,
        // clickRatePct proxies positive engagement (save + join + book +
        // show_more + profile_view) as a share of all feedback events.
        clickRatePct,
      },

      // Cache health
      cache: {
        validEntries:    validCacheCount,
        expiredEntries:  expiredCacheCount,
        totalEntries:    totalCacheCount,
        uniqueUsers:     uniqueCachedUsers,
        hitRatePct:      cacheHitRate,
        byEntryType:     cacheByType,
      },

      // Feedback action rates (as % of total feedback events)
      feedbackRates: {
        totalEvents:  feedbackTotal,
        byAction:     feedbackByAction,
        saveRatePct:      rateOf("save"),
        joinRatePct:      rateOf("joined"),
        bookRatePct:      rateOf("booked"),
        hideRatePct:      rateOf("hide_category"),
        notInterestedPct: rateOf("not_interested"),
        reportRatePct:    rateOf("report"),
        blockRatePct:     rateOf("block"),
        hideUserRatePct:  rateOf("hide_user"),
        showMoreRatePct:  rateOf("show_more"),
      },

      // Notifications
      notifications: {
        total:           notifTotal,
        byOutcome:       notifByOutcome,
        byType:          notifByType,
        suppressReasons: notifSuppressReason,
        openRatePct:     openRate,
        muteRatePct:     muteRate,
      },

      // Safety
      safetyFilterFires: {
        total:    safetyRows.length,
        byReason: safetyByReason,
      },

      // Abuse
      abuse: {
        total:      abuseRows.length,
        bySeverity: abuseBySeverity,
        byStatus:   abuseByStatus,
      },

      // User exposure metrics
      topBoostedUsers: topRewardUsers.map((r) => ({
        userId:          r.user_id,
        score:           r.active_user_score,
        trustMultiplier: r.trust_multiplier,
        boostEligible:   r.boost_eligible,
        boostVisible:    r.boost_visibility_enabled,
      })),
      overexposedUsers: overexposedUsers.map((r) => ({
        userId:          r.user_id,
        score:           r.active_user_score,
        trustMultiplier: r.trust_multiplier,
      })),
      newUserExposure: {
        count: newUserRows.length,
        users: newUserRows.map((r) => ({ userId: r.user_id, score: r.active_user_score })),
      },

      // Buddy exposure — number of active rent_buddy_profiles available as
      // candidates for the rent_a_buddy section
      buddyExposure: {
        activeBuddyCount,
      },

      // Event completion — location-verified event posts (last 30d) vs upcoming events
      eventCompletion: {
        completedCount:      completedEventCount,
        upcomingCount:       upcomingEventCount,
        completionRatePct:   eventCompletionRatePct,
      },

      // City supply / demand
      citySupplyDemand: topCities,

      // Delayed posts
      delayedPosts: {
        pendingCount:       delayedCount,
        totalPostsInWindow: totalPosts,
        delayedRatePct:     delayedPublishRate,
      },
    });
  } catch (err) {
    req.log.error({ err }, "admin/compass/dashboard: query failed");
    sendError(res, "db_error", "Dashboard query failed", { exposeDetail: true });
  }
});

// ── POST /api/admin/compass/weights ──────────────────────────────────────────

const createWeightSetSchema = z.object({
  name:        z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  weights:     z.record(z.number()).default({}),
});

router.post("/admin/compass/weights", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = createWeightSetSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { name, description, weights } = parsed.data;

  try {
    const { data, error } = await sc
      .from("compass_admin_weight_sets")
      .insert({ name, description: description ?? null, weights, created_by: userId })
      .select("id, name, description, weights, is_active, created_at")
      .single();

    if (error) { sendError(res, "db_error", error.message); return; }

    await logAdminAction(sc, userId, "create_weight_set", (data as any).id, { name, weights });
    res.status(201).json({ weightSet: data });
  } catch (err) {
    req.log.error({ err }, "admin/compass/weights: create failed");
    sendError(res, "db_error", "Could not create weight set", { exposeDetail: true });
  }
});

// ── PATCH /api/admin/compass/weights/:id ─────────────────────────────────────

const updateWeightSetSchema = z.object({
  name:        z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  weights:     z.record(z.number()).optional(),
});

router.patch("/admin/compass/weights/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const { id } = req.params;
  if (!id) { sendError(res, "invalid_payload", "Missing id"); return; }

  const parsed = updateWeightSetSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name        !== undefined) updates["name"]        = parsed.data.name;
  if (parsed.data.description !== undefined) updates["description"] = parsed.data.description;
  if (parsed.data.weights     !== undefined) updates["weights"]     = parsed.data.weights;

  try {
    const { data, error } = await sc
      .from("compass_admin_weight_sets")
      .update(updates)
      .eq("id", id)
      .select("id, name, description, weights, is_active, updated_at")
      .single();

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!data)  { sendError(res, "not_found", "Weight set not found"); return; }

    await logAdminAction(sc, userId, "update_weight_set", id, updates as Record<string, unknown>);
    res.json({ weightSet: data });
  } catch (err) {
    req.log.error({ err }, "admin/compass/weights/:id: update failed");
    sendError(res, "db_error", "Could not update weight set", { exposeDetail: true });
  }
});

// ── POST /api/admin/compass/version ──────────────────────────────────────────

const activateVersionSchema = z.object({
  weightSetId: z.string().uuid(),
  versionTag:  z.string().min(1).max(80),
  notes:       z.string().max(1000).optional(),
});

router.post("/admin/compass/version", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = activateVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { weightSetId, versionTag, notes } = parsed.data;

  try {
    const now = new Date().toISOString();

    // ── Precondition: verify weight set exists before any mutation ────────
    // This prevents the "retired current version + insert fails" scenario
    // that would leave the system with no active version.
    const { data: wsCheck, error: wsErr } = await sc
      .from("compass_admin_weight_sets")
      .select("id")
      .eq("id", weightSetId)
      .single();
    if (wsErr || !wsCheck) {
      sendError(res, "not_found", `Weight set '${weightSetId}' not found`);
      return;
    }

    // Retire any currently active algorithm versions
    await sc
      .from("compass_algorithm_versions")
      .update({ rollout_status: "retired", retired_at: now })
      .eq("rollout_status", "active");

    // Deactivate ALL previously active weight sets (only one should be active
    // at a time; this is the authoritative deactivation step)
    await sc
      .from("compass_admin_weight_sets")
      .update({ is_active: false, updated_at: now })
      .eq("is_active", true);

    // Activate the selected weight set
    await sc
      .from("compass_admin_weight_sets")
      .update({ is_active: true, updated_at: now })
      .eq("id", weightSetId);

    // Create new algorithm version row
    const { data, error } = await sc
      .from("compass_algorithm_versions")
      .insert({
        weight_set_id:        weightSetId,
        version_tag:          versionTag,
        launched_by_admin_id: userId,
        rollout_status:       "active",
        rollback_available:   true,
        notes:                notes ?? null,
      })
      .select("id, version_tag, rollout_status, launched_at")
      .single();

    if (error) { sendError(res, "db_error", error.message); return; }

    // Invalidate all user caches so new weights take effect immediately
    const affected = await invalidateAllUserCaches(sc, "admin_version_activation");

    await logAdminAction(sc, userId, "activate_version", (data as any).id, {
      weightSetId,
      versionTag,
      cacheUsersInvalidated: affected,
    });
    res.status(201).json({ version: data, cacheUsersInvalidated: affected });
  } catch (err) {
    req.log.error({ err }, "admin/compass/version: activate failed");
    sendError(res, "db_error", "Could not activate version", { exposeDetail: true });
  }
});

// ── POST /api/admin/compass/rollback ─────────────────────────────────────────

const rollbackSchema = z.object({
  reason: z.string().max(500).optional(),
});

router.post("/admin/compass/rollback", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = rollbackSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  try {
    const now = new Date().toISOString();

    // Find the currently active version
    const { data: activeVersions } = await sc
      .from("compass_algorithm_versions")
      .select("id, version_tag, weight_set_id")
      .eq("rollout_status", "active")
      .order("launched_at", { ascending: false })
      .limit(1);

    const currentVersion = ((activeVersions as any[]) ?? [])[0] ?? null;

    // Find the most recent retired version with rollback_available = true
    const { data: prevVersions } = await sc
      .from("compass_algorithm_versions")
      .select("id, version_tag, weight_set_id")
      .eq("rollout_status", "retired")
      .eq("rollback_available", true)
      .order("launched_at", { ascending: false })
      .limit(1);

    const prevVersion = ((prevVersions as any[]) ?? [])[0] ?? null;

    if (!currentVersion) {
      sendError(res, "not_found", "No active algorithm version to roll back");
      return;
    }

    // ── Precondition: require a prior safe version before touching anything ─
    // Without this guard, rolling back the current version leaves the system
    // with no active version, which breaks all feed requests.
    if (!prevVersion) {
      sendError(res, "not_found", "No prior rollback-available version found; rollback aborted to preserve current active state");
      return;
    }

    // Mark current version as rolled_back
    await sc
      .from("compass_algorithm_versions")
      .update({ rollout_status: "rolled_back", retired_at: now })
      .eq("id", currentVersion.id);

    // Deactivate the current version's weight set
    if (currentVersion.weight_set_id) {
      await sc
        .from("compass_admin_weight_sets")
        .update({ is_active: false, updated_at: now })
        .eq("id", currentVersion.weight_set_id);
    }

    // Reactivate previous version and its weight set (if available)
    if (prevVersion) {
      await sc
        .from("compass_algorithm_versions")
        .update({ rollout_status: "active", retired_at: null })
        .eq("id", prevVersion.id);

      if (prevVersion.weight_set_id) {
        // First deactivate any currently active weight sets
        await sc
          .from("compass_admin_weight_sets")
          .update({ is_active: false, updated_at: now })
          .eq("is_active", true);

        // Then activate the previous version's weight set
        await sc
          .from("compass_admin_weight_sets")
          .update({ is_active: true, updated_at: now })
          .eq("id", prevVersion.weight_set_id);
      }
    }

    // Write rollback audit row
    const { data: rollbackRow } = await sc
      .from("compass_rollbacks")
      .insert({
        from_version_id: currentVersion.id,
        to_version_id:   prevVersion?.id ?? null,
        rolled_back_by:  userId,
        reason:          parsed.data.reason ?? null,
      })
      .select("id, from_version_id, to_version_id, created_at")
      .single();

    // Globally invalidate all user caches so rolled-back weights take effect
    const affected = await invalidateAllUserCaches(sc, "admin_rollback");

    await logAdminAction(sc, userId, "rollback", currentVersion.id, {
      fromVersion:           currentVersion.version_tag,
      toVersion:             prevVersion?.version_tag ?? null,
      reason:                parsed.data.reason ?? null,
      cacheUsersInvalidated: affected,
    });

    res.json({
      rollback:              rollbackRow,
      fromVersion:           currentVersion,
      toVersion:             prevVersion ?? null,
      cacheUsersInvalidated: affected,
    });
  } catch (err) {
    req.log.error({ err }, "admin/compass/rollback: failed");
    sendError(res, "db_error", "Rollback failed", { exposeDetail: true });
  }
});

// ── POST /api/admin/compass/rebuild-cache ────────────────────────────────────

router.post("/admin/compass/rebuild-cache", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  try {
    // Invalidate all user caches with per-user audit trail
    const affected = await invalidateAllUserCaches(sc, "admin_global_rebuild");

    await logAdminAction(sc, userId, "rebuild_cache", null, {
      cacheUsersInvalidated: affected,
    });
    res.json({ ok: true, message: "Cache cleared", cacheUsersInvalidated: affected });
  } catch (err) {
    req.log.error({ err }, "admin/compass/rebuild-cache: failed");
    sendError(res, "db_error", "Cache rebuild failed", { exposeDetail: true });
  }
});

// ── PATCH /api/admin/compass/frontload-rules ─────────────────────────────────

const frontloadRulesSchema = z.object({
  rules: z.array(z.object({
    flag:    z.string().min(1).max(120),
    enabled: z.boolean(),
  })).min(1).max(20),
});

router.patch("/admin/compass/frontload-rules", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = frontloadRulesSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  try {
    const results: Array<{ flag: string; enabled: boolean; ok: boolean }> = [];

    for (const { flag, enabled } of parsed.data.rules) {
      try {
        await sc
          .from("feature_flags")
          .upsert({ flag, enabled }, { onConflict: "flag" });
        results.push({ flag, enabled, ok: true });
      } catch {
        results.push({ flag, enabled, ok: false });
      }
    }

    // Invalidate the Compass flags cache so routes pick up new values immediately
    invalidateFlagsCache();

    await logAdminAction(sc, userId, "update_frontload_rules", null, {
      rules: parsed.data.rules,
    });
    res.json({ updated: results });
  } catch (err) {
    req.log.error({ err }, "admin/compass/frontload-rules: failed");
    sendError(res, "db_error", "Could not update rules", { exposeDetail: true });
  }
});

// ── POST /api/admin/compass/users/:userId/remove-boost-eligibility ────────────

router.post("/admin/compass/users/:userId/remove-boost-eligibility", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const targetUserId = req.params["userId"];
  if (!targetUserId) { sendError(res, "invalid_payload", "Missing userId"); return; }

  try {
    await sc
      .from("compass_active_user_scores")
      .upsert(
        { user_id: targetUserId, boost_eligible: false },
        { onConflict: "user_id" },
      );

    await invalidate(sc, targetUserId, "admin_boost_eligibility_removed");
    await logAdminAction(sc, adminId, "remove_boost_eligibility", targetUserId);
    res.json({ ok: true, userId: targetUserId, boostEligible: false });
  } catch (err) {
    req.log.error({ err }, "admin/compass/remove-boost-eligibility: failed");
    sendError(res, "db_error", "Could not update boost eligibility", { exposeDetail: true });
  }
});

// ── POST /api/admin/compass/users/:userId/restore-boost-eligibility ──────────

router.post("/admin/compass/users/:userId/restore-boost-eligibility", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId: adminId, sc } = admin;

  const targetUserId = req.params["userId"];
  if (!targetUserId) { sendError(res, "invalid_payload", "Missing userId"); return; }

  try {
    await sc
      .from("compass_active_user_scores")
      .upsert(
        { user_id: targetUserId, boost_eligible: true },
        { onConflict: "user_id" },
      );

    await invalidate(sc, targetUserId, "admin_boost_eligibility_restored");
    await logAdminAction(sc, adminId, "restore_boost_eligibility", targetUserId);
    res.json({ ok: true, userId: targetUserId, boostEligible: true });
  } catch (err) {
    req.log.error({ err }, "admin/compass/restore-boost-eligibility: failed");
    sendError(res, "db_error", "Could not update boost eligibility", { exposeDetail: true });
  }
});

// ── GET /api/admin/compass/abuse-flags ───────────────────────────────────────

router.get("/admin/compass/abuse-flags", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const severity = req.query["severity"] as string | undefined;
  const status   = req.query["status"]   as string | undefined;
  const limit    = Math.min(100, Number(req.query["limit"]) || 50);

  try {
    let query = sc
      .from("compass_abuse_flags")
      .select("id, pattern_type, involved_users, severity, status, evidence, detected_at")
      .order("detected_at", { ascending: false })
      .limit(limit);

    if (severity) query = query.eq("severity", severity);
    if (status)   query = query.eq("status",   status);

    const { data, error } = await query;
    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ flags: data ?? [] });
  } catch (err) {
    req.log.error({ err }, "admin/compass/abuse-flags: query failed");
    sendError(res, "db_error", "Could not fetch abuse flags", { exposeDetail: true });
  }
});

// ── GET /api/admin/compass/safety-filters ────────────────────────────────────

router.get("/admin/compass/safety-filters", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(200, Number(req.query["limit"]) || 100);
  const since = req.query["since"] as string | undefined;

  try {
    let query = sc
      .from("compass_safety_filter_logs")
      .select("id, viewer_id, item_id, item_type, block_reason, author_id, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (since) query = query.gte("created_at", since);

    const { data, error } = await query;
    if (error) { sendError(res, "db_error", error.message); return; }

    const rows: any[] = data ?? [];
    const byReason: Record<string, number> = {};
    for (const r of rows) {
      byReason[r.block_reason] = (byReason[r.block_reason] ?? 0) + 1;
    }

    res.json({ total: rows.length, byReason, logs: rows });
  } catch (err) {
    req.log.error({ err }, "admin/compass/safety-filters: query failed");
    sendError(res, "db_error", "Could not fetch safety filter logs", { exposeDetail: true });
  }
});

// ── GET /api/admin/compass/active-rewards ─────────────────────────────────────

router.get("/admin/compass/active-rewards", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query["limit"]) || 50);

  try {
    const { data, error } = await sc
      .from("compass_active_user_scores")
      .select("user_id, active_user_score, trust_multiplier, boost_eligible, boost_visibility_enabled, last_computed_at")
      .order("active_user_score", { ascending: false })
      .limit(limit);

    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ rewards: data ?? [] });
  } catch (err) {
    req.log.error({ err }, "admin/compass/active-rewards: query failed");
    sendError(res, "db_error", "Could not fetch active rewards", { exposeDetail: true });
  }
});

// ── GET /api/admin/compass/testing-sandbox ────────────────────────────────────

router.get("/admin/compass/testing-sandbox", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  try {
    const { data, error } = await sc
      .from("compass_testing_scenarios")
      .select("id, name, scenario, last_result, created_by, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(50);

    if (error) { sendError(res, "db_error", error.message); return; }
    res.json({ scenarios: data ?? [] });
  } catch (err) {
    req.log.error({ err }, "admin/compass/testing-sandbox: query failed");
    sendError(res, "db_error", "Could not fetch testing scenarios", { exposeDetail: true });
  }
});

// ── POST /api/admin/compass/testing-sandbox/preview ──────────────────────────

const VALID_USER_TYPES: TestUserType[] = ["traveler", "buddy", "new_user", "creator"];

const sandboxPreviewSchema = z.object({
  userType:   z.enum(["traveler", "buddy", "new_user", "creator"]),
  city:       z.string().min(1).max(120),
  intentMode: z.string().min(1).max(80).default("explore_now"),
  saveName:   z.string().max(200).optional(),
});

router.post("/admin/compass/testing-sandbox/preview", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const parsed = sandboxPreviewSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { userType, city, intentMode, saveName } = parsed.data;

  try {
    // Run sandbox — intentionally passes null for db (no production reads/writes)
    const result = await runSandbox(null, { userType, city, intentMode });

    // Optionally save the scenario for future re-use.
    // Upsert on (name, created_by) — requires the unique index added in migration 0055.
    if (saveName) {
      try {
        const scenario = { userType, city, intentMode };
        const { data: savedRow } = await sc
          .from("compass_testing_scenarios")
          .upsert(
            {
              name:        saveName,
              created_by:  userId,
              scenario,
              last_result: result,
              updated_at:  new Date().toISOString(),
            },
            { onConflict: "name,created_by" },
          )
          .select("id")
          .single();
        await logAdminAction(sc, userId, "save_testing_scenario", (savedRow as any)?.id, { scenario });
      } catch { /* non-fatal */ }
    }

    await logAdminAction(sc, userId, "run_testing_sandbox", null, { userType, city, intentMode });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "admin/compass/testing-sandbox/preview: failed");
    sendError(res, "db_error", "Sandbox preview failed", { exposeDetail: true });
  }
});

export default router;
