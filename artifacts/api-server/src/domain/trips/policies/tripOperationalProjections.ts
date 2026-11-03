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
import { isFlagEnabled, readFlagState } from "../../../lib/featureFlags.js";
import { probeSchemaReadiness } from "../../../lib/capability/schemaCapability.js";
import type { CapabilityDefinition, SchemaReadiness } from "../../../lib/capability/schemaRequirement.js";
import { logger } from "../../../lib/logger.js";

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
    "2794_trip_meeting_checkpoints.sql (trip_meeting_checkpoints, trip_meeting_checkpoint_participants, safe_return_sessions.subgroup_id)",
  ],
  requires: {
    tables: {
      trips: { columns: ["id", "version", "timezone"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      trip_commitments: { columns: ["id", "trip_id", "type", "starts_at", "required_arrival_at", "place_id", "lateness_tolerance", "prep_duration", "flexibility", "at_risk_reason", "at_risk_at"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      trip_risks: { columns: ["id", "trip_id", "likelihood", "impact", "status"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      trip_stages: { columns: ["id", "trip_id", "starts_at", "ends_at", "sequence", "state"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      // 2780 — read by the closeout (dissolve step) and the crew map (subgroup-scoped live shares).
      trip_subgroups: { columns: ["id", "trip_id", "state"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      trip_subgroup_members: { columns: ["subgroup_id", "user_id", "left_at"], probe: { column: "subgroup_id", value: SCHEMA_PROBE_SENTINEL_ID } },
      // 2794 — §10.4 meeting checkpoints; read by health, Today, the map and the offline bundle.
      trip_meeting_checkpoints: { columns: ["id", "trip_id", "subgroup_id", "label", "lat", "lng", "meet_at", "purpose", "status"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      trip_meeting_checkpoint_participants: { columns: ["checkpoint_id", "user_id", "arrival_state", "arrived_at"], probe: { column: "checkpoint_id", value: SCHEMA_PROBE_SENTINEL_ID } },
      trip_crew_location_sessions: { columns: ["id", "trip_id", "status", "subgroup_id"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      // 2781 — the persisted decision ledger.
      trip_decisions: { columns: ["decision_id", "trip_id", "decision_type", "calculated_at", "retain_until"], probe: { column: "decision_id", value: SCHEMA_PROBE_SENTINEL_ID } },
      // 2785 — the disruption switch TripHealth consults.
      trip_disruptions: { columns: ["id", "trip_id", "kind", "severity", "state"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      // 2784 — §15.4 append-only booking history; routes/tripReservations.ts
      // consults domain/trips/events/tripReservationHistory.ts, which is this gate.
      trip_reservations: { columns: ["id", "trip_id", "status", "version", "cancelled_at"], probe: { column: "id", value: SCHEMA_PROBE_SENTINEL_ID } },
      trip_reservation_events: { columns: ["id", "reservation_id", "trip_id", "event_type", "version"], probe: { column: "id", value: "-1" } }, // a BIGINT key (2784): the uuid sentinel is 22P02 here
    },
  },
  // This module IS the consumer: it consults the capability (flag + schema
  // probe) and the three builders — domain/trips/projections/TripFreedomProjection.ts,
  // TripHealthProjection.ts, TripTodayProjection.ts — call it first and refuse
  // on its answer. The ratchet's consumer check wants the module that reaches
  // lib/capability, which is this one.
  consumers: ["domain/trips/policies/tripOperationalProjections.ts"],
  note:
    "With the flag ON over a database without trip_commitments / trip_risks / trip_stages, every freedom-window, " +
    "health and today read 42P01s. Refusing answers feature_disabled on the routes and 'not enabled' to Compass, " +
    "which is a true answer on every database; the migrations to apply are named in the refusal. Callers: " +
    "domain/trips/projections/TripFreedomProjection.ts, TripHealthProjection.ts, TripTodayProjection.ts, TripCloseoutService.ts, " +
    "TripDecisionLedger.ts, domain/trips/services/TripCrewLocationService.ts (subgroup-scoped shares). One gate for the whole " +
    "2760–2785 batch on purpose: the batch ships together, and a database with half of it is a database this flag must refuse.",
};

export type TripOperationalGate =
  | { enabled: true }
  | { enabled: false; reason: "flag_off" | "flag_unknown" | "schema_missing" | "schema_unknown"; schema: SchemaReadiness | null };

const log = logger.child({ mod: "tripOperationalProjections" });
const TTL_MS = 30_000;
let _cache: { sc: unknown; gate: TripOperationalGate; at: number } | null = null;

/** Test hook. */
export function invalidateTripOperationalProjectionsGate(): void { _cache = null; }

export async function tripOperationalProjectionsGate(sc: any): Promise<TripOperationalGate> {
  if (_cache && _cache.sc === sc && Date.now() - _cache.at < TTL_MS) return _cache.gate;
  let gate: TripOperationalGate;
  // The flag is read TRI-STATE (fix to #803, verifier finding 1): "off" and
  // "could not be read" are different answers. A caller that falls back to a
  // destructive legacy path when the flag is off (DELETE
  // /trips/:tripId/reservations/:id hard-deletes) must not take that path
  // because the feature_flags read failed. An unreadable flag is `flag_unknown` — closed, retryable, NOT cached. "off" needs
  // isFlagEnabled's false AND readFlagState's "off" (isFlagEnabled stays the read site check:flag-schema-prerequisites counts).
  const flagState: "on" | "off" | "unknown" = (await isFlagEnabled(sc, TRIP_OPERATIONAL_PROJECTIONS_FLAG)) ? "on" : (await readFlagState(sc, TRIP_OPERATIONAL_PROJECTIONS_FLAG)) === "off" ? "off" : "unknown";
  if (flagState === "unknown") {
    log.error({ capability: TRIP_OPERATIONAL_PROJECTIONS_FLAG }, `capability ${TRIP_OPERATIONAL_PROJECTIONS_FLAG} could not be read — the operational projections are refused (retryably)`);
    return { enabled: false, reason: "flag_unknown", schema: null };
  }
  if (flagState === "off") {
    return { enabled: false, reason: "flag_off", schema: null }; // NOT cached (fix to #803, re-verification): `flag_off` authorises DELETE's hard delete, so it is re-read every time (one PK lookup) — a cached OFF must not survive an OFF→ON toggle into a destroyed row
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
 * when the truth is "ask again". `flag_unknown` (the flag itself could not be
 * read) is the same kind of answer as `schema_unknown`: retryable.
 */
export function refusalForGate(gate: Exclude<TripOperationalGate, { enabled: true }>): { ok: false; reason: "FEATURE_DISABLED" | "TRIP_PROJECTION_UNAVAILABLE"; message: string } {
  return { ok: false, reason: gate.reason === "schema_unknown" || gate.reason === "flag_unknown" ? "TRIP_PROJECTION_UNAVAILABLE" : "FEATURE_DISABLED", message: describeOperationalGate(gate) };
}

/** The message a refusal carries; names the migrations when the schema is what is missing. */
export function describeOperationalGate(gate: Exclude<TripOperationalGate, { enabled: true }>): string {
  if (gate.reason === "flag_off") return `${TRIP_OPERATIONAL_PROJECTIONS_FLAG} is off`;
  if (gate.reason === "flag_unknown") return `${TRIP_OPERATIONAL_PROJECTIONS_FLAG} could not be read just now; try again`;
  return `${TRIP_OPERATIONAL_PROJECTIONS_FLAG} is on but its schema is ${gate.reason === "schema_missing" ? "absent" : "unverifiable"}` +
    (gate.schema?.missing?.length ? ` (${gate.schema.missing.join(", ")})` : "") +
    `; apply ${TRIP_OPERATIONAL_PROJECTIONS.providedBy.join(", ")} or turn the flag off`;
}

// census-trips (hotfix 2026-10-24): every table above DECLARES the key column its readiness probe filters on. The
// default (`id`) is absent from trip_decisions (keyed decision_id), trip_subgroup_members (subgroup_id, user_id) and
// trip_meeting_checkpoint_participants (checkpoint_id, user_id), so PostgREST answered 42703 to `.eq("id", …)`; and
// trip_reservation_events' `id` is a BIGINT, so the uuid sentinel answered 22P02. Either way the gate could never open: with trip_operational_projections_enabled ON in production since 2026-10-23, every operational
// read still refused. test/db/capabilityProbeColumns.db.test.ts runs every capability's probe filter on the replayed chain
// and fails on any answer but "no row" (a missing column, a type the probe value cannot take, a missing table).
import { SCHEMA_PROBE_SENTINEL_ID } from "../../../lib/capability/schemaRequirement.js";
