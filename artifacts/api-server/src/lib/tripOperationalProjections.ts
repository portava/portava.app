/**
 * `trip_operational_projections_enabled` — the capability gate for the Trips
 * read projections that need kernel-era schema: §7.3 freedom windows
 * (`trip_commitments`), §17.1 health (`trip_risks`), §11.1 today
 * (`trip_stages`), all on `trips.version`.
 *
 * WHY A FLAG, AND WHY THIS ONE
 * ============================
 * Production does not have 2420/2760-2762 (PRODUCTION-MIGRATED is an owner
 * action). `check:flag-schema-prerequisites` found the defect class the first
 * time these projections were wired: COMPASS_ENABLED is ON in production and
 * Compass's `get_freedom_windows` reached `trip_commitments`, a table
 * production lacks — a tool that reports enabled and fails. The fix is the
 * one the ratchet names: the projections consult a capability of their own,
 * seeded FALSE (2778), so the schema they need belongs to THIS flag's closure
 * and not to Compass's or the crew map's, and turning it on before the
 * migrations land is refused with the migrations named.
 *
 * The gate is a PURE helper in prerequisitesCore's sense: it reads the flag
 * and probes the schema through the capability definition (table names are
 * variables to the scanner), naming no schema of its own. A builder that
 * calls it first is a gate boundary, and its reads belong here.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { probeSchemaReadiness } from "./capability/schemaCapability.js";
import type { CapabilityDefinition, SchemaReadiness } from "./capability/schemaRequirement.js";
import { logger } from "./logger.js";

export const TRIP_OPERATIONAL_PROJECTIONS_FLAG = "trip_operational_projections_enabled";

export const TRIP_OPERATIONAL_PROJECTIONS: CapabilityDefinition = {
  flag: TRIP_OPERATIONAL_PROJECTIONS_FLAG,
  providedBy: [
    "2420_trip_kernel_foundation.sql (trips.version)",
    "2760_trip_stages.sql",
    "2761_trip_legs_and_commitments.sql",
    "2762_trip_goals_decisions_risks.sql",
    "2778_trip_operational_projections_flag.sql (seeds the flag FALSE)",
    "2780_trip_subgroups.sql (trip_subgroups, trip_crew_location_sessions.subgroup_id)",
    "2781_trip_decisions_ledger.sql (trip_decisions)",
    "2784_trip_reservation_history.sql (trip_reservations.version/cancelled_at, trip_reservation_events)",
    "2785_trip_disruptions_and_derived_events.sql (trip_disruptions, trip_commitments.at_risk_*)",
  ],
  requires: {
    tables: {
      trips: { columns: ["id", "version", "timezone"] },
      trip_commitments: { columns: ["id", "trip_id", "type", "starts_at", "required_arrival_at", "place_id", "lateness_tolerance", "prep_duration", "flexibility", "at_risk_reason", "at_risk_at"] },
      trip_risks: { columns: ["id", "trip_id", "likelihood", "impact", "status"] },
      trip_stages: { columns: ["id", "trip_id", "starts_at", "ends_at", "sequence", "state"] },
      // 2780 — read by the closeout (dissolve step) and the crew map (subgroup-scoped live shares).
      trip_subgroups: { columns: ["id", "trip_id", "state"] },
      trip_subgroup_members: { columns: ["subgroup_id", "user_id", "left_at"] },
      trip_crew_location_sessions: { columns: ["id", "trip_id", "status", "subgroup_id"] },
      // 2781 — the persisted decision ledger.
      trip_decisions: { columns: ["decision_id", "trip_id", "decision_type", "calculated_at", "retain_until"] },
      // 2785 — the disruption switch TripHealth consults.
      trip_disruptions: { columns: ["id", "trip_id", "kind", "severity", "state"] },
      // 2784 — §15.4 append-only booking history; routes/tripReservations.ts
      // consults lib/tripReservationHistory.ts, which is this gate.
      trip_reservations: { columns: ["id", "trip_id", "status", "version", "cancelled_at"] },
      trip_reservation_events: { columns: ["id", "reservation_id", "trip_id", "event_type", "version"] },
    },
  },
  // This module IS the consumer: it consults the capability (flag + schema
  // probe) and the three builders — services/trips/TripFreedomProjection.ts,
  // TripHealthProjection.ts, TripTodayProjection.ts — call it first and refuse
  // on its answer. The ratchet's consumer check wants the module that reaches
  // lib/capability, which is this one.
  consumers: ["lib/tripOperationalProjections.ts"],
  note:
    "With the flag ON over a database without trip_commitments / trip_risks / trip_stages, every freedom-window, " +
    "health and today read 42P01s. Refusing answers feature_disabled on the routes and 'not enabled' to Compass, " +
    "which is a true answer on every database; the migrations to apply are named in the refusal. Callers: " +
    "services/trips/TripFreedomProjection.ts, TripHealthProjection.ts, TripTodayProjection.ts, TripCloseoutService.ts, " +
    "TripDecisionLedger.ts, services/tripCrew/TripCrewLocationService.ts (subgroup-scoped shares). One gate for the whole " +
    "2760–2785 batch on purpose: the batch ships together, and a database with half of it is a database this flag must refuse.",
};

export type TripOperationalGate =
  | { enabled: true }
  | { enabled: false; reason: "flag_off" | "schema_missing" | "schema_unknown"; schema: SchemaReadiness | null };

const log = logger.child({ mod: "tripOperationalProjections" });
const TTL_MS = 30_000;
let _cache: { sc: unknown; gate: TripOperationalGate; at: number } | null = null;

/** Test hook. */
export function invalidateTripOperationalProjectionsGate(): void { _cache = null; }

