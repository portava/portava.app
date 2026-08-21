/**
 * Admin Journey Shadow Rollout routes.
 *
 * All routes are admin-only (/admin/journey-shadow/*).
 * All mutations pass ctx.userId as actor — never from request body.
 * All routes use asyncHandler + strict Zod schemas.
 *
 * Routes:
 *   POST /admin/journey-shadow/stages        -> configure_journey_shadow_stage_v1
 *   POST /admin/journey-shadow/cohorts       -> assign_journey_shadow_cohort_v1
 *   POST /admin/journey-shadow/cohorts/:assignmentId/revoke -> revoke_journey_shadow_cohort_v1
 *   POST /admin/journey-shadow/sessions      -> issue_journey_shadow_session_v1
 *   POST /admin/journey-shadow/stop          -> global_journey_shadow_stop_v1
 *   POST /admin/journey-shadow/ground-truth  -> record_journey_shadow_ground_truth_v1
 *   POST /admin/journey-shadow/evaluate      -> run aggregate QA evaluation + persist
 *   GET  /admin/journey-shadow/report        -> aggregate report (no user IDs etc.)
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { queryJourneyRetentionHealth } from "../lib/journeyObservationPurge.js";
import {
  configureJourneyShadowStage,
  assignJourneyShadowCohort,
  revokeJourneyShadowCohort,
  issueJourneyShadowSession,
  globalJourneyShadowStop,
  recordJourneyShadowGroundTruth,
} from "../services/journey/JourneyShadowRolloutService.js";
import {
  evaluateJourneyShadowQa,
  computeShadowRating,
} from "../services/journey/JourneyShadowQaService.js";

const router = Router();

// ── Schema helpers ─────────────────────────────────────────────────────────────

/** Rejects any coordinate-like keys or raw IDs at the schema level */
const COORDINATE_KEYS = new Set([
  "lat", "lng", "latitude", "longitude", "coordinates",
  "observation_id", "observation_ids", "raw_ids", "raw_id",
  "user_id", "profile_id", "account_id", "device_id",
  "session_id",
]);

function hasCoordinateKey(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some((k) => COORDINATE_KEYS.has(k.toLowerCase()));
}

// ── POST /admin/journey-shadow/stages ────────────────────────────────────────

const configureStageSchema = z
  .object({
    stage: z.enum(["internal", "qa", "consented"]),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  })
  .strict();

router.post(
  "/admin/journey-shadow/stages",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { userId, sc } = ctx;

    const parsed = configureStageSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    // approvedAt is always server-generated — never from request body
    const approvedAt = new Date().toISOString();

    try {
      const result = await configureJourneyShadowStage(sc, userId, {
        stage: parsed.data.stage,
        startsAt: parsed.data.startsAt,
        endsAt: parsed.data.endsAt,
        approvedAt,
      });
      res.status(201).json({ stageId: result.stageId, approvedAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "stage configuration failed";
      sendError(res, "db_error", msg);
    }
  }),
);

// ── POST /admin/journey-shadow/cohorts ───────────────────────────────────────

const assignCohortSchema = z
  .object({
    userId: z.string().uuid(),
    stageId: z.string().uuid(),
    cohortStartsAt: z.string().datetime({ offset: true }),
    cohortEndsAt: z.string().datetime({ offset: true }),
  })
  .strict();

router.post(
  "/admin/journey-shadow/cohorts",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { userId, sc } = ctx;

    const parsed = assignCohortSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    try {
      const result = await assignJourneyShadowCohort(sc, userId, {
        userId: parsed.data.userId,
        stageId: parsed.data.stageId,
        cohortStartsAt: parsed.data.cohortStartsAt,
        cohortEndsAt: parsed.data.cohortEndsAt,
      });
      res.status(201).json({ assignmentId: result.assignmentId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cohort assignment failed";
      sendError(res, "db_error", msg);
    }
  }),
);

// ── POST /admin/journey-shadow/cohorts/:assignmentId/revoke ──────────────────

const revokeAssignmentParamSchema = z.object({
  assignmentId: z.string().uuid(),
});

router.post(
  "/admin/journey-shadow/cohorts/:assignmentId/revoke",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { userId, sc } = ctx;

    const paramParsed = revokeAssignmentParamSchema.safeParse(req.params);
    if (!paramParsed.success) {
      sendError(res, "invalid_payload", "Invalid assignmentId");
      return;
    }

    try {
      const result = await revokeJourneyShadowCohort(sc, userId, paramParsed.data.assignmentId);
      res.json({ revoked: result.revoked });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cohort revocation failed";
      sendError(res, "db_error", msg);
    }
  }),
);

// ── POST /admin/journey-shadow/sessions ──────────────────────────────────────

