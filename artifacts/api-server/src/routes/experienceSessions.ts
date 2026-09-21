/**
 * Sensing §5.4 — the ExperienceSession bridge, reachable:
 *
 *   GET  /api/intel/experience-sessions/open      the viewer's open session
 *   POST /api/intel/experience-sessions           ACTION on a DECLARED kind → open
 *   POST /api/intel/experience-sessions/from-opportunity
 *                                                 ACTION on a WORLD OPPORTUNITY → open
 *   POST /api/intel/experience-sessions/:id/close OUTCOME → closed
 *
 * ── CX-15: THE PUBLIC SEAM, AND WHY IT RE-DERIVES ────────────────────────────
 * census-compass CX-15 read: *"It bridges a recommendation to an outcome, not a
 * world opportunity; nothing outside Compass can start one."*
 *
 * `POST …/from-opportunity` is the answer to both halves. It lives on a router
 * that is not Compass and is open to any surface — Wall, Map, Discovery, Home —
 * and it does NOT take the caller's word for the opportunity. It re-derives one
 * server-side through the SAME path routes/opportunities uses (the ONE live
 * read, lib/contextKernel's nine §18.1 contexts, lib/opportunityEngine over
 * them) and bridges from the projection the engine produced. A caller cannot
 * name its own kind, its own claim refs, or a subject the engine gave nothing
 * for. That is also the subject AUTHORIZATION, fail-closed: a §20
 * safety-suppressed subject is 403 `subject_not_actionable` and writes nothing,
 * "we could not look" (`live_intelligence_unavailable`) is spelled differently
 * from "we looked and there is nothing" (`no_opportunity`), and neither opens
 * a session.
 *
 * S54 — the session it opens is bounded by the OPPORTUNITY's own §18.2 window,
 * so the bridge cannot be parked on a place; and after it closes or expires no
 * route here names its subject again, because there is no list, no history and
 * no by-subject read to ask.
 *
 * The engine is lib/experienceSession (pure) and the spine is
 * lib/experienceSessionStore over `canonical_events` — no new table, no new
 * verb, and the outcome lands as the same canonical outcome event
 * lib/intelOutcomes already defines, which is what lib/intelCalibrationScheduler
 * reads back. The route computes no world truth and stores no location.
 *
 * ── THE LAST ARROW: OUTCOME → CALIBRATION ────────────────────────────────────
 * A close that NAMES the served snapshot and claim is recorded through the
 * existing outcome path (`recordIntelOutcome`), so the single event it writes
 * carries BOTH the exact `payload.intel` envelope the daily calibration report
 * counts (`intelCalibrationScheduler`: verb ∈ OUTCOME_VERBS AND
 * `payload->intel` NOT NULL) and this session's closure — and the
 * served-plausibility check, the claim-belongs-to-this-snapshot check and the
 * per-(actor, snapshot) dedup are that path's, not a second copy of them here.
 * A close that names none is the session's own event only, `calibrated: false`:
 * invisible to calibration, and honestly so, rather than fabricating a
 * snapshot id to be counted.
 *
 * ── WHAT IT REFUSES, AND WHY THE REFUSALS ARE NAMED ──────────────────────────
 * A session with no opportunity kind is not a bridge (`no_opportunity_reference`).
 * A second session while one is open is refused (`already_open`) — one open
 * session per viewer is what keeps this from becoming a trail. A close after
 * the window is refused (`expired`): an outcome reported after the window is
 * not evidence about that window, and feeding it to a calibration report would
 * be a lie. A close of a closed session is refused (`already_closed`): closing
 * is terminal. And a read that FAILED is a refusal, never "you have no open
 * session" — opening a second session on the strength of a failed read is the
 * §20 confusion this exists to prevent.
 *
 * Gated by `experience_session_enabled` (migration 2841, seeded FALSE), read
 * fail-closed: absent / false / unreadable ⇒ feature_disabled, and nothing is
 * read or written.
 *
 * Security: requireUser, and every read and write is keyed on the caller's own
 * id — a session id belonging to someone else simply does not resolve.
 */
