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
import { buildConsumerProjection } from "../services/passport/PassportConsumerProjections.js";
import { allowSafetyContext } from "../services/passport/PassportConsumerAccess.js";
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
  alertFellShort,
  type AlertOutcome,
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

/**
 * Is a Safe Return flag on?
 *
 * ── "OFF" AND "WE DO NOT KNOW" ARE DIFFERENT ANSWERS ────────────────────────
 * supabase-js RESOLVES on a database error, so `const { data } = await …;
 * Boolean(data?.enabled)` returned FALSE for a flag row that could not be read,
 * and every caller renders false as "Safe Return is not yet enabled". Telling
 * someone who is about to walk home alone that the feature does not exist —
 * when it does, and a retry would have started their timer — is not a graceful
 * degradation. `unknown` is a third value so the callers can refuse with a
 * retryable 503 instead of a flat, false "off".
 *
 * A missing ROW is still a real `false`: an unseeded flag is off by design.
 */
type FlagState = "on" | "off" | "unknown";

/**
 * NAME KEPT DELIBERATELY. `scripts/check-flag-polarity.mjs` resolves which
 * flags this router reads by finding the string literals passed to a helper
 * called `isFlagEnabled` (this file has a declared SHADOW_READERS entry for it).
 * Renaming it made `safe_return_live_share_enabled` and
 * `safe_return_trusted_circle_alerts_enabled` report as SEEDED BUT NEVER READ —
 * i.e. the guard could no longer see that these gates exist. What changed is
 * the RETURN TYPE, not the name or the arguments.
 */
async function isFlagEnabled(db: ReturnType<typeof getServiceClient>, flag: string): Promise<FlagState> {
  if (!db) return "unknown";
  try {
    const { data, error } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    if (error) return "unknown";
    return (data as any)?.enabled ? "on" : "off";
  } catch {
    return "unknown";
  }
}

/**
 * Answer a request when a flag could not be read.
 * 503 + retryable, never a 404 "feature_disabled" that reads as "this does not
 * exist for you".
 */
function sendFlagUnknown(res: Parameters<typeof sendError>[1] extends never ? never : any, flag: string): void {
  sendError(
    res,
    "degraded_unavailable",
    `Safe Return availability could not be confirmed right now (${flag}). Please try again.`,
  );
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
  const flag = await isFlagEnabled(db, "safe_return_enabled");
  if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
  if (flag === "off") {
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
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled", "Safe Return is not yet enabled"); return; }
  }

  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // Reject if the user already has an active session — prevents double-sessions
  // when the setup sheet is opened from two different screens concurrently.
  const existing = await getActiveSession(db, user.id);
  if (!existing.ok) {
    // The duplicate-session pre-check could not run. Creating anyway risks a
    // second session; refusing costs one retry. Refuse — and say why.
    req.log.error({ reason: existing.reason, userId: user.id }, "safe-return create: active-session pre-check failed");
    sendError(res, "degraded_unavailable", "We could not start Safe Return right now. Please try again.");
    return;
  }
  if (existing.value) {
    sendError(res, "conflict", "You already have an active Safe Return session");
    return;
  }

  const created = await createSession(db, { userId: user.id, ...parsed.data });
  if (!created) {
    // Could be a true DB error, or the partial unique index fired for a concurrent
    // request that slipped past the pre-check above.  Re-check so we can return a
    // meaningful 409 instead of a generic 500.
    const stillActive = await getActiveSession(db, user.id);
    if (stillActive.ok && stillActive.value) {
      sendError(res, "conflict", "You already have an active Safe Return session");
    } else {
      sendError(res, "db_error", "Failed to create session", { exposeDetail: true });
    }
    return;
  }

  const session = created.session;

  // Evict Compass profile cache — safeReturnActive signal changes immediately.
  invalidateCompassProfile(user.id);

  // THE CONTACTS ARE REPORTED, NOT ASSUMED.
  //
  // `contactsSaved` is what `safe_return_contacts` actually holds. When it is
  // short of `contactsRequested`, the people the user nominated will NOT be
  // alerted if this timer runs out, and the response says so in the same breath
  // as the 201 rather than letting a green check mark stand for a write that
  // did not happen. The session itself is still real and still worth having:
  // the timer runs and the traveller's own missed-check-in alert works.
  const contactsIncomplete = created.contactsSaved < created.contactsRequested;
  if (contactsIncomplete) {
    req.log.error(
      {
        sessionId: session.id,
        userId: user.id,
        contactsRequested: created.contactsRequested,
        contactsSaved: created.contactsSaved,
        reason: created.contactsError,
      },
      "safe-return create: trusted contacts were NOT stored — this session cannot alert them",
    );
  }

  res.status(201).json({
    ok: true,
    session: toPublicSession(session),
    contacts: { requested: created.contactsRequested, saved: created.contactsSaved },
    ...(contactsIncomplete
      ? {
          degraded: true,
          warnings: ["trusted_contacts_not_saved"],
          message:
            "Your Safe Return timer is running, but we could not save your trusted contacts. They will not be alerted — please add them again.",
        }
      : {}),
  });

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
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled"); return; }
  }

  const started = await startSession(db, req.params.id, user.id);
  if (started.outcome === "unavailable") {
    req.log.error({ reason: started.reason, sessionId: req.params.id }, "safe-return start: update failed");
    sendError(res, "degraded_unavailable", "We could not start your Safe Return timer. Please try again.");
    return;
  }
  if (started.outcome === "no_match") {
    sendError(res, "not_found", "Session not found or cannot be started");
    return;
  }

  // Evict Compass profile cache — session is now active.
  invalidateCompassProfile(user.id);

  res.status(200).json({ ok: true, session: toPublicSession(started.session) });
});

