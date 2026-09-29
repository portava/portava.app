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
import { Router, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isCompassEnabled } from "../compass/flags.js";
import {
  SENSE_CATEGORIES,
  getSenseSettings,
  upsertSenseSettings, SenseSettingsUnavailable,
  runSense, senseCoverage, type SenseSource,
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

  const read = { settings: false }; const settings = await getSenseSettings(sc, auth.user.id, read); if (read.settings) { sendSenseSettingsUnavailable(res, "get"); return; } // DV-83: an unread row is not "passive"
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
  }).catch((err: unknown) => senseSettingsRefused(res, err));
  if (!settings) return; res.json({ compassEnabled: true, settings });
}));

// ── POST /compass/sense/check ─────────────────────────────────────────────────

router.post("/compass/sense/check", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const result = await runSense(sc, auth.user.id, {
    hourUtc: _testHourUtc ?? undefined, nowMinutes: _testNowMinutes ?? undefined,
  });
  if (senseCoverage(result.failedSources) === "none") { sendSenseUnavailable(res, result.failedSources); return; }
  res.json({
    compassEnabled: true,
    presenceLevel: result.presenceLevel,
    evaluated: result.evaluated,
    delivered: result.delivered,
    suppressed: result.suppressed, ...(result.failedSources.length > 0 ? { partial: true, failedSources: result.failedSources } : {}),
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
    const { data, error } = await sc
      .from("compass_sense_nudges")
      .select("id, nudge_type, category, title, body, action_url, confidence, created_at")
      .eq("user_id", auth.user.id)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(20); if (error) throw error; // DV-83: an unread log is not "no nudges"
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
  } catch (err) {
    req.log.warn({ err, userId: auth.user.id }, "compass/sense/nudges unread"); sendError(res, "degraded_unavailable", "Your recent nudges could not be read right now. Please try again shortly.");
  }
}));

export default router;

// ── DV-83: a check that could not read its sources says so ─────────────────
//
// A healthy check answers exactly the five keys it always has. When some
// signal sources could not be read, the same 200 adds `partial: true` and
// `failedSources` (a consumer that ignores unknown keys is unaffected, and
// one that wants the truth can read it). When NONE could be read there is no
// evaluation to report, so the answer is a retryable 503 rather than
// `evaluated: 0` — which would be indistinguishable from "nothing worth a
// nudge". An unreadable presence setting (`failedSources: ["settings"]`) is
// the same case: the run stays fail-closed and sends nothing, but it cannot
// claim "passive, nothing evaluated" over a row it never read.
//
// GET /compass/sense/nudges follows the same rule: an unreadable nudge log is
// a retryable 503, never `nudges: []`.
function sendSenseUnavailable(res: Response, failedSources: readonly SenseSource[]): void {
  res.status(503).json({
    error: "degraded_unavailable",
    message: "Compass could not read any of the signals it checks right now. Please try again shortly.",
    retryable: true,
    failedSources,
  });
}

// ── DV-83: settings that could not be read are not "passive" ──────────────
//
// GET answers a retryable 503 over an unread row instead of the `passive`
// default. PUT refuses (503, nothing written) when it needs the current row
// and cannot read it, or when the database reports its write failed. Healthy
// bodies are unchanged. census-compass §32.
const SENSE_SETTINGS_UNAVAILABLE = {
  get: "Your Compass Sense settings could not be read right now. Please try again shortly.",
  read: "Your Compass Sense settings could not be read, so nothing was changed. Please try again shortly.",
  write: "Your Compass Sense settings could not be saved. Please try again shortly.",
} as const;

function sendSenseSettingsUnavailable(res: Response, why: keyof typeof SENSE_SETTINGS_UNAVAILABLE): void {
  sendError(res, "degraded_unavailable", SENSE_SETTINGS_UNAVAILABLE[why]);
}

/** Answers a SenseSettingsUnavailable as a 503 and yields null; anything else is rethrown. */
function senseSettingsRefused(res: Response, err: unknown): null {
  if (!(err instanceof SenseSettingsUnavailable)) throw err;
  sendSenseSettingsUnavailable(res, err.phase);
  return null;
}