import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  ATTRIBUTION_TOUCHES,
  EXPERIENCE_RATING_MAX,
  EXPERIENCE_RATING_MIN,
  INTEL_OUTCOMES,
  recordIntelOutcome,
} from "../lib/intelOutcomes.js";
import { liveLabelsServable } from "../lib/liveClaimRead.js";
import { haversineKm } from "../lib/mapSearch.js";
import { WALKING_SPEED_KMH } from "../compass/CompassLiveConstraints.js";
import { ATTENTION_RELEVANCE } from "../lib/attentionEngine.js";
import { DECISION_INTENTS } from "../lib/compassDecision.js";
import { assembleContextKernel, type SubjectWorldContext } from "../lib/contextKernel.js";
import { readAttentionContext, readSubjectWorld, DEFAULT_FORECAST_HORIZON_MINUTES } from "../lib/contextKernelRead.js";
import { MAX_FORECAST_HORIZON_MINUTES } from "../lib/forecastState.js";
import { OPPORTUNITY_KINDS, buildOpportunities } from "../lib/opportunityEngine.js";
import {
  MAX_SESSION_HOURS,
  closeExperienceSession,
  openExperienceSession,
  openSessionForOpportunity,
  sessionForbiddenKeys,
} from "../lib/experienceSession.js";
import { appendSessionEvent, readOpenSession, readSessionById } from "../lib/experienceSessionStore.js";

const router = Router();

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ capability, fail-closed. */
export const EXPERIENCE_SESSION_FLAG = "experience_session_enabled";

const uuid = z.string().uuid();
const openSchema = z.object({
  subjectId: uuid,
  opportunityKind: z.enum(OPPORTUNITY_KINDS),
  claimRefs: z.array(z.string().min(1).max(200)).max(20).optional(),
  hours: z.number().min(0.25).max(MAX_SESSION_HOURS).optional(),
  surface: z.string().min(1).max(40).optional(),
});
/**
 * CX-15's seam. Note what is NOT here: no `opportunityKind`, no `claimRefs`.
 * The opportunity is re-derived server-side; a caller supplies only the subject
 * it wants to act on and the CONTEXT that request is being made in — the same
 * declared context routes/opportunities takes, so the two seams cannot disagree
 * about what an opportunity is.
 */
const fromOpportunitySchema = z.object({
  subjectId: uuid,
  hours: z.number().min(0.25).max(MAX_SESSION_HOURS).optional(),
  surface: z.string().min(1).max(40).optional(),
  intent: z.enum(DECISION_INTENTS).optional(),
  relevance: z.enum(ATTENTION_RELEVANCE).optional(),
  queueToleranceMinutes: z.number().min(0).max(24 * 60).optional(),
  horizonMinutes: z.number().min(1).max(MAX_FORECAST_HORIZON_MINUTES).optional(),
  utcOffsetMinutes: z.number().min(-14 * 60).max(14 * 60).optional(),
  tripNextStopSubjectId: uuid.optional(),
  // One ETA scalar, exactly as routes/opportunities does it: the position never
  // enters the kernel and is stored nowhere.
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});
const closeSchema = z.object({
  outcome: z.enum(INTEL_OUTCOMES),
  experienceRating: z.number().int().min(EXPERIENCE_RATING_MIN).max(EXPERIENCE_RATING_MAX).optional(),
  surface: z.string().min(1).max(40).optional(),
  // §5.4's last arrow — OUTCOME → CALIBRATION. Supply the snapshot and claim
  // the session was served, and the close is recorded through the EXISTING
  // outcome path (lib/intelOutcomes.recordIntelOutcome): one canonical event
  // carrying BOTH the exact `payload.intel` envelope the daily calibration
  // report counts and this session's closure. Omit them and the close is
  // recorded as the session's own event only — honest, and invisible to
  // calibration, which is what "when permitted" looks like when nothing
  // permitted it.
  snapshotId: uuid.optional(),
  claimId: uuid.optional(),
  servedAt: z.string().datetime().optional(),
  touch: z.enum(ATTRIBUTION_TOUCHES).optional(),
});

async function gate(req: any, res: any): Promise<{ sc: any; userId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client unavailable");
    return null;
  }
  if (!(await isFlagEnabled(sc, "experience_session_enabled"))) {
    sendError(res, "feature_disabled", "Experience sessions are not enabled");
    return null;
  }
  return { sc, userId: auth.user.id };
}

router.get(
  "/intel/experience-sessions/open",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const now = Date.now();
    const { open, refusal } = await readOpenSession(g.sc, g.userId, now);
    if (refusal) {
      res.json({ ok: true, session: null, state: null, refusal });
      return;
    }
    res.json({ ok: true, session: open?.envelope ?? null, state: open?.state ?? null, refusal: null });
  }),
);

