/**
 * Cold start for a new viewer — `06` §9, census-discovery §85 (lane W10-R3),
 * DV-55. Behind `discovery_cold_start_enabled` (3482, seeded FALSE).
 *
 * `06` §9 names four inputs for a new user. Where each comes from here:
 *
 *   explicit onboarding interests   `profiles.interests`, `profiles.travel_style`
 *                                   and `profiles.travel_styles` — what the
 *                                   viewer TOLD the product (routes/profile.ts
 *                                   writes them). Before §85 they reached no
 *                                   ranker; PDE read only Compass's interests.
 *   destination/trip context        the destination the request names (already
 *                                   `viewer.city`), plus the place types the
 *                                   viewer saved as trip ideas
 *                                   (`trip_saved_places.place_type`) — an
 *                                   explicit act, so a stated interest.
 *   local context                   the destination itself, and — with 3480 on —
 *                                   the city's trending/emerging retrievals.
 *   diversified high-confidence     unchanged: portavaRank's diversity pass and
 *   content                         the verified bonus on curated rows.
 *
 * WHO IS COLD. A viewer whose category observations are below
 * MIN_TOTAL_CATEGORY_OBSERVATIONS — exactly the viewer `loadPdeViewer` gives
 * no `categoryAffinities`. Nobody above that floor is touched.
 *
 * STATED, NEVER INFERRED, NEVER WRITTEN BACK. Onboarding answers are an
 * instruction, so they become interest TAGS (portavaRank's `interestTag`
 * feature), never learned category affinities; and nothing here writes to
 * `profiles` or to Compass preferences.
 *
 * A read that fails is recorded in `degraded` and contributes nothing: the
 * viewer is ranked exactly as before §85.
 */
import type { PdeViewer } from "../discoveryPde.js";

/** Most tags cold start may add to a viewer. */
export const COLD_START_MAX_TAGS = 20;
/** Trip ideas read for their place types. */
export const COLD_START_TRIP_IDEAS = 50;

export interface ColdStartReport {
  cold: boolean;
  applied: boolean;
  /** Tags added, by origin. */
  seeded: { onboarding: number; tripContext: number };
  /** The local context the request carried. */
  local: "request_destination" | "none";
  degraded: Array<"profile" | "trip_ideas">;
}

function norm(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t.length > 0 && t.length <= 50 ? t : null;
}

export async function applyColdStart(sc: any, viewer: PdeViewer): Promise<{ viewer: PdeViewer; report: ColdStartReport }> {
  const cold = viewer.categoryAffinities === undefined;
  const report: ColdStartReport = {
    cold, applied: false, seeded: { onboarding: 0, tripContext: 0 },
    local: viewer.city ? "request_destination" : "none", degraded: [],
  };
  if (!cold || !sc) return { viewer, report };

  const onboarding: string[] = [];
  try {
    const { data, error } = await sc
      .from("profiles")
      .select("interests, travel_style, travel_styles")
      .eq("id", viewer.userId)
      .maybeSingle();
    if (error) report.degraded.push("profile");
    else if (data) {
      const d = data as { interests?: unknown; travel_style?: unknown; travel_styles?: unknown };
      for (const v of [...(Array.isArray(d.interests) ? d.interests : []), d.travel_style, ...(Array.isArray(d.travel_styles) ? d.travel_styles : [])]) {
        const t = norm(v); if (t) onboarding.push(t);
      }
    }
  } catch { report.degraded.push("profile"); }

  const trip: string[] = [];
  try {
    const { data, error } = await sc
      .from("trip_saved_places")
      .select("place_type, saved_at")
      .eq("user_id", viewer.userId)
      .order("saved_at", { ascending: false })
      .limit(COLD_START_TRIP_IDEAS);
    if (error) report.degraded.push("trip_ideas");
    else for (const r of (Array.isArray(data) ? data : []) as Array<{ place_type?: unknown }>) { const t = norm(r.place_type); if (t) trip.push(t); }
  } catch { report.degraded.push("trip_ideas"); }

  const tags = new Set(viewer.interestTags);
  for (const t of onboarding) { if (tags.size - viewer.interestTags.size >= COLD_START_MAX_TAGS) break; if (!tags.has(t)) { tags.add(t); report.seeded.onboarding++; } }
  for (const t of trip) { if (tags.size - viewer.interestTags.size >= COLD_START_MAX_TAGS) break; if (!tags.has(t)) { tags.add(t); report.seeded.tripContext++; } }
  if (tags.size === viewer.interestTags.size) return { viewer, report };
  report.applied = true;
  return { viewer: { ...viewer, interestTags: tags }, report };
}