// ── GET /api/me/safe-return/sessions/active ───────────────────────────────────

router.get("/me/safe-return/sessions/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    // NOT `{ session: null }`. "You have no Safe Return running" is the whole
    // answer this endpoint gives, and it must never be assembled from a flag
    // read that failed.
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { res.status(200).json({ session: null, featureEnabled: false }); return; }
  }

  const active = await getActiveSession(db, user.id);
  if (!active.ok) {
    req.log.error({ reason: active.reason, userId: user.id }, "safe-return: active-session read failed");
    sendError(
      res,
      "degraded_unavailable",
      "We could not check whether you have a Safe Return running. Please try again.",
    );
    return;
  }
  res.status(200).json({ session: active.value ? toPublicSession(active.value) : null });
});

// ── POST /api/me/safe-return/sessions/:id/extend ─────────────────────────────

router.post("/me/safe-return/sessions/:id/extend", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled"); return; }
  }

  const parsed = extendSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid minutes");
    return;
  }

  const extended = await extendTimer(db, req.params.id, user.id, parsed.data.minutes);
  if (extended.outcome === "unavailable") {
    // A 404 here would tell someone whose timer is about to expire that their
    // session does not exist. It does; the write failed and a retry may work.
    req.log.error({ reason: extended.reason, sessionId: req.params.id }, "safe-return extend: failed");
    sendError(res, "degraded_unavailable", "We could not extend your timer. Please try again.");
    return;
  }
  if (extended.outcome === "no_match") {
    sendError(res, "not_found", "Session not found or cannot be extended");
    return;
  }

  res.status(200).json({ ok: true, session: toPublicSession(extended.session) });
});

// ── POST /api/me/safe-return/sessions/:id/confirm ────────────────────────────

