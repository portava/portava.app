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
import { liveLabelsServable, readLiveClaimEnvelopes, type LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import { haversineKm } from "../lib/mapSearch.js";
import { WALKING_SPEED_KMH } from "../compass/CompassLiveConstraints.js";
import { DECISION_INTENTS, decideCompass, type DecisionSubject } from "../lib/compassDecision.js";

const router = Router();

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ capability, fail-closed. */
export const COMPASS_DECISION_FLAG = "compass_decision_enabled";

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

interface PlaceRow { id: string; latitude: number | null; longitude: number | null; status: string | null }

async function readPlace(sc: any, id: string): Promise<{ ok: true; row: PlaceRow | null } | { ok: false }> {
  const { data, error } = await sc.from("places").select("id, latitude, longitude, status").eq("id", id).maybeSingle();
  if (error) return { ok: false };
  return { ok: true, row: (data as PlaceRow | null) ?? null };
}

async function subjectState(sc: any, subjectId: string, readable: boolean, now: Date): Promise<DecisionSubject> {
  const envelopes: LiveClaimEnvelope[] = readable ? await readLiveClaimEnvelopes(sc, subjectId, { now }) : [];
  return { subjectId, envelopes, readable };
}

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

    const place = await readPlace(sc, q.subjectId);
    if (!place.ok) {
      sendError(res, "db_error", "Could not read the place");
      return;
    }
    if (!place.row) {
      sendError(res, "not_found", "Unknown place");
      return;
    }

    // ETA: the client's own estimate wins; otherwise a straight-line walking
    // estimate from the viewer's position, if it sent one; otherwise unknown —
    // and an unknown ETA is an unknown interception, stated by the engine.
    let etaMinutes: number | null = q.etaMinutes ?? null;
    if (etaMinutes === null && q.lat !== undefined && q.lng !== undefined) {
      const { latitude, longitude } = place.row;
      if (typeof latitude === "number" && typeof longitude === "number") {
        const km = haversineKm(q.lat, q.lng, latitude, longitude);
        etaMinutes = Math.ceil((km / WALKING_SPEED_KMH) * 60);
      }
    }

    const now = new Date();
    const readable = await liveLabelsServable(sc);
    const candidate = await subjectState(sc, q.subjectId, readable, now);
    const current = q.currentSubjectId
      ? { ...(await subjectState(sc, q.currentSubjectId, readable, now)), sinceMinutes: q.currentSinceMinutes ?? null }
      : null;

    const result = decideCompass(
      {
        candidate,
        current,
        returnSubjectId: q.returnSubjectId ?? null,
        intent: q.intent ?? null,
        etaMinutes,
        queueToleranceMinutes: q.queueToleranceMinutes ?? null,
      },
      now.getTime(),
    );

    res.json({
      ok: true,
      subjectId: q.subjectId,
      decision: result.decision,
      reasons: result.reasons,
      grounding: result.grounding,
      summary: result.summary,
      interception: result.interception,
      switchingCost: result.switchingCost,
      candidate: result.candidate,
      current: result.current,
      liveIntelligenceReadable: readable,
      generatedAt: now.toISOString(),
    });
  }),
);

export default router;
