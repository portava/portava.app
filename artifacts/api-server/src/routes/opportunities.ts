/**
 * GET /api/intel/opportunities — Sensing §6's pipeline, reachable:
 *
 *   CONTEXT KERNEL  →  OPPORTUNITY ENGINE  →  FEATURE-SPECIFIC PROJECTION
 *
 * The route does the I/O and nothing else. It assembles lib/contextKernel's
 * nine §18.1 contexts through lib/contextKernelRead (the ONE live read path,
 * the notification preference service, the hour's notification count), runs
 * lib/opportunityEngine over the kernel — which itself calls lib/compassDecision
 * rather than restating a rule of it — and answers the subset of fields the
 * requested surface receives.
 *
 * It computes no world truth, ranks nothing of its own, and writes nothing.
 *
 * ── THE GUARD ON THE WIRE ────────────────────────────────────────────────────
 * §5: an OpportunityProjection "must not claim canonical world truth". Before
 * serializing, every projection is scanned by
 * `opportunityEngine.opportunityWorldValueKeys`; if one ever carries a world
 * value (a density, a trajectory, a vibe, a count) the response is REFUSED with
 * `db_error` rather than served. The guard runs in production, not only in the
 * suite.
 *
 * ── WHAT THIS ROUTE DOES NOT READ ────────────────────────────────────────────
 * No trip table. The Trips lane owns those reads; the TripContext here is what
 * the CALLER declared for this request (its next stop, its day index), used for
 * one relevance factor and stored nowhere. A caller that declares nothing gets
 * `trip: null` — UNKNOWN, reported in `unknownContexts`, never "not on a trip".
 *
 * Gated by `opportunity_engine_enabled` (migration 2840, seeded FALSE), read
 * fail-closed: absent / false / unreadable ⇒ feature_disabled. Behind it the
 * Live gates still decide whether anything is served; with the pilot off every
 * subject is refused `live_intelligence_unavailable` and no opportunity is
 * invented to fill the page (§20).
 *
 * Security: requireUser. The viewer's position, when sent, becomes one ETA
 * scalar per subject and is stored nowhere; no identity reaches the kernel.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { liveLabelsServable } from "../lib/liveClaimRead.js";
import { haversineKm } from "../lib/mapSearch.js";
import { WALKING_SPEED_KMH } from "../compass/CompassLiveConstraints.js";
import { ATTENTION_RELEVANCE } from "../lib/attentionEngine.js";
import { DECISION_INTENTS } from "../lib/compassDecision.js";
import { assembleContextKernel, unknownContexts, type SubjectWorldContext } from "../lib/contextKernel.js";
import { readAttentionContext, readSubjectWorld, DEFAULT_FORECAST_HORIZON_MINUTES } from "../lib/contextKernelRead.js";
import {
  OPPORTUNITY_SURFACES,
  buildOpportunities,
  opportunityWorldValueKeys,
  projectForSurface,
  type OpportunitySurface,
} from "../lib/opportunityEngine.js";
import { MAX_FORECAST_HORIZON_MINUTES } from "../lib/forecastState.js";

const router = Router();

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ capability, fail-closed. */
export const OPPORTUNITY_ENGINE_FLAG = "opportunity_engine_enabled";
/** Subjects one request may name. */
export const OPPORTUNITY_MAX_SUBJECTS = 20;

const uuid = z.string().uuid();
const minutes = z.coerce.number().min(0).max(24 * 60);
const uuidList = z
  .string()
  .min(1)
  .transform((s) => s.split(",").map((v) => v.trim()).filter((v) => v.length > 0))
  .refine((ids) => ids.length > 0 && ids.length <= OPPORTUNITY_MAX_SUBJECTS, {
    message: `Between 1 and ${OPPORTUNITY_MAX_SUBJECTS} subject ids`,
  })
  .refine((ids) => ids.every((id) => uuid.safeParse(id).success), { message: "Subject ids must be uuids" });