router.post("/me/safe-return/sessions/:id/confirm", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled"); return; }
  }

  const confirmed = await confirmSafe(db, req.params.id, user.id);
  if (confirmed.outcome === "unavailable") {
    // "Already closed" would tell someone who just got home that they are done.
    // They are not: the session is still active and will alert their contacts.
    req.log.error({ reason: confirmed.reason, sessionId: req.params.id }, "safe-return confirm: failed");
    sendError(res, "degraded_unavailable", "We could not record that you are safe. Please try again.");
    return;
  }
  if (confirmed.outcome === "no_match") {
    sendError(res, "not_found", "Session not found or already closed");
    return;
  }
  const session = confirmed.session;

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
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled"); return; }
  }

  const cancelled = await cancelSession(db, req.params.id, user.id);
  if (cancelled.outcome === "unavailable") {
    // A cancel that failed must not display as cancelled: the session is still
    // running and will escalate to this person's contacts at the timer.
    req.log.error({ reason: cancelled.reason, sessionId: req.params.id }, "safe-return cancel: failed");
    sendError(res, "degraded_unavailable", "We could not cancel this Safe Return. It may still be running — please try again.");
    return;
  }
  if (cancelled.outcome === "no_match") {
    sendError(res, "not_found", "Session not found or already closed");
    return;
  }

  // Evict Compass profile cache — session cancelled, safeReturnActive changes.
  invalidateCompassProfile(user.id);

  res.status(200).json({ ok: true, session: toPublicSession(cancelled.session) });
});

// ── POST /api/me/safe-return/sessions/:id/trigger-missed ─────────────────────
// Marks a session as missed and escalates. Timer must have already expired.

router.post("/me/safe-return/sessions/:id/trigger-missed", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled"); return; }
  }

  // Fetch session first to get escalation level and options
  const existingRead = await getSessionById(db, req.params.id, user.id);
  if (!existingRead.ok) {
    req.log.error({ reason: existingRead.reason, sessionId: req.params.id }, "safe-return trigger-missed: session read failed");
    sendError(res, "degraded_unavailable", "We could not start the escalation. Please try again.");
    return;
  }
  const existing = existingRead.value;
  if (!existing || existing.status !== "active") {
    sendError(res, "not_found", "Active session not found");
    return;
  }

  // Timer must have already expired — reject premature triggers
  if (existing.timerEndAt && new Date(existing.timerEndAt) > new Date()) {
    sendError(res, "forbidden", "Timer has not yet expired");
    return;
  }

  const missed = await markMissed(db, req.params.id, user.id);
  if (missed.outcome === "unavailable") {
    req.log.error({ reason: missed.reason, sessionId: req.params.id }, "safe-return trigger-missed: markMissed failed");
    sendError(res, "degraded_unavailable", "We could not start the escalation. Please try again.");
    return;
  }
  if (missed.outcome === "no_match") {
    sendError(res, "not_found", "Active session not found");
    return;
  }
  const session = missed.session;

  // ── ESCALATION ─────────────────────────────────────────────────────────────
  //
  // Level 0 = notify only the user
  // Level 1 = user + TC (if enabled)
  // Level 2 = user + TC + live share prompt
  // Level 3 = user + TC + host + crew
  //
  // WHAT CHANGED, AND WHY IT IS THE POINT OF THIS ENDPOINT. Every call below
  // used to return `void`, so the handler answered `{ ok: true, escalationLevel
  // }` no matter what happened — including the case where `listContacts` hit an
  // unreadable table, handed back `[]`, and "alert the trusted circle" quietly
  // became "alert nobody". The response now carries what was actually achieved,
  // and `alertsIncomplete` is true whenever anyone who should have been told
  // was not. The escalation is NEVER abandoned because one channel failed —
  // reaching two of three people beats reaching none — so this is a 200 with an
  // honest body, not a refusal.
  const outcomes: Record<string, AlertOutcome> = {};
  let alertsIncomplete = false;

  outcomes.traveller = await sendMissedCheckIn(db, session);

  if (session.escalationLevel >= 1) {
    const contactsRead = await listContacts(db, session.id, user.id);
    const flagTc = await isFlagEnabled(db, "safe_return_trusted_circle_alerts_enabled");
    if (flagTc === "unknown") {
      // A flag we cannot read must not silently cancel an alert. Attempt the
      // notification: `trusted_circle_enabled` on the session is the user's own
      // consent and is checked inside notifyTrustedCircle, so this cannot
      // notify anyone the user did not nominate.
      req.log.error({ sessionId: session.id }, "safe-return escalation: trusted-circle flag unreadable — attempting the alert anyway");
    }
    if (flagTc !== "off") {
      const contacts = contactsRead.ok ? contactsRead.value : [];
      if (!contactsRead.ok) {
        req.log.error(
          { reason: contactsRead.reason, sessionId: session.id },
          "safe-return escalation: contacts unreadable — we cannot say who should have been alerted",
        );
      }
      outcomes.trustedCircle = await notifyTrustedCircle(db, session, contacts, !contactsRead.ok);
      // Mark contacts as notified — only the ones an alert was attempted for.
      const stamps = await Promise.all(contacts.map((c) => markContactNotified(db, c.id)));
      if (stamps.some((r) => !r.ok)) {
        req.log.error({ sessionId: session.id }, "safe-return escalation: notified_at not stamped for every contact");
      }
    }
  }

  if (session.escalationLevel >= 3) {
    outcomes.host = await notifyHost(db, session);
    outcomes.crew = await notifyTripCrew(db, session);
  }

  for (const o of Object.values(outcomes)) if (alertFellShort(o)) alertsIncomplete = true;
  if (alertsIncomplete) {
    req.log.error({ sessionId: session.id, outcomes }, "safe-return escalation: NOT everyone who should have been alerted was");
  }

  res.status(200).json({
    ok: true,
    session: toPublicSession(session),
    escalationLevel: session.escalationLevel,
    alerts: outcomes,
    alertsIncomplete,
    ...(alertsIncomplete
      ? { message: "We could not confirm that everyone was alerted. Please contact someone directly if you can." }
      : {}),
  });
});