const issueSessionSchema = z
  .object({
    assignmentId: z.string().uuid(),
    sessionType: z.enum(["live_share", "trip_check_in"]),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

router.post(
  "/admin/journey-shadow/sessions",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { userId, sc } = ctx;

    const parsed = issueSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    try {
      const result = await issueJourneyShadowSession(sc, userId, {
        assignmentId: parsed.data.assignmentId,
        sessionType: parsed.data.sessionType,
        expiresAt: parsed.data.expiresAt,
      });
      res.status(201).json({ locationSessionId: result.locationSessionId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "session issuance failed";
      sendError(res, "db_error", msg);
    }
  }),
);

// ── POST /admin/journey-shadow/stop ──────────────────────────────────────────

router.post(
  "/admin/journey-shadow/stop",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { userId, sc } = ctx;

    try {
      const result = await globalJourneyShadowStop(sc, userId);
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "global stop failed";
      sendError(res, "db_error", msg);
    }
  }),
);

// ── POST /admin/journey-shadow/ground-truth ──────────────────────────────────

/**
 * Ground truth body schema.
 * - Never accepts coordinates (lat/lng/latitude/longitude).
 * - Canonical placeId/categoryId are UUID references, never coordinates.
 * - Never accepts actor/approvedBy from request.
 */