export async function tripOperationalProjectionsGate(sc: any): Promise<TripOperationalGate> {
  if (_cache && _cache.sc === sc && Date.now() - _cache.at < TTL_MS) return _cache.gate;
  let gate: TripOperationalGate;
  if (!(await isFlagEnabled(sc, TRIP_OPERATIONAL_PROJECTIONS_FLAG))) {
    gate = { enabled: false, reason: "flag_off", schema: null };
  } else {
    const schema = await probeSchemaReadiness(sc, TRIP_OPERATIONAL_PROJECTIONS);
    if (schema.state === "ready") gate = { enabled: true };
    else {
      gate = { enabled: false, reason: schema.state === "missing" ? "schema_missing" : "schema_unknown", schema };
      log.error(
        { capability: TRIP_OPERATIONAL_PROJECTIONS_FLAG, schemaState: schema.state, missing: schema.missing, errorCode: schema.errorCode, providedBy: TRIP_OPERATIONAL_PROJECTIONS.providedBy },
        `capability ${TRIP_OPERATIONAL_PROJECTIONS_FLAG} is ON but its schema is ${schema.state === "missing" ? "ABSENT" : "UNVERIFIABLE"} — the operational projections are refused. ${TRIP_OPERATIONAL_PROJECTIONS.note}`,
      );
    }
  }
  _cache = { sc, gate, at: Date.now() };
  return gate;
}

/**
 * The builder-level refusal for a closed gate. `flag_off` and `schema_missing`
 * are FEATURE_DISABLED — a true, stable answer (the routes say
 * feature_disabled, Compass says "not enabled"). `schema_unknown` is a probe
 * that could not answer — a read that failed — and is
 * TRIP_PROJECTION_UNAVAILABLE, retryable, exactly as a failed read inside the
 * builder would be. Conflating the two would tell a client to stop asking
 * when the truth is "ask again".
 */
export function refusalForGate(gate: Exclude<TripOperationalGate, { enabled: true }>): { ok: false; reason: "FEATURE_DISABLED" | "TRIP_PROJECTION_UNAVAILABLE"; message: string } {
  return { ok: false, reason: gate.reason === "schema_unknown" ? "TRIP_PROJECTION_UNAVAILABLE" : "FEATURE_DISABLED", message: describeOperationalGate(gate) };
}

/** The message a refusal carries; names the migrations when the schema is what is missing. */
export function describeOperationalGate(gate: Exclude<TripOperationalGate, { enabled: true }>): string {
  if (gate.reason === "flag_off") return `${TRIP_OPERATIONAL_PROJECTIONS_FLAG} is off`;
  return `${TRIP_OPERATIONAL_PROJECTIONS_FLAG} is on but its schema is ${gate.reason === "schema_missing" ? "absent" : "unverifiable"}` +
    (gate.schema?.missing?.length ? ` (${gate.schema.missing.join(", ")})` : "") +
    `; apply ${TRIP_OPERATIONAL_PROJECTIONS.providedBy.join(", ")} or turn the flag off`;
}
