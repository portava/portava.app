/**
 * GET /api/compass/decision — Sensing §10: Compass emits a DECISION.
 *
 *   GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN
 *
 * The engine is lib/compassDecision (pure). This route only gathers its
 * inputs through the seams that already exist — the candidate's live claims
 * through lib/liveClaimRead (the ONE read path every surface consumes, gated
 * and fail-closed there), the viewer's current experience the same way, the
 * place's coordinates for a walking ETA when the client sends none — and
 * answers with the decision, its reasons, its §5.1 grounding, the peak
 * interception and the switching-cost report. It computes no world truth of
 * its own and writes nothing.
 *
 * Gated by `compass_decision_enabled` (migration 2800, seeded FALSE), read
 * fail-closed: absent / false / unreadable ⇒ feature_disabled. Behind it the
 * Live gates still decide whether anything is served — with the pilot off or
 * a scope unpromoted the engine answers WAIT with `live_intelligence_unavailable`
 * or `no_live_evidence`, never GO; it does not fabricate a reading to have
 * something to say (Sensing §20).
 *
 * Security: requireUser. The viewer's location, when sent, is used for one
 * distance and stored nowhere.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { DECISION_INTENTS } from "../lib/compassDecision.js";
import { COMPASS_DECISION_FLAG, assembleCompassDecision } from "../lib/compassDecisionAssembly.js";

const router = Router();

// Re-exported so the literal beside the read below and the tool's stay one name.
export { COMPASS_DECISION_FLAG };

const uuid = z.string().uuid();
const minutes = z.coerce.number().min(0).max(24 * 60);
const querySchema = z.object({
  subjectId: uuid,
  currentSubjectId: uuid.optional(),
  currentSinceMinutes: minutes.optional(),
  returnSubjectId: uuid.optional(),
  intent: z.enum(DECISION_INTENTS).optional(),
  etaMinutes: minutes.optional(),
  queueToleranceMinutes: minutes.optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

router.get(
  "/compass/decision",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    if (!(await isFlagEnabled(sc, "compass_decision_enabled"))) {
      sendError(res, "feature_disabled", "Compass decisions are not enabled");
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
      return;
    }
    const q = parsed.data;

    const now = new Date();
    const assembled = await assembleCompassDecision(sc, q, now);
    if (!assembled.ok) {
      if (assembled.reason === "db_error") sendError(res, "db_error", "Could not read the place");
      else sendError(res, "not_found", "Unknown place");
      return;
    }
    const { result, liveIntelligenceReadable: readable } = assembled;

    res.json({
      ok: true,
      subjectId: q.subjectId,
      decision: result.decision,
      reasons: result.reasons,
      grounding: result.grounding,
      summary: result.summary,
      interception: result.interception,
      switchingCost: result.switchingCost,
      confirmation: result.confirmation,
      candidate: result.candidate,
      current: result.current,
      liveIntelligenceReadable: readable,
      generatedAt: now.toISOString(),
    });
  }),
);

export default router;