// ── POST /api/me/safe-return/sessions/:id/live-share/start ───────────────────

router.post("/me/safe-return/sessions/:id/live-share/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled"); return; }
  }
  {
    const flag = await isFlagEnabled(db, "safe_return_live_share_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_live_share_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled", "Live location sharing is not yet enabled"); return; }
  }

  const sessionRead = await getSessionById(db, req.params.id, user.id);
  if (!sessionRead.ok) {
    req.log.error({ reason: sessionRead.reason, sessionId: req.params.id }, "safe-return live-share start: session read failed");
    sendError(res, "degraded_unavailable", "We could not start live sharing. Please try again.");
    return;
  }
  const session = sessionRead.value;
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

  // Verify the contact belongs to this session and has live-location permission.
  //
  // FAIL CLOSED, AND SAY WHICH FAILURE IT WAS. `can_receive_live_location` is
  // the consent that decides whether a person's live position may be handed to
  // someone, so an unreadable row can never be treated as a grant. It was also
  // never distinguished from "no such contact": `const { data: contact }` made
  // a read error look like a contact the user had not added, and the sharer got
  // a flat 404 for a share that would have worked on retry. Both refuse; only
  // one of them is retryable, and only one of them is true.
  const { data: contact, error: contactErr } = await db
    .from("safe_return_contacts")
    .select("id, contact_user_id, can_receive_live_location")
    .eq("id", parsed.data.recipientContactId)
    .eq("session_id", session.id)
    .maybeSingle();

  if (contactErr) {
    req.log.error({ err: contactErr, sessionId: session.id }, "safe-return live-share start: contact permission read failed");
    sendError(res, "degraded_unavailable", "We could not confirm this contact's permissions. Please try again.");
    return;
  }
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
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { sendError(res, "feature_disabled"); return; }
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

    {
      const flag = await isFlagEnabled(db, "safe_return_enabled");
      if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
      if (flag === "off") { sendError(res, "feature_disabled", "Safe Return is not yet enabled"); return; }
    }
    {
      const flag = await isFlagEnabled(db, "safe_return_live_share_enabled");
      if (flag === "unknown") { sendFlagUnknown(res, "safe_return_live_share_enabled"); return; }
      if (flag === "off") { sendError(res, "feature_disabled", "Live location sharing is not yet enabled"); return; }
    }

    const { shareId } = (req as any).safeReturnRecipient as { shareId: string };
    const result = await getRecipientView(db, shareId, callerUserId);

    if ("error" in result) {
      // `unavailable` is 503-and-retryable, NOT one of the three 404s. "Expired",
      // "stopped" and "not found" all tell a worried contact that there is
      // nothing more to look at; only one of those may be said about a read
      // that failed, and it is none of them.
      if (result.error === "unavailable") {
        sendError(res, "degraded_unavailable", "This live share could not be loaded. Please try again.");
        return;
      }
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
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { res.status(200).json({ sessions: [], featureEnabled: false }); return; }
  }

  const limit = Math.min(50, parseInt(String(req.query.limit ?? "20"), 10) || 20);
  const historyRead = await listHistory(db, user.id, limit);
  if (!historyRead.ok) {
    // An empty history reads as "you have never used Safe Return". That is a
    // claim about the record, and a failed read cannot make it.
    req.log.error({ reason: historyRead.reason, userId: user.id }, "safe-return history: read failed");
    sendError(res, "degraded_unavailable", "Your Safe Return history could not be loaded. Please try again.");
    return;
  }
  const sessions = historyRead.value;

  // Fetch per-session event aggregates in one query
  const sessionIds = sessions.map((s) => s.id);
  let eventsBySession: Record<string, { alertsSent: number; missedCount: number; liveShareStarted: number; liveShareStopped: number }> = {};
  // Set when the events read failed: the per-session counts below are then
  // NOT zero-because-nothing-happened, they are unknown, and "0 alerts sent"
  // is the single most misleading number this endpoint can print.
  let eventsUnavailable = false;
  try {
    if (sessionIds.length > 0) {
      const { data: events, error: eventsErr } = await db
        .from("safe_return_events")
        .select("session_id, event_type")
        .in("session_id", sessionIds);
      if (eventsErr) {
        eventsUnavailable = true;
        req.log.error({ err: eventsErr, userId: user.id }, "safe-return history: event aggregates unreadable");
      }

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
  } catch (err) {
    eventsUnavailable = true;
    req.log.error({ err, userId: user.id }, "safe-return history: event aggregates threw");
  }

  res.status(200).json({
    sessions: sessions.map((s) => ({
      ...toPublicSession(s),
      // `null`, not a row of zeros, when the aggregates could not be read.
      events: eventsUnavailable
        ? null
        : (eventsBySession[s.id] ?? { alertsSent: 0, missedCount: 0, liveShareStarted: 0, liveShareStopped: 0 }),
    })),
    ...(eventsUnavailable ? { eventsUnavailable: true } : {}),
  });
});

