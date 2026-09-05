/**
 * POST /api/media/analytics/batch
 *
 * Receives batched client-side media analytics events from useMediaAnalytics
 * and delegates each to recordMediaEvent (fire-and-forget, MEDIA_ANALYTICS_ENABLED gated).
 *
 * Requires auth. Payload is validated; forbidden fields are stripped server-side
 * by recordMediaEvent before any DB write.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import {
  recordMediaEvent,
  MEDIA_NORTH_STAR_EVENT_TYPES,
  type MediaEventType,
} from "../lib/mediaAnalytics.js";

const router = Router();

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
 * They are spread from MEDIA_NORTH_STAR_EVENT_TYPES rather than retyped, so the
 * list cannot drift from the `MediaEventType` union again; the spread is still
 * an enumeration of eight fixed names, not an opening of the allow-list.
 */
const VALID_EVENT_TYPES = new Set<string>([
  "mode_switch", "impression", "qualified_view", "completion", "rewatch",
  "like", "comment", "save", "share", "profile_open", "place_open",
  "event_open", "trip_open", "grid_tile_open", "gems_filter_change",
  "add_to_trip", "directions_tap", "wrong_place_report",
  "upload_start", "processing_complete", "processing_failure", "playback_failure",
  ...MEDIA_NORTH_STAR_EVENT_TYPES,
]);

const batchSchema = z.object({
  events: z.array(
    z.object({
      type:    z.string(),
      payload: z.record(z.unknown()).optional().default({}),
    }),
  ).max(50),
});

router.post("/media/analytics/batch", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) {
    // Non-fatal: analytics must never block the client
    res.json({ ok: true, accepted: 0 });
    return;
  }

  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  let accepted = 0;
  for (const evt of parsed.data.events) {
    if (!VALID_EVENT_TYPES.has(evt.type)) continue;
    // Stamp the authenticated viewer_id — client cannot spoof this
    const payload = { ...evt.payload, viewer_id: user.id };
    recordMediaEvent(evt.type as MediaEventType, payload, sc);
    accepted++;
  }

  res.json({ ok: true, accepted });
}));

export default router;
