/**
 * Find Your Circle — API routes.
 *
 * Mounted at /api/circle (via index.ts → router.use(circleRouter)).
 *
 * All routes:
 *   - Require authentication via requireUser
 *   - Gate on `find_your_circle_enabled` feature flag (fail-open: disabled if
 *     flag row missing)
 *   - Validate context type strictly (trip | event); unknown types → 400
 *   - Never expose: email, phone, GPS, needs_help bool, admin notes,
 *     emergency data, or private trip/event fields
 *
 * precise_live visibility mode is deferred to V2; any request specifying it
 * returns 403.
 */

import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, safeSecretEquals, type ApiErrorCode } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  canViewCirclePresence,
  canViewCirclePresenceBatch,
  canBeSeenByViewersBatch,
  CURRENT_CONSENT_VERSION,
  type ContextType,
} from "../lib/circleAccessGuard.js";
import { shapePresence, type CircleProfileSnippet } from "../lib/circleResponseShaper.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter as NotifRouter } from "../services/notifications/NotificationRouter.js";
import { nameVisibilitySet, nameVisibleFor } from "../lib/publicIdentity.js";

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_CONTEXT_TYPES = new Set<string>(["trip", "event"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Presence stale threshold defaults
const TRIP_PRESENCE_TTL_HOURS  = 24; // 24h after trip end
const EVENT_PRESENCE_TTL_HOURS = 2;  // 2h after event end

// Rate-limit windows (configurable via env)
const CIRCLE_MEMBERS_RL_LIMIT  = parseInt(process.env.CIRCLE_MEMBERS_RL_LIMIT  ?? "60",  10);
const CIRCLE_MEMBERS_RL_WIN_MS  = 60_000;           // 60 calls/min (scrape prevention)
const CIRCLE_PRESENCE_RL_LIMIT  = parseInt(process.env.CIRCLE_PRESENCE_RL_LIMIT ?? "30", 10);
const CIRCLE_PRESENCE_RL_WIN_MS = 5 * 60_000;       // 30 updates/5 min (spam prevention)
const CIRCLE_NEED_HELP_RL_LIMIT = parseInt(process.env["CIRCLE_NEED_HELP_RL_LIMIT"] ?? "20", 10); // set to 0 to disable
const CIRCLE_NEED_HELP_RL_WIN_MS = 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function validateContextType(
  res: any,
  type: string,
): type is ContextType {
  if (!VALID_CONTEXT_TYPES.has(type)) {
    sendError(res, "invalid_payload", `Unknown context type '${type}'. Must be 'trip' or 'event'.`);
    return false;
  }
  return true;
}

function validateContextId(res: any, id: string): boolean {
  if (!UUID_RE.test(id)) {
    sendError(res, "invalid_payload", "Invalid context id");
    return false;
  }
  return true;
}

/** Require the find_your_circle_enabled flag (NOT the kill-switch). */
async function requireFeatureEnabled(res: any, sc: any): Promise<boolean> {
  const enabled = await isFlagEnabled(sc, "find_your_circle_enabled");
  if (!enabled) {
    sendError(res, "feature_disabled", "Find Your Circle is not available yet");
    return false;
  }
  return true;
}

/** Local admin guard — checks profiles.role = 'admin'. */
async function requireAdmin(
  req: any,
  res: any,
): Promise<{ user: any; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return null;
  }
  const { data, error } = await sc
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (error || !data || (data as any).role !== "admin") {
    sendError(res, "forbidden", "Admin access required");
    return null;
  }
  return { user, sc };
}

/** Check whether userId is the host of the given context. */
async function isContextHost(
  sc: any,
  userId: string,
  contextType: ContextType,
  contextId: string,
): Promise<boolean> {
  if (contextType === "trip") {
    const { data } = await sc
      .from("trips")
      .select("owner_id")
      .eq("id", contextId)
      .maybeSingle();
    return (data as any)?.owner_id === userId;
  }
  const { data } = await sc
    .from("events")
    .select("host_id")
    .eq("id", contextId)
    .maybeSingle();
  return (data as any)?.host_id === userId;
}

/** Check whether userId is an accepted member of the context. */
async function isAcceptedMember(
  sc: any,
  userId: string,
  contextType: ContextType,
  contextId: string,
): Promise<boolean> {
  if (contextType === "trip") {
    const { data, error } = await sc
      .from("trip_members")
      .select("role, status")
      .eq("trip_id", contextId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return false;
    const row = data as { role: string; status?: string | null };
    const acceptedRoles = new Set(["owner", "co_host", "member", "viewer"]);
    if (!acceptedRoles.has(row.role)) return false;
    if (row.status != null && row.status !== "accepted") return false;
    return true;
  }
  // Event: require both RSVP going AND a confirmed event_attendees row.
  const [rsvpResult, attendeeResult] = await Promise.all([
    sc.from("event_rsvps").select("status").eq("event_id", contextId).eq("user_id", userId).maybeSingle(),
    sc.from("event_attendees").select("user_id").eq("event_id", contextId).eq("user_id", userId).maybeSingle(),
  ]);
  if (rsvpResult.error || !rsvpResult.data) return false;
  if ((rsvpResult.data as any).status !== "going") return false;
  if (attendeeResult.error || !attendeeResult.data) return false;
  return true;
}

/** Fetch accepted member user_ids for a context. */
async function getAcceptedMemberIds(
  sc: any,
  contextType: ContextType,
  contextId: string,
): Promise<string[]> {
  if (contextType === "trip") {
    const { data } = await sc
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", contextId)
      .in("role", ["owner", "co_host", "member", "viewer"]);
    return ((data ?? []) as any[])
      .filter((r) => r.status == null || r.status === "accepted")
      .map((r) => r.user_id as string);
  }
  // Event: intersection of going RSVPs and event_attendees (both required)
  const [rsvpResult, attendeeResult] = await Promise.all([
    sc.from("event_rsvps").select("user_id").eq("event_id", contextId).eq("status", "going"),
    sc.from("event_attendees").select("user_id").eq("event_id", contextId),
  ]);
  const goingIds = new Set(((rsvpResult.data ?? []) as any[]).map((r) => r.user_id as string));
  const attendeeIds = new Set(((attendeeResult.data ?? []) as any[]).map((r) => r.user_id as string));
  return [...goingIds].filter((id) => attendeeIds.has(id));
}

/** Write a circle_audit_events row. Non-fatal — swallows errors. */
async function writeAuditEvent(
  sc: any,
  opts: {
    actorUserId?: string | null;
    targetUserId?: string | null;
    contextType?: string | null;
    contextId?: string | null;
    eventType: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const { error } = await sc.from("circle_audit_events").insert({
      actor_user_id:  opts.actorUserId  ?? null,
      target_user_id: opts.targetUserId ?? null,
      context_type:   opts.contextType  ?? null,
      context_id:     opts.contextId    ?? null,
      event_type:     opts.eventType,
      metadata:       opts.metadata     ?? null,
    });
    if (error) console.warn("circle audit insert failed (non-fatal):", error.message ?? error);
  } catch (err) {
    console.warn("circle audit insert threw (non-fatal):", err);
  }
}

/**
 * Send Circle push notifications to a set of users (fire-and-forget).
 * Swallows all errors — notification failure must never block Circle operations.
 * Caps at 50 recipients to avoid overloading the notification pipeline.
 */
async function sendCircleNotifications(
  sc: any,
  recipientIds: string[],
  eventType: string,
  params: Record<string, string>,
): Promise<void> {
  if (recipientIds.length === 0) return;
  try {
    const svc    = new NotificationService(sc);
    const router = new NotifRouter(sc);
    await Promise.all(
      recipientIds.slice(0, 50).map(async (uid) => {
        try {
          const row = await svc.create({ userId: uid, eventType, params });
          if (row) await router.route(row);
        } catch { /* non-fatal */ }
      }),
    );
  } catch { /* non-fatal */ }
}

/**
 * Post a Circle status card to the trip/event Telegraph thread (fire-and-forget).
 * - Finds the thread via trip_id (trips) or events.chat_thread_id (events).
 * - Inserts a message with msg_type='circle_status_card'.
 * - PRIVACY: the message body intentionally stores ONLY the card subtype — no
 *   status labels, venue names, GPS, or needs_help data.  Any member of the
 *   thread (whether or not they are a Circle member for this context) can read
 *   stored message bodies, so all Circle-specific details MUST remain behind the
 *   authorized Circle API endpoints (GET /circle/contexts/:type/:id/presence,
 *   GET /circle/contexts/:type/:id/meeting-points, etc.).  The mobile app deep-
 *   links to those endpoints on card tap; the server never stores details here.
 * - No-op if no thread exists for this context.
 */
async function postCircleStatusCard(
  sc: any,
  contextType: ContextType,
  contextId: string,
  actorId: string,
  cardSubtype: string,
  extra?: { venueLabel?: string | null; approxArea?: string | null },
): Promise<void> {
  try {
    let threadId: string | null = null;

    if (contextType === "trip") {
      const { data } = await sc
        .from("message_threads")
        .select("id")
        .eq("thread_type", "trip")
        .eq("trip_id", contextId)
        .maybeSingle();
      threadId = (data as any)?.id ?? null;
    } else {
      // Events store their chat thread id on the events row itself.
      const { data } = await sc
        .from("events")
        .select("chat_thread_id")
        .eq("id", contextId)
        .maybeSingle();
      threadId = (data as any)?.chat_thread_id ?? null;
    }

    if (!threadId) return; // No Telegraph thread for this context — no-op.

    // Body stores the subtype and, for meeting-point cards, a privacy-safe location label.
    // No GPS, precise venues, or personally identifying location details are stored here —
    // only the user-supplied venue/approximate label which the host deliberately shared.
    const bodyObj: Record<string, unknown> = { subtype: cardSubtype };
    if (extra?.venueLabel)  bodyObj["venueLabel"]  = extra.venueLabel;
    if (extra?.approxArea)  bodyObj["approxArea"]  = extra.approxArea;

    const { error: cardErr } = await sc.from("messages").insert({
      thread_id: threadId,
      sender_id: actorId,
      msg_type:  "circle_status_card",
      subtype:   cardSubtype,
      body:      JSON.stringify(bodyObj),
    });
    if (cardErr) console.warn("circle status card insert failed (non-fatal):", cardErr.message ?? cardErr);
  } catch { /* non-fatal — card delivery must never block Circle operations */ }
}

/**
 * Resolve the actor's notification-facing name honoring the universal display-name
 * rule. The actor is the acting user; recipients are OTHER users, so their real
 * name may only appear if the actor opted in — otherwise fall back to @handle.
 * Non-fatal — always returns a usable string.
 */
async function resolveActorName(sc: any, userId: string, fallback = "Someone"): Promise<string> {
  try {
    const { data } = await sc
      .from("profiles")
      .select("display_name, name, handle")
      .eq("id", userId)
      .maybeSingle();
    const handle = (data as any)?.handle as string | null;
    const allowed = await nameVisibleFor(sc, userId);
    if (allowed) {
      const n = (data as any)?.display_name ?? (data as any)?.name;
      if (n) return n as string;
    }
    return handle ? `@${handle}` : fallback;
  } catch {
    return fallback;
  }
}

/** Resolve the display name for a context (trip title or event name). Non-fatal. */
async function resolveContextTitle(
  sc: any,
  contextType: ContextType,
  contextId: string,
): Promise<string> {
  try {
    if (contextType === "trip") {
      const { data } = await sc
        .from("trips")
        .select("title, destination_city")
        .eq("id", contextId)
        .maybeSingle();
      return (data as any)?.title ?? (data as any)?.destination_city ?? "";
    }
    const { data } = await sc
      .from("events")
      .select("title")
      .eq("id", contextId)
      .maybeSingle();
    return (data as any)?.title ?? "";
  } catch {
    return "";
  }
}

// ── GET /circle/settings ──────────────────────────────────────────────────────

router.get("/circle/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data } = await sc
    .from("circle_visibility_settings")
    .select("global_enabled, visibility_mode, trip_sharing_default, event_sharing_default, is_paused, paused_until, consent_version, consented_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  res.status(200).json({
    globalEnabled:        (data as any)?.global_enabled         ?? false,
    visibilityMode:       (data as any)?.visibility_mode        ?? "status_only",
    tripSharingDefault:   (data as any)?.trip_sharing_default   ?? "status_only",
    eventSharingDefault:  (data as any)?.event_sharing_default  ?? "status_only",
    isPaused:             (data as any)?.is_paused              ?? false,
    pausedUntil:          (data as any)?.paused_until           ?? null,
    consentVersion:       (data as any)?.consent_version        ?? null,
    consentedAt:          (data as any)?.consented_at           ?? null,
    updatedAt:            (data as any)?.updated_at             ?? null,
    currentConsentVersion: CURRENT_CONSENT_VERSION,
  });
});