// ── GET /api/me/safe-return/trusted-contacts ──────────────────────────────────
// List the user's Trusted Circle members (for contact selection in setup)

router.get("/me/safe-return/trusted-contacts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { res.status(200).json({ contacts: [], featureEnabled: false }); return; }
  }

  // Trusted Circle = mutual follows (following each other) or circle members
  //
  // The `catch { res.json({ contacts: [] }) }` this replaces is the same defect
  // in its most direct form: the ONE screen where a person picks who to alert
  // if they do not come back would have rendered "you have nobody" out of a
  // failed read, and they would have set up a Safe Return with an empty circle.
  try {
    const { data: following, error: followErr } = await client
      .from("user_follows")
      .select("following_id, profiles!user_follows_following_id_fkey(id, display_name, handle, avatar_url)")
      .eq("follower_id", auth.user.id);

    if (followErr) {
      req.log.error({ err: followErr, userId: auth.user.id }, "safe-return trusted-contacts: read failed");
      sendError(res, "degraded_unavailable", "Your contacts could not be loaded. Please try again.");
      return;
    }

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
  } catch (err) {
    req.log.error({ err, userId: auth.user.id }, "safe-return trusted-contacts: threw");
    sendError(res, "degraded_unavailable", "Your contacts could not be loaded. Please try again.");
  }
});

// ── GET /api/me/safe-return/sessions/:id/contacts ─────────────────────────────
// List contacts attached to a session (supports "Share Location Now" picker)

