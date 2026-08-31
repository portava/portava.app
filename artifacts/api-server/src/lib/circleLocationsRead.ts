/**
 * circleLocationsRead — the ONE implementation of "which circle members'
 * positions may this viewer see, and how precisely".
 *
 * WHY THIS FILE EXISTS
 * ====================
 * The rule lived inline inside GET /api/me/circle-locations (routes/location.ts).
 * That was fine while exactly one surface served it. The Map Intelligence
 * Gateway (Map spec §19: "the mobile client should not independently
 * reconstruct Portava intelligence rules") needs the same layer, and two
 * copies of a privacy predicate is how a leak ships: one side gains a gate, the
 * other does not, and nothing fails.
 *
 * So the logic moved here VERBATIM. This module is the extraction of the route
 * handler as it stands today — same queries, same order, same fail-closed
 * directions, same output rows. src/test/mapProjectionLayers.test.ts proves the
 * equivalence differentially: it drives the real HTTP route and this function
 * over the SAME fake client and asserts the two agree, scenario by scenario.
 *
 * THE GATES, IN THE ORDER THEY RUN (all fail-CLOSED)
 * ==================================================
 *   1. Emergency stop `disable_location_sharing` — an unreadable flag ENGAGES
 *      the stop (isKillSwitchEngaged inverts the failure polarity), because a
 *      serve path that keeps serving while the switch is unreadable is a kill
 *      switch that fails exactly when it is reached for.
 *   2. Circle membership — only rows in circle_memberships for this viewer.
 *   3. Bidirectional blocks — a null block set means NOBODY, never "no blocks".
 *   4. Affirmative consent — location_preferences.trusted_circle_share === true.
 *      A MISSING prefs row is NOT consent (the settings UI defaults it false).
 *   5. Master switch — user_privacy_settings.allow_location_sharing === false
 *      removes the member entirely, matching lib/mapTravelers.
 *   6. Sharing state — effectiveDiscoveryVisibility() === null (paused, mode
 *      'off', or 'no_location') emits NOTHING for that member: not even a
 *      coarsened row, because city/country/updatedAt is itself a location.
 *   7. Coarsening — every surviving coordinate goes through coarsenPosition,
 *      including the viewer's own row. RAW COORDINATES NEVER LEAVE THE SERVER.
 *
 * Gates 4 and 5 are skipped for the viewer's OWN entry: their own position is
 * not a share to anyone else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ================================
 * No clock read (so no split-clock risk), no HTTP, no logging, no response
 * shaping. Read failures are RETURNED, not thrown or swallowed, so the callers
 * can keep their own error envelopes byte-for-byte.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isKillSwitchEngaged } from "./featureFlags.js";
import { fetchBlockedSet } from "./blocks.js";
import { coarsenPosition, effectiveDiscoveryVisibility } from "./mapTravelers.js";
import { nameVisibilitySet } from "./publicIdentity.js";

/**
 * Exactly the row shape GET /api/me/circle-locations already serves — no field
 * added, none removed. An extraction that also widens the payload is not an
 * extraction.
 */
export interface CircleLocationEntry {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  country: string | null;
  updatedAt: string | null;
}

/** Which read failed, so a caller can log the same message it logs today. */
export type CircleLocationsStage =
  | "circle"
  | "prefs"
  | "privacy_settings"
  | "location_state";

export type CircleLocationsResult =
  | { ok: true; locations: CircleLocationEntry[] }
  | { ok: false; stage: CircleLocationsStage; message: string };

export interface CircleLocationsOptions {
  /**
   * A block set the caller has ALREADY resolved for this viewer, so a request
   * that touches several people-bearing layers issues one fetchBlockedSet
   * rather than one per layer. `null` carries the fail-closed meaning
   * unchanged: block state unknown → nobody is returned.
   *
   * Omit it entirely and this module resolves the set itself — which is what
   * the standalone route does today.
   */
  blockedSet?: Set<string> | null;
}

