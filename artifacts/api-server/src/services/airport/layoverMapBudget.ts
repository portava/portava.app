/**
 * layoverMapBudget — spec §13's TIME-BUDGET CHIPS (census-layover L118):
 * *"Changing time-budget chips triggers simulation/replanning, not local visual
 * filtering alone."*
 *
 * A chip asks the SERVER one question — "what if my usable time were only B
 * minutes?" — and the answer is the §13 map-band pipeline the overview already
 * runs (`mapBandedStops` in routes/airport.ts: the envelope's geometric band,
 * the certified plan fit, `mapBandForStop`) over the certified record with ONE
 * term narrowed: `envelope.usableMinutes := B`. Nothing is re-derived, nothing
 * is stored, and the deadline, the gate and the verdict are the record's own.
 * The route is `POST /airport/sessions/:id/simulate` (routes/layoverSimulate.ts).
 *
 * ── A CHIP CAN ONLY NARROW, AND ONLY WHERE NARROWING ONE TERM IS SOUND ──────
 *   record unreadable (usable time not a finite, non-negative whole number)
 *                                 → REFUSED `uncertified`. Nothing is banded.
 *   B above the certified figure  → REFUSED `above_certified`, with the figure.
 *                                   A chip may never widen what was certified.
 *   B below LANDSIDE_AVAILABLE_FLOOR_MIN (90)
 *                                 → REFUSED `below_floor`. Below that floor the
 *                                   engine's own verdict changes category
 *                                   (`adviseLeaving`: tight at 45–89, no under
 *                                   45) and the landside gate with it, so a
 *                                   record narrowed in ONE term would carry a
 *                                   gate the engine would not certify for that
 *                                   window. At or above the floor, the verdict,
 *                                   the tier and the gate are the ones the
 *                                   engine certifies at the record's figure —
 *                                   `layoverMapBudget.test.ts` pins that by
 *                                   comparing the simulation with a session
 *                                   CERTIFIED at exactly B.
 *
 * ── WHEN CHIPS ARE OFFERED (`GET /overview` → `mapBudgetChips`) ─────────────
 * Only behind BOTH `layover_map_budget_chips_enabled` (3785, seeded FALSE) and
 * `layover_map_bands_enabled` (3633, seeded FALSE): with the chip flag off the
 * overview carries no key at all. On, they are withheld — with the reason —
 * when the record is unreadable, the landside gate is CLOSED (every landside
 * stop is BLOCKED at any budget; §13 also says to suppress exploration-first
 * affordances when the traveller cannot or must not be out), there is no stop
 * outside the airport to band, or no rung of the ladder is below the certified
 * figure. The ladder is a product choice (owner question OQ-L118-1).
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { landsideStatusOf, type LandsideGate } from "./LayoverConstraints.js";
import { LANDSIDE_AVAILABLE_FLOOR_MIN } from "./LayoverLifecycle.js";
import type { LeaveAdvice } from "./LayoverSafetyEngine.js";

/** The floor below which no budget is simulated. NOT A NEW NUMBER — see the header. */
export const MAP_BUDGET_FLOOR_MIN = LANDSIDE_AVAILABLE_FLOOR_MIN;

/** The budgets a chip may offer, ascending (OQ-L118-1). Each is offered only below the certified figure. */
export const MAP_BUDGET_LADDER_MIN = [90, 120, 180, 240, 360, 480] as const;

/** The largest budget the route will parse — a day. Anything above any certified figure is refused anyway. */
export const MAP_BUDGET_MAX_MIN = 1440;

export const MAP_BUDGET_CHIPS_WITHHELD = [
  "map_bands_off",
  "uncertified",
  "landside_closed",
  "no_landside_stop",
  "nothing_to_narrow",
] as const;
export type MapBudgetChipsWithheld = (typeof MAP_BUDGET_CHIPS_WITHHELD)[number];

/** What `GET /overview` publishes as `mapBudgetChips` while the chip flag is ON. */
export interface MapBudgetChips {
  available: boolean;
  /** Why the chips are not offered; `null` exactly when they are. */
  withheld: MapBudgetChipsWithheld | null;
  /** The record's own `envelope.usableMinutes` the chips narrow, or `null` when unreadable. */
  certifiedUsableMinutes: number | null;
  /** The budgets offered, ascending: each ≥ the floor and < the certified figure. Empty unless available. */
  budgets: number[];
}

/** The terms of a certified record this module reads. `LayoverFeasibilityRecord` satisfies it. */
export interface MapBudgetRecord {
  envelope: { usableMinutes: number };
  landsideGate: LandsideGate;
  verdict?: LeaveAdvice["verdict"];
}

