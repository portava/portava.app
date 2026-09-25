/**
 * Layover external event ingest — §11's producer door.
 *
 * POST /api/layover/events   — publish one canonical event envelope
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §11 / §11.1 step 1, §23 (validate + deduplicate by stable source key),
 *   §24 (duplicate events). Census-layover L92, L194, L263.
 *
 * ── WHY THIS IS NOT IN routes/airport.ts ─────────────────────────────────────
 * Every route in that file answers a signed-in TRAVELLER about THEIR session,
 * and `requireOwnedSession` is the first line of each one. This route answers a
 * MACHINE — a flight feed, an airport operations feed — about a fact that
 * belongs to no session and no person. The two have different callers,
 * different credentials and different failure modes, and putting them in one
 * router would mean every reader of that file has to hold both in mind.
 *
 * ── AUTHENTICATION IS A PRODUCER SECRET, NOT A USER TOKEN ────────────────────
 * Being signed in as a traveller is NOT authority to publish an airport fact.
 * An external event moves a safety input — `flight.arrival_delayed` shortens a
 * usable window, `airport.security_wait_changed` moves a return deadline — so a
 * caller who can publish one can move somebody else's return deadline. A user
 * JWT would let any account do that.
 *
 * The secret lives in `LAYOVER_EVENT_PRODUCER_SECRET` and is compared with
 * `safeSecretEquals`, which hashes both sides before `timingSafeEqual` so
 * neither content nor length leaks through response timing.
 *
 * WHEN THE VARIABLE IS UNSET THE ROUTE REFUSES EVERYTHING. It does not fall
 * back to "no secret configured, so allow", and it does not compare the header
 * against `undefined` and hope — `safeSecretEquals` returns false for a
 * non-string, but relying on that would make an unset secret look like a
 * working configuration in the logs. The refusal is explicit and says which
 * variable is missing, so a misconfigured deploy reads as misconfigured rather
 * than as a quiet open door.
 *
 * ── THE ORDER OF THE TWO GATES IS DELIBERATE ─────────────────────────────────
 * The secret is checked BEFORE the feature flag. Both refuse, with different
 * codes, so checking the flag first would let an unauthenticated caller read
 * the flag's state off the status code. An unauthenticated caller learns one
 * thing from this route: that it exists.
 *
 * ── A DUPLICATE IS A SUCCESS ─────────────────────────────────────────────────
 * §24 requires that a duplicate event change nothing, not that it be reported
 * as an error. A producer told "409" retries; a producer told
 * `{ ok: true, duplicate: true }` stops. The response says which uniqueness
 * constraint caught it, because a channel that keeps tripping the dedup-key one
 * has a producer minting fresh ids per delivery, and that is worth knowing.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { safeSecretEquals, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";
// The flag name below is written as a STRING LITERAL at its call site, not as
// the imported LAYOVER_EVENT_INGEST_FLAG constant, and replacing it with the
// constant would be a regression. `check:flag-polarity` resolves a flag READ
// only when it can see the literal; `isFlagEnabled(sc, CONSTANT)` reports the
// flag as "SEEDED BUT NEVER READ", which is the shape of a switch an operator
// can toggle while the thing it names keeps happening.
import { ingestExternalEvent } from "../services/layover/LayoverExternalEventService.js";

const router = Router();

/** The header a producer presents. Not `Authorization`: this is not a bearer token. */
export const PRODUCER_SECRET_HEADER = "x-layover-producer-secret";

/**
 * The envelope as it arrives.
 *
 * Deliberately PERMISSIVE. Every real check — the closed eleven-type
 * vocabulary, the per-type payload validators, the future-dated refusal, the
 * subject-ref shape, the confidence band — lives in `normalizeEvent`, which is
 * the one place §11's envelope is defined. A second, stricter schema here would
 * be a second definition of the same shape, and the two would drift.
 *
 * What this DOES do is bound the request: reject a body that is not an object
 * at all, and keep `payload` and `subjectRefs` from being wildly oversized
 * before they reach a validator that would have to walk them.
 */
const ingestSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(64),
  occurredAt: z.string().min(1).max(64),
  source: z.string().min(1).max(128),
  sourceEventId: z.string().max(200).optional(),
  subjectRefs: z.array(z.object({ kind: z.string().max(32), ref: z.string().max(200) })).max(64).optional(),
  payload: z.record(z.unknown()).optional(),
  confidence: z.string().max(16).optional(),
});

/**
 * Why each rejection reason gets its own sentence: a producer integrating
 * against this route reads the body, not the source. `unknown_event_type` and
 * `bad_payload` are the two a new integration hits, and "invalid" tells it
 * nothing about which of the eleven types it misspelled.
 */
const REJECTION_MESSAGE: Record<string, string> = {
  unknown_event_type: "eventType is not one of the eleven types this channel accepts.",
  missing_event_id: "eventId must be a non-empty string.",
  missing_source: "source must be a non-empty string.",
  bad_occurred_at: "occurredAt must be an ISO instant.",
  occurred_in_future: "occurredAt is later than the instant this request arrived. A future-dated event is a clock fault or a forgery, and admitting it would let this producer pre-empt every later real event.",
  no_subject: "subjectRefs must name at least one subject of kind airport, session, flight, route or user.",
  bad_payload: "payload failed the validator for this eventType.",
  bad_confidence: "confidence must be INSUFFICIENT, LOW, MEDIUM or HIGH.",
};

router.post("/layover/events", asyncHandler(async (req, res) => {
  // ── gate 1: the producer secret, before anything else ──────────────────────
  const expected = process.env.LAYOVER_EVENT_PRODUCER_SECRET;
  if (typeof expected !== "string" || expected.length === 0) {
    logger.warn(
      {},
      "layover event ingest called with LAYOVER_EVENT_PRODUCER_SECRET unset — refusing; an unset secret is a misconfiguration, not an open door",
    );
    sendError(res, "degraded_unavailable", "This channel is not configured to accept events.");
    return;
  }
  if (!safeSecretEquals(req.get(PRODUCER_SECRET_HEADER), expected)) {
    sendError(res, "unauthenticated", "Producer credential missing or incorrect.");
    return;
  }

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "degraded_unavailable", "Storage is unavailable, so this event was not accepted. Retry.");
    return;
  }

  // ── gate 2: the capability flag, seeded FALSE by migration 2981 ────────────
  if (!(await isFlagEnabled(sc, "layover_event_ingest_enabled"))) {
    sendError(res, "degraded_unavailable", "Event ingest is not open.");
    return;
  }

  const parsed = ingestSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid event envelope");
    return;
  }

  // `Date.now()` is read ONCE and threaded through, rather than being read
  // again inside the service. Two reads would let `received_at` and the bound
  // `occurredAt` is judged against disagree, and the table's
  // `layover_external_events_not_future` CHECK would then refuse an event the
  // normaliser had just accepted.
  const result = await ingestExternalEvent(sc, parsed.data, Date.now());

  if (!result.ok) {
    if (result.kind === "rejected") {
      sendError(
        res,
        "invalid_payload",
        REJECTION_MESSAGE[result.reason] ?? `This event was refused: ${result.reason}.`,
      );
      return;
    }
    sendError(res, "db_error", result.message);
    return;
  }

  res.json({
    ok: true,
    eventId: result.event.eventId,
    dedupKey: result.event.dedupKey,
    // TRUE when the event was already stored. This is a SUCCESS: §24 requires a
    // duplicate to change nothing, and a producer shown an error here would
    // retry a delivery that had already landed.
    duplicate: result.duplicate,
    duplicateKind: result.duplicateKind,
  });
}));

export default router;
