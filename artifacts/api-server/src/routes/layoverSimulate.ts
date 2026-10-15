/**
 * Layover time-budget simulation — spec §13 (census-layover L118):
 * *"Changing time-budget chips triggers simulation/replanning, not local visual
 * filtering alone."*
 *
 *   POST /api/airport/sessions/:id/simulate   { budgetMinutes }
 *
 * A SEPARATE ROUTER, like `routes/layoverConstraints.ts`, for the reason that
 * file gives: `routes/airport.ts` is line-anchored by census citations, and a
 * handler there would move every one below it.
 *
 * ── WHAT IT ANSWERS ─────────────────────────────────────────────────────────
 * The plan stops, each banded SAFE / TIGHT / BLOCKED by the SAME pipeline the
 * overview publishes (`mapBandedStops`, exported from routes/airport.ts for
 * this route and nothing else), over the certified record with ONE term
 * narrowed to the chip's budget (`narrowRecordToBudget`), plus the plan's fit
 * under that budget (`certifiedPlanFit`). The certified record is this
 * request's ONE certification — `consumerLayoverRecord ?? certifySessionFeasibility`,
 * exactly as every other layover read takes it. Its usable time is the
 * record's `envelope.usableMinutes` and nothing else: no deadline − now.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 *   404 feature_disabled   airport mode, the chips flag (3785) or the map-bands
 *                          flag (3633) is off — both chip flags are seeded FALSE
 *   400 invalid_payload    `budgetMinutes` is not a whole number 1–1440, or the
 *                          body carries anything else
 *   404 not_found          not this traveller's session
 *   409 conflict           `reason: uncertified | below_floor | above_certified`
 *                          (`mapBudgetRefusal`): a chip can only NARROW the
 *                          certified figure, and only where that is sound
 *   503                    the session, the airport or the stops unreadable
 *
 * ── WHAT IT NEVER DOES ──────────────────────────────────────────────────────
 * It stores nothing: no decision row, no snapshot, no stop write. A simulated
 * band is a hypothetical, not the certified state, so `persistDecision` (which
 * records what the traveller was TOLD as certified) is deliberately not called.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { certifiedPlanFit } from "../services/airport/LayoverConstraints.js";
import { certificationHeader, certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { layoverAirportCountry, resolveLayoverEntry } from "../services/airport/layoverEntryGate.js";
import { getSession } from "../services/airport/LayoverSessionService.js";
import { consumerLayoverRecord, resolveSessionAirport } from "../services/airport/LayoverSnapshot.js";
import {
  MAP_BUDGET_MAX_MIN,
  mapBudgetRefusal,
  narrowRecordToBudget,
  simulationStatement,
} from "../services/airport/layoverMapBudget.js";
import { mapBandedStops, stopsOr503 } from "./airport.js";

const router = Router();

/** One field. `.strict()`: anything else is refused by name rather than ignored. */
export const simulateBodySchema = z
  .object({ budgetMinutes: z.number().int().min(1).max(MAP_BUDGET_MAX_MIN) })
  .strict();

router.post("/airport/sessions/:id/simulate", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(sc, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return; }
  if (!(await isFlagEnabled(sc, "layover_map_budget_chips_enabled")) || !(await isFlagEnabled(sc, "layover_map_bands_enabled"))) {
    sendError(res, "feature_disabled", "Time-budget chips are not switched on.");
    return;
  }

  const parsed = simulateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", `budgetMinutes must be a whole number of minutes from 1 to ${MAP_BUDGET_MAX_MIN}, and nothing else`, { exposeDetail: true });
    return;
  }
  const { budgetMinutes } = parsed.data;

  const read = await getSession(sc, req.params.id, auth.user.id);
  if (!read.ok) { sendError(res, "degraded_unavailable", "Your layover could not be loaded. Please try again."); return; }
  if (!read.session) { sendError(res, "not_found", "Session not found"); return; }
  const session = read.session;
  const resolved = await resolveSessionAirport(sc, session);
  if (!resolved.ok) { sendError(res, "degraded_unavailable", "Your airport's timings could not be loaded. Please try again."); return; }
  const airport = resolved.airport;

  // ONE clock read, for the one certification. Everything below is that record.
  const nowMs = Date.now();
  const record = (await consumerLayoverRecord(sc, airport, session, nowMs))
    ?? certifySessionFeasibility(airport, session, {
      nowMs,
      entry: await resolveLayoverEntry(sc, session.userId, layoverAirportCountry(airport)),
    });

  const refusal = mapBudgetRefusal(record, budgetMinutes);
  if (refusal) {
    sendError(res, refusal.reason === "not_a_budget" ? "invalid_payload" : "conflict", refusal.message, { exposeDetail: true, reason: refusal.reason });
    return;
  }

  const stops = await stopsOr503(sc, res, session.id);
  if (!stops) return;
  const narrowed = narrowRecordToBudget(record, budgetMinutes);
  const banded = await mapBandedStops(sc, airport, narrowed, stops);
  // The bands flag is read again inside the pipeline; a flip between the two
  // reads leaves the stops unbanded, which is not a simulation — refuse it.
  if (banded.some((s) => !("mapBand" in s))) {
    sendError(res, "feature_disabled", "Time-budget chips are not switched on.");
    return;
  }

  res.json({
    ok: true,
    simulation: {
      budgetMinutes,
      certifiedUsableMinutes: record.envelope.usableMinutes,
      stored: false,
      statement: simulationStatement(budgetMinutes, record.envelope.usableMinutes),
    },
    stops: banded,
    planFit: certifiedPlanFit(narrowed, stops),
    // The CERTIFIED record's header — the one the budget narrows, not a new certification.
    certification: certificationHeader(record),
  });
}));

export default router;
