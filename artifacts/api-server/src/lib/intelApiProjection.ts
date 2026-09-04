/**
 * Intelligence Gathering — internal API field projection (IG-10, spec §22 field
 * licensing registry).
 *
 * "Only fields with explicit redistribution permission may leave Portava … the
 * API's durable advantage must be Portava-owned claims, outcomes and derived
 * aggregates." This module is the field-level enforcement: given an intel row, it
 * returns ONLY the columns whose ownership class is redistributable
 * (lib/dataRights), and for a live-state snapshot it additionally refuses to
 * project anything that is not privacy-eligible or has expired.
 *
 * SCOPE BOUNDARY. This decides WHICH FIELDS are eligible if egress is permitted;
 * it never decides WHETHER egress happens. External egress is a separate switch
 * (intel_external_api) held under Portava's control — issuing an external
 * credential is out of scope here. With that flag off, internal reads use this
 * projection; nothing leaves the building.
 *
 * RUNTIME EFFECT: NONE on its own — pure functions.
 */
import { redistributableFields, mayRedistribute } from "./dataRights.js";
import { sourceCountBucket } from "./liveClaimRead.js";
import { normalizeConflictState, capForConflict, conflictBlock } from "./intelConflict.js";
import { confidenceBand, CONFIDENCE_BANDS, type ConfidenceBand } from "./intelContracts.js";

/** Project a row to only its redistributable columns (fail-closed on unknowns). */
export function projectRedistributable(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of redistributableFields(table)) {
    if (Object.prototype.hasOwnProperty.call(row, f.column)) out[f.column] = row[f.column];
  }
  return out;
}

/**
 * Project a live-state snapshot for the API. Returns null (nothing leaves) unless
 * the snapshot is privacy-eligible AND unexpired. `expires_at` is always carried
 * when present — redistributing live state without its expiry invites a consumer
 * to cache it indefinitely (spec §22 note on intel_state_snapshots.expires_at).
 */
export function projectSnapshotForApi(
  row: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): Record<string, unknown> | null {
  if (!row) return null;
  if (row.privacy_eligible !== true) return null; // never redistribute an ineligible aggregate
  const exp = row.expires_at;
  if (typeof exp === "string") {
    const t = Date.parse(exp);
    if (Number.isFinite(t) && t <= now.getTime()) return null; // expired ⇒ not live ⇒ not served
  }
  const proj = projectRedistributable("intel_state_snapshots", row);
  // Defence in depth: an id or actor field must never appear in the projection.
  if (mayRedistribute("intel_state_snapshots", "distinct_actors")) {
    // Registry drift guard — distinct_actors must remain non-redistributable.
    delete proj["distinct_actors"];
  }
  // source_count is stored as the EXACT distinct-actor count, so redistributing
  // it verbatim leaks the precise k-anon cohort size that distinct_actors is
  // restricted for. The registry permits it "above threshold only", so emit the
  // coarse bucket (few/several/many) — the same value the client read path
  // exposes — and drop the exact number.
  if (typeof proj["source_count"] === "number") {
    proj["source_count_bucket"] = sourceCountBucket(proj["source_count"] as number);
    delete proj["source_count"];
  }
  // §10: "prevent high-confidence external API output" under a material
  // conflict. Normalise the stored state (NULL/pre-2275 ⇒ 'none'; unknown ⇒
  // material, fail-closed), cap the confidence + band below the live band the
  // same way the user-facing read does, and attach the counts-only conflict
  // block so a consumer sees WHY the confidence is capped. Only ever lowers.
  const conflictState = normalizeConflictState(row.conflict_state);
  const rawConfidence = typeof proj["confidence"] === "number" ? (proj["confidence"] as number) : null;
  const storedBand = proj["confidence_band"];
  const rawBand = (CONFIDENCE_BANDS as readonly string[]).includes(storedBand as string)
    ? (storedBand as ConfidenceBand)
    : confidenceBand(rawConfidence);
  const capped = capForConflict(conflictState, rawConfidence, rawBand);
  if (rawConfidence !== null) proj["confidence"] = capped.confidence;
  if (proj["confidence_band"] !== undefined) proj["confidence_band"] = capped.band;
  proj["conflict_state"] = conflictState;
  const lastUpdated = typeof row.computed_at === "string" ? row.computed_at
    : typeof row.observed_at === "string" ? row.observed_at : now.toISOString();
  proj["conflict"] = conflictBlock(conflictState, lastUpdated);
  return proj;
}
