/** 2745 must exist before a measured/stated route can be persisted and served as such. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { probeSchemaReadiness } from "../../lib/capability/schemaCapability.js";
import { logger } from "../../lib/logger.js";

export async function canPersistTravelProvenance(db: SupabaseClient): Promise<boolean> {
  const readiness = await probeSchemaReadiness(db, LAYOVER_TRAVEL_PROVENANCE_SCHEMA);
  if (readiness.state === "ready") return true;
  logger.warn({ readiness }, "Layover routed recommendations unavailable: travel provenance schema not ready");
  return false;
}

/** census-trips follow-up hotfix (2026-10-24): exported so test/db/capabilityProbeColumns.db.test.ts runs this probe on the replayed chain. */
export const LAYOVER_TRAVEL_PROVENANCE_SCHEMA: CapabilityDefinition = {
    // Cache identity only; readiness is independent of feature-flag rollout intent.
    flag: "schema:layover-travel-provenance:2745:v1",
    providedBy: ["2745_layover_recommendation_travel_provenance.sql"],
    consumers: ["services/airport/LayoverRecommendationService.ts"],
    note: "A routed figure must retain its explicit provenance on the stored recommendation.",
    requires: { tables: { layover_recommendations: { columns: ["id", "travel_time_source"] } } },
  };
import type { CapabilityDefinition } from "../../lib/capability/schemaRequirement.js";