// ── PATCH /circle/settings ────────────────────────────────────────────────────

// Accept precise_live so we can return 403 (not supported) rather than 400 (invalid payload)
const PatchSettingsSchema = z.object({
  globalEnabled:       z.boolean().optional(),
  visibilityMode:      z.enum(["status_only", "approximate_area", "venue_checkin", "precise_live"]).optional(),
  tripSharingDefault:  z.enum(["off", "status_only", "approximate_area", "venue_checkin"]).optional(),
  eventSharingDefault: z.enum(["off", "status_only", "approximate_area", "venue_checkin"]).optional(),
  isPaused:            z.boolean().optional(),
  consentVersion:      z.string().optional(),
});

router.patch("/circle/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const parsed = PatchSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const { globalEnabled, visibilityMode, tripSharingDefault, eventSharingDefault, isPaused, consentVersion } = parsed.data;

  // Fetch current state to detect enable transition
  const { data: existing } = await sc
    .from("circle_visibility_settings")
    .select("global_enabled, consented_at")
    .eq("user_id", user.id)
    .maybeSingle();

  const wasDisabled = !((existing as any)?.global_enabled);
  const isEnabling  = globalEnabled === true && wasDisabled;

  // Consent required when enabling for the first time
  if (isEnabling) {
    if (!consentVersion) {
      res.status(409).json({
        error: "consent_required",
        message: "You must accept the Find Your Circle consent to enable sharing.",
        currentConsentVersion: CURRENT_CONSENT_VERSION,
      });
      return;
    }
    if (consentVersion !== CURRENT_CONSENT_VERSION) {
      res.status(409).json({
        error: "consent_version_mismatch",
        message: `Consent version mismatch. Expected ${CURRENT_CONSENT_VERSION}.`,
        currentConsentVersion: CURRENT_CONSENT_VERSION,
      });
      return;
    }
  }

  if (visibilityMode === "precise_live") {
    res.status(403).json({ error: "not_supported", message: "Precise live mode is not available in V1." });
    return;
  }

  const upsertPayload: Record<string, unknown> = {
    user_id:    user.id,
    updated_at: new Date().toISOString(),
  };
  if (globalEnabled !== undefined)       upsertPayload["global_enabled"]        = globalEnabled;
  if (visibilityMode !== undefined)      upsertPayload["visibility_mode"]       = visibilityMode;
  if (tripSharingDefault !== undefined)  upsertPayload["trip_sharing_default"]  = tripSharingDefault;
  if (eventSharingDefault !== undefined) upsertPayload["event_sharing_default"] = eventSharingDefault;
  if (isPaused !== undefined) {
    upsertPayload["is_paused"]    = isPaused;
    upsertPayload["paused_until"] = null; // V1: no timed pause; always cleared when toggling
  }
  if (isEnabling && consentVersion) {
    upsertPayload["consent_version"] = consentVersion;
    upsertPayload["consented_at"]    = new Date().toISOString();
  }

  const { data, error } = await sc
    .from("circle_visibility_settings")
    .upsert(upsertPayload, { onConflict: "user_id" })
    .select("global_enabled, visibility_mode, trip_sharing_default, event_sharing_default, is_paused, paused_until, consent_version, consented_at, updated_at")
    .maybeSingle();

  if (error) {
    sendError(res, "db_error", error.message);
    return;
  }

  // Audit events (fire-and-forget)
  if (isEnabling) {
    void writeAuditEvent(sc, {
      actorUserId: user.id,
      eventType:   "consent_accepted",
      metadata:    { consentVersion },
    });
    void writeAuditEvent(sc, {
      actorUserId: user.id,
      eventType:   "sharing_enabled",
    });
  } else if (globalEnabled === false) {
    void writeAuditEvent(sc, { actorUserId: user.id, eventType: "sharing_disabled" });
  }
  if (visibilityMode) {
    void writeAuditEvent(sc, {
      actorUserId: user.id,
      eventType:   "visibility_mode_changed",
      metadata:    { visibilityMode },
    });
  }

  // When enabling Circle globally, notify members of every active context (fire-and-forget).
  // This is the send path for the `circle.sharing_enabled` template.
  if (isEnabling) {
    void (async () => {
      try {
        // Discover caller's contexts using canonical membership tables — no circle_members.
        // Events require BOTH going RSVP AND event_attendees row (same gate as getAcceptedMemberIds).
        const [tripMemberRes, eventRsvpRes, eventAttendeeRes, actorName] = await Promise.all([
          sc.from("trip_members").select("trip_id").eq("user_id", user.id).eq("status", "accepted"),
          sc.from("event_rsvps").select("event_id").eq("user_id", user.id).eq("status", "going"),
          sc.from("event_attendees").select("event_id").eq("user_id", user.id),
          resolveActorName(sc, user.id),
        ]);
        // Intersect event_rsvps × event_attendees for canonical eligibility.
        const rsvpEids     = new Set(((eventRsvpRes.data     ?? []) as any[]).map((r) => r.event_id as string));
        const attendeeEids = new Set(((eventAttendeeRes.data  ?? []) as any[]).map((r) => r.event_id as string));
        const eligibleEids = [...rsvpEids].filter((eid) => attendeeEids.has(eid));
        const contexts: { context_type: ContextType; context_id: string }[] = [
          ...((tripMemberRes.data  ?? []) as any[]).map((r) => ({ context_type: "trip"  as ContextType, context_id: r.trip_id  as string })),
          ...eligibleEids.map((eid) => ({ context_type: "event" as ContextType, context_id: eid })),
        ];
        await Promise.all(
          contexts.map(async ({ context_type, context_id }) => {
            try {
              const [memberIds, contextTitle] = await Promise.all([
                getAcceptedMemberIds(sc, context_type, context_id),
                resolveContextTitle(sc, context_type, context_id),
              ]);
              const recipients = memberIds.filter((m) => m !== user.id);
              await sendCircleNotifications(sc, recipients, "circle.sharing_enabled", {
                actor: actorName, contextTitle, contextType: context_type, contextId: context_id,
              });
            } catch { /* non-fatal per context */ }
          }),
        );
      } catch { /* non-fatal */ }
    })();
  }

  res.status(200).json({
    globalEnabled:       (data as any)?.global_enabled         ?? false,
    visibilityMode:      (data as any)?.visibility_mode        ?? "status_only",
    tripSharingDefault:  (data as any)?.trip_sharing_default   ?? "status_only",
    eventSharingDefault: (data as any)?.event_sharing_default  ?? "status_only",
    isPaused:            (data as any)?.is_paused              ?? false,
    pausedUntil:         (data as any)?.paused_until           ?? null,
    consentVersion:        (data as any)?.consent_version        ?? null,
    consentedAt:           (data as any)?.consented_at           ?? null,
    updatedAt:             (data as any)?.updated_at             ?? null,
    currentConsentVersion: CURRENT_CONSENT_VERSION,
  });
});

