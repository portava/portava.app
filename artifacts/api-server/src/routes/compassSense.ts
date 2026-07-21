/**
 * Compass Sense — Phase 11 routes.
 *
 *   GET  /api/compass/sense/settings — presence level + per-category permissions
 *   PUT  /api/compass/sense/settings — update presence/permissions
 *   POST /api/compass/sense/check    — evaluate signals for the caller and
 *                                      deliver any nudges that pass every gate
 *                                      (presence → permission → quiet hours →
 *                                      dedupe → daily cap)
 *   GET  /api/compass/sense/nudges   — recent delivered nudges (7 days)
 *
 * Security: requireUser on all routes. Feature-gated on COMPASS_ENABLED like
 * every Compass surface — disabled flag returns an honest fallback envelope.
 * All enforcement is server-side; the client never decides what may be sent.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isCompassEnabled } from "../compass/flags.js";
import {
  SENSE_CATEGORIES,
  getSenseSettings,
  upsertSenseSettings,
  runSense,
  type SenseCategory,
} from "../compass/CompassSenseEngine.js";

const router = Router();

/* ── Test hooks ──────────────────────────────────────────────────────────────
 * Sense is time-aware (free-time daytime gate, quiet hours). Tests inject a
 * fixed UTC hour / minutes-of-day so behaviour is deterministic.
 */
let _testHourUtc: number | null = null;
let _testNowMinutes: number | null = null;
export function _setTestHourUtc(hour: number | null): void { _testHourUtc = hour; }
export function _setTestNowMinutes(mins: number | null): void { _testNowMinutes = mins; }

async function gate(res: any): Promise<any | null> {
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not available");
    return null;
  }
  const enabled = await isCompassEnabled(sc).catch(() => false);
  if (!enabled) {
    res.json({ compassEnabled: false, fallback: true });
    return null;
  }
  return sc;
}

// ── GET /compass/sense/settings ───────────────────────────────────────────────

router.get("/compass/sense/settings", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const settings = await getSenseSettings(sc, auth.user.id);
  res.json({ compassEnabled: true, settings });
}));

// ── PUT /compass/sense/settings ───────────────────────────────────────────────

const PutSettingsSchema = z.object({
  presenceLevel: z.enum(["passive", "aware", "active"]).optional(),
  categories: z
    .record(z.boolean())
    .optional()
    .refine(
      (c) => c == null || Object.keys(c).every((k) => (SENSE_CATEGORIES as readonly string[]).includes(k)),
      `Unknown category — valid: ${SENSE_CATEGORIES.join(", ")}`,
    ),
});

router.put("/compass/sense/settings", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const parsed = PutSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }

  const settings = await upsertSenseSettings(sc, auth.user.id, {
    presenceLevel: parsed.data.presenceLevel,
    categories: parsed.data.categories as Partial<Record<SenseCategory, boolean>> | undefined,
  });
  res.json({ compassEnabled: true, settings });
}));

// ── POST /compass/sense/check ─────────────────────────────────────────────────

router.post("/compass/sense/check", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const result = await runSense(sc, auth.user.id, {
    hourUtc: _testHourUtc ?? undefined,
    nowMinutes: _testNowMinutes ?? undefined,
  });
  res.json({
    compassEnabled: true,
    presenceLevel: result.presenceLevel,
    evaluated: result.evaluated,
    delivered: result.delivered,
    suppressed: result.suppressed,
  });
}));

// ── GET /compass/sense/nudges ─────────────────────────────────────────────────

router.get("/compass/sense/nudges", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  try {
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const { data } = await sc
      .from("compass_sense_nudges")
      .select("id, nudge_type, category, title, body, action_url, confidence, created_at")
      .eq("user_id", auth.user.id)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(20);
    res.json({
      compassEnabled: true,
      nudges: ((data ?? []) as any[]).map((n) => ({
        id: String(n.id),
        type: String(n.nudge_type),
        category: String(n.category),
        title: String(n.title),
        body: String(n.body),
        actionUrl: (n.action_url as string | null) ?? null,
        confidence: n.confidence ?? null,
        createdAt: String(n.created_at),
      })),
    });
  } catch {
    res.json({ compassEnabled: true, nudges: [] });
  }
}));

export default router;
