/** Read-only readiness checks for independently pressed curation schema.
 * The namespaced `flag` slots are cache identities only: this module calls
 * probeSchemaReadiness, never resolveCapability or a feature-flag reader.
 * Missing and unreadable schema both refuse feature queries; no probe runs RPCs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { probeSchemaReadiness } from "../../lib/capability/schemaCapability.js";
import { SCHEMA_PROBE_SENTINEL_ID, type CapabilityDefinition } from "../../lib/capability/schemaRequirement.js";

const CURATION_SCHEMA: CapabilityDefinition = {
  flag: "schema:airport-curation:3874-3881:v2",
  providedBy: ["3874_airport_curation_provenance_ttl.sql", "3881_airport_sourced_timing.sql"],
  consumers: ["services/airport/airportCuration.ts"],
  note: "Curation reads and transitions require the complete provenance workflow schema.",
  requires: {
    tables: {
      airport_curated_facts: { columns: ["id", "airport_id", "fact_kind", "fact_class", "version", "value", "source_kind", "source_url", "source_title", "source_note", "retrieved_at", "expires_at", "state", "proposed_via", "proposed_by", "proposed_at", "validation_report", "validated_by", "validated_at", "published_by", "published_at", "rejected_by", "rejected_at", "rejection_reason", "superseded_at", "superseded_by_fact_id", "retracted_by", "retraction_reason"] },
      airport_profiles: { columns: ["id", "legacy_verified", "curated_timing_fact_id", "curated_timing_expires_at", "curated_topology_fact_id", "curated_topology_expires_at", "curated_transport_fact_id", "curated_transport_expires_at", "topology_version", "topology_changed_at", "facts_provenance", "curated_timing_evidence"] },
    },
    functions: ["airport_curation_publish", "airport_curation_retract"],
  },
};
const CALIBRATION_SCHEMA: CapabilityDefinition = {
  flag: "schema:airport-calibration:3880:v1",
  providedBy: ["3880_airport_time_band_calibration.sql"],
  consumers: ["services/airport/layoverCalibration.ts"],
  note: "Calibration cannot read or write a partially available time-band projection.",
  requires: {
    tables: {
      airport_time_band_calibrations: { columns: ["id", "airport_id", "fact_type", "local_hour", "calibrated_p90_minutes", "superseded_at"] },
      airport_profiles: { columns: ["id", "calibrated_checkpoint_extra", "calibration_expires_at", "calibration_version"] },
    },
    functions: ["airport_calibration_apply"],
  },
};
const OUTCOME_SCHEMA: CapabilityDefinition = {
  flag: "schema:airport-calibration-outcomes:2992:v1",
  providedBy: ["2700_layover_certified_feasibility.sql", "2992_layover_decision_record_and_operational_tables.sql"],
  consumers: ["services/airport/layoverCalibration.ts"],
  note: "Outcome evidence is unavailable until both measured outcomes and certified predictions exist.",
  requires: { tables: {
    layover_outcomes: { columns: ["session_id", "actual_airport_return_at", "boarding_outcome", "left_airport"], probe: { column: "session_id", value: SCHEMA_PROBE_SENTINEL_ID } },
    layover_certified_computations: { columns: ["id", "session_id", "hard_return_time", "computed_at"] },
  } },
};

export function airportCurationSchemaReadiness(db: SupabaseClient) {
  return probeSchemaReadiness(db, CURATION_SCHEMA);
}
export function airportCalibrationSchemaReadiness(db: SupabaseClient) {
  return probeSchemaReadiness(db, CALIBRATION_SCHEMA);
}
export function airportOutcomeSchemaReadiness(db: SupabaseClient) {
  return probeSchemaReadiness(db, OUTCOME_SCHEMA);
}