/** The record's certified usable minutes, or `null` when it is not a readable figure. */
export function certifiedUsableMinutes(record: Pick<MapBudgetRecord, "envelope"> | null | undefined): number | null {
  const m = record?.envelope?.usableMinutes;
  return typeof m === "number" && Number.isInteger(m) && m >= 0 ? m : null;
}

/** The chips a traveller is offered for this record and plan (the flags are read by `mapBudgetChipsField`). */
export function mapBudgetChipsFor(
  record: MapBudgetRecord,
  stops: ReadonlyArray<{ insideAirport?: boolean | null }>,
): MapBudgetChips {
  const certified = certifiedUsableMinutes(record);
  const withheld = (why: MapBudgetChipsWithheld): MapBudgetChips =>
    ({ available: false, withheld: why, certifiedUsableMinutes: certified, budgets: [] });
  if (certified === null) return withheld("uncertified");
  if (landsideStatusOf(record) === "closed") return withheld("landside_closed");
  if (!stops.some((s) => s.insideAirport !== true)) return withheld("no_landside_stop");
  const budgets = MAP_BUDGET_LADDER_MIN.filter((b) => b < certified); // every rung is ≥ the floor (pinned in the test)
  if (budgets.length === 0) return withheld("nothing_to_narrow");
  return { available: true, withheld: null, certifiedUsableMinutes: certified, budgets: [...budgets] };
}

/**
 * The overview's `mapBudgetChips`, spread into the response. Chip flag OFF (the
 * seed) or unreadable: `{}` — the overview is byte-for-byte what it was. ON with
 * the map bands OFF: published, withheld as `map_bands_off`, because a chip has
 * no band to move.
 */
export async function mapBudgetChipsField(
  sc: any,
  record: MapBudgetRecord,
  stops: ReadonlyArray<{ insideAirport?: boolean | null }>,
): Promise<{ mapBudgetChips?: MapBudgetChips }> {
  if (!(await isFlagEnabled(sc, "layover_map_budget_chips_enabled"))) return {};
  if (!(await isFlagEnabled(sc, "layover_map_bands_enabled"))) {
    return { mapBudgetChips: { available: false, withheld: "map_bands_off", certifiedUsableMinutes: certifiedUsableMinutes(record), budgets: [] } };
  }
  return { mapBudgetChips: mapBudgetChipsFor(record, stops) };
}

export const MAP_BUDGET_REFUSALS = ["not_a_budget", "uncertified", "below_floor", "above_certified"] as const;
export type MapBudgetRefusalReason = (typeof MAP_BUDGET_REFUSALS)[number];

export interface MapBudgetRefusal {
  reason: MapBudgetRefusalReason;
  message: string;
  certifiedUsableMinutes: number | null;
}

/** Why `budgetMinutes` may not be simulated against this record, or `null` when it may. */
export function mapBudgetRefusal(record: Pick<MapBudgetRecord, "envelope">, budgetMinutes: number): MapBudgetRefusal | null {
  const certified = certifiedUsableMinutes(record);
  if (!Number.isInteger(budgetMinutes) || budgetMinutes <= 0) {
    return { reason: "not_a_budget", certifiedUsableMinutes: certified, message: "A time budget is a whole number of minutes." };
  }
  if (certified === null) {
    return { reason: "uncertified", certifiedUsableMinutes: null, message: "Your usable time could not be certified, so no time budget can be simulated." };
  }
  if (budgetMinutes > certified) {
    return {
      reason: "above_certified", certifiedUsableMinutes: certified,
      message: `Your certified usable time is ${certified} minutes. A time budget can only narrow it, never widen it.`,
    };
  }
  if (budgetMinutes < MAP_BUDGET_FLOOR_MIN) {
    return {
      reason: "below_floor", certifiedUsableMinutes: certified,
      message: `Below ${MAP_BUDGET_FLOOR_MIN} minutes Portava does not plan a trip out of the airport, so there is nothing to simulate.`,
    };
  }
  return null;
}

/**
 * The record with ONE term narrowed — `envelope.usableMinutes := budgetMinutes`
 * — for the simulation only. Every other field, the deadline and the gate
 * included, is the certified record's own object. Never stored, never
 * published as a record. The caller has already passed `mapBudgetRefusal`.
 */
export function narrowRecordToBudget<R extends { envelope: { usableMinutes: number } }>(record: R, budgetMinutes: number): R {
  return { ...record, envelope: { ...record.envelope, usableMinutes: budgetMinutes } };
}

/** "2 h", "1 h 30 min", "45 min". */
export function budgetLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The sentence the map shows above simulated bands. Server text: the client renders it, never composes it. */
export function simulationStatement(budgetMinutes: number, certified: number): string {
  return `If you had only ${budgetLabel(budgetMinutes)} out of the airport: each band below is read against ${budgetMinutes} usable minutes instead of your certified ${certified}. Your return time does not change, and nothing was saved.`;
}
