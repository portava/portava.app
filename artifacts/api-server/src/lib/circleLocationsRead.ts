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
 * The logic moved here from the route. src/test/mapProjectionLayers.test.ts
 * proves the equivalence differentially: it drives the real HTTP route and this
 * function over the SAME fake client and asserts the two agree, scenario by
 * scenario — so a gate added here is a gate added to BOTH surfaces, which is
 * the whole point of the extraction.
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
 *   7. Account standing — profiles.account_status must be 'active'. A member
 *      with no profiles row at all is DROPPED (status unknown → fail closed),
 *      and an unreadable profiles read is now an ERROR rather than a silent
 *      degradation, because "no name" and "no standing check" are not the same
 *      failure. See the gate itself for the omit-vs-strip reasoning.
 *   8. Freshness — a position older than the map-wide 60-minute bound (or of
 *      unknown age) is DROPPED. See the gate itself for why a pin has a
 *      shelf life.
 *   9. Coarsening — every surviving coordinate goes through coarsenPosition,
 *      including the viewer's own row. RAW COORDINATES NEVER LEAVE THE SERVER.
 *
 * Gates 4 and 5 are skipped for the viewer's OWN entry: their own position is
 * not a share to anyone else. Gates 7 and 8 are NOT skipped for self — see
 * their comments.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ================================
 * No HTTP, no logging, no response shaping. Read failures are RETURNED, not
 * thrown or swallowed, so the callers can keep their own error envelopes
 * byte-for-byte.
 *
 * It reads the clock EXACTLY ONCE (`nowMs`, threaded into every freshness
 * comparison). Two clock reads in one pass can put two members on opposite
 * sides of the same cutoff; src/test/splitClockGuard.test.ts also forbids
 * mixing Date.now() with a no-arg new Date() in one function body.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isKillSwitchEngaged } from "./featureFlags.js";
