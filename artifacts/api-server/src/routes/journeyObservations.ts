import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  ingestJourneyObservationBatch,
  JOURNEY_MAX_BATCH_SIZE,
  journeyObservationSchema,
  type JourneyObservationResult,
} from "../services/journey/JourneyObservationService.js";
import { processJourneySegmentationShadowSession } from "../services/location/JourneySegmentationShadowService.js";

const router = Router();

const batchEnvelopeSchema = z
  .object({
    observations: z.array(z.unknown()).min(1).max(JOURNEY_MAX_BATCH_SIZE),
  })
  .strict();

/**
 * Write-only owner endpoint. There is intentionally no raw observation GET
 * route and no response contains coordinates or persisted observation IDs.
 */
router.post("/me/journey/observations", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const envelope = batchEnvelopeSchema.safeParse(req.body);
  if (!envelope.success) {
    sendError(res, "invalid_payload", "Invalid Journey observation batch");
    return;
  }

  const parsed: Array<{
    index: number;
    observation: z.infer<typeof journeyObservationSchema>;
  }> = [];
  const malformed: JourneyObservationResult[] = [];

  envelope.data.observations.forEach((candidate, index) => {
    const result = journeyObservationSchema.safeParse(candidate);
    if (result.success) parsed.push({ index, observation: result.data });
    else malformed.push({ index, status: "rejected", code: "invalid_observation" });
  });

  const db = getServiceClient();
  if (!db) {
    sendError(res, "server_not_configured");
    return;
  }

  const ingested = await ingestJourneyObservationBatch(db, auth.user.id, parsed);
  const results = [...malformed, ...ingested].sort((a, b) => a.index - b.index);
  const accepted = results.filter((result) => result.status === "accepted").length;
  const deduplicated = results.filter((result) => result.status === "deduplicated").length;
  const rejected = results.length - accepted - deduplicated;

  const observationByIndex = new Map(
    parsed.map(({ index, observation }) => [index, observation] as const),
  );
  const shadowEligibleSessionIds = [...new Set(
    ingested.flatMap((result) => {
      // A deduplicated row was accepted by an earlier request. Re-running the
      // idempotent session processor lets a client replay recover a transient
      // post-ingest shadow failure without creating another raw observation.
      if (result.status !== "accepted" && result.status !== "deduplicated") return [];
      const observation = observationByIndex.get(result.index);
      return observation ? [observation.locationSessionId] : [];
    }),
  )];
  const shadowResults = await Promise.allSettled(
    shadowEligibleSessionIds.map((sessionId) =>
      processJourneySegmentationShadowSession(db, auth.user.id, sessionId)),
  );
  let shadowRevisionCount = 0;
  shadowResults.forEach((result, index) => {
    if (result.status === "rejected") {
      req.log.error(
        { err: result.reason, locationSessionId: shadowEligibleSessionIds[index] },
        "journey shadow segmentation failed",
      );
      return;
    }
    if (result.value.status === "persisted") {
      shadowRevisionCount += result.value.revisionCount;
    }
  });

  req.log.info(
    {
      accepted,
      deduplicated,
      rejected,
      batchSize: results.length,
      shadowSessionCount: shadowEligibleSessionIds.length,
      shadowRevisionCount,
    },
    "journey observation batch processed",
  );

  res.status(200).json({
    ok: true,
    accepted,
    deduplicated,
    rejected,
    results,
  });
}));

export default router;