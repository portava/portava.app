/**
 * Safe Return routes
 *
 * All user-facing routes are gated by the 'safe_return_enabled' feature flag.
 * Live-share routes additionally require 'safe_return_live_share_enabled'.
 *
 * Endpoint set:
 *   GET  /api/me/safe-return/suggest/:planItemId
 *   POST /api/me/safe-return/sessions
 *   POST /api/me/safe-return/sessions/:id/start
 *   GET  /api/me/safe-return/sessions/active
 *   POST /api/me/safe-return/sessions/:id/extend
 *   POST /api/me/safe-return/sessions/:id/confirm
 *   POST /api/me/safe-return/sessions/:id/cancel
 *   POST /api/me/safe-return/sessions/:id/trigger-missed
 *   POST /api/me/safe-return/sessions/:id/live-share/start
 *   POST /api/me/safe-return/sessions/:id/live-share/stop
 *   GET  /api/safe-return/live-share/:shareId
 *   GET  /api/me/safe-return/history
 *   GET  /api/me/safe-return/trusted-contacts
 *
 * Privacy: exact coords never appear in API responses (enforced by toPublicSession).
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { nameVisibilitySet } from "../lib/publicIdentity";
import { createStamp } from "../services/passport/PassportStampService.js";
import { recordContributionIfEnabled } from "../services/passport/PassportContributionService.js";
import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { createSuggestedMemory } from "../services/passport/PassportMemoryService.js";
import { invalidateCompassProfile } from "../compass/CompassProfileService.js";
import {
  createSession,
  startSession,
  extendTimer,
  confirmSafe,
  cancelSession,
  markMissed,
  getActiveSession,
  getSessionById,
  listHistory,
  listContacts,
  markContactNotified,
} from "../services/safeReturn/SafeReturnService";
import {
  shouldSuggest,
  getSuggestionReason,
} from "../services/safeReturn/SafeReturnTriggerService";
import {
  sendMissedCheckIn,
  notifyTrustedCircle,
  notifyHost,
  notifyTripCrew,
} from "../services/safeReturn/SafeReturnNotificationService";
import {
  startShare,
  stopShare,
  getRecipientView,
} from "../services/safeReturn/SafeReturnLiveShareService";
import {
  toPublicSession,
  toPublicContact,
  requireSafeReturnRecipient,
} from "../services/safeReturn/SafeReturnPrivacyGuard";

const router = Router();

// ── Feature flag helpers ──────────────────────────────────────────────────────

async function isFlagEnabled(db: ReturnType<typeof getServiceClient>, flag: string): Promise<boolean> {
  if (!db) return false;
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const contactSchema = z.object({
  contactUserId:          z.string().uuid().optional().nullable(),
  contactName:            z.string().max(200).optional().nullable(),
  contactPhone:           z.string().max(30).optional().nullable(),
  contactEmail:           z.string().email().max(200).optional().nullable(),
  contactMethod:          z.enum(["in_app", "sms", "email"]),
  canReceiveLiveLocation: z.boolean().optional().default(false),
});

const createSessionSchema = z.object({
  planItemId:           z.string().uuid().optional().nullable(),
  tripId:               z.string().uuid().optional().nullable(),
  triggerReason:        z.string().max(500).optional().nullable(),
  escalationLevel:      z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional().default(0),
  timerMinutes:         z.number().int().min(5).max(480).optional().nullable(),
  trustedCircleEnabled: z.boolean().optional().default(false),
  liveShareEnabled:     z.boolean().optional().default(false),
  notifyHostEnabled:    z.boolean().optional().default(false),
  notifyTripCrewEnabled:z.boolean().optional().default(false),
  emergencyNote:        z.string().max(1000).optional().nullable(),
  contacts:             z.array(contactSchema).max(10).optional().default([]),
});

const extendSchema = z.object({
  minutes: z.number().int().min(5).max(240),
});

// ── GET /api/me/safe-return/suggest/:planItemId ───────────────────────────────

router.get("/me/safe-return/suggest/:planItemId", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    res.status(200).json({ suggest: false, featureEnabled: false });
    return;
  }

  const { planItemId } = req.params;

  // Fetch plan item via user-scoped client (RLS filters non-member rows).
  // Belt-and-suspenders: we also explicitly verify trip membership below.
  const { data: item } = await client
    .from("trip_plan_items")
    .select("id, category, starts_at, day_date, location_name, lat, lng, trip_id")
    .eq("id", planItemId)
    .maybeSingle();

  if (!item) {
    sendError(res, "not_found", "Plan item not found");
    return;
  }

  // Explicit membership check — ensure caller is a member or owner of the trip.
  const tripId = (item as any).trip_id as string | null;
  if (tripId) {
    const { data: membership } = await client
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      sendError(res, "forbidden", "You are not a member of this trip");
      return;
    }
  }

  // Fetch user location context (best-effort)
  let homeCity: string | null = null;
  let currentCity: string | null = null;
  try {
    const { data: profile } = await client
      .from("profiles")
      .select("home_city")
      .eq("id", user.id)
      .maybeSingle();
    homeCity = (profile as any)?.home_city ?? null;

    const { data: locState } = await client
      .from("user_location_state")
      .select("city")
      .eq("user_id", user.id)
      .maybeSingle();
    currentCity = (locState as any)?.city ?? null;
  } catch { /* non-fatal */ }

  // Fetch trip member count for solo-activity signal
  let attendeeCount: number | undefined;
  try {
    if ((item as any).trip_id) {
      const { count } = await client
        .from("trip_members")
        .select("*", { count: "exact", head: true })
        .eq("trip_id", (item as any).trip_id);
      attendeeCount = count ?? undefined;
    }
  } catch { /* non-fatal */ }

  // Check for location caution flag via geo_zones (safety_rating = caution | avoid)
  let hasLocationCautionFlag = false;
  try {
    const lat = (item as any).lat as number | null;
    const lng = (item as any).lng as number | null;
    if (lat != null && lng != null) {
      // Bounding-box pre-filter (~50 km) then check safety_rating
      const delta = 0.45; // ~50 km in degrees
      const { data: zones } = await db
        .from("geo_zones")
        .select("safety_rating")
        .in("safety_rating", ["caution", "avoid"])
        .gte("center_lat", lat - delta)
        .lte("center_lat", lat + delta)
        .gte("center_lng", lng - delta)
        .lte("center_lng", lng + delta)
        .limit(1);
      hasLocationCautionFlag = !!zones && zones.length > 0;
    }
  } catch { /* non-fatal */ }

  const planItemCtx = {
    id: (item as any).id,
    category: (item as any).category ?? "other",
    startsAt: (item as any).starts_at ?? null,
    dayDate: (item as any).day_date ?? null,
    locationName: (item as any).location_name ?? null,
    attendeeCount,
    hasLocationCautionFlag,
  };

  const result = shouldSuggest(planItemCtx, user.id, { homeCity, currentCity });

  res.status(200).json({
    suggest: result.shouldSuggest,
    reasons: result.reasons,
    confidence: result.confidence,
    reasonText: result.shouldSuggest ? getSuggestionReason(result.reasons) : null,
    planItemId,
  });
});

