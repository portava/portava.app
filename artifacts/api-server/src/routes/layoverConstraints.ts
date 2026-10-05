/**
 * Layover constraints — spec §18 `updateConstraint(sessionId, patch)` on the wire.
 *
 *   GET /api/airport/sessions/:id/constraints   what is declared, what the gate
 *                                               makes of it, the one question
 *   PUT /api/airport/sessions/:id/constraints   declare or re-declare
 *
 * A SEPARATE ROUTER, like `routes/layoverEvents.ts`, for the reason that file
 * gives: `routes/airport.ts` is line-anchored by ~170 census citations, and two
 * handlers there would move every one below them.
 *
 * ── THE FOUR ANSWERS A READ CAN GIVE, AND THE ONE IT NEVER GIVES ────────────
 *   200  the declared set (or `constraints: null` — the store was read and
 *        holds nothing), the certified gate and the lifecycle state
 *   404  not this traveller's session
 *   503  the session, the airport or the declared set could not be READ
 *   …and never a 200 that reports an unreadable store as "nothing declared".
 *   `layover_constraints` unreadable is a 503 here even though every OTHER
 *   layover endpoint keeps answering (with the cautious arithmetic): this is
 *   the one surface whose whole content is the thing that could not be read.
 *
 * ── A DECLARATION IS TOLD TO THE TRAVELLER, SO IT IS RECORDED ───────────────
 * PUT publishes the certified answer the declaration produced, so it goes
 * through `persistDecision` exactly as `GET /:id/safety` does — awaited, never
 * able to fail the response, and three-valued on the wire.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import { BAGGAGE_MODES, type ConstraintPatch, type DeclarableField } from "../services/airport/LayoverConstraints.js";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { layoverAirportCountry, resolveLayoverEntry } from "../services/airport/layoverEntryGate.js";
import { getSession, type LayoverSession } from "../services/airport/LayoverSessionService.js";
import { consumerLayoverRecord, resolveSessionAirport } from "../services/airport/LayoverSnapshot.js";
import {
  constraintsPayload,
  declareLayoverConstraints,
  readLandsidePlan,
  type ConstraintStorage,
  type DeclareRefusal,
} from "../services/layover/LayoverConstraintService.js";
import { readConstraintFlags } from "../services/layover/LayoverConstraintStore.js";
import { persistDecision } from "../services/layover/LayoverDecisionStore.js";

const router = Router();

/**
 * The declarable fields, and nothing else. `.strict()`: a field this route
 * cannot keep (a mobility profile, a terminal) is REFUSED by name rather than
 * accepted and dropped — an edit that reports ok and changes nothing is the
 * defect `PATCH /sessions/:id` had with its `*Local` fields.
 */
export const constraintPatchSchema = z
  .object({
    baggageMode: z.enum(BAGGAGE_MODES).optional(),
    recheckRequired: z.boolean().nullable().optional(),
    airportChangeRequired: z.boolean().nullable().optional(),
  })
  .strict();

const UNREADABLE = "Your bag and connection details could not be loaded. Please try again.";

/** Flag on, session owned, airport resolved — or the reply already sent. */
async function ownedSessionAndAirport(
  req: any,
  res: any,
): Promise<{ sc: any; userId: string; session: LayoverSession; airport: AirportProfile } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return null; }
  if (!(await isFlagEnabled(sc, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return null; }

  const read = await getSession(sc, req.params.id, auth.user.id);
  if (!read.ok) {
    sendError(res, "degraded_unavailable", "Your layover could not be loaded. Please try again.");
    return null;
  }
  if (!read.session) { sendError(res, "not_found", "Session not found"); return null; }

  const resolved = await resolveSessionAirport(sc, read.session);
  if (!resolved.ok) {
    sendError(res, "degraded_unavailable", "Your airport's timings could not be loaded. Please try again.");
    return null;
  }
  return { sc, userId: auth.user.id, session: read.session, airport: resolved.airport };
}

router.get("/airport/sessions/:id/constraints", asyncHandler(async (req, res) => {
  const ctx = await ownedSessionAndAirport(req, res);
  if (!ctx) return;
  const { sc, session, airport } = ctx;

  if (session.constraints?.read === "unreadable") {
    sendError(res, "degraded_unavailable", UNREADABLE);
    return;
  }

  // ONE clock read, for the one certification.
  const nowMs = Date.now();
  const record = (await consumerLayoverRecord(sc, airport, session, nowMs))
    ?? certifySessionFeasibility(airport, session, {
      nowMs,
      entry: await resolveLayoverEntry(sc, session.userId, layoverAirportCountry(airport)),
    });

  res.json(constraintsPayload({ session, record, plan: await readLandsidePlan(sc, session.id) }));
}));

const REFUSAL_CODE: Record<DeclareRefusal, Parameters<typeof sendError>[1]> = {
  nothing_declared: "invalid_payload",
  nothing_storable: "conflict",
  session_closed: "not_found",
  constraints_unreadable: "degraded_unavailable",
  write_failed: "degraded_unavailable",
};

router.put("/airport/sessions/:id/constraints", asyncHandler(async (req, res) => {
  const ctx = await ownedSessionAndAirport(req, res);
  if (!ctx) return;
  const { sc, userId, session, airport } = ctx;

  const parsed = constraintPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid constraint details");
    return;
  }

  const outcome = await declareLayoverConstraints(sc, {
    session,
    airport,
    patch: parsed.data as ConstraintPatch,
    nowMs: Date.now(),
    entry: await resolveLayoverEntry(sc, session.userId, layoverAirportCountry(airport)),
  });
  if (!outcome.ok) {
    sendError(res, REFUSAL_CODE[outcome.reason], outcome.message);
    return;
  }

  // §20 — the traveller is being told a certified answer, so it is written
  // down. A side effect that cannot fail the response; see GET /:id/safety.
  const persisted = await persistDecision(sc, userId, outcome.session.id, outcome.record);

  res.json({
    ...constraintsPayload({
      session: outcome.session,
      record: outcome.record,
      plan: await readLandsidePlan(sc, outcome.session.id),
    }),
    stored: outcome.stored,
    // Fields the traveller sent that this storage posture could not keep. Empty
    // is the norm; non-empty must be SAID, not swallowed.
    unsaved: outcome.unsaved,
    sessionSynced: outcome.sessionSynced,
    persisted: persisted.ok
      ? { state: persisted.state, unwritten: persisted.unwritten }
      : { state: "not_stored" as const, reason: persisted.reason },
  });
}));