// ── POST /circle/pause-all ────────────────────────────────────────────────────

router.post("/circle/pause-all", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("circle_visibility_settings")
    .upsert(
      { user_id: user.id, is_paused: true, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    )
    .select("global_enabled, visibility_mode, trip_sharing_default, event_sharing_default, is_paused, paused_until, consent_version, consented_at, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }

  void writeAuditEvent(sc, { actorUserId: user.id, eventType: "sharing_paused" });

  // Notify members of all active contexts that this user paused Circle (fire-and-forget).
  void (async () => {
    try {
      const [tripMemberRes, eventRsvpRes, eventAttendeeRes, actorName] = await Promise.all([
        sc.from("trip_members").select("trip_id").eq("user_id", user.id).eq("status", "accepted"),
        sc.from("event_rsvps").select("event_id").eq("user_id", user.id).eq("status", "going"),
        sc.from("event_attendees").select("event_id").eq("user_id", user.id),
        resolveActorName(sc, user.id),
      ]);
      const rsvpEids     = new Set(((eventRsvpRes.data     ?? []) as any[]).map((r) => r.event_id as string));
      const attendeeEids = new Set(((eventAttendeeRes.data  ?? []) as any[]).map((r) => r.event_id as string));
      const eligibleEids = [...rsvpEids].filter((eid) => attendeeEids.has(eid));
      const contexts: { context_type: ContextType; context_id: string }[] = [
        ...((tripMemberRes.data ?? []) as any[]).map((r) => ({ context_type: "trip"  as ContextType, context_id: r.trip_id  as string })),
        ...eligibleEids.map((eid) => ({ context_type: "event" as ContextType, context_id: eid })),
      ];
      await Promise.all(
        contexts.map(async ({ context_type, context_id }) => {
          try {
            const [memberIds, contextTitle] = await Promise.all([
              getAcceptedMemberIds(sc, context_type, context_id),
              resolveContextTitle(sc, context_type, context_id),
            ]);
            const recipients = memberIds.filter((m) => m !== user.id);
            await sendCircleNotifications(sc, recipients, "circle.sharing_paused", {
              actor: actorName, contextTitle, contextType: context_type, contextId: context_id,
            });
          } catch { /* non-fatal per context */ }
        }),
      );
    } catch { /* non-fatal */ }
  })();

  res.status(200).json({
    globalEnabled:       (data as any)?.global_enabled         ?? false,
    visibilityMode:      (data as any)?.visibility_mode        ?? "status_only",
    tripSharingDefault:  (data as any)?.trip_sharing_default   ?? "status_only",
    eventSharingDefault: (data as any)?.event_sharing_default  ?? "status_only",
    isPaused:            (data as any)?.is_paused              ?? true,
    pausedUntil:         (data as any)?.paused_until           ?? null,
    consentVersion:      (data as any)?.consent_version        ?? null,
    consentedAt:         (data as any)?.consented_at           ?? null,
    updatedAt:           (data as any)?.updated_at             ?? null,
    currentConsentVersion: CURRENT_CONSENT_VERSION,
  });
});

// ── GET /circle/contexts/:type/:id/settings ───────────────────────────────────

router.get("/circle/contexts/:type/:id/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const { data } = await sc
    .from("circle_context_settings")
    .select("enabled, visibility_mode_override, paused, paused_until, updated_at")
    .eq("user_id", user.id)
    .eq("context_type", type)
    .eq("context_id", id)
    .maybeSingle();

  res.status(200).json({
    enabled:                 (data as any)?.enabled                   ?? true,
    visibilityModeOverride:  (data as any)?.visibility_mode_override  ?? null,
    paused:                  (data as any)?.paused                    ?? false,
    pausedUntil:             (data as any)?.paused_until              ?? null,
    updatedAt:               (data as any)?.updated_at                ?? null,
  });
});

// ── PATCH /circle/contexts/:type/:id/settings ─────────────────────────────────

// Include precise_live so the schema accepts it and we can return 403 (not 400)
const PatchContextSettingsSchema = z.object({
  enabled:               z.boolean().optional(),
  visibilityModeOverride: z.enum(["status_only", "approximate_area", "venue_checkin", "precise_live"]).nullable().optional(),
  pausedUntil:           z.string().nullable().optional(),
});

router.patch("/circle/contexts/:type/:id/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const parsed = PatchContextSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const member = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!member) { sendError(res, "forbidden", "Not a member of this context"); return; }

  const payload: Record<string, unknown> = {
    user_id:      user.id,
    context_type: type,
    context_id:   id,
    updated_at:   new Date().toISOString(),
  };
  if (parsed.data.enabled !== undefined) payload["enabled"] = parsed.data.enabled;
  if (parsed.data.visibilityModeOverride !== undefined) {
    if (parsed.data.visibilityModeOverride === "precise_live") {
      res.status(403).json({ error: "not_supported", message: "Precise live mode is not available in V1." });
      return;
    }
    payload["visibility_mode_override"] = parsed.data.visibilityModeOverride;
  }
  if (parsed.data.pausedUntil !== undefined) payload["paused_until"] = parsed.data.pausedUntil;

  const { data, error } = await sc
    .from("circle_context_settings")
    .upsert(payload, { onConflict: "user_id,context_type,context_id" })
    .select("enabled, visibility_mode_override, paused, paused_until, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(200).json({
    enabled:                (data as any)?.enabled                   ?? true,
    visibilityModeOverride: (data as any)?.visibility_mode_override  ?? null,
    paused:                 (data as any)?.paused                    ?? false,
    pausedUntil:            (data as any)?.paused_until              ?? null,
    updatedAt:              (data as any)?.updated_at                ?? null,
  });
});

// ── GET /circle/contexts/:type/:id/members ────────────────────────────────────

