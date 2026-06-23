/**
 * Safe Return routes (Phase 4 seam — gated by safe_return_geo_enabled flag)
 *
 * POST /api/me/safe-return/start      — start a Safe Return session
 * POST /api/me/safe-return/checkin    — "I made it back" / check-in
 * GET  /api/me/safe-return/active     — list active sessions (public labels only)
 *
 * PRIVACY: exact coords stored server-side only. Public responses contain
 * only city/district labels, timer info, and status.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { startSession, endSession, getActiveSessions } from "../services/location/LocationSessionService";

const router = Router();

const VALID_TIMERS = ["15min", "30min", "1hr", "until_plan_ends", "manual"] as const;

const startSchema = z.object({
  timer:          z.enum(VALID_TIMERS).default("30min"),
  city:           z.string().max(128).nullable().optional(),
  district:       z.string().max(128).nullable().optional(),
  country:        z.string().max(128).nullable().optional(),
  countryCode:    z.string().max(8).nullable().optional(),
  lat:            z.number().min(-90).max(90).nullable().optional(),
  lng:            z.number().min(-180).max(180).nullable().optional(),
  relatedTripId:  z.string().uuid().nullable().optional(),
});

async function isFeatureEnabled(db: ReturnType<typeof getServiceClient>): Promise<boolean> {
  if (!db) return false;
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("key", "safe_return_geo_enabled")
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

// ── POST /api/me/safe-return/start ────────────────────────────────────────────

router.post("/me/safe-return/start", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "server_not_configured"); return; }

  if (!await isFeatureEnabled(db)) {
    sendError(res, "feature_disabled", "Safe Return is not yet enabled");
    return;
  }

  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const session = await startSession(db, {
    userId:        user.id,
    sessionType:   "safe_return",
    timer:         parsed.data.timer,
    city:          parsed.data.city,
    district:      parsed.data.district,
    country:       parsed.data.country,
    countryCode:   parsed.data.countryCode,
    lat:           parsed.data.lat,
    lng:           parsed.data.lng,
    relatedTripId: parsed.data.relatedTripId,
  });

  if (!session) {
    sendError(res, "db_error", "Failed to start session");
    return;
  }

  // Return public shape — no coords
  res.status(201).json({
    ok: true,
    session: {
      id:          session.id,
      sessionType: session.sessionType,
      startedAt:   session.startedAt,
      expiresAt:   session.expiresAt,
      city:        session.city,
      district:    session.district,
      country:     session.country,
      safeReturnActive: true,
    },
  });
});

// ── POST /api/me/safe-return/checkin ─────────────────────────────────────────

router.post("/me/safe-return/checkin", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "server_not_configured"); return; }

  if (!await isFeatureEnabled(db)) {
    sendError(res, "feature_disabled", "Safe Return is not yet enabled");
    return;
  }

  const { sessionId } = (req.body ?? {}) as { sessionId?: string };

  if (sessionId) {
    // End a specific session ("I made it back")
    const ok = await endSession(db, sessionId, user.id);
    res.status(200).json({ ok, safeReturnActive: !ok });
    return;
  }

  // End all active safe_return sessions
  const active = await getActiveSessions(db, user.id, "safe_return");
  await Promise.all(active.map((s) => endSession(db, s.id, user.id)));
  res.status(200).json({ ok: true, ended: active.length, safeReturnActive: false });
});

// ── GET /api/me/safe-return/active ────────────────────────────────────────────

router.get("/me/safe-return/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { res.status(200).json({ sessions: [], safeReturnActive: false }); return; }

  if (!await isFeatureEnabled(db)) {
    res.status(200).json({ sessions: [], safeReturnActive: false, featureEnabled: false });
    return;
  }

  const active = await getActiveSessions(db, user.id, "safe_return");
  res.status(200).json({
    safeReturnActive: active.length > 0,
    sessions: active.map((s) => ({
      id:          s.id,
      startedAt:   s.startedAt,
      expiresAt:   s.expiresAt,
      city:        s.city,
      district:    s.district,
      country:     s.country,
    })),
  });
});

export default router;