// ── POST /api/me/safe-return/sessions ────────────────────────────────────────

router.post("/me/safe-return/sessions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled", "Safe Return is not yet enabled");
    return;
  }

  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // Reject if the user already has an active session — prevents double-sessions
  // when the setup sheet is opened from two different screens concurrently.
  const existing = await getActiveSession(db, user.id);
  if (existing) {
    sendError(res, "conflict", "You already have an active Safe Return session");
    return;
  }

  const session = await createSession(db, { userId: user.id, ...parsed.data });
  if (!session) {
    // Could be a true DB error, or the partial unique index fired for a concurrent
    // request that slipped past the pre-check above.  Re-check so we can return a
    // meaningful 409 instead of a generic 500.
    const stillActive = await getActiveSession(db, user.id);
    if (stillActive) {
      sendError(res, "conflict", "You already have an active Safe Return session");
    } else {
      sendError(res, "db_error", "Failed to create session", { exposeDetail: true });
    }
    return;
  }

  // Evict Compass profile cache — safeReturnActive signal changes immediately.
  invalidateCompassProfile(user.id);

  res.status(201).json({ ok: true, session: toPublicSession(session) });

  // Fire-and-forget: award safe_return_ready stamp when user activates Safe Return.
  void (async () => {
    try {
      const sc = getServiceClient();
      if (!sc) return;
      const result = await awardStamp(sc, {
        userId:        user.id,
        definitionSlug: "safe_return_ready",
        sourceType:    "safe_return",
        sourceId:      (session as any).id,
      });
      if (result.awarded) {
        const { NotificationService } = await import("../services/notifications/NotificationService.js");
        const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");
        const notifSvc    = new NotificationService(sc);
        const notifRouter = new NotificationRouter(sc);
        const row = await notifSvc.create({
          userId:     user.id,
          eventType:  "passport.stamp_earned",
          sourceType: "safe_return",
          sourceId:   (session as any).id,
          params:     { location: "Safe Return" },
        });
        if (row) await notifRouter.route(row);
      }
    } catch {}
  })();
});