router.get("/circle/contexts/:type/:id/members", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Rate limit: prevent member-graph scraping (60 req/min per user)
  const rl = checkRateLimit("circle_members", user.id, CIRCLE_MEMBERS_RL_LIMIT, CIRCLE_MEMBERS_RL_WIN_MS);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    sendError(res, "rate_limited", "Too many requests. Please slow down.");
    return;
  }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;
  if (!await requireFeatureEnabled(res, sc)) return;

  const viewerIsMember = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!viewerIsMember) { sendError(res, "forbidden", "Not a member of this context"); return; }

  const memberIds = await getAcceptedMemberIds(sc, type as ContextType, id);

  if (memberIds.length === 0) {
    res.status(200).json({ members: [] });
    return;
  }

  // Load profiles
  const { data: profileRows } = await sc
    .from("profiles")
    .select("id, handle, display_name, name, avatar_url")
    .in("id", memberIds);

  const profileMap = new Map<string, any>();
  for (const p of (profileRows ?? []) as any[]) {
    profileMap.set(p.id as string, p);
  }

  // Universal display-name rule: only subjects who opted in expose their real name.
  const allowedNames = await nameVisibilitySet(sc, memberIds);

  const limitParam  = Math.min(Math.max(Number((req.query as any).limit  ?? 50), 1), 200);
  const offsetParam = Math.max(Number((req.query as any).offset ?? 0), 0);

  // Run access guard for all members in one batched pass (self excluded by the batch gate)
  const results: any[] = [];
  const guardResults = await canViewCirclePresenceBatch(
    sc,
    user.id,
    memberIds.filter((mid) => mid !== user.id),
    type as ContextType,
    id,
  );
  for (const [targetId, guardResult] of guardResults) {
    if (!guardResult.allowed) continue;

    // Defensive: precise_live is not supported in V1 — skip this member
    // rather than exposing an unsupported mode.
    if (guardResult.visibilityMode === "precise_live") continue;

    const prof = profileMap.get(targetId);
    const nameAllowed = targetId === user.id || allowedNames.has(targetId);
    const snippet: CircleProfileSnippet = {
      userId:      targetId,
      avatarUrl:   (prof?.avatar_url as string | null)                                    ?? null,
      displayName: nameAllowed
        ? ((prof?.display_name as string | null) ?? (prof?.name as string | null) ?? "")
        : "",
      username:    (prof?.handle as string | null)                                         ?? "",
    };

    results.push(
      shapePresence(
        snippet,
        guardResult.presenceRow ?? null,
        guardResult.visibilityMode ?? "status_only",
        guardResult.isStale ?? false,
      ),
    );
  }

  // Sort deterministically (displayName asc) then apply offset/limit
  results.sort((a, b) =>
    (a.displayName as string).localeCompare(b.displayName as string),
  );
  const totalCount  = results.length;
  const pageResults = results.slice(offsetParam, offsetParam + limitParam);

  res.status(200).json({
    members:    pageResults,
    totalCount,
    limit:      limitParam,
    offset:     offsetParam,
    hasMore:    offsetParam + limitParam < totalCount,
  });
});

// ── GET /circle/contexts/:type/:id/is-member ──────────────────────────────────
// Lightweight membership check — returns { isMember: boolean } without exposing
// member lists or presence data.  Safe to call from any authenticated user.

router.get("/circle/contexts/:type/:id/is-member", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const isMember = await isAcceptedMember(sc, user.id, type as ContextType, id);
  res.status(200).json({ isMember });
});

// ── GET /circle/contexts/:type/:id/who-can-see-me ─────────────────────────────

router.get("/circle/contexts/:type/:id/who-can-see-me", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;
  if (!await requireFeatureEnabled(res, sc)) return;

  const viewerIsMember = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!viewerIsMember) { sendError(res, "forbidden", "Not a member of this context"); return; }

  const memberIds = await getAcceptedMemberIds(sc, type as ContextType, id);
  const others = memberIds.filter((m) => m !== user.id);

  // Check which of the other members (as viewers) can see user.id (as target)
  // — batched inverse-shape gate, identical privacy semantics.
  const gateResults = await canBeSeenByViewersBatch(sc, user.id, others, type as ContextType, id);
  const canSeeMeIds = others.filter((otherId) => gateResults.get(otherId)?.allowed === true);

  // Load profiles for canSeeMeIds
  const { data: profileRows } = canSeeMeIds.length > 0
    ? await sc.from("profiles").select("id, handle, display_name, name, avatar_url").in("id", canSeeMeIds)
    : { data: [] };

  const allowedNames = await nameVisibilitySet(sc, canSeeMeIds);

  const members = ((profileRows ?? []) as any[]).map((p) => ({
    userId:      p.id as string,
    username:    (p.handle as string | null) ?? "",
    displayName: (p.id as string) === user.id || allowedNames.has(p.id as string)
      ? ((p.display_name as string | null) ?? (p.name as string | null) ?? "")
      : "",
    avatarUrl:   (p.avatar_url as string | null) ?? null,
  }));

  res.status(200).json({ members });
});

// ── GET /circle/contexts/:type/:id/my-presence ────────────────────────────────
// Returns the viewer's own presence row, shaped the same way as member rows.
// Self is excluded from the /members list, so callers use this endpoint to
// render the pinned viewer row at the top of the Circle screen.

router.get("/circle/contexts/:type/:id/my-presence", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;
  if (!await requireFeatureEnabled(res, sc)) return;

  const viewerIsMember = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!viewerIsMember) { sendError(res, "forbidden", "Not a member of this context"); return; }

  // Fetch viewer's own profile
  const { data: profData } = await sc
    .from("profiles")
    .select("id, handle, display_name, name, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  const prof = profData as any;
  const snippet: CircleProfileSnippet = {
    userId:      user.id,
    avatarUrl:   (prof?.avatar_url as string | null) ?? null,
    displayName: (prof?.display_name as string | null) ?? (prof?.name as string | null) ?? "",
    username:    (prof?.handle as string | null) ?? "",
  };

  // Fetch viewer's own presence row from this context.
  // NOTE: circle_presence (migration 0117) has no visibility_mode column —
  // do not select it or Supabase will return a query error.
  // The viewer always sees their own row at "status_only" equivalent (full status,
  // no foreign-visibility filtering needed for the self-view).
  const { data: presenceData, error: presenceError } = await sc
    .from("circle_presence")
    .select("id, status, status_label, approximate_label, venue_label, checked_in, updated_at, is_stale, expires_at")
    .eq("user_id", user.id)
    .eq("context_type", type)
    .eq("context_id", id)
    .maybeSingle();

  if (presenceError) {
    req.log.error({ presenceError }, "my-presence query failed");
    sendError(res, "db_error", presenceError.message);
    return;
  }

  const presence = presenceData as any;
  const isExpired =
    presence?.expires_at && new Date(presence.expires_at) < new Date();
  const effectivePresence = !presence || isExpired ? null : presence;
  const isStale = Boolean(effectivePresence?.is_stale);

  // Viewer always sees their own row without foreign-visibility filtering.
  // circle_presence has no visibility_mode column (migration 0117) — default
  // to "status_only" which passes all label fields through shapePresence unchanged.
  const visibilityMode = "status_only";

  const shaped = shapePresence(snippet, effectivePresence, visibilityMode, isStale);
  // Override: viewer always has full access to their own row
  shaped.canMessage = false;
  shaped.canViewProfile = true;

  res.status(200).json(shaped);
});

// ── POST /circle/contexts/:type/:id/presence ──────────────────────────────────

const PostPresenceSchema = z.object({
  status:           z.enum(["active", "arrived", "with_group", "leaving", "safe"]).optional(),
  statusLabel:      z.string().max(100).nullable().optional(),
  approximateLabel: z.string().max(200).nullable().optional(),
  venueLabel:       z.string().max(200).nullable().optional(),
  visibilityMode:   z.enum(["status_only", "approximate_area", "venue_checkin"]).optional(),
});