const querySchema = z.object({
  subjectIds: uuidList,
  surface: z.enum(OPPORTUNITY_SURFACES).optional(),
  intent: z.enum(DECISION_INTENTS).optional(),
  relevance: z.enum(ATTENTION_RELEVANCE).optional(),
  queueToleranceMinutes: minutes.optional(),
  horizonMinutes: z.coerce.number().min(1).max(MAX_FORECAST_HORIZON_MINUTES).optional(),
  utcOffsetMinutes: z.coerce.number().min(-14 * 60).max(14 * 60).optional(),
  currentSubjectId: uuid.optional(),
  currentSinceMinutes: minutes.optional(),
  returnSubjectId: uuid.optional(),
  tripNextStopSubjectId: uuid.optional(),
  tripDayIndex: z.coerce.number().int().min(1).max(365).optional(),
  tripTotalDays: z.coerce.number().int().min(1).max(365).optional(),
  seen: z
    .string()
    .transform((s) => s.split(",").map((v) => v.trim()).filter((v) => v.length > 0))
    .optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

interface PlaceRow {
  id: string;
  latitude: number | null;
  longitude: number | null;
}

router.get(
  "/intel/opportunities",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client unavailable");
      return;
    }
    if (!(await isFlagEnabled(sc, "opportunity_engine_enabled"))) {
      sendError(res, "feature_disabled", "The opportunity engine is not enabled");
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
      return;
    }
    const q = parsed.data;
    const surface: OpportunitySurface = q.surface ?? "compass";
    const now = new Date();
    const nowMs = now.getTime();

    // Subjects the kernel will carry: the named ones, plus the current
    // experience when the caller declared one (the decision engine needs its
    // live state to price the switching cost).
    const subjectIds = Array.from(new Set([...q.subjectIds, ...(q.currentSubjectId ? [q.currentSubjectId] : [])]));

    // ETA per subject: one distance from the viewer's position, when sent.
    // The position itself never enters the kernel.
    const etaMinutesBySubject: Record<string, number | null> = {};
    for (const id of subjectIds) etaMinutesBySubject[id] = null;
    if (q.lat !== undefined && q.lng !== undefined) {
      const { data, error } = await sc.from("places").select("id, latitude, longitude").in("id", subjectIds);
      if (error) {
        sendError(res, "db_error", "Could not read the places");
        return;
      }
      for (const row of (data ?? []) as PlaceRow[]) {
        if (typeof row.latitude === "number" && typeof row.longitude === "number") {
          const km = haversineKm(q.lat, q.lng, row.latitude, row.longitude);
          etaMinutesBySubject[row.id] = Math.ceil((km / WALKING_SPEED_KMH) * 60);
        }
      }
    }

    const readable = await liveLabelsServable(sc);
    const subjects: SubjectWorldContext[] = [];
    for (const id of subjectIds) {
      subjects.push(
        await readSubjectWorld(sc, id, {
          now,
          readable,
          horizonMinutes: q.horizonMinutes ?? DEFAULT_FORECAST_HORIZON_MINUTES,
        }),
      );
    }

    const attention = await readAttentionContext(sc, auth.user.id, now, q.seen ?? []);

    const kernel = assembleContextKernel(
      {
        user: {
          intent: q.intent ?? null,
          queueToleranceMinutes: q.queueToleranceMinutes ?? null,
          relevance: q.relevance ?? "none",
        },
        utcOffsetMinutes: q.utcOffsetMinutes ?? null,
        spatial: { viewerPositionKnown: q.lat !== undefined && q.lng !== undefined, etaMinutesBySubject },
        trip:
          q.tripNextStopSubjectId || q.tripDayIndex !== undefined
            ? {
                onTrip: true,
                dayIndex: q.tripDayIndex ?? null,
                totalDays: q.tripTotalDays ?? null,
                nextStopSubjectId: q.tripNextStopSubjectId ?? null,
              }
            : null,
        social: null,
        experience:
          q.currentSubjectId || q.returnSubjectId
            ? {
                currentSubjectId: q.currentSubjectId ?? null,
                currentSinceMinutes: q.currentSinceMinutes ?? null,
                leftSubjectId: q.returnSubjectId ?? null,
              }
            : null,
        subjects,
        attention,
      },
      nowMs,
    );

    const { opportunities, refusals } = buildOpportunities(kernel, nowMs);

    // The current experience is context, not a candidate: it is never offered
    // back to a viewer who is already there.
    const served = opportunities.filter((o) => o.subjectId !== (q.currentSubjectId ?? null));
    const wire = projectForSurface(served, surface);

    // §5's prohibition, enforced on the WIRE and not only in the suite: what is
    // scanned is exactly what would be serialized, so neither the stage nor a
    // surface projection can introduce a world value without this refusing the
    // whole response.
    const worldValues = [...opportunityWorldValueKeys(served), ...opportunityWorldValueKeys(wire)];
    if (worldValues.length > 0) {
      req.log?.error?.({ keys: worldValues }, "opportunity projection carried a world value");
      sendError(res, "db_error", "Opportunity projection refused");
      return;
    }

    res.json({
      ok: true,
      surface,
      liveIntelligenceReadable: readable,
      opportunities: wire,
      refusals: refusals.filter((r) => r.subjectId !== (q.currentSubjectId ?? null)),
      contexts: {
        unknown: unknownContexts(kernel),
        temporal: kernel.temporal,
        // The WORLD reading itself — the Crowd engine's state per subject and
        // the Forecast engine's, or the named reason there is no forecast.
        // This is where a world value belongs and the only place it appears:
        // an opportunity above carries none (the guard refuses one), and a
        // surface that wants to render what the world IS reads it here.
        world: kernel.world.subjects.map((s) => ({
          subjectId: s.subjectId,
          readable: s.readable,
          crowd: s.crowd,
          forecast: s.forecast,
          forecastRefusal: s.forecastRefused?.refusal ?? null,
        })),
        attention: {
          available: kernel.attention.available,
          deliveredInWindow: kernel.attention.deliveredInWindow,
          budgetPerWindow: kernel.attention.budgetPerWindow,
        },
        safety: { suppressedSubjectIds: kernel.safety.suppressedSubjectIds },
      },
    });
  }),
);

export default router;