// ── POST /api/me/safe-return/sessions/:id/start ───────────────────────────────

router.post("/me/safe-return/sessions/:id/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const session = await startSession(db, req.params.id, user.id);
  if (!session) {
    sendError(res, "not_found", "Session not found or cannot be started");
    return;
  }

  // Evict Compass profile cache — session is now active.
  invalidateCompassProfile(user.id);

  res.status(200).json({ ok: true, session: toPublicSession(session) });
});

// ── GET /api/me/safe-return/sessions/active ───────────────────────────────────

router.get("/me/safe-return/sessions/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    res.status(200).json({ session: null, featureEnabled: false }); return;
  }

  const session = await getActiveSession(db, user.id);
  res.status(200).json({ session: session ? toPublicSession(session) : null });
});

// ── POST /api/me/safe-return/sessions/:id/extend ─────────────────────────────

router.post("/me/safe-return/sessions/:id/extend", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = extendSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid minutes");
    return;
  }

  const session = await extendTimer(db, req.params.id, user.id, parsed.data.minutes);
  if (!session) {
    sendError(res, "not_found", "Session not found or cannot be extended");
    return;
  }

  res.status(200).json({ ok: true, session: toPublicSession(session) });
});

// ── POST /api/me/safe-return/sessions/:id/confirm ────────────────────────────

router.post("/me/safe-return/sessions/:id/confirm", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const session = await confirmSafe(db, req.params.id, user.id);
  if (!session) {
    sendError(res, "not_found", "Session not found or already closed");
    return;
  }

  // Fire-and-forget: award a Safe Return stamp + suggested memory behind feature flag
  void (async () => {
    try {
      const sc = getServiceClient();
      if (!sc) return;
      const { data: flagRow } = await sc
        .from("feature_flags")
        .select("enabled")
        .eq("flag", "passport_stamps_enabled")
        .maybeSingle();
      if (!(flagRow as any)?.enabled) return;
      const result = await createStamp(sc, {
        userId: user.id,
        stampType: "safe_return",
        tripId: (session as any).trip_id ?? null,
        verificationLevel: "safe_return",
        sourceType: "safe_return_confirm",
        visibility: "private",
      });
      // §20 ledger (TABLE 21). DELIBERATELY NO CITY: a Safe Return says where
      // someone was alone and when they got back, and the reputation projection
      // would turn a city here into a public "Knows <city> well" claim derived
      // from that. This event counts toward the level only — the stamp itself
      // is already forced to visibility 'private' above for the same reason.
      void recordContributionIfEnabled(sc, {
        userId: user.id,
        eventType: "safe_return_completed",
        sourceType: "safe_return_confirm",
        sourceId: req.params.id,
        verificationLevel: "safe_return",
        metadata: { category: "safe_return" },
      });
      if (result?.isNew) {
        const { data: memFlagRow } = await sc
          .from("feature_flags")
          .select("enabled")
          .eq("flag", "passport_memories_enabled")
          .maybeSingle();
        if ((memFlagRow as any)?.enabled) {
          await createSuggestedMemory(sc, {
            userId: user.id,
            title: "Safe return confirmed",
            category: "safe_return",
            tripId: (session as any).trip_id ?? null,
            sourceType: "safe_return_confirm",
            verificationLevel: "safe_return",
            suggestionReason: "You confirmed a Safe Return",
          });
        }
      }

      // Also award via StampAwardEngine (idempotent) so safe_return_completed
      // participates in the stamp system v2 award/revoke/audit flow.
      const engineResult = await awardStamp(sc, {
        userId:        user.id,
        definitionSlug: "safe_return_completed",
        sourceType:    "safe_return",
        sourceId:      (session as any).id,
      });
      if (engineResult.awarded) {
        const { NotificationService } = await import("../services/notifications/NotificationService.js");
        const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");
        const notifSvc    = new NotificationService(sc);
        const notifRouter = new NotificationRouter(sc);
        const row = await notifSvc.create({
          userId:     user.id,
          eventType:  "passport.stamp_earned",
          sourceType: "safe_return",
          sourceId:   (session as any).id,
          params:     { location: "Safe Return" },
        });
        if (row) await notifRouter.route(row);
      }
    } catch {}
  })();

  // Evict Compass profile cache — session confirmed/closed, safeReturnActive changes.
  invalidateCompassProfile(user.id);

  res.status(200).json({ ok: true, session: toPublicSession(session) });
});