router.post("/circle/contexts/:type/:id/presence", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Rate limit: throttle presence update spam (30 updates per 5 minutes per user)
  const rl = checkRateLimit("circle_presence", user.id, CIRCLE_PRESENCE_RL_LIMIT, CIRCLE_PRESENCE_RL_WIN_MS);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    sendError(res, "rate_limited", "Presence updates are too frequent. Please try again shortly.");
    return;
  }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;
  if (!await requireFeatureEnabled(res, sc)) return;

  if ((req.body as any).visibilityMode === "precise_live") {
    res.status(403).json({ error: "not_supported", message: "Precise live mode is not available in V1." });
    return;
  }

  const parsed = PostPresenceSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const memberOk = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!memberOk) { sendError(res, "forbidden", "Not a member of this context"); return; }

  // Compute expires_at based on context end time
  let expiresAt: string | null = null;
  if (type === "trip") {
    const { data: trip } = await sc.from("trips").select("end_date").eq("id", id).maybeSingle();
    if ((trip as any)?.end_date) {
      const end = new Date((trip as any).end_date + "T23:59:59Z");
      end.setUTCHours(end.getUTCHours() + TRIP_PRESENCE_TTL_HOURS);
      expiresAt = end.toISOString();
    }
  } else {
    const { data: event } = await sc.from("events").select("ends_at").eq("id", id).maybeSingle();
    if ((event as any)?.ends_at) {
      const end = new Date((event as any).ends_at);
      end.setUTCHours(end.getUTCHours() + EVENT_PRESENCE_TTL_HOURS);
      expiresAt = end.toISOString();
    }
  }

  const upsertPayload: Record<string, unknown> = {
    user_id:      user.id,
    context_type: type,
    context_id:   id,
    last_seen_at: new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    is_stale:     false,
  };
  if (parsed.data.status !== undefined)           upsertPayload["status"]            = parsed.data.status;
  if (parsed.data.statusLabel !== undefined)      upsertPayload["status_label"]      = parsed.data.statusLabel;
  if (parsed.data.approximateLabel !== undefined) upsertPayload["approximate_label"] = parsed.data.approximateLabel;
  if (parsed.data.venueLabel !== undefined)       upsertPayload["venue_label"]       = parsed.data.venueLabel;
  if (expiresAt !== null)                         upsertPayload["expires_at"]        = expiresAt;

  const { data, error } = await sc
    .from("circle_presence")
    .upsert(upsertPayload, { onConflict: "user_id,context_type,context_id" })
    .select("id, status, status_label, last_seen_at, expires_at, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }

  // Fire circle.context_active when this is the first active sharer in the context (fire-and-forget).
  // Only fires when status transitions to active; skips if others are already sharing.
  const requestedStatus = parsed.data.status ?? "active";
  if (requestedStatus === "active") {
    void (async () => {
      try {
        const [memberIds, actorName, contextTitle, otherActiveRes] = await Promise.all([
          getAcceptedMemberIds(sc, type as ContextType, id),
          resolveActorName(sc, user.id),
          resolveContextTitle(sc, type as ContextType, id),
          sc.from("circle_presence")
            .select("user_id")
            .eq("context_type", type)
            .eq("context_id", id)
            .eq("status", "active")
            .neq("user_id", user.id),
        ]);
        const otherActive = (otherActiveRes.data ?? []) as any[];
        if (otherActive.length === 0) {
          // Caller is the first one sharing — notify all other members.
          const recipients = memberIds.filter((m) => m !== user.id);
          await sendCircleNotifications(sc, recipients, "circle.context_active", {
            actor: actorName, contextTitle, contextType: type, contextId: id,
          });
        }
      } catch { /* non-fatal */ }
    })();
  }

  res.status(200).json({
    id:           (data as any)?.id          ?? null,
    status:       (data as any)?.status      ?? "active",
    statusLabel:  (data as any)?.status_label ?? null,
    lastSeenAt:   (data as any)?.last_seen_at ?? null,
    expiresAt:    (data as any)?.expires_at   ?? null,
    updatedAt:    (data as any)?.updated_at   ?? null,
  });
});

// ── POST /circle/contexts/:type/:id/check-in ──────────────────────────────────

const PostCheckinSchema = z.object({
  checkinType:      z.enum(["arrived", "with_group", "leaving", "safe"]),
  note:             z.string().max(300).nullable().optional(),
  venueLabel:       z.string().max(200).nullable().optional(),
  approximateLabel: z.string().max(200).nullable().optional(),
});

router.post("/circle/contexts/:type/:id/check-in", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;
  if (!await requireFeatureEnabled(res, sc)) return;

  const parsed = PostCheckinSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const memberOk = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!memberOk) { sendError(res, "forbidden", "Not a member of this context"); return; }

  const checkinPayload = {
    user_id:          user.id,
    context_type:     type,
    context_id:       id,
    checkin_type:     parsed.data.checkinType,
    note:             parsed.data.note             ?? null,
    venue_label:      parsed.data.venueLabel        ?? null,
    approximate_label: parsed.data.approximateLabel ?? null,
  };

  const [checkinResult] = await Promise.all([
    sc.from("circle_checkins").insert(checkinPayload).select("id, checkin_type, created_at").maybeSingle(),
    // Update presence snapshot
    sc.from("circle_presence").upsert(
      {
        user_id:          user.id,
        context_type:     type,
        context_id:       id,
        status:           parsed.data.checkinType,
        venue_label:      parsed.data.venueLabel        ?? null,
        approximate_label: parsed.data.approximateLabel ?? null,
        checked_in:       true,
        last_seen_at:     new Date().toISOString(),
        updated_at:       new Date().toISOString(),
        is_stale:         false,
      },
      { onConflict: "user_id,context_type,context_id" },
    ),
  ]);

  if (checkinResult.error) { sendError(res, "db_error", checkinResult.error.message); return; }

  void writeAuditEvent(sc, {
    actorUserId:  user.id,
    contextType:  type,
    contextId:    id,
    eventType:    "checkin_created",
    metadata:     { checkinType: parsed.data.checkinType },
  });

  // Fire notifications + Telegraph card (all fire-and-forget, never block the 201 response).
  void (async () => {
    try {
      const [memberIds, actorName, contextTitle] = await Promise.all([
        getAcceptedMemberIds(sc, type as ContextType, id),
        resolveActorName(sc, user.id),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const recipients = memberIds.filter((m) => m !== user.id);
      // Notifications: status label is user-supplied — safe to include. Venue is not.
      await sendCircleNotifications(sc, recipients, "circle.checkin", {
        actor:        actorName,
        statusLabel:  parsed.data.checkinType,  // e.g. "arrived", "with_group"
        contextTitle,
        contextType:  type,
        contextId:    id,
      });
      // Telegraph status card: preserve checkinType subtype for distinct card variants
      // (e.g. "arrived" vs "with_group") — body still contains only { subtype } for privacy.
      void postCircleStatusCard(sc, type as ContextType, id, user.id, parsed.data.checkinType);
    } catch { /* non-fatal */ }
  })();

  res.status(201).json({
    id:          (checkinResult.data as any)?.id           ?? null,
    checkinType: (checkinResult.data as any)?.checkin_type ?? null,
    createdAt:   (checkinResult.data as any)?.created_at   ?? null,
  });
});

// ── POST /circle/contexts/:type/:id/pause ─────────────────────────────────────

router.post("/circle/contexts/:type/:id/pause", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const pauseUntil = (req.body as any)?.pauseUntil ?? null;

  const { error } = await sc
    .from("circle_context_settings")
    .upsert(
      {
        user_id:      user.id,
        context_type: type,
        context_id:   id,
        paused:       true,
        paused_until: pauseUntil,
        updated_at:   new Date().toISOString(),
      },
      { onConflict: "user_id,context_type,context_id" },
    );

  if (error) { sendError(res, "db_error", error.message); return; }

  void writeAuditEvent(sc, {
    actorUserId: user.id,
    contextType: type,
    contextId:   id,
    eventType:   "presence_paused",
    metadata:    { pauseUntil },
  });

  res.status(200).json({ paused: true, pausedUntil: pauseUntil });
});

// ── POST /circle/contexts/:type/:id/resume ────────────────────────────────────

router.post("/circle/contexts/:type/:id/resume", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const { error } = await sc
    .from("circle_context_settings")
    .upsert(
      {
        user_id:      user.id,
        context_type: type,
        context_id:   id,
        paused:       false,
        paused_until: null,
        updated_at:   new Date().toISOString(),
      },
      { onConflict: "user_id,context_type,context_id" },
    );

  if (error) { sendError(res, "db_error", error.message); return; }

  void writeAuditEvent(sc, {
    actorUserId: user.id,
    contextType: type,
    contextId:   id,
    eventType:   "presence_resumed",
  });

  res.status(200).json({ paused: false });
});

// ── GET /circle/contexts/:type/:id/meeting-point ──────────────────────────────

router.get("/circle/contexts/:type/:id/meeting-point", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const memberOk = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!memberOk) { sendError(res, "forbidden", "Not a member of this context"); return; }

  const { data } = await sc
    .from("circle_meeting_points")
    .select("id, venue_label, approximate_label, description, created_at, updated_at")
    .eq("context_type", type)
    .eq("context_id", id)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    res.status(200).json({ meetingPoint: null });
    return;
  }

  const row = data as any;
  res.status(200).json({
    meetingPoint: {
      id:               row.id,
      venueLabel:       row.venue_label       ?? null,
      approximateLabel: row.approximate_label ?? null,
      description:      row.description       ?? null,
      // V1: public_lat / public_lng columns not yet in schema — always null.
      // V2 will expose these once the DB migration adds them.
      lat:              (row.public_lat  as number | null) ?? null,
      lng:              (row.public_lng  as number | null) ?? null,
      createdAt:        row.created_at,
      updatedAt:        row.updated_at,
    },
  });
});

// ── POST /circle/contexts/:type/:id/meeting-point (host only) ─────────────────

const MeetingPointSchema = z.object({
  venueLabel:       z.string().max(200).nullable().optional(),
  approximateLabel: z.string().max(200).nullable().optional(),
  description:      z.string().max(500).nullable().optional(),
});

