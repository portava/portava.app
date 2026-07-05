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
import { requireUser, sendError, type ApiErrorCode } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  canViewCirclePresence,
  CURRENT_CONSENT_VERSION,
  type ContextType,
} from "../lib/circleAccessGuard.js";
import { shapePresence, type CircleProfileSnippet } from "../lib/circleResponseShaper.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { NotificationService } from "../services/notifications/NotificationService.js";
import { NotificationRouter as NotifRouter } from "../services/notifications/NotificationRouter.js";

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
const CIRCLE_NEED_HELP_RL_LIMIT = 20;               // generous — never block genuine emergencies
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
    await sc.from("circle_audit_events").insert({
      actor_user_id:  opts.actorUserId  ?? null,
      target_user_id: opts.targetUserId ?? null,
      context_type:   opts.contextType  ?? null,
      context_id:     opts.contextId    ?? null,
      event_type:     opts.eventType,
      metadata:       opts.metadata     ?? null,
    });
  } catch {}
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
 * - Inserts a message with msg_type='circle_status_card' containing ONLY
 *   privacy-safe, user-supplied fields.  GPS, needs_help, and emergency data
 *   are NEVER included.
 * - No-op if no thread exists for this context.
 */
async function postCircleStatusCard(
  sc: any,
  contextType: ContextType,
  contextId: string,
  actorId: string,
  cardSubtype: string,
  safeCardData: Record<string, unknown>,
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

    // Body is stored as JSON string. Rendering is handled client-side.
    // Unauthorized viewers (non-Circle members) will see the placeholder
    // "Shared a Circle update." — enforced by the client renderer.
    await sc.from("messages").insert({
      thread_id: threadId,
      sender_id: actorId,
      msg_type:  "circle_status_card",
      subtype:   cardSubtype,
      body:      JSON.stringify(safeCardData),
    });
  } catch { /* non-fatal — card delivery must never block Circle operations */ }
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

  const limitParam  = Math.min(Math.max(Number((req.query as any).limit  ?? 50), 1), 200);
  const offsetParam = Math.max(Number((req.query as any).offset ?? 0), 0);

  // Run access guard per member (excluding self)
  const results: any[] = [];
  await Promise.all(
    memberIds
      .filter((mid) => mid !== user.id)
      .map(async (targetId) => {
        const guardResult = await canViewCirclePresence(
          sc,
          user.id,
          targetId,
          type as ContextType,
          id,
        );
        if (!guardResult.allowed) return;

        // Defensive: precise_live is not supported in V1 — skip this member
        // rather than exposing an unsupported mode.
        if (guardResult.visibilityMode === "precise_live") return;

        const prof = profileMap.get(targetId);
        const snippet: CircleProfileSnippet = {
          userId:      targetId,
          avatarUrl:   (prof?.avatar_url as string | null)                                    ?? null,
          displayName: (prof?.display_name as string | null) ?? (prof?.name as string | null) ?? "",
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
      }),
  );

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

  const canSeeMeIds: string[] = [];
  await Promise.all(
    others.map(async (otherId) => {
      // Check if otherId (as viewer) can see user.id (as target)
      const result = await canViewCirclePresence(sc, otherId, user.id, type as ContextType, id);
      if (result.allowed) canSeeMeIds.push(otherId);
    }),
  );

  // Load profiles for canSeeMeIds
  const { data: profileRows } = canSeeMeIds.length > 0
    ? await sc.from("profiles").select("id, handle, display_name, name, avatar_url").in("id", canSeeMeIds)
    : { data: [] };

  const members = ((profileRows ?? []) as any[]).map((p) => ({
    userId:      p.id as string,
    username:    (p.handle as string | null) ?? "",
    displayName: (p.display_name as string | null) ?? (p.name as string | null) ?? "",
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
      const [memberIds, actorProfile, contextTitle] = await Promise.all([
        getAcceptedMemberIds(sc, type as ContextType, id),
        sc.from("profiles").select("display_name, name").eq("id", user.id).maybeSingle(),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const actorName = (actorProfile.data as any)?.display_name
        ?? (actorProfile.data as any)?.name
        ?? "Someone";
      const recipients = memberIds.filter((m) => m !== user.id);
      // Notifications: status label is user-supplied — safe to include. Venue is not.
      await sendCircleNotifications(sc, recipients, "circle.checkin", {
        actor:        actorName,
        statusLabel:  parsed.data.checkinType,  // e.g. "arrived", "with_group"
        contextTitle,
        contextType:  type,
        contextId:    id,
      });
      // Telegraph status card: include only user-supplied, privacy-safe fields.
      void postCircleStatusCard(sc, type as ContextType, id, user.id, "checkin", {
        actorName,
        checkinType:  parsed.data.checkinType,
        venueLabel:   parsed.data.venueLabel   ?? null,
        // approximateLabel: intentionally omitted from card — too location-specific.
      });
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
  await sc
    .from("circle_meeting_points")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("context_type", type)
    .eq("context_id", id)
    .eq("is_active", true);

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
      const [memberIds, actorProfile, contextTitle] = await Promise.all([
        getAcceptedMemberIds(sc, type as ContextType, id),
        sc.from("profiles").select("display_name, name").eq("id", user.id).maybeSingle(),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const actorName = (actorProfile.data as any)?.display_name ?? (actorProfile.data as any)?.name ?? "The host";
      const safeVenue = parsed.data.venueLabel ?? null;
      const safeArea  = parsed.data.approximateLabel ?? null;
      const recipients = memberIds.filter((m) => m !== user.id);
      await sendCircleNotifications(sc, recipients, "circle.meeting_point_updated", {
        actor: actorName, contextTitle, contextType: type, contextId: id,
        venueLabel:       safeVenue ?? "", approximateLabel: safeArea ?? "",
      });
      void postCircleStatusCard(sc, type as ContextType, id, user.id, "meeting_point", {
        actorName, venueLabel: safeVenue, approximateLabel: safeArea,
        // Never include lat/lng — V1 coordinates are null; V2 will decide exposure.
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

  await sc
    .from("circle_meeting_points")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("context_type", type)
    .eq("context_id", id)
    .eq("is_active", true);

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
      const [memberIds, actorProfile, contextTitle] = await Promise.all([
        getAcceptedMemberIds(sc, type as ContextType, id),
        sc.from("profiles").select("display_name, name").eq("id", user.id).maybeSingle(),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const actorName = (actorProfile.data as any)?.display_name ?? (actorProfile.data as any)?.name ?? "The host";
      const recipients = memberIds.filter((m) => m !== user.id);
      await sendCircleNotifications(sc, recipients, "circle.meeting_point_updated", {
        actor: actorName, contextTitle, contextType: type, contextId: id,
        venueLabel: "", approximateLabel: "Meeting point removed",
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

  // Update presence with needs_help=true (upsert)
  await sc
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

  // Append check-in log
  await sc.from("circle_checkins").insert({
    user_id:      user.id,
    context_type: type,
    context_id:   id,
    checkin_type: "needs_help",
    note:         (req.body as any)?.note ?? null,
  });

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
      const [actorProfile, contextTitle] = await Promise.all([
        sc.from("profiles").select("display_name, name").eq("id", user.id).maybeSingle(),
        resolveContextTitle(sc, type as ContextType, id),
      ]);
      const actorName = (actorProfile.data as any)?.display_name ?? (actorProfile.data as any)?.name ?? "Someone";

      // Resolve the host for this context.
      let hostId: string | null = null;
      if (type === "trip") {
        const { data: trip } = await sc
          .from("trips")
          .select("user_id")
          .eq("id", id)
          .maybeSingle();
        hostId = (trip as any)?.user_id ?? null;
      } else {
        const { data: ev } = await sc
          .from("events")
          .select("creator_id, organizer_id")
          .eq("id", id)
          .maybeSingle();
        hostId = (ev as any)?.organizer_id ?? (ev as any)?.creator_id ?? null;
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
// Returns a curated list of suggested users the caller could invite to their
// active Circle contexts.  Candidates are: mutual followers who are NOT already
// Circle members in any of the caller's active contexts.
//
// Designed to power the "Invite someone" card in the Compass feed; intentionally
// kept simple for V1 (no ML ranking).  The endpoint is additive — adding the
// caller to the Compass SECTION_NAMES list would require touching 10+ Compass
// files.  Instead, the mobile Compass screen calls this endpoint and renders the
// card independently.
//
// Response shape:
//   { suggestions: TravelerSearchResult[] }
//
// Capped at 10 results.  Rate-limited via the members limiter (same window).

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

  // Step 1: collect users the caller follows and who follow back (mutual).
  const [followingRes, followersRes] = await Promise.all([
    sc.from("follows").select("following_id").eq("follower_id", user.id),
    sc.from("follows").select("follower_id").eq("following_id", user.id),
  ]);
  const following = new Set(((followingRes.data ?? []) as any[]).map((r) => r.following_id as string));
  const followers = new Set(((followersRes.data ?? []) as any[]).map((r) => r.follower_id as string));
  const mutuals   = [...following].filter((id) => followers.has(id));

  if (mutuals.length === 0) {
    res.json({ suggestions: [] });
    return;
  }

  // Step 2: find user IDs already in any of the caller's active Circle contexts.
  const { data: myContextsData } = await sc
    .from("circle_members")
    .select("context_id")
    .eq("user_id", user.id)
    .eq("status", "accepted");
  const myContextIds = ((myContextsData ?? []) as any[]).map((r) => r.context_id as string);

  let alreadyInCircle: Set<string> = new Set();
  if (myContextIds.length > 0) {
    const { data: existingData } = await sc
      .from("circle_members")
      .select("user_id")
      .in("context_id", myContextIds)
      .eq("status", "accepted");
    alreadyInCircle = new Set(((existingData ?? []) as any[]).map((r) => r.user_id as string));
  }

  const candidates = mutuals
    .filter((id) => id !== user.id && !alreadyInCircle.has(id))
    .slice(0, 30); // over-fetch before profile load

  if (candidates.length === 0) {
    res.json({ suggestions: [] });
    return;
  }

  // Step 3: load public profile snippets.
  const { data: profiles } = await sc
    .from("profiles")
    .select("id, display_name, name, avatar_url, username, home_city")
    .in("id", candidates);

  const suggestions = ((profiles ?? []) as any[]).slice(0, 10).map((p) => ({
    userId:      p.id,
    displayName: p.display_name ?? p.name ?? "Traveler",
    username:    p.username     ?? null,
    avatarUrl:   p.avatar_url   ?? null,
    homeCity:    p.home_city    ?? null,
  }));

  res.json({ suggestions });
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
      const { data: profileData } = await sc
        .from("profiles").select("display_name, name").eq("id", user.id).maybeSingle();
      const actorName = (profileData as any)?.display_name ?? (profileData as any)?.name ?? "Someone";

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
    await sc
      .from("circle_context_settings")
      .upsert(rows, { onConflict: "user_id,context_type,context_id" });
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
  if (!secret || provided !== secret) {
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
    await sc.from("circle_presence").update({ is_stale: true }).in("id", staleIds);
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
    await sc.from("circle_presence").delete().in("id", expiredIds);
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
    await sc
      .from("circle_presence")
      .delete()
      .eq("context_type", "trip")
      .in("context_id", endedTripIds);
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
    await sc
      .from("circle_presence")
      .delete()
      .eq("context_type", "event")
      .in("context_id", endedEventIds);
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