router.get("/me/safe-return/sessions/:id/contacts", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { res.status(200).json({ contacts: [], featureEnabled: false }); return; }
  }

  const sessionRead = await getSessionById(db, req.params.id, user.id);
  if (!sessionRead.ok) {
    req.log.error({ reason: sessionRead.reason, sessionId: req.params.id }, "safe-return session contacts: session read failed");
    sendError(res, "degraded_unavailable", "We could not load this session. Please try again.");
    return;
  }
  const session = sessionRead.value;
  if (!session) {
    sendError(res, "not_found", "Session not found"); return;
  }

  // This is the "Share Location Now" picker. An empty list means "you nominated
  // nobody"; the `catch`/`?? []` pair used to produce that same empty list from
  // an unreadable table, so a user looking for someone to send their location to
  // was shown a screen saying they had no one.
  try {
    const { data: rows, error } = await db
      .from("safe_return_contacts")
      .select("id, contact_user_id, contact_name, can_receive_live_location")
      .eq("session_id", session.id);

    if (error) {
      req.log.error({ err: error, sessionId: session.id }, "safe-return session contacts: read failed");
      sendError(res, "degraded_unavailable", "Your contacts could not be loaded. Please try again.");
      return;
    }

    const contacts = ((rows as any[]) ?? []).map((r: any) => ({
      id:                    r.id,
      contactUserId:         r.contact_user_id ?? null,
      contactName:           r.contact_name ?? null,
      canReceiveLiveLocation: !!r.can_receive_live_location,
    }));

    res.status(200).json({ ok: true, contacts });
  } catch (err) {
    req.log.error({ err, sessionId: session.id }, "safe-return session contacts: threw");
    sendError(res, "degraded_unavailable", "Your contacts could not be loaded. Please try again.");
  }
});

// ── GET /api/me/safe-return/contacts/:userId/passport ─────────────────────────
//
// §21 TABLE 22, Safety row: "restricted purpose-specific context only". The
// `safety` variant is the narrowest projection in the system — handle,
// verification, and whether §24 marks this relationship blocked/unavailable.
// Deliberately no name, no avatar, no location, no trust, no availability: a
// safety surface needs to identify a person and know the relationship is
// intact, and nothing else.
//
// The PURPOSE is the authorisation (`allowSafetyContext`): a safe-return
// contact link in either direction. Without one there is no safety question to
// answer, and the route refuses rather than projecting the restricted shape —
// the restricted shape is what a permitted viewer sees of a blocked person, not
// a consolation prize for an unrelated one.
router.get("/me/safe-return/contacts/:userId/passport", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const db = getServiceClient() ?? client;
  {
    const flag = await isFlagEnabled(db, "safe_return_enabled");
    if (flag === "unknown") { sendFlagUnknown(res, "safe_return_enabled"); return; }
    if (flag === "off") { res.status(200).json({ passport: null, featureEnabled: false }); return; }
  }

  const { userId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const gate = await allowSafetyContext(db, user.id, userId);
  if (!gate.allowed) { sendError(res, "forbidden", "No safety relationship with this user"); return; }

  try {
    // OWNERSHIP, NOT A FLAG CHECK. Safe Return does not depend on Locate My
    // Friends (Map spec §23 lists them as two SEPARATE purpose-bound location
    // scopes: "Locate My Friends: temporary group-scoped approximate/precise"
    // and "Safe Return: purpose-bound precise location"), and the `safety`
    // variant projects handle / verified / blocked and no traveler state at
    // all. Until this argument existed, the shared Passport assembler still
    // SELECTed `locate_friends_members` and `locate_friends_sessions` on this
    // request and threw the answer away — a cross-feature read of a disabled
    // feature's storage, ungated, on a safety surface.
    //
    // `crewSignal: "excluded"` states the contract instead of inheriting
    // whatever `locate_friends_enabled` happens to be set to, so turning that
    // flag on can never quietly hand this read back to Safe Return.
    const passport = await buildConsumerProjection(db, "safety", userId, user.id, {
      crewSignal: "excluded",
    });
    if (!passport) { sendError(res, "not_found", "User not found"); return; }
    res.status(200).json({ passport });
  } catch (err) {
    req.log.error({ err, userId }, "safe-return contact passport projection failed");
    sendError(res, "db_error", "Could not load contact passport");
  }
});

export default router;