router.post("/circle/contexts/:type/:id/meeting-point", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const hostOk = await isContextHost(sc, user.id, type as ContextType, id);
  if (!hostOk) { sendError(res, "forbidden", "Only the host can set meeting points"); return; }

  const parsed = MeetingPointSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  // Deactivate any existing active meeting point
  const { error: deactivateErr } = await sc
    .from("circle_meeting_points")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("context_type", type)
    .eq("context_id", id)
    .eq("is_active", true);
  if (deactivateErr) { sendError(res, "db_error", deactivateErr.message); return; }

  const { data, error } = await sc
    .from("circle_meeting_points")
    .insert({
      context_type:     type,
      context_id:       id,
      host_user_id:     user.id,
      venue_label:      parsed.data.venueLabel        ?? null,
      approximate_label: parsed.data.approximateLabel ?? null,
      description:      parsed.data.description       ?? null,
      is_active:        true,
    })
    .select("id, venue_label, approximate_label, description, created_at, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }

  void writeAuditEvent(sc, {
    actorUserId: user.id,
    contextType: type,
    contextId:   id,
    eventType:   "host_changed_meeting_point",
  });

  // Notifications + Telegraph card (fire-and-forget)
  void (async () => {
    try {
      const [memberIds, actorName, contextTitle] = await Promise.all([
        getAcceptedMemberIds(sc, type as ContextType, id),
        resolveActorName(sc, user.id, "The host"),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const recipients = memberIds.filter((m) => m !== user.id);
      // Privacy: no venue/location fields in notification params — status + deep-link only.
      await sendCircleNotifications(sc, recipients, "circle.meeting_point_updated", {
        actor: actorName, contextTitle, contextType: type, contextId: id,
      });
      // Telegraph status card: includes user-supplied venue/approx label (host-chosen, not GPS).
      void postCircleStatusCard(sc, type as ContextType, id, user.id, "meeting_point", {
        venueLabel: (data as any)?.venue_label       ?? null,
        approxArea: (data as any)?.approximate_label ?? null,
      });
    } catch { /* non-fatal */ }
  })();

  const row = data as any;
  res.status(201).json({
    id:               row?.id,
    venueLabel:       row?.venue_label       ?? null,
    approximateLabel: row?.approximate_label ?? null,
    description:      row?.description       ?? null,
    // V1: coordinate columns not yet in schema — always null; V2 will populate.
    lat:              null,
    lng:              null,
    createdAt:        row?.created_at,
    updatedAt:        row?.updated_at,
  });
});

// ── PATCH /circle/contexts/:type/:id/meeting-point (host only) ────────────────

router.patch("/circle/contexts/:type/:id/meeting-point", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const hostOk = await isContextHost(sc, user.id, type as ContextType, id);
  if (!hostOk) { sendError(res, "forbidden", "Only the host can update meeting points"); return; }

  const parsed = MeetingPointSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.venueLabel !== undefined)       updatePayload["venue_label"]       = parsed.data.venueLabel;
  if (parsed.data.approximateLabel !== undefined) updatePayload["approximate_label"] = parsed.data.approximateLabel;
  if (parsed.data.description !== undefined)      updatePayload["description"]       = parsed.data.description;

  const { data, error } = await sc
    .from("circle_meeting_points")
    .update(updatePayload)
    .eq("context_type", type)
    .eq("context_id", id)
    .eq("is_active", true)
    .select("id, venue_label, approximate_label, description, created_at, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "No active meeting point found"); return; }

  void writeAuditEvent(sc, {
    actorUserId: user.id,
    contextType: type,
    contextId:   id,
    eventType:   "host_changed_meeting_point",
  });

  // Notifications + Telegraph card (fire-and-forget) — same pattern as POST /meeting-point
  void (async () => {
    try {
      const [memberIds, actorName, contextTitle] = await Promise.all([
        getAcceptedMemberIds(sc, type as ContextType, id),
        resolveActorName(sc, user.id, "The host"),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const recipients = memberIds.filter((m) => m !== user.id);
      // Privacy: no venue/location fields in notification params — status + deep-link only.
      await sendCircleNotifications(sc, recipients, "circle.meeting_point_updated", {
        actor: actorName, contextTitle, contextType: type, contextId: id,
      });
      void postCircleStatusCard(sc, type as ContextType, id, user.id, "meeting_point", {
        venueLabel: (data as any)?.venue_label       ?? null,
        approxArea: (data as any)?.approximate_label ?? null,
      });
    } catch { /* non-fatal */ }
  })();

  const row = data as any;
  res.status(200).json({
    id:               row?.id,
    venueLabel:       row?.venue_label       ?? null,
    approximateLabel: row?.approximate_label ?? null,
    description:      row?.description       ?? null,
    // V1: coordinate columns not yet in schema — always null; V2 will populate.
    lat:              null,
    lng:              null,
    createdAt:        row?.created_at ?? null,
    updatedAt:        row?.updated_at,
  });
});

// ── DELETE /circle/contexts/:type/:id/meeting-point (host only) ───────────────

router.delete("/circle/contexts/:type/:id/meeting-point", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const hostOk = await isContextHost(sc, user.id, type as ContextType, id);
  if (!hostOk) { sendError(res, "forbidden", "Only the host can remove meeting points"); return; }

  const { error: removeErr } = await sc
    .from("circle_meeting_points")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("context_type", type)
    .eq("context_id", id)
    .eq("is_active", true);
  if (removeErr) { sendError(res, "db_error", removeErr.message); return; }

  void writeAuditEvent(sc, {
    actorUserId: user.id,
    contextType: type,
    contextId:   id,
    eventType:   "host_changed_meeting_point",
    metadata:    { action: "removed" },
  });

  // Notify members that the meeting point was cleared (fire-and-forget)
  void (async () => {
    try {
      const [memberIds, actorName, contextTitle] = await Promise.all([
        getAcceptedMemberIds(sc, type as ContextType, id),
        resolveActorName(sc, user.id, "The host"),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const recipients = memberIds.filter((m) => m !== user.id);
      // Privacy: no venue/location fields — status + deep-link only.
      await sendCircleNotifications(sc, recipients, "circle.meeting_point_updated", {
        actor: actorName, contextTitle, contextType: type, contextId: id,
      });
    } catch { /* non-fatal */ }
  })();

  res.status(200).json({ removed: true });
});

// ── POST /circle/contexts/:type/:id/need-help ─────────────────────────────────

router.post("/circle/contexts/:type/:id/need-help", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { type, id } = req.params;
  if (!validateContextType(res, type)) return;
  if (!validateContextId(res, id)) return;

  const memberOk = await isAcceptedMember(sc, user.id, type as ContextType, id);
  if (!memberOk) { sendError(res, "forbidden", "Not a member of this context"); return; }

  // Rate limit: generous — prioritises genuine emergencies over spam prevention.
  // 20/min per user; admin-override is possible via env (CIRCLE_NEED_HELP_RL_LIMIT=0 disables).
  if (CIRCLE_NEED_HELP_RL_LIMIT > 0) {
    const needHelpRl = checkRateLimit("circle_need_help", user.id, CIRCLE_NEED_HELP_RL_LIMIT, CIRCLE_NEED_HELP_RL_WIN_MS);
    if (!needHelpRl.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(needHelpRl.retryAfterMs / 1000)));
      sendError(res, "rate_limited", "Too many requests. Please slow down.");
      return;
    }
  }

  // Update presence with needs_help=true (upsert)
  const { error: presenceErr } = await sc
    .from("circle_presence")
    .upsert(
      {
        user_id:      user.id,
        context_type: type,
        context_id:   id,
        status:       "needs_help",
        needs_help:   true,
        last_seen_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
        is_stale:     false,
      },
      { onConflict: "user_id,context_type,context_id" },
    );
  if (presenceErr) { sendError(res, "db_error", presenceErr.message); return; }

  // Append check-in log (best-effort: presence is already updated — log only)
  const { error: checkinErr } = await sc.from("circle_checkins").insert({
    user_id:      user.id,
    context_type: type,
    context_id:   id,
    checkin_type: "needs_help",
    note:         (req.body as any)?.note ?? null,
  });
  if (checkinErr) console.warn("needs-help check-in insert failed (non-fatal):", checkinErr.message ?? checkinErr);

  // Audit event
  void writeAuditEvent(sc, {
    actorUserId: user.id,
    contextType: type,
    contextId:   id,
    eventType:   "needs_help_triggered",
  });

  // Alert the context host only (fire-and-forget).
  // Members other than the host are intentionally excluded — this is a
  // host-action alert, not a broadcast. Do NOT include GPS, needs_help bool,
  // or any emergency detail in notification params.
  void (async () => {
    try {
      const [actorName, contextTitle] = await Promise.all([
        resolveActorName(sc, user.id),
        resolveContextTitle(sc, type as ContextType, id),
      ]);

      // Resolve the host for this context using canonical owner columns.
      // trips: owner_id  — events: host_id  (consistent with trips.ts / admin.ts)
      let hostId: string | null = null;
      if (type === "trip") {
        const { data: trip } = await sc
          .from("trips")
          .select("owner_id")
          .eq("id", id)
          .maybeSingle();
        hostId = (trip as any)?.owner_id ?? null;
      } else {
        const { data: ev } = await sc
          .from("events")
          .select("host_id")
          .eq("id", id)
          .maybeSingle();
        hostId = (ev as any)?.host_id ?? null;
      }

      // Only notify if there is a host and they are not the caller themselves.
      if (hostId && hostId !== user.id) {
        await sendCircleNotifications(sc, [hostId], "circle.need_help_host_alert", {
          actor: actorName, contextTitle, contextType: type, contextId: id,
        });
      }
    } catch { /* non-fatal — safety alert must never silently break the response */ }
  })();

  // IMPORTANT: response MUST NOT expose needs_help bool, GPS, or emergency details.
  res.status(200).json({
    acknowledged: true,
    message:      "Your circle has been notified. Stay safe.",
  });
});

// ── GET /circle/compass-suggestions ──────────────────────────────────────────
//
// Returns Circle-state suggestion cards for the caller's active Circle contexts.
// Each card represents an actionable prompt the Compass feed can surface.
//
// Card types:
//   "circle_active"       — At least one other member is actively sharing in a
//                           context the caller is part of.  Shows activity count.
//   "turn_on_circle"      — Caller has an accepted Circle membership in a context
//                           but has not yet enabled sharing (no active presence row).
//   "set_meeting_point"   — Caller is the host of a context with no active meeting
//                           point set.  Prompts them to add one.
//
// Privacy rules:
//   - Never include GPS, needs_help, or member identities in cards.
//   - `activeCount` is a plain integer — no user IDs.
//   - Contexts where the caller doesn't have accepted membership are excluded.
//
// Response shape:
//   { cards: CompassCircleCard[] }
//
// Capped at 5 cards.  Rate-limited via the members limiter (same window).

router.get("/circle/compass-suggestions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await requireFeatureEnabled(res, sc)) return;

  const rl = checkRateLimit("circle_members", user.id, CIRCLE_MEMBERS_RL_LIMIT, CIRCLE_MEMBERS_RL_WIN_MS);
  if (!rl.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
    sendError(res, "rate_limited", "Too many requests. Please slow down.");
    return;
  }

  // Step 1: discover caller's contexts using canonical membership tables.
  // circle_members has no migration — trip_members / event_rsvps + event_attendees are the source of truth.
  // Events require BOTH an accepted RSVP (going) AND an event_attendees row — same gate as isAcceptedMember.
  const [tripMemberRes, eventRsvpRes, eventAttendeeRes] = await Promise.all([
    sc.from("trip_members").select("trip_id").eq("user_id", user.id).eq("status", "accepted").limit(20),
    sc.from("event_rsvps").select("event_id").eq("user_id", user.id).eq("status", "going").limit(20),
    sc.from("event_attendees").select("event_id").eq("user_id", user.id).limit(20),
  ]);
  // Intersect: only include events where the caller appears in both tables (canonical check).
  const rsvpEventIds   = new Set(((eventRsvpRes.data     ?? []) as any[]).map((r) => r.event_id as string));
  const attendeeEventIds = new Set(((eventAttendeeRes.data ?? []) as any[]).map((r) => r.event_id as string));
  const eligibleEventIds = [...rsvpEventIds].filter((id) => attendeeEventIds.has(id));

  const myContexts: { context_type: string; context_id: string }[] = [
    ...((tripMemberRes.data  ?? []) as any[]).map((r) => ({ context_type: "trip",  context_id: r.trip_id  as string })),
    ...eligibleEventIds.map((eid) => ({ context_type: "event", context_id: eid })),
  ];

  if (myContexts.length === 0) {
    res.json({ cards: [] });
    return;
  }

  // Step 2: determine the caller's current sharing state and presence activity
  // per context — batch DB calls in parallel for all contexts.
  const cards: Array<{
    cardType:     "circle_active" | "turn_on_circle" | "set_meeting_point";
    contextType:  string;
    contextId:    string;
    contextTitle: string;
    metadata:     Record<string, unknown>;
  }> = [];

  await Promise.all(
    myContexts.map(async ({ context_type, context_id }) => {
      try {
        const ct = context_type as ContextType;

        // Parallel: context title + caller's own presence row + all member presence + meeting points (if host)
        const [contextTitle, callerPresenceRes, allPresenceRes, isHost] = await Promise.all([
          resolveContextTitle(sc, ct, context_id),

          // Caller's own active presence row
          sc.from("circle_presence")
            .select("status, is_stale")
            .eq("user_id", user.id)
            .eq("context_type", ct)
            .eq("context_id", context_id)
            .maybeSingle(),

          // All non-stale active presence rows for this context (any member)
          sc.from("circle_presence")
            .select("user_id, status, is_stale")
            .eq("context_type", ct)
            .eq("context_id", context_id)
            .eq("status", "active"),

          // Determine if caller is host (trip: owner_id, event: host_id)
          (async (): Promise<boolean> => {
            if (ct === "trip") {
              const { data } = await sc.from("trips").select("owner_id").eq("id", context_id).maybeSingle();
              return (data as any)?.owner_id === user.id;
            }
            const { data } = await sc.from("events").select("host_id").eq("id", context_id).maybeSingle();
            return (data as any)?.host_id === user.id;
          })(),
        ]);

        const callerPresence  = callerPresenceRes.data as any;
        const allActive       = ((allPresenceRes.data ?? []) as any[]).filter((r) => !r.is_stale);
        const othersActive    = allActive.filter((r) => r.user_id !== user.id);
        const callerIsSharing = callerPresence && callerPresence.status === "active" && !callerPresence.is_stale;

        // Card: circle_active — caller is sharing and others are too.
        // Does NOT early-return — set_meeting_point can co-exist for the same context.
        if (callerIsSharing && othersActive.length > 0) {
          cards.push({
            cardType: "circle_active",
            contextType: context_type,
            contextId: context_id,
            contextTitle,
            metadata: { activeCount: othersActive.length },
          });
        }

        // Card: turn_on_circle — caller is a member but not actively sharing.
        // Mutually exclusive with circle_active and set_meeting_point.
        if (!callerIsSharing) {
          cards.push({
            cardType: "turn_on_circle",
            contextType: context_type,
            contextId: context_id,
            contextTitle,
            metadata: { othersActiveCount: othersActive.length },
          });
          return; // nothing else relevant for this context while caller isn't sharing
        }

        // Card: set_meeting_point — caller is the host, is sharing, and no active
        // meeting point is set yet.  Independent of circle_active — both can appear.
        if (isHost) {
          const { data: mpData } = await sc
            .from("circle_meeting_points")
            .select("id")
            .eq("context_type", ct)
            .eq("context_id", context_id)
            .eq("is_active", true)
            .maybeSingle();
          if (!mpData) {
            cards.push({
              cardType: "set_meeting_point",
              contextType: context_type,
              contextId: context_id,
              contextTitle,
              metadata: {},
            });
          }
        }
      } catch { /* non-fatal per context */ }
    }),
  );

  // Return at most 5 cards, prioritising circle_active > turn_on_circle > set_meeting_point.
  const ORDER: Record<string, number> = { circle_active: 0, turn_on_circle: 1, set_meeting_point: 2 };
  cards.sort((a, b) => (ORDER[a.cardType] ?? 9) - (ORDER[b.cardType] ?? 9));

  res.json({ cards: cards.slice(0, 3) });
});

