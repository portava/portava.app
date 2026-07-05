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

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_CONTEXT_TYPES = new Set<string>(["trip", "event"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Presence stale threshold defaults
const TRIP_PRESENCE_TTL_HOURS  = 24; // 24h after trip end
const EVENT_PRESENCE_TTL_HOURS = 2;  // 2h after event end

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

// ── GET /circle/settings ──────────────────────────────────────────────────────

router.get("/circle/settings", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data } = await sc
    .from("circle_visibility_settings")
    .select("global_enabled, visibility_mode, consent_version, consented_at, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  res.status(200).json({
    globalEnabled:    (data as any)?.global_enabled  ?? false,
    visibilityMode:   (data as any)?.visibility_mode ?? "status_only",
    consentVersion:   (data as any)?.consent_version ?? null,
    consentedAt:      (data as any)?.consented_at    ?? null,
    updatedAt:        (data as any)?.updated_at       ?? null,
    currentConsentVersion: CURRENT_CONSENT_VERSION,
  });
});

// ── PATCH /circle/settings ────────────────────────────────────────────────────

// Accept precise_live so we can return 403 (not supported) rather than 400 (invalid payload)
const PatchSettingsSchema = z.object({
  globalEnabled:    z.boolean().optional(),
  visibilityMode:   z.enum(["status_only", "approximate_area", "venue_checkin", "precise_live"]).optional(),
  consentVersion:   z.string().optional(),
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
  const { globalEnabled, visibilityMode, consentVersion } = parsed.data;

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
  if (globalEnabled !== undefined) upsertPayload["global_enabled"] = globalEnabled;
  if (visibilityMode !== undefined) upsertPayload["visibility_mode"] = visibilityMode;
  if (isEnabling && consentVersion) {
    upsertPayload["consent_version"] = consentVersion;
    upsertPayload["consented_at"]    = new Date().toISOString();
  }

  const { data, error } = await sc
    .from("circle_visibility_settings")
    .upsert(upsertPayload, { onConflict: "user_id" })
    .select("global_enabled, visibility_mode, consent_version, consented_at, updated_at")
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
    globalEnabled:    (data as any)?.global_enabled  ?? false,
    visibilityMode:   (data as any)?.visibility_mode ?? "status_only",
    consentVersion:   (data as any)?.consent_version ?? null,
    consentedAt:      (data as any)?.consented_at    ?? null,
    updatedAt:        (data as any)?.updated_at       ?? null,
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

  const row = data as any;
  res.status(201).json({
    id:               row?.id,
    venueLabel:       row?.venue_label       ?? null,
    approximateLabel: row?.approximate_label ?? null,
    description:      row?.description       ?? null,
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
    .select("id, venue_label, approximate_label, description, updated_at")
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

  // IMPORTANT: response MUST NOT expose needs_help bool, GPS, or emergency details.
  res.status(200).json({
    acknowledged: true,
    message:      "Your circle has been notified. Stay safe.",
  });
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