// ── POST /api/me/safe-return/sessions/:id/cancel ─────────────────────────────

router.post("/me/safe-return/sessions/:id/cancel", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const session = await cancelSession(db, req.params.id, user.id);
  if (!session) {
    sendError(res, "not_found", "Session not found or already closed");
    return;
  }

  // Evict Compass profile cache — session cancelled, safeReturnActive changes.
  invalidateCompassProfile(user.id);

  res.status(200).json({ ok: true, session: toPublicSession(session) });
});

// ── POST /api/me/safe-return/sessions/:id/trigger-missed ─────────────────────
// Marks a session as missed and escalates. Timer must have already expired.

router.post("/me/safe-return/sessions/:id/trigger-missed", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  // Fetch session first to get escalation level and options
  const existing = await getSessionById(db, req.params.id, user.id);
  if (!existing || existing.status !== "active") {
    sendError(res, "not_found", "Active session not found");
    return;
  }

  // Timer must have already expired — reject premature triggers
  if (existing.timerEndAt && new Date(existing.timerEndAt) > new Date()) {
    sendError(res, "forbidden", "Timer has not yet expired");
    return;
  }

  const session = await markMissed(db, req.params.id, user.id);
  if (!session) {
    sendError(res, "db_error", "Failed to mark session as missed", { exposeDetail: true });
    return;
  }

  // Escalation: Level 0 = notify only the user
  //             Level 1 = user + TC (if enabled)
  //             Level 2 = user + TC + live share prompt
  //             Level 3 = user + TC + host + crew

  await sendMissedCheckIn(db, session);

  if (session.escalationLevel >= 1) {
    const contacts = await listContacts(db, session.id, user.id);
    const flagTcEnabled = await isFlagEnabled(db, "safe_return_trusted_circle_alerts_enabled");
    if (flagTcEnabled) {
      await notifyTrustedCircle(db, session, contacts);
      // Mark contacts as notified
      await Promise.all(contacts.map((c) => markContactNotified(db, c.id)));
    }
  }

  if (session.escalationLevel >= 3) {
    await notifyHost(db, session);
    await notifyTripCrew(db, session);
  }

  res.status(200).json({ ok: true, session: toPublicSession(session), escalationLevel: session.escalationLevel });
});

// ── POST /api/me/safe-return/sessions/:id/live-share/start ───────────────────