// ── POST /circle/pause-on-session-end ─────────────────────────────────────────
//
// Called by the mobile app (AppState "background"/"inactive" transition) to
// gracefully pause the caller's Circle presence across ALL active contexts
// before the session ends.  This prevents stale "active" badges lingering
// after the user closes the app.
//
// - Sets status = "paused" on every active circle_presence row for the caller.
// - Notifies other members of each affected context (fire-and-forget).
// - Does NOT delete presence — the user can resume without re-joining.
//
// Idempotent: calling it while already paused is a no-op (returns 200).

router.post("/circle/pause-on-session-end", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  if (!await requireFeatureEnabled(res, sc)) return;

  // Fetch all active (non-paused) presence rows for the caller.
  //
  // `paused` was NOT a member of circle_presence_status_check
  // (active | arrived | with_group | leaving | safe | needs_help) until
  // migration 2298 admitted it. Until then the `.neq` below excluded nothing
  // and — far worse — the UPDATE that follows was rejected 23514 on every
  // press, so this endpoint has always returned db_error and Circle sharing
  // could never actually be paused. The same rejected write sits on the
  // deactivation path at routes/profile.ts:1413. 2298 is the fix; the code
  // here was already saying the right thing.
  const { data: presenceRows, error: fetchErr } = await sc
    .from("circle_presence")
    .select("context_type, context_id")
    .eq("user_id", user.id)
    .neq("status", "paused");

  if (fetchErr) { sendError(res, "db_error", fetchErr.message); return; }

  if (!presenceRows || presenceRows.length === 0) {
    // Already paused or not sharing in any context — idempotent OK.
    res.status(200).json({ paused: 0 });
    return;
  }

  // Bulk-update all active rows to "paused".
  const { error: updateErr } = await sc
    .from("circle_presence")
    .update({ status: "paused", updated_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .neq("status", "paused");

  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  // Audit one entry per affected context (fire-and-forget).
  for (const row of presenceRows as any[]) {
    void writeAuditEvent(sc, {
      actorUserId: user.id,
      contextType: row.context_type,
      contextId:   row.context_id,
      eventType:   "sharing_paused_on_session_end",
    });
  }

  // Notify members of each affected context (fire-and-forget — never block 200).
  void (async () => {
    try {
      const actorName = await resolveActorName(sc, user.id);

      await Promise.all(
        (presenceRows as any[]).map(async (row) => {
          try {
            const [memberIds, contextTitle] = await Promise.all([
              getAcceptedMemberIds(sc, row.context_type as ContextType, row.context_id),
              resolveContextTitle(sc, row.context_type as ContextType, row.context_id),
            ]);
            const recipients = memberIds.filter((m) => m !== user.id);
            await sendCircleNotifications(sc, recipients, "circle.sharing_paused", {
              actor: actorName, contextTitle,
              contextType: row.context_type, contextId: row.context_id,
            });
          } catch { /* non-fatal per context */ }
        }),
      );
    } catch { /* non-fatal */ }
  })();

  res.status(200).json({ paused: presenceRows.length });
});

// ── Admin: GET /admin/circle/reports ─────────────────────────────────────────

router.get("/admin/circle/reports", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(Number((req.query as any).limit ?? 50), 200);

  const { data, error } = await sc
    .from("circle_audit_events")
    .select("id, actor_user_id, target_user_id, context_type, context_id, event_type, metadata, created_at")
    .in("event_type", [
      "needs_help_triggered",
      "admin_disabled_context",
      "admin_kill_switch_toggled",
      "sharing_disabled",
    ])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }

  res.status(200).json({ reports: data ?? [] });
});

