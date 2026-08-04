/**
 * Compass Live — Phase 12 routes.
 *
 *   GET  /api/compass/live/session — current session state (active or not)
 *   POST /api/compass/live/start   — explicitly start a live session
 *   POST /api/compass/live/stop    — explicitly stop; returns the end-of-session summary
 *   POST /api/compass/live/check   — one live tick: refresh rolling context and
 *                                    evaluate Phase 11 + live-only signals.
 *                                    STRICTLY scoped: with no active session it
 *                                    evaluates nothing and writes nothing.
 *
 * Security: requireUser on all routes; COMPASS_ENABLED gate with the honest
 * fallback envelope, same as every Compass surface.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isCompassEnabled } from "../compass/flags.js";
import {
  getActiveLiveSession,
  startLiveSession,
  stopLiveSession,
  runLiveCheck,
} from "../compass/CompassLiveEngine.js";

const router = Router();

/* ── Test hooks ──────────────────────────────────────────────────────────────
 * Live checks are time-aware (next-up windows, late-night ride-home). Tests
 * inject a fixed timestamp / UTC hour so behaviour is deterministic.
 */
let _testNowMs: number | null = null;
let _testHourUtc: number | null = null;
export function _setTestNowMs(ms: number | null): void { _testNowMs = ms; }
export function _setTestHourUtc(hour: number | null): void { _testHourUtc = hour; }

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

// ── GET /compass/live/session ─────────────────────────────────────────────────

router.get("/compass/live/session", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const session = await getActiveLiveSession(sc, auth.user.id);
  res.json({ compassEnabled: true, active: session != null, session });
}));

// ── POST /compass/live/start ──────────────────────────────────────────────────

router.post("/compass/live/start", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  try {
    const { session, alreadyActive } = await startLiveSession(sc, auth.user.id, _testNowMs ?? undefined);
    res.status(alreadyActive ? 200 : 201).json({
      compassEnabled: true,
      active: true,
      alreadyActive,
      session,
    });
  } catch (err: any) {
    req.log.error({ err, userId: auth.user.id }, "compass/live/start failed");
    sendError(res, "db_error", "Could not start a live session", { exposeDetail: true });
  }
}));

// ── POST /compass/live/stop ───────────────────────────────────────────────────

router.post("/compass/live/stop", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const { stopped, summary } = await stopLiveSession(sc, auth.user.id, _testNowMs ?? undefined);
  res.json({ compassEnabled: true, active: false, stopped, summary });
}));

// ── POST /compass/live/check ──────────────────────────────────────────────────

router.post("/compass/live/check", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = await gate(res);
  if (!sc) return;

  const result = await runLiveCheck(sc, auth.user.id, {
    nowMs: _testNowMs ?? undefined,
    hourUtc: _testHourUtc ?? undefined,
  });
  res.json({
    compassEnabled: true,
    active: result.active,
    session: result.session,
    evaluated: result.evaluated,
    delivered: result.delivered,
    suppressed: result.suppressed,
  });
}));

export default router;