router.post("/me/safe-return/sessions/:id/live-share/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled"); return;
  }
  if (!await isFlagEnabled(db, "safe_return_live_share_enabled")) {
    sendError(res, "feature_disabled", "Live location sharing is not yet enabled"); return;
  }

  const session = await getSessionById(db, req.params.id, user.id);
  if (!session) {
    sendError(res, "not_found", "Session not found"); return;
  }
  if (!session.liveShareEnabled) {
    sendError(res, "forbidden", "Live share was not enabled for this session"); return;
  }

  const schema = z.object({
    recipientContactId: z.string().uuid(),
    durationMinutes:    z.number().int().min(5).max(240).optional().default(60),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "recipientContactId (uuid) is required");
    return;
  }

  // Verify the contact belongs to this session and has live-location permission
  const { data: contact } = await db
    .from("safe_return_contacts")
    .select("id, contact_user_id, can_receive_live_location")
    .eq("id", parsed.data.recipientContactId)
    .eq("session_id", session.id)
    .maybeSingle();

  if (!contact) {
    sendError(res, "not_found", "Contact not found on this session"); return;
  }
  if (!(contact as any).can_receive_live_location) {
    sendError(res, "forbidden", "This contact has not been granted live location access"); return;
  }

  const share = await startShare(
    db,
    session.id,
    user.id,
    (contact as any).contact_user_id ?? null,
    (contact as any).id,
    parsed.data.durationMinutes,
  );

  if (!share) {
    sendError(res, "db_error", "Failed to start live share", { exposeDetail: true }); return;
  }

  res.status(201).json({
    ok: true,
    share: {
      id: share.id,
      status: share.status,
      startedAt: share.startedAt,
      expiresAt: share.expiresAt,
      // No GPS in response
    },
  });
});

// ── POST /api/me/safe-return/sessions/:id/live-share/stop ────────────────────

router.post("/me/safe-return/sessions/:id/live-share/stop", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const { shareId } = req.body ?? {};
  if (!shareId || typeof shareId !== "string") {
    sendError(res, "invalid_payload", "shareId is required"); return;
  }

  const share = await stopShare(db, shareId, user.id);
  if (!share) {
    sendError(res, "not_found", "Live share not found or already stopped"); return;
  }

  res.status(200).json({ ok: true, share: { id: share.id, status: share.status, stoppedAt: share.stoppedAt } });
});

// ── GET /api/safe-return/live-share/:shareId ──────────────────────────────────
// Recipient view — requireSafeReturnRecipient middleware enforces strict
// recipient-only access before the handler runs.

router.get(
  "/safe-return/live-share/:shareId",
  requireSafeReturnRecipient,
  async (req, res) => {
    const { db, callerUserId } = (req as any).safeReturnRecipient as {
      db: NonNullable<ReturnType<typeof getServiceClient>>;
      callerUserId: string;
      shareId: string;
      share: any;
    };

    if (!await isFlagEnabled(db, "safe_return_enabled")) {
      sendError(res, "feature_disabled", "Safe Return is not yet enabled"); return;
    }
    if (!await isFlagEnabled(db, "safe_return_live_share_enabled")) {
      sendError(res, "feature_disabled", "Live location sharing is not yet enabled"); return;
    }

    const { shareId } = (req as any).safeReturnRecipient as { shareId: string };
    const result = await getRecipientView(db, shareId, callerUserId);

    if ("error" in result) {
      if (result.error === "not_found") { sendError(res, "not_found", "Live share not found"); return; }
      if (result.error === "expired")   { sendError(res, "not_found", "Live share has expired"); return; }
      if (result.error === "stopped")   { sendError(res, "not_found", "Live share has been stopped"); return; }
      if (result.error === "forbidden") { sendError(res, "forbidden", "You are not authorized to view this share"); return; }
    }

    if ("view" in result) {
      res.status(200).json({ ok: true, share: result.view });
      return;
    }

    sendError(res, "not_found");
  },
);

// ── GET /api/me/safe-return/history ──────────────────────────────────────────

