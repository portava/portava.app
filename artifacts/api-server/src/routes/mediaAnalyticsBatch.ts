/**
 * POST /api/media/analytics/batch
 *
 * Receives batched client-side media analytics events from useMediaAnalytics
 * and acknowledges only rows returned by persistence (MEDIA_ANALYTICS_ENABLED gated).
 *
 * Requires auth. Unknown fields, raw text, malformed values and caller-supplied
 * viewer identity are rejected before the recorder; server-only outcomes are refused.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  persistMediaEventBatch,
  MEDIA_NORTH_STAR_EVENT_TYPES, MEDIA_CLIENT_OUTCOME_SIGNAL_TYPES, MEDIA_SERVER_OUTCOME_SIGNAL_TYPES,
  type MediaEventType,
} from "../lib/mediaAnalytics.js";

import { mediaAnalyticsClientPayload } from "../lib/mediaAnalyticsClientPayload.js";
import composerOutcomesRouter from "./composerOutcomes.js";

const router = Router();
router.use(composerOutcomesRouter);

/**
 * Event types this endpoint will forward. Still a closed allow-list — an
 * unknown type is dropped, never written.
 *
 * The `media_*` entries are the eight §45 north-star transitions. They were
 * missing, which made the whole north-star funnel silently empty: the client
 * emits them (features/media/telemetry/mediaTelemetry.ts), the batch endpoint
 * answered `{ ok: true }`, and this line dropped every one of them on the way
 * to recordMediaEvent. Nothing failed anywhere, so nothing reported it — the
 * funnel simply read zero.
 *
 * Client-observable types are spread from MEDIA_NORTH_STAR_EVENT_TYPES, so the
 * list cannot drift from the `MediaEventType` union again; server-confirmed
 * arrivals/contributions are excluded and cannot be forged by the client.
 */
const VALID_EVENT_TYPES = new Set<string>([
  // Observed Watch views use /media/:id/view with owner/item/session receipts.
  // Generic batches cannot bypass that access and idempotency boundary.
  "mode_switch",
  "like", "comment", "save", "share", "profile_open", "place_open",
  "event_open", "trip_open", "grid_tile_open", "gems_filter_change",
  "add_to_trip", "directions_tap", "wrong_place_report",
  "upload_start", "processing_complete", "processing_failure", "playback_failure",
  ...MEDIA_NORTH_STAR_EVENT_TYPES.filter(type => !MEDIA_SERVER_OUTCOME_SIGNAL_TYPES.includes(type)),
  // §44 outcome signals a client surface emits (census-media §21). The SERVER-only
  // outcome signals (MEDIA_SERVER_OUTCOME_SIGNAL_TYPES) are deliberately absent.
  ...MEDIA_CLIENT_OUTCOME_SIGNAL_TYPES,
]);

const batchSchema = z.object({
  events: z.array(
    z.object({
      type:    z.string(),
      payload: mediaAnalyticsClientPayload.optional().default({}),
    }).strict(),
  ).max(50),
}).strict();

router.post("/media/analytics/batch", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    res.status(503).json({ ok: false, accepted: 0, retryable: false, reason: "analytics_unavailable" });
    return;
  }

  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const events = parsed.data.events.filter(evt => VALID_EVENT_TYPES.has(evt.type));
  const rejected = parsed.data.events.length - events.length;
  const receipt = await persistMediaEventBatch(events.map(evt => ({
    type: evt.type as MediaEventType, payload: { ...evt.payload, viewer_id: user.id },
  })), sc);
  // A disabled policy or erasure trigger explicitly discards events. It is
  // never described as persistence. Legacy clients must not retry an ambiguous
  // batch: no per-event identity exists in this old transport contract.
  res.status(receipt.failed ? 503 : 200).json({
    ok: receipt.failed === 0, ...receipt, rejected, retryable: false,
    ...(receipt.failed ? { reason: "analytics_write_failed" } : {}),
  });
}));

export default router;