/** What `POST /airport/sessions` reports about the constraints it was given. */
export type CreationConstraints =
  | { stored: ConstraintStorage; version: number | null; unsaved: DeclarableField[]; sessionSynced: boolean }
  | { stored: "not_stored"; reason: DeclareRefusal | "airport_unreadable"; message: string; retryable: boolean };

/**
 * The constraint fields a traveller sent WITH a new session.
 *
 * Returns `{}` when they sent none — the create response is then exactly what
 * it was. Never throws and never fails the create, which has committed: the
 * session row already carries the conservative `checked_bags` for the mode
 * (`baggageChargesBags`), so a declaration that could not be stored still
 * leaves the arithmetic on the cautious side, and the response says which it
 * was.
 */
export async function declareConstraintsAtCreation(
  sc: any,
  session: LayoverSession,
  body: ConstraintPatch,
): Promise<{ constraints?: CreationConstraints }> {
  const patch: ConstraintPatch = {
    ...(body.baggageMode !== undefined ? { baggageMode: body.baggageMode } : {}),
    ...(body.recheckRequired !== undefined ? { recheckRequired: body.recheckRequired } : {}),
    ...(body.airportChangeRequired !== undefined ? { airportChangeRequired: body.airportChangeRequired } : {}),
  };
  const stated = (Object.keys(patch) as DeclarableField[]);
  if (stated.length === 0) return {};

  const flags = await readConstraintFlags(sc);
  if (!flags.storage) {
    // Nothing to append and nothing to mirror: the INSERT that created the
    // session wrote the conservative boolean already.
    return {
      constraints: {
        stored: "session_booleans_only",
        version: null,
        unsaved: stated.filter((f) => f !== "baggageMode"),
        sessionSynced: true,
      },
    };
  }

  const resolved = await resolveSessionAirport(sc, session);
  if (!resolved.ok) {
    return {
      constraints: {
        stored: "not_stored",
        reason: "airport_unreadable",
        message: "Your bag and connection details could not be saved yet. Open your layover and set them there.",
        retryable: true,
      },
    };
  }
  const outcome = await declareLayoverConstraints(sc, {
    session,
    airport: resolved.airport,
    patch,
    nowMs: Date.now(),
    entry: await resolveLayoverEntry(sc, session.userId, layoverAirportCountry(resolved.airport)),
  });
  if (!outcome.ok) {
    return { constraints: { stored: "not_stored", reason: outcome.reason, message: outcome.message, retryable: outcome.retryable } };
  }
  return {
    constraints: {
      stored: outcome.stored,
      version: outcome.set?.version ?? null,
      unsaved: outcome.unsaved,
      sessionSynced: outcome.sessionSynced,
    },
  };
}

/**
 * `PATCH /airport/sessions/:id` and the constraint fields.
 *
 * Returns the sentence to refuse with, or null. Two cases:
 *   - the patch names a declarable field: those are edited here, not there,
 *     and that route would otherwise accept the key and drop it;
 *   - the patch edits `checkedBags` while a declared set exists: the boolean
 *     would change and the arithmetic would not, because the declared mode
 *     governs. An edit that reports ok and changes nothing is refused instead.
 */
export function sessionPatchConstraintRefusal(
  patch: { baggageMode?: unknown; recheckRequired?: unknown; airportChangeRequired?: unknown; checkedBags?: unknown },
  current: Pick<LayoverSession, "constraints">,
): string | null {
  if (patch.baggageMode !== undefined || patch.recheckRequired !== undefined || patch.airportChangeRequired !== undefined) {
    return "Bag and connection details are changed with PUT /airport/sessions/:id/constraints.";
  }
  if (patch.checkedBags !== undefined && current.constraints?.read === "declared") {
    return "This layover has declared bag details, so checkedBags is no longer edited directly — use PUT /airport/sessions/:id/constraints.";
  }
  return null;
}

export default router;