const groundTruthSchema = z
  .object({
    assignmentId: z.string().uuid(),
    locationSessionId: z.string().uuid(),
    recordedAt: z.string().datetime({ offset: true }),
    expectedArrivalAt: z.string().datetime({ offset: true }).nullable().optional(),
    expectedDepartureAt: z.string().datetime({ offset: true }).nullable().optional(),
    expectedDwellSeconds: z.number().finite().nonnegative().nullable().optional(),
    expectedPlaceId: z.string().uuid().nullable().optional(),
    expectedCategoryId: z.string().uuid().nullable().optional(),
    expectedStop: z.boolean(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  // Reject if any coordinate key present (defence in depth — Zod strict() already blocks extra keys)
  .refine(
    (val) => !hasCoordinateKey(val as unknown as Record<string, unknown>),
    { message: "ground truth must not contain coordinate or raw identifier fields" },
  );

router.post(
  "/admin/journey-shadow/ground-truth",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { userId, sc } = ctx;

    const parsed = groundTruthSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    const d = parsed.data;

    // Extra guard: reject coordinate-named keys anywhere in body
    if (hasCoordinateKey(req.body as Record<string, unknown>)) {
      sendError(res, "invalid_payload", "Ground truth must not contain coordinate fields");
      return;
    }

    try {
      const result = await recordJourneyShadowGroundTruth(sc, userId, {
        assignmentId: d.assignmentId,
        locationSessionId: d.locationSessionId,
        recordedAt: d.recordedAt,
        expectedArrivalAt: d.expectedArrivalAt ?? null,
        expectedDepartureAt: d.expectedDepartureAt ?? null,
        expectedDwellSeconds: d.expectedDwellSeconds ?? null,
        expectedPlaceId: d.expectedPlaceId ?? null,
        expectedCategoryId: d.expectedCategoryId ?? null,
        expectedStop: d.expectedStop,
        notes: d.notes ?? null,
      });
      res.status(201).json({ groundTruthId: result.groundTruthId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ground truth recording failed";
      sendError(res, "db_error", msg);
    }
  }),
);

// ── POST /admin/journey-shadow/evaluate ──────────────────────────────────────

const evaluateSchema = z
  .object({
    stageId: z.string().uuid(),
    periodStartsAt: z.string().datetime({ offset: true }),
    periodEndsAt: z.string().datetime({ offset: true }),
  })
  .strict();

router.post(
  "/admin/journey-shadow/evaluate",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { userId, sc } = ctx;

    const parsed = evaluateSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    try {
      const result = await evaluateJourneyShadowQa(sc, userId, {
        stageId: parsed.data.stageId,
        periodStartsAt: parsed.data.periodStartsAt,
        periodEndsAt: parsed.data.periodEndsAt,
      });
      res.status(201).json({
        reportId: result.reportId,
        fixtureCount: result.fixtureCount,
        metrics: result.metrics,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "evaluation failed";
      sendError(res, "db_error", msg);
    }
  }),
);

// ── GET /admin/journey-shadow/report ─────────────────────────────────────────

/**
 * Aggregate admin-only report. Never returns:
 * - user IDs, session IDs, assignment IDs
 * - raw timestamps from observations
 * - coordinates
 * - per-user rows
 * - raw truth payloads
 *
 * Fails closed on missing or unreadable data.
 */
const reportQuerySchema = z.object({
  stageId: z.string().uuid(),
  periodStartsAt: z.string().datetime({ offset: true }),
  periodEndsAt: z.string().datetime({ offset: true }),
});

router.get(
  "/admin/journey-shadow/report",
  asyncHandler(async (req, res) => {
    const ctx = await requireAdmin(req, res);
    if (!ctx) return;
    const { sc } = ctx;

    const parsed = reportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query params");
      return;
    }

    const { stageId, periodStartsAt, periodEndsAt } = parsed.data;

    // 1. Retention health — fail closed if not HEALTHY
    let retention;
    try {
      retention = await queryJourneyRetentionHealth({ client: sc });
    } catch {
      sendError(res, "db_error", "retention health check failed");
      return;
    }

    // 2. Stage status — fail closed if missing
    let stageRow: Record<string, unknown> | null = null;
    try {
      const { data, error } = await sc
        .from("journey_shadow_stages")
        .select("id, stage, starts_at, ends_at, is_active, created_at, max_accounts")
        .eq("id", stageId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        sendError(res, "not_found", "Stage not found");
        return;
      }
      stageRow = data as Record<string, unknown>;
    } catch {
      sendError(res, "db_error", "stage query failed");
      return;
    }

    // 3. Cohort/session/observation/quality/revision/truth counts — aggregate only
    let cohortCount = 0;
    let sessionCount = 0;
    let observationCount: number | null = null;
    let revisionCount: number | null = null;
    let truthCount = 0;
    let failureModes: Record<string, unknown> = {};

    try {
      // Cohort assignments overlapping the period window:
      // cohort_starts_at <= periodEndsAt AND cohort_ends_at >= periodStartsAt
      const { count: cohortCountResult, error: cohortErr } = await sc
        .from("journey_shadow_cohort_assignments")
        .select("id", { count: "exact", head: true })
        .eq("stage_id", stageId)
        .lte("cohort_starts_at", periodEndsAt)
        .gte("cohort_ends_at", periodStartsAt);
      if (cohortErr) throw cohortErr;
      cohortCount = cohortCountResult ?? 0;
    } catch {
      sendError(res, "db_error", "cohort count query failed");
      return;
    }

    let assignmentIds: string[] = [];
    let issuedSessionIds: string[] = [];

    if (cohortCount > 0) {
      try {
        const { data, error } = await sc
          .from("journey_shadow_cohort_assignments")
          .select("id")
          .eq("stage_id", stageId)
          .lte("cohort_starts_at", periodEndsAt)
          .gte("cohort_ends_at", periodStartsAt);
        if (error) throw error;
        const rows = ((data ?? []) as Array<{ id: string }>);
        assignmentIds = rows.map((r) => r.id);
      } catch {
        sendError(res, "db_error", "assignment detail query failed");
        return;
      }

      // Load issued session IDs for these assignments
      try {
        const { data: issuanceData, error: issuanceErr } = await sc
          .from("journey_shadow_session_issuances")
          .select("location_session_id")
          .in("assignment_id", assignmentIds);
        if (issuanceErr) throw issuanceErr;
        const issuanceRows = ((issuanceData ?? []) as Array<{ location_session_id: string }>);
        issuedSessionIds = issuanceRows
          .map((r) => r.location_session_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0);
        sessionCount = issuedSessionIds.length;
      } catch {
        sendError(res, "db_error", "session count query failed");
        return;
      }

      if (issuedSessionIds.length > 0) {
        // Use aggregate_journey_shadow_observations_v1 which authorises every
        // issued session inside the same SQL transaction before aggregating.
        // Returns only counts + quality distributions — never coordinates, IDs,
        // or raw timestamps. Unusable rows are included to measure failure-mode
        // distributions (stale/poor-accuracy/impossible-speed). Fails closed if
        // any session is denied.
        try {
          const { data: aggData, error: aggErr } = await sc.rpc(
            "aggregate_journey_shadow_observations_v1",
            {
              p_actor: ctx.userId,
              p_stage_id: stageId,
              p_period_starts_at: periodStartsAt,
              p_period_ends_at: periodEndsAt,
            },
          );
          if (aggErr) throw aggErr;
          const agg = (aggData ?? {}) as {
            totalObservationCount?: number;
            qualityClassDistribution?: Record<string, number>;
            qualityReasonDistribution?: Record<string, number>;
          };
          observationCount = agg.totalObservationCount ?? 0;
          failureModes = {
            qualityClassDistribution: agg.qualityClassDistribution ?? {},
            qualityReasonDistribution: agg.qualityReasonDistribution ?? {},
          };
        } catch {
          sendError(res, "db_error", "observation aggregate query failed");
          return;
        }

        // Count derived segment revisions via the SECURITY DEFINER aggregate RPC
        // aggregate_journey_shadow_segment_revisions_v1. service_role no longer
        // has direct SELECT on journey_segment_revisions; the RPC authorises every
        // issued session inside the same SQL transaction (overlap-scoped) before
        // counting and returns ONLY {revisionCount} — never rows, IDs, or
        // timestamps. Fails closed with a generic error if any session is denied.
        try {
          const { data: segAgg, error: revErr } = await sc.rpc(
            "aggregate_journey_shadow_segment_revisions_v1",
            {
              p_actor: ctx.userId,
              p_stage_id: stageId,
              p_period_starts_at: periodStartsAt,
              p_period_ends_at: periodEndsAt,
            },
          );
          if (revErr) throw revErr;
          const seg = (segAgg ?? {}) as { revisionCount?: number };
          revisionCount = seg.revisionCount ?? 0;
        } catch {
          sendError(res, "db_error", "revision count query failed");
          return;
        }
      } else {
        observationCount = 0;
        revisionCount = 0;
        failureModes = {
          qualityClassDistribution: {},
          qualityReasonDistribution: {},
        };
      }

      try {
        const { count: truthCountResult, error: truthErr } = await sc
          .from("journey_shadow_ground_truth")
          .select("id", { count: "exact", head: true })
          .in("assignment_id", assignmentIds)
          .gte("recorded_at", periodStartsAt)
          .lte("recorded_at", periodEndsAt);
        if (truthErr) throw truthErr;
        truthCount = truthCountResult ?? 0;
      } catch {
        sendError(res, "db_error", "truth count query failed");
        return;
      }
    }

    // 4. Latest aggregate QA report for this stage+period
    let latestQaPayload: unknown = null;
    try {
      const { data: qaData, error: qaErr } = await sc
        .from("journey_shadow_qa_reports")
        .select("payload, submitted_at")
        .eq("stage_id", stageId)
        .gte("period_starts_at", periodStartsAt)
        .lte("period_ends_at", periodEndsAt)
        .order("submitted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (qaErr) throw qaErr;
      if (qaData) {
        // Return only the aggregate payload — never raw truth or user data
        latestQaPayload = (qaData as any).payload ?? null;
      }
    } catch {
      // Non-fatal — report with null qa payload
      latestQaPayload = null;
    }

    // 5. Compute shadow rating from latest QA metrics (if available)
    let shadowRating: string = "insufficient";
    let ratingReasons: string[] = [];
    const behaviorPatternInferenceReady = false; // always false

    if (latestQaPayload && typeof latestQaPayload === "object") {
      const qp = latestQaPayload as Record<string, unknown>;
      const fixtureCount = typeof qp["fixtureCount"] === "number" ? qp["fixtureCount"] : 0;
      // Only compute rating if we have the metrics shape
      if (
        typeof qp["falseStop"] === "object" &&
        typeof qp["falseDwell"] === "object" &&
        typeof qp["placeMatch"] === "object" &&
        typeof qp["categoryMatch"] === "object" &&
        typeof qp["confidenceCalibration"] === "object" &&
        typeof qp["impossibleSpeedEvents"] === "number"
      ) {
        try {
          const rating = computeShadowRating(
            latestQaPayload as any,
            retention.state,
            fixtureCount,
          );
          shadowRating = rating.rating;
          ratingReasons = rating.reasons;
        } catch {
          shadowRating = "insufficient";
        }
      } else {
        // Missing fields — conservative
        shadowRating = "insufficient";
        ratingReasons = ["qa_metrics_incomplete"];
      }
    } else {
      // No QA report yet
      if (retention.state !== "HEALTHY") {
        shadowRating = "blocked";
        ratingReasons = [`retention_not_healthy:${retention.state}`];
      } else if (truthCount === 0) {
        shadowRating = "blocked";
        ratingReasons = ["zero_truth_samples"];
      } else {
        shadowRating = "insufficient";
        ratingReasons = ["no_qa_report"];
      }
    }

    // 6. Build response — no user IDs, session IDs, assignment IDs, raw timestamps,
    //    coordinates, per-user rows, or raw truth payloads
    res.json({
      stage: {
        id: stageRow["id"],
        stage: stageRow["stage"],
        startsAt: stageRow["starts_at"],
        endsAt: stageRow["ends_at"],
        isActive: stageRow["is_active"],
        maxAccounts: stageRow["max_accounts"] ?? null,
      },
      period: {
        startsAt: periodStartsAt,
        endsAt: periodEndsAt,
      },
      retentionHealth: {
        state: retention.state,
        lastSuccessAt: retention.lastSuccessAt,
        consecutiveFailures: retention.consecutiveFailures,
        pendingRetryCount: retention.pendingRetryCount,
      },
      counts: {
        cohortAssignments: cohortCount,
        sessions: sessionCount,
        observations: observationCount,
        revisions: revisionCount,
        groundTruthSamples: truthCount,
      },
      failureModes,
      latestQaReport: latestQaPayload,
      shadowRating,
      ratingReasons,
      behaviorPatternInferenceReady,
    });
  }),
);

export default router;
