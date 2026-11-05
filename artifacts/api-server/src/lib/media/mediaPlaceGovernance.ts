import { readCanonicalPlaceVisibility } from "../places/placeGovernance.js";

/** A current catalog decision, never a cached allow. Historical owner libraries
 * do not use this public-distribution gate. */
export class MediaPlaceGovernanceUnavailable extends Error {
  readonly status = 503;
  readonly code = "degraded_unavailable";
  constructor() { super("Current place visibility could not be checked. Please try again."); }
}

export async function visibleMediaPlaceIds(sc: any, ids: readonly string[]): Promise<Set<string>> {
  const result = await readCanonicalPlaceVisibility(sc, ids);
  if (!result.ok) throw new MediaPlaceGovernanceUnavailable();
  return result.visibleIds;
}

export async function filterMediaByCurrentPlace<T extends { canonical_place_id?: unknown }>(sc: any, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.map(row => row.canonical_place_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  const visible = await visibleMediaPlaceIds(sc, ids);
  return rows.filter(row => row.canonical_place_id == null || row.canonical_place_id === ""
    || (typeof row.canonical_place_id === "string" && visible.has(row.canonical_place_id)));
}