router.post(
  "/intel/experience-sessions",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const now = Date.now();

    // One open session per viewer. A read that FAILED is not "no session".
    const existing = await readOpenSession(g.sc, g.userId, now);
    if (existing.refusal) {
      res.status(409).json({ ok: false, refusal: existing.refusal });
      return;
    }
    if (existing.open) {
      res.status(409).json({ ok: false, refusal: "already_open", session: existing.open.envelope });
      return;
    }

    const built = openExperienceSession(
      g.userId,
      {
        sessionId: randomUUID(),
        subjectId: parsed.data.subjectId,
        opportunityKind: parsed.data.opportunityKind,
        claimRefs: parsed.data.claimRefs ?? [],
        hours: parsed.data.hours,
        surface: parsed.data.surface,
      },
      now,
    );
    if (!built.ok) {
      res.status(422).json({ ok: false, refusal: built.refusal });
      return;
    }
    // §5.4 "not a raw tracking history", enforced on what is about to be
    // written rather than asserted in a comment.
    const trail = sessionForbiddenKeys(built.event.payload ?? {});
    if (trail.length > 0) {
      req.log?.error?.({ keys: trail }, "experience session payload was trail-shaped");
      sendError(res, "db_error", "Session refused");
      return;
    }
    const write = await appendSessionEvent(g.sc, built.event);
    if (!write.ok) {
      res.status(500).json({ ok: false, refusal: write.refusal });
      return;
    }
    res.status(201).json({ ok: true, session: built.envelope, state: "open" });
  }),
);

/**
 * CX-15 — the WORLD OPPORTUNITY seam, open to any surface.
 *
 * This is the half of CX-15 that says *"nothing outside Compass can start
 * one"*. The handler never trusts the caller's description of the opportunity:
 * it assembles the kernel and runs lib/opportunityEngine, exactly as
 * routes/opportunities does, and bridges from the projection that engine
 * produced — so the origin stamped on the session (`world_opportunity`) is
 * earned, not claimed.
 *
 * The same derivation IS the subject authorization, and it is fail-closed:
 * safety-suppressed ⇒ 403; no opportunity, or no live intelligence to look
 * with, ⇒ 409 with the reason named. A refusal writes nothing.
 */
router.post(
  "/intel/experience-sessions/from-opportunity",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const parsed = fromOpportunitySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const q = parsed.data;
    const now = new Date();
    const nowMs = now.getTime();

    // One open session per viewer, across BOTH seams. A read that FAILED is not
    // "no session" — opening a second on the strength of it is the §20
    // confusion, and it is also how sessions would start accumulating.
    const existing = await readOpenSession(g.sc, g.userId, nowMs);
    if (existing.refusal) {
      res.status(409).json({ ok: false, refusal: existing.refusal });
      return;
    }
    if (existing.open) {
      res.status(409).json({ ok: false, refusal: "already_open", session: existing.open.envelope });
      return;
    }

    // ── Re-derive the opportunity. The caller described none. ────────────────
    const etaMinutesBySubject: Record<string, number | null> = { [q.subjectId]: null };
    if (q.lat !== undefined && q.lng !== undefined) {
      const { data, error } = await g.sc.from("places").select("id, latitude, longitude").eq("id", q.subjectId);
      if (error) {
        sendError(res, "db_error", "Could not read the place");
        return;
      }
      const row = ((data ?? []) as Array<{ id: string; latitude: number | null; longitude: number | null }>)[0];
      if (row && typeof row.latitude === "number" && typeof row.longitude === "number") {
        const km = haversineKm(q.lat, q.lng, row.latitude, row.longitude);
        etaMinutesBySubject[q.subjectId] = Math.ceil((km / WALKING_SPEED_KMH) * 60);
      }
    }

    const readable = await liveLabelsServable(g.sc);
    const subject: SubjectWorldContext = await readSubjectWorld(g.sc, q.subjectId, {
      now,
      readable,
      horizonMinutes: q.horizonMinutes ?? DEFAULT_FORECAST_HORIZON_MINUTES,
    });
    const attention = await readAttentionContext(g.sc, g.userId, now, []);
    const kernel = assembleContextKernel(
      {
        user: {
          intent: q.intent ?? null,
          queueToleranceMinutes: q.queueToleranceMinutes ?? null,
          relevance: q.relevance ?? "none",
        },
        utcOffsetMinutes: q.utcOffsetMinutes ?? null,
        spatial: { viewerPositionKnown: q.lat !== undefined && q.lng !== undefined, etaMinutesBySubject },
        trip: q.tripNextStopSubjectId ? { onTrip: true, dayIndex: null, totalDays: null, nextStopSubjectId: q.tripNextStopSubjectId } : null,
        social: null,
        experience: null,
        subjects: [subject],
        attention,
      },
      nowMs,
    );
    const { opportunities, refusals } = buildOpportunities(kernel, nowMs);
    const opportunity = opportunities.find((o) => o.subjectId === q.subjectId) ?? null;
    if (!opportunity) {
      // AUTHORIZATION, fail-closed. A subject the engine gave nothing for is a
      // subject this viewer may not act on, and safety outranks everything: a
      // §20 suppression is a 403, not a "try again".
      const reason = refusals.find((r) => r.subjectId === q.subjectId)?.reason ?? "no_opportunity";
      const status = reason === "safety_suppressed" ? 403 : 409;
      res.status(status).json({ ok: false, refusal: "subject_not_actionable", reason });
      return;
    }

    const built = openSessionForOpportunity(
      g.userId,
      { sessionId: randomUUID(), opportunity, hours: q.hours, surface: q.surface },
      nowMs,
    );
    if (!built.ok) {
      res.status(422).json({ ok: false, refusal: built.refusal });
      return;
    }
    // S54 "not a raw tracking history", enforced on what is about to be written
    // rather than asserted in a comment.
    const trail = sessionForbiddenKeys(built.event.payload ?? {});
    if (trail.length > 0) {
      req.log?.error?.({ keys: trail }, "experience session payload was trail-shaped");
      sendError(res, "db_error", "Session refused");
      return;
    }
    const write = await appendSessionEvent(g.sc, built.event);
    if (!write.ok) {
      res.status(500).json({ ok: false, refusal: write.refusal });
      return;
    }
    res.status(201).json({
      ok: true,
      session: built.envelope,
      state: "open",
      // What the ENGINE decided, echoed so the surface can render the reason it
      // was offered — never a world value (§5): no density, no trajectory.
      opportunity: {
        kind: opportunity.kind,
        relevance: opportunity.relevance,
        decision: opportunity.decision,
        reachable: opportunity.reachable,
        validUntil: opportunity.window.expiresAt,
      },
    });
  }),
);