router.get("/me/safe-return/history", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    res.status(200).json({ sessions: [], featureEnabled: false }); return;
  }

  const limit = Math.min(50, parseInt(String(req.query.limit ?? "20"), 10) || 20);
  const sessions = await listHistory(db, user.id, limit);

  // Fetch per-session event aggregates in one query
  const sessionIds = sessions.map((s) => s.id);
  let eventsBySession: Record<string, { alertsSent: number; missedCount: number; liveShareStarted: number; liveShareStopped: number }> = {};
  try {
    if (sessionIds.length > 0) {
      const { data: events } = await db
        .from("safe_return_events")
        .select("session_id, event_type")
        .in("session_id", sessionIds);

      for (const ev of (events as any[]) ?? []) {
        const sid = ev.session_id as string;
        if (!eventsBySession[sid]) {
          eventsBySession[sid] = { alertsSent: 0, missedCount: 0, liveShareStarted: 0, liveShareStopped: 0 };
        }
        const agg = eventsBySession[sid]!;
        const t = ev.event_type as string;
        // Count all alert-family events as "alertsSent" — trusted circle,
        // host, and crew notifications are the actual alert event types;
        // "alert_sent" is kept as an alias for any legacy rows.
        if (t === "alert_sent" || t === "trusted_circle_notified" || t === "host_notified" || t === "crew_notified") agg.alertsSent++;
        if (t === "check_in_missed")     agg.missedCount++;
        if (t === "live_share_started")  agg.liveShareStarted++;
        if (t === "live_share_stopped" || t === "live_share_expired") agg.liveShareStopped++;
      }
    }
  } catch { /* non-fatal — omit aggregates */ }

  res.status(200).json({
    sessions: sessions.map((s) => ({
      ...toPublicSession(s),
      events: eventsBySession[s.id] ?? { alertsSent: 0, missedCount: 0, liveShareStarted: 0, liveShareStopped: 0 },
    })),
  });
});

// ── GET /api/me/safe-return/trusted-contacts ──────────────────────────────────
// List the user's Trusted Circle members (for contact selection in setup)

router.get("/me/safe-return/trusted-contacts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    res.status(200).json({ contacts: [], featureEnabled: false }); return;
  }

  // Trusted Circle = mutual follows (following each other) or circle members
  try {
    const { data: following } = await client
      .from("user_follows")
      .select("following_id, profiles!user_follows_following_id_fkey(id, display_name, handle, avatar_url)")
      .eq("follower_id", auth.user.id);

    // Universal display-name rule: contacts show @handle unless opted in.
    const rows = ((following as any[]) ?? []);
    const allowedContactNames = await nameVisibilitySet(db, rows.map((f: any) => f.following_id));
    const contacts = rows.map((f: any) => ({
      userId:      f.following_id,
      displayName: allowedContactNames.has(f.following_id as string) ? (f.profiles?.display_name ?? null) : null,
      handle:      f.profiles?.handle ?? null,
      avatarUrl:   f.profiles?.avatar_url ?? null,
    }));

    res.status(200).json({ contacts });
  } catch {
    res.status(200).json({ contacts: [] });
  }
});

// ── GET /api/me/safe-return/sessions/:id/contacts ─────────────────────────────
// List contacts attached to a session (supports "Share Location Now" picker)

router.get("/me/safe-return/sessions/:id/contacts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  if (!await isFlagEnabled(db, "safe_return_enabled")) {
    res.status(200).json({ contacts: [], featureEnabled: false }); return;
  }

  const session = await getSessionById(db, req.params.id, user.id);
  if (!session) {
    sendError(res, "not_found", "Session not found"); return;
  }

  try {
    const { data: rows } = await db
      .from("safe_return_contacts")
      .select("id, contact_user_id, contact_name, can_receive_live_location")
      .eq("session_id", session.id);

    const contacts = ((rows as any[]) ?? []).map((r: any) => ({
      id:                    r.id,
      contactUserId:         r.contact_user_id ?? null,
      contactName:           r.contact_name ?? null,
      canReceiveLiveLocation: !!r.can_receive_live_location,
    }));

    res.status(200).json({ ok: true, contacts });
  } catch {
    res.status(200).json({ ok: true, contacts: [] });
  }
});

export default router;