import { fetchBlockedSet } from "./blocks.js";
import {
  coarsenPosition,
  effectiveDiscoveryVisibility,
  freshnessBucket,
} from "./mapTravelers.js";
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
  | "location_state"
  /**
   * The profiles read. It used to be unchecked (degrading to "no name, no
   * avatar"), which was a safe direction while the read only supplied display
   * fields. It now also supplies account_status, so an unreadable profiles
   * table means UNKNOWN STANDING for every member — and serving a suspended
   * member's position is exactly the defect this gate exists to prevent.
   */
  | "profiles";

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

  // 6. Positions + display info + account standing.
  //
  // `last_known_at` is selected alongside `updated_at` because the two mean
  // different things and only one of them is a position age. routes/location.ts
  // stamps `updated_at` on EVERY upsert — including a manual city pick or a
  // permission_status change that carries no coordinates — but writes
  // `last_known_at` only inside `if (lat != null)`. So a member who last moved
  // in June and toggled a setting this morning has a one-hour-old `updated_at`
  // over a three-month-old pin. `last_known_at` is the honest signal, which is
  // why lib/mapTravelers gates the public map on it too.
  const [locationRes, profileRes] = await Promise.all([
    sc
      .from("user_location_state")
      .select("user_id, lat, lng, city, country, updated_at, last_known_at")
      .in("user_id", visibleIds),
    sc.from("profiles").select("id, name, avatar_url, account_status").in("id", visibleIds),
  ]);

  if (locationRes.error) {
    return { ok: false, stage: "location_state", message: locationRes.error.message };
  }

  // The profiles read is now privacy-load-bearing (account_status, gate 7), so
  // a failure can no longer degrade to "rows without names" — that would serve
  // suspended members' positions whenever the profiles table hiccuped. Fail
  // closed instead: report the stage and let the caller answer db_error.
  if (profileRes.error) {
    return { ok: false, stage: "profiles", message: profileRes.error.message };
  }

  const profileMap = new Map((profileRes.data ?? []).map((p: any) => [p.id as string, p]));

  const allowedLocNames = await nameVisibilitySet(sc, visibleIds);

  // ONE clock read for the whole pass — see the header note. Every freshness
  // comparison below is against this instant, so two members can never land on
  // opposite sides of "the same" cutoff.
  const nowMs = Date.now();

  const locations: CircleLocationEntry[] = [];
  for (const raw of locationRes.data ?? []) {
    const row = raw as any;
    const uid = row.user_id as string;

    const prefs = prefsByMemberId.get(uid) ?? null;
    const vis = effectiveDiscoveryVisibility(prefs);
    if (vis === null) continue;

    const profile = profileMap.get(uid);

    // ── Gate 7: account standing ──────────────────────────────────────────
    //
    // PREDICATE. `profiles.account_status === 'active'` — the allowlist, not a
    // denylist of known-bad values. It is the form lib/mapTravelers uses for
    // the public map (`if (prof.account_status !== "active") continue`), and
    // the form discoverySearch, follows and compass use as a DB filter
    // (`.in("account_status", ["active"])`). A denylist of
    // ['suspended','banned'] would silently start serving any status added
    // later ('deactivated', 'pending_deletion', 'deleted' — all of which exist
    // in this codebase and all of which lib/profileVisibility already answers
    // "unavailable" for).
    //
    // A null/absent column value reads as 'active', matching lib/http.ts's
    // requireUser (`(profile as any)?.account_status ?? "active"`). The column
    // is NOT NULL in the schema, so this only covers pre-migration rows; it is
    // NOT the fail-closed case. The fail-closed cases are the two below: an
    // unreadable profiles table (handled above) and a member with no profiles
    // row at all (handled here) — both mean "standing unknown", and unknown
    // standing must not put a person on a map.
    //
    // OMIT, NOT STRIP. The alternative was to keep the member and null out
    // lat/lng. Rejected for three reasons. (a) A stripped row still carries
    // city, country and updatedAt, and gate 6 four lines up already rules that
    // "city/country/updatedAt is itself a location" — stripping would leak the
    // very fields that gate refuses to emit. (b) Every other surface treats a
    // non-active account as absent, not as a placeholder: mapTravelers skips
    // them, discoverySearch filters them out in SQL, profileVisibility returns
    // "unavailable". A half-row here would be the only surface that confirms
    // "this suspended person is still somewhere". (c) lib/mapProjection's
    // projectCircleMember returns null for a null coordinate anyway, so on the
    // gateway a stripped row is already an omitted row — keeping it would
    // change only the legacy endpoint, i.e. reintroduce the two-surfaces
    // divergence this module exists to end.
    //
    // NOT SKIPPED FOR SELF. Gates 4 and 5 are consent gates — a user's own
    // preference about sharing has nothing to say about their own view. This
    // one is platform ENFORCEMENT: requireUser already refuses every request
    // from a banned or suspended account, so applying it uniformly here just
    // closes the remaining statuses ('deactivated', 'pending_deletion') on the
    // one surface that would otherwise still plot them.
    if (!profile) continue;
    if (((profile.account_status as string | null) ?? "active") !== "active") continue;

    // ── Gate 8: freshness ─────────────────────────────────────────────────
    //
    // THE BOUND: 60 minutes, taken from lib/mapTravelers rather than invented
    // here — `freshnessBucket` is that module's own cutoff function, so the
    // circle layer and the public traveler layer expire a pin at exactly the
    // same age and can never drift apart. (Reusing the function, not copying
    // the number, is the point: FRESH_MAX_MS has one definition.)
    //
    // WHY A BOUND AT ALL: the consumer renders a pin, and a pin means "here".
    // A months-old pin says a person is somewhere they are not, and someone
    // may act on it — go there, or conclude the person is fine. The raw
    // `updatedAt` field does not save it: nothing forces a consumer to read
    // it, and lib/mapProjection's projectCircleMember explicitly does not
    // ("No freshness… Manufacturing 'live' from a recent write would make a
    // stale pin read as a confirmed one"). The server must therefore decide.
    //
    // BOUNDARY: inclusive. freshnessBucket returns 'recent' for
    // `age <= 60 min`, so a position exactly 60 minutes old is SERVED and one
    // 60 minutes + 1 ms old is dropped.
    //
    // UNKNOWN AGE IS STALE. freshnessBucket returns null for a null timestamp,
    // an unparseable one, and one in the future (negative age — clock skew or
    // a spoofed fix, which would otherwise pin forever). All three mean "we
    // cannot say how old this is", and a pin we cannot date is exactly the pin
    // that must not be drawn. Same direction as mapTravelers, whose bbox query
    // also excludes rows with a null last_known_at.
    //
    // OMIT, NOT STRIP — same reasoning as gate 7: a stale row's city, country
    // and updatedAt are still a location.
    //
    // NOT SKIPPED FOR SELF: a stale self-pin is the one a user is most likely
    // to trust, and this row is coarsened and served over the same map.
    if (freshnessBucket((row.last_known_at as string | null) ?? null, nowMs) === null) continue;

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
      // Still `updated_at`, deliberately: the payload shape does not change,
      // and `updated_at >= last_known_at` always, so a row that cleared gate 8
      // cannot carry an `updatedAt` that OVERSTATES its age. The safety
      // decision is the gate, not this field.
      updatedAt: (row.updated_at as string | null) ?? null,
    });
  }

  return { ok: true, locations };
}
