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
  return proj;
}