export async function readCircleLocations(
  sc: SupabaseClient,
  viewerId: string,
  opts: CircleLocationsOptions = {},
): Promise<CircleLocationsResult> {
  // 1. Emergency stop, on the SERVE path as well as the write path.
  if (await isKillSwitchEngaged(sc as any, "disable_location_sharing")) {
    return { ok: true, locations: [] };
  }

  // 2. Caller's circle members.
  const { data: memberRows, error: memberErr } = await sc
    .from("circle_memberships")
    .select("other_id")
    .eq("user_id", viewerId);

  if (memberErr) {
    return { ok: false, stage: "circle", message: memberErr.message };
  }

  const memberIdsRaw: string[] = (memberRows ?? []).map((r: any) => r.other_id as string);

  // 3. Bidirectional block filter, fail-closed.
  const blockedSet =
    opts.blockedSet !== undefined ? opts.blockedSet : await fetchBlockedSet(sc, viewerId);
  if (blockedSet === null) return { ok: true, locations: [] };

  const memberIds: string[] = memberIdsRaw.filter((id) => !blockedSet.has(id));
  if (memberIds.length === 0) return { ok: true, locations: [] };

  // 4 + 5. Consent and the master switch, read in parallel, fail-closed on either.
  const [prefsRes, upsRes] = await Promise.all([
    sc
      .from("location_preferences")
      .select("user_id, trusted_circle_share, location_mode, sharing_paused, discovery_visibility")
      .in("user_id", memberIds),
    sc
      .from("user_privacy_settings")
      .select("user_id, allow_location_sharing")
      .in("user_id", memberIds),
  ]);

  if (prefsRes.error) {
    return { ok: false, stage: "prefs", message: prefsRes.error.message };
  }
  if (upsRes.error) {
    return { ok: false, stage: "privacy_settings", message: upsRes.error.message };
  }

  const locationSharingDisabled = new Set<string>(
    (upsRes.data ?? [])
      .filter((r: any) => r.allow_location_sharing === false)
      .map((r: any) => r.user_id as string),
  );

  const consentedToCircleShare = new Set<string>();
  const prefsByMemberId = new Map<
    string,
    { location_mode?: string | null; sharing_paused?: boolean | null; discovery_visibility?: string | null }
  >();
  for (const r of prefsRes.data ?? []) {
    const row = r as any;
    if (row.trusted_circle_share === true) consentedToCircleShare.add(row.user_id as string);
    prefsByMemberId.set(row.user_id as string, row);
  }

  const visibleIds = memberIds.filter(
    (id) => id === viewerId || (consentedToCircleShare.has(id) && !locationSharingDisabled.has(id)),
  );
  if (visibleIds.length === 0) return { ok: true, locations: [] };

  // 6. Positions + display info.
  const [locationRes, profileRes] = await Promise.all([
    sc
      .from("user_location_state")
      .select("user_id, lat, lng, city, country, updated_at")
      .in("user_id", visibleIds),
    sc.from("profiles").select("id, name, avatar_url").in("id", visibleIds),
  ]);

  if (locationRes.error) {
    return { ok: false, stage: "location_state", message: locationRes.error.message };
  }

  // NOTE (preserved, not "fixed"): a profiles read error is NOT checked here,
  // exactly as in the route today — it degrades to an empty profile map, i.e.
  // no name and no avatar. That direction is safe (it withholds identity), so
  // the extraction keeps it rather than changing behaviour under cover of a
  // refactor.
  const profileMap = new Map((profileRes.data ?? []).map((p: any) => [p.id as string, p]));

  const allowedLocNames = await nameVisibilitySet(sc, visibleIds);

  const locations: CircleLocationEntry[] = [];
  for (const raw of locationRes.data ?? []) {
    const row = raw as any;
    const uid = row.user_id as string;

    const prefs = prefsByMemberId.get(uid) ?? null;
    const vis = effectiveDiscoveryVisibility(prefs);
    if (vis === null) continue;

    const profile = profileMap.get(uid);
    const nameOk = uid === viewerId || allowedLocNames.has(uid);

    let lat: number | null = row.lat != null ? Number(row.lat) : null;
    let lng: number | null = row.lng != null ? Number(row.lng) : null;
    if (lat != null && lng != null) {
      const coarsened = coarsenPosition(uid, lat, lng, vis);
      lat = coarsened.lat;
      lng = coarsened.lng;
    }

    locations.push({
      userId: uid,
      name: nameOk ? ((profile?.name as string | null) ?? null) : null,
      avatarUrl: (profile?.avatar_url as string | null) ?? null,
      lat,
      lng,
      city: (row.city as string | null) ?? null,
      country: (row.country as string | null) ?? null,
      updatedAt: (row.updated_at as string | null) ?? null,
    });
  }

  return { ok: true, locations };
}