router.post(
  "/intel/experience-sessions/:sessionId/close",
  asyncHandler(async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const id = uuid.safeParse(req.params.sessionId);
    if (!id.success) {
      sendError(res, "invalid_payload", "Invalid session id");
      return;
    }
    const parsed = closeSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const now = Date.now();
    const found = await readSessionById(g.sc, g.userId, id.data, now);
    if (found.refusal) {
      res.status(409).json({ ok: false, refusal: found.refusal });
      return;
    }
    if (!found.session) {
      sendError(res, "not_found", "No such session");
      return;
    }
    const built = closeExperienceSession(found.session.envelope, g.userId, parsed.data, now);
    if (!built.ok) {
      res.status(409).json({ ok: false, refusal: built.refusal, state: found.session.state });
      return;
    }
    // With a served snapshot named, the close goes through the EXISTING
    // outcome path so the event carries `payload.intel` and is counted by the
    // calibration report; the served-plausibility, the claim-belongs-to-the-
    // snapshot check and the per-(actor, snapshot) dedup are that path's, not a
    // second copy of them here.
    const q = parsed.data;
    if (q.snapshotId && q.claimId && q.servedAt) {
      const recorded = await recordIntelOutcome(g.sc, g.userId, {
        snapshotId: q.snapshotId,
        claimId: q.claimId,
        outcome: q.outcome,
        experienceRating: q.experienceRating,
        servedAt: q.servedAt,
        touch: q.touch ?? "go_tap",
        surface: q.surface,
        experienceSession: built.envelope as unknown as Record<string, unknown>,
      });
      if (!recorded.ok) {
        res.status(409).json({ ok: false, refusal: recorded.reason, calibrated: false });
        return;
      }
      res.json({
        ok: true,
        session: built.envelope,
        state: "closed",
        verb: built.event.verb,
        outcomeEventId: recorded.eventId,
        deduped: recorded.deduped === true,
        calibrated: true,
      });
      return;
    }

    const write = await appendSessionEvent(g.sc, built.event);
    if (!write.ok) {
      res.status(500).json({ ok: false, refusal: write.refusal });
      return;
    }
    res.json({ ok: true, session: built.envelope, state: "closed", verb: built.event.verb, calibrated: false });
  }),
);

export default router;