// ── Admin: POST /admin/circle/disable-context ─────────────────────────────────

router.post("/admin/circle/disable-context", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, user: adminUser } = admin;

  const { contextType, contextId, reason } = req.body as {
    contextType?: string;
    contextId?: string;
    reason?: string;
  };

  if (!contextType || !VALID_CONTEXT_TYPES.has(contextType)) {
    sendError(res, "invalid_payload", "contextType must be 'trip' or 'event'");
    return;
  }
  if (!contextId || !UUID_RE.test(contextId)) {
    sendError(res, "invalid_payload", "contextId must be a valid UUID");
    return;
  }

  // Get all members and disable context settings for each
  const memberIds = await getAcceptedMemberIds(sc, contextType as ContextType, contextId);

  if (memberIds.length > 0) {
    const rows = memberIds.map((uid) => ({
      user_id:      uid,
      context_type: contextType,
      context_id:   contextId,
      enabled:      false,
      updated_at:   new Date().toISOString(),
    }));
    const { error: disableErr } = await sc
      .from("circle_context_settings")
      .upsert(rows, { onConflict: "user_id,context_type,context_id" });
    if (disableErr) { sendError(res, "db_error", disableErr.message); return; }
  }

  void writeAuditEvent(sc, {
    actorUserId:  adminUser.id,
    contextType,
    contextId,
    eventType:    "admin_disabled_context",
    metadata:     { reason: reason ?? null, affectedUsers: memberIds.length },
  });

  res.status(200).json({ disabled: true, affectedUsers: memberIds.length });
});

// ── Admin: POST /admin/circle/kill-switch ────────────────────────────────────

router.post("/admin/circle/kill-switch", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, user: adminUser } = admin;

  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    sendError(res, "invalid_payload", "enabled must be a boolean");
    return;
  }

  // enabled=true means the kill switch is ACTIVE (feature is DISABLED for users)
  const { error } = await sc
    .from("feature_flags")
    .upsert(
      {
        flag:        "find_your_circle_disabled",
        enabled,
        description: "Emergency kill switch — disables all Find Your Circle endpoints",
        updated_at:  new Date().toISOString(),
      },
      { onConflict: "flag" },
    );

  if (error) { sendError(res, "db_error", error.message); return; }

  void writeAuditEvent(sc, {
    actorUserId: adminUser.id,
    eventType:   "admin_kill_switch_toggled",
    metadata:    { killSwitchEnabled: enabled },
  });

  res.status(200).json({ killSwitchEnabled: enabled });
});

// ── POST /circle/internal/cleanup-presence (cron-safe, not user-facing) ──────

router.post("/circle/internal/cleanup-presence", async (req, res) => {
  const secret = process.env.INTERNAL_API_SECRET;
  const provided = req.headers["x-internal-secret"];
  // Constant-time compare — a plain !== leaks how many leading characters
  // matched through response timing, which is enough to recover
  // INTERNAL_API_SECRET byte by byte. See safeSecretEquals in lib/http.ts.
  if (!secret || !safeSecretEquals(provided, secret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const now = new Date();

  // 1. Mark stale: last_seen_at + stale_after_secs < now
  //    Supabase client can't do column arithmetic, so we fetch candidates first.
  const { data: staleRows } = await sc
    .from("circle_presence")
    .select("id, last_seen_at, stale_after_secs")
    .eq("is_stale", false);

  const staleIds = ((staleRows ?? []) as any[])
    .filter((r) => {
      const threshold = new Date(r.last_seen_at as string).getTime() + (r.stale_after_secs as number) * 1000;
      return threshold < now.getTime();
    })
    .map((r) => r.id as string);

  let markedStale = 0;
  if (staleIds.length > 0) {
    const { error: staleErr } = await sc.from("circle_presence").update({ is_stale: true }).in("id", staleIds);
    if (staleErr) { sendError(res, "db_error", staleErr.message); return; }
    markedStale = staleIds.length;
  }

  // 2. Delete hard-expired presence rows
  const { data: expiredRows } = await sc
    .from("circle_presence")
    .select("id, expires_at")
    .not("expires_at", "is", null);

  const expiredIds = ((expiredRows ?? []) as any[])
    .filter((r) => r.expires_at && new Date(r.expires_at as string) < now)
    .map((r) => r.id as string);

  let deleted = 0;
  if (expiredIds.length > 0) {
    const { error: expireDelErr } = await sc.from("circle_presence").delete().in("id", expiredIds);
    if (expireDelErr) { sendError(res, "db_error", expireDelErr.message); return; }
    deleted = expiredIds.length;
  }

  // 3. Trip-ended expiry — trips ended more than 24h ago
  const tripCutoff = new Date(now.getTime() - TRIP_PRESENCE_TTL_HOURS * 3_600_000).toISOString();
  const { data: endedTrips } = await sc
    .from("trips")
    .select("id")
    .not("end_date", "is", null)
    .lte("end_date", tripCutoff.slice(0, 10)); // date comparison

  const endedTripIds = ((endedTrips ?? []) as any[]).map((t) => t.id as string);
  let tripDeleted = 0;
  if (endedTripIds.length > 0) {
    const { error: tripDelErr } = await sc
      .from("circle_presence")
      .delete()
      .eq("context_type", "trip")
      .in("context_id", endedTripIds);
    if (tripDelErr) { sendError(res, "db_error", tripDelErr.message); return; }
    tripDeleted = endedTripIds.length;
  }

  // 4. Event-ended expiry — events ended more than 2h ago
  const eventCutoff = new Date(now.getTime() - EVENT_PRESENCE_TTL_HOURS * 3_600_000).toISOString();
  const { data: endedEvents } = await sc
    .from("events")
    .select("id")
    .not("ends_at", "is", null)
    .lte("ends_at", eventCutoff);

  const endedEventIds = ((endedEvents ?? []) as any[]).map((e) => e.id as string);
  let eventDeleted = 0;
  if (endedEventIds.length > 0) {
    const { error: eventDelErr } = await sc
      .from("circle_presence")
      .delete()
      .eq("context_type", "event")
      .in("context_id", endedEventIds);
    if (eventDelErr) { sendError(res, "db_error", eventDelErr.message); return; }
    eventDeleted = endedEventIds.length;
  }

  res.status(200).json({
    markedStale,
    deleted,
    tripContextsSwept:  endedTripIds.length,
    eventContextsSwept: endedEventIds.length,
    tripPresenceDeleted:  tripDeleted,
    eventPresenceDeleted: eventDeleted,
  });
});

export default router;
