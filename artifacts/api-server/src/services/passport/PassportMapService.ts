/**
 * PassportMapService
 *
 * Builds the privacy-safe passport map payload.
 * INVARIANT: Never returns exact lat/lng coordinates.
 * Returns only city-level and neighborhood-zone markers aggregated from passport_stamps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallerContext } from "./PassportPrivacyGuard.js";
import { filterStamps, filterMemories } from "./PassportPrivacyGuard.js";
import type { StampRow } from "./PassportPrivacyGuard.js";
import { loadMemories } from "./PassportMemoryService.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "PassportMapService" });

/**
 * A named place inside one Trip's city — §26 level 5.
 *
 * Identity comes from the stamp/memory's own `place_id` when it has one and
 * from its `neighborhood` otherwise, so a landmark and a zone both get a level
 * without either pretending to be the other. The LABEL is resolved from
 * `places.name`; an unresolvable id falls back to the neighbourhood and then to
 * a generic word rather than surfacing a uuid.
 *
 * NO COORDINATES, by construction: nothing here reads latitude/longitude, and
 * the rows it is built from have already been through `guardStamp` /
 * `guardMemory`, which null `place_id` and `neighborhood` for the callers who
 * may not have them. The Places level therefore cannot be a second route to a
 * field the guard just took away.
 */
export interface WorldPlace {
  /** Stable list key: the place id, else `n:<neighborhood>`. */
  key: string;
  /** Display label — `places.name`, else the neighbourhood, else "Place". */
  name: string;
  placeId: string | null;
  neighborhood: string | null;
  stampCount: number;
  memoryCount: number;
}

/** One Memory filed under a Trip — §26 level 6. Coarse fields only. */
export interface WorldMemory {
  id: string;
  title: string | null;
  category: string | null;
  /** The `WorldPlace.key` this memory sits at, when it names one. */
  placeKey: string | null;
  earnedAt: string | null;
}

/**
 * One Trip inside a city — §26 level 4.
 *
 * `tripId: null` is the UNTRIPPED bucket: a city's stamps and memories that
 * belong to no Trip. It exists so that growing the hierarchy a level cannot
 * silently drop the records that have no value for it — the city's own
 * `stampCount` still equals the sum of its Trips.
 */
export interface WorldTrip {
  tripId: string | null;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  stampCount: number;
  places: WorldPlace[];
  memories: WorldMemory[];
}

export interface MapMarker {
  country: string;
  city: string;
  neighborhood: string | null;
  stampCount: number;
  verificationLevel: string;
  /** Coarse label for UI display — never raw coordinates */
  displayLabel: string;
  /**
   * §26 levels 4–6 for this city: `Trip → Places → Memories / Stamps`. Newest
   * Trip first, the untripped bucket last.
   */
  trips: WorldTrip[];
}

export interface PassportMapPayload {
  markers: MapMarker[];
  countries: string[];
  cities: string[];
}

/**
 * Build the privacy-safe map payload for a user.
 * callerCtx controls which stamps are included based on visibility.
 */
export async function buildMapPayload(
  db: SupabaseClient,
  userId: string,
  callerCtx: CallerContext,
  opts: { hotelBlurEnabled?: boolean } = {},
): Promise<PassportMapPayload> {
  const { data, error } = await db
    .from("passport_stamps")
    .select("id, stamp_type, country, city, neighborhood, place_id, plan_id, trip_id, source_type, verification_level, visibility, earned_at:awarded_at, created_at")
    .eq("user_id", userId)
    .not("city", "is", null)
    .order("awarded_at", { ascending: false })
    .limit(500);

  if (error || !data) {
    if (error) {
      logger.error({ table: "passport_stamps", op: "select", message: error.message }, "buildMapPayload failed");
    }
    return { markers: [], countries: [], cities: [] };
  }

  const stamps = data as StampRow[];
  const visible = filterStamps(stamps, callerCtx, opts);

  // Aggregate by city
  const cityMap = new Map<string, MapMarker>();
  for (const stamp of visible) {
    if (!stamp.city) continue;
    const key = `${stamp.country ?? ""}|${stamp.city}`;
    if (cityMap.has(key)) {
      const existing = cityMap.get(key)!;
      existing.stampCount += 1;
      // Upgrade verification level (gps > checkin > unverified)
      if (verificationRank(stamp.verification_level) > verificationRank(existing.verificationLevel)) {
        existing.verificationLevel = stamp.verification_level;
      }
    } else {
      cityMap.set(key, {
        country: stamp.country ?? "",
        city: stamp.city,
        neighborhood: stamp.neighborhood ?? null,
        stampCount: 1,
        verificationLevel: stamp.verification_level,
        displayLabel: stamp.city + (stamp.country ? `, ${stamp.country}` : ""),
        trips: [],
      });
    }
  }

  const markers = Array.from(cityMap.values());
  // §26 levels 4–6. Built from `visible` — the POST-guard rows — so every deeper
  // level inherits the privacy answer the guard already gave and re-decides none
  // of it.
  await attachTripLevels(db, userId, callerCtx, markers, visible, opts);
  const countries = [...new Set(markers.map((m) => m.country).filter(Boolean))].sort();
  const cities = [...new Set(markers.map((m) => m.city).filter(Boolean))].sort();

  return { markers, countries, cities };
}

/** The city bucket key a stamp or memory belongs to. Must match `buildMapPayload`. */
function cityKeyOf(country: unknown, city: unknown): string {
  return `${country ?? ""}|${city ?? ""}`;
}

/** Place identity for a row that may name a place, a zone, or neither. */
function placeKeyOf(placeId: unknown, neighborhood: unknown): string | null {
  if (typeof placeId === "string" && placeId.length > 0) return placeId;
  if (typeof neighborhood === "string" && neighborhood.trim().length > 0) return `n:${neighborhood}`;
  return null;
}

/**
 * Fill in §26's `Trip → Places → Memories / Stamps` for every city marker.
 *
 * THREE SUPPLEMENTARY READS, each fail-soft and each costing only its own level:
 *   `trips`            titles and dates for the Trip level. Unreadable ⇒ the
 *                      Trips still exist, unnamed — losing a title must not lose
 *                      the stamps grouped under it.
 *   `places`           display names for the Places level. Unreadable ⇒ places
 *                      fall back to their neighbourhood label.
 *   `passport_memories` level 6, via `loadMemories` + `filterMemories` — the SAME
 *                      per-memory gate every other Passport surface runs, so My
 *                      World cannot become the surface that shows a private
 *                      memory. Unreadable ⇒ no memories, hierarchy intact.
 *
 * Mutates `markers` in place; the marker list, its counts and the payload's
 * `countries`/`cities` are untouched.
 */
async function attachTripLevels(
  db: SupabaseClient,
  userId: string,
  callerCtx: CallerContext,
  markers: MapMarker[],
  visible: StampRow[],
  opts: { hotelBlurEnabled?: boolean },
): Promise<void> {
  if (markers.length === 0) return;
  const markerByCity = new Map(markers.map((m) => [cityKeyOf(m.country, m.city), m]));

  // tripId ("" = untripped) → per-city working state.
  interface Bucket {
    tripId: string | null;
    stampCount: number;
    places: Map<string, WorldPlace>;
    memories: WorldMemory[];
  }
  const buckets = new Map<string, Map<string, Bucket>>(); // cityKey → tripKey → bucket
  const bucketFor = (cityKey: string, tripId: string | null): Bucket | null => {
    // MY WORLD IS A STAMP MAP. The marker list was derived from stamps before
    // this ran and is not added to here, so a memory in a city holding no stamp
    // has nowhere to hang — it is refused a bucket rather than inventing a city
    // the traveller has no stamp for.
    if (!markerByCity.has(cityKey)) return null;
    const perCity = buckets.get(cityKey) ?? new Map<string, Bucket>();
    buckets.set(cityKey, perCity);
    const tripKey = tripId ?? "";
    let b = perCity.get(tripKey);
    if (!b) {
      b = { tripId, stampCount: 0, places: new Map(), memories: [] };
      perCity.set(tripKey, b);
    }
    return b;
  };
  const placeIn = (b: Bucket, placeId: unknown, neighborhood: unknown): WorldPlace | null => {
    const key = placeKeyOf(placeId, neighborhood);
    if (!key) return null;
    let p = b.places.get(key);
    if (!p) {
      const nb = typeof neighborhood === "string" && neighborhood.trim().length > 0 ? neighborhood : null;
      p = {
        key,
        name: nb ?? "Place",
        placeId: typeof placeId === "string" && placeId.length > 0 ? placeId : null,
        neighborhood: nb,
        stampCount: 0,
        memoryCount: 0,
      };
      b.places.set(key, p);
    }
    return p;
  };

  const tripIds = new Set<string>();
  const placeIds = new Set<string>();

  for (const s of visible) {
    const b = bucketFor(cityKeyOf(s.country, s.city), s.trip_id ?? null);
    if (!b) continue;
    b.stampCount += 1;
    if (s.trip_id) tripIds.add(s.trip_id);
    const p = placeIn(b, s.place_id, s.neighborhood);
    if (p) {
      p.stampCount += 1;
      if (p.placeId) placeIds.add(p.placeId);
    }
  }

  // Level 6 — the owner's memories at the viewer's own permitted visibility.
  let memories: any[] = [];
  try {
    memories = filterMemories(await loadMemories(db, userId), callerCtx, opts) as any[];
  } catch {
    memories = [];
  }
  for (const m of memories) {
    const b = bucketFor(cityKeyOf(m.country, m.city), m.trip_id ?? null);
    if (!b) continue; // stampless city — see bucketFor.
    if (m.trip_id) tripIds.add(m.trip_id);
    const p = placeIn(b, m.place_id, m.neighborhood);
    if (p) {
      p.memoryCount += 1;
      if (p.placeId) placeIds.add(p.placeId);
    }
    b.memories.push({
      id: m.id,
      title: m.title ?? null,
      category: m.category ?? null,
      placeKey: p?.key ?? null,
      earnedAt: m.earned_at ?? null,
    });
  }

  // Trip titles/dates. A failure costs the NAMES, never the grouping.
  const tripMeta = new Map<string, { title: string | null; startDate: string | null; endDate: string | null }>();
  if (tripIds.size > 0) {
    try {
      const { data, error } = await db
        .from("trips")
        .select("id, title, start_date, end_date")
        .in("id", [...tripIds]);
      if (error) {
        logger.warn({ table: "trips", op: "select", message: error.message }, "My World trip level unnamed");
      }
      for (const r of ((data as any[]) ?? [])) {
        tripMeta.set(r.id, {
          title: r.title ?? null,
          startDate: r.start_date ?? null,
          endDate: r.end_date ?? null,
        });
      }
    } catch {
      /* unnamed trips, never missing ones */
    }
  }

  // Place names. A failure costs the LABELS, never the level.
  if (placeIds.size > 0) {
    try {
      const { data, error } = await db
        .from("places")
        .select("id, name, neighborhood")
        .in("id", [...placeIds]);
      if (error) {
        logger.warn({ table: "places", op: "select", message: error.message }, "My World places unnamed");
      }
      const names = new Map<string, string>();
      for (const r of ((data as any[]) ?? [])) {
        if (r.id && typeof r.name === "string" && r.name.trim().length > 0) names.set(r.id, r.name);
      }
      for (const perCity of buckets.values()) {
        for (const b of perCity.values()) {
          for (const p of b.places.values()) {
            const resolved = p.placeId ? names.get(p.placeId) : undefined;
            if (resolved) p.name = resolved;
          }
        }
      }
    } catch {
      /* unlabelled places, never missing ones */
    }
  }

  for (const marker of markers) {
    const perCity = buckets.get(cityKeyOf(marker.country, marker.city));
    if (!perCity) continue;
    const trips: WorldTrip[] = [...perCity.values()].map((b) => {
      const meta = b.tripId ? tripMeta.get(b.tripId) : undefined;
      const places = [...b.places.values()].sort(
        (a, z) => z.stampCount + z.memoryCount - (a.stampCount + a.memoryCount) || a.name.localeCompare(z.name),
      );
      return {
        tripId: b.tripId,
        title: meta?.title ?? null,
        startDate: meta?.startDate ?? null,
        endDate: meta?.endDate ?? null,
        stampCount: b.stampCount,
        places,
        memories: b.memories.sort((a, z) => String(z.earnedAt ?? "").localeCompare(String(a.earnedAt ?? ""))),
      };
    });
    // Newest journey first; the untripped bucket is not a journey and sorts last.
    trips.sort((a, z) => {
      if ((a.tripId === null) !== (z.tripId === null)) return a.tripId === null ? 1 : -1;
      return String(z.startDate ?? "").localeCompare(String(a.startDate ?? ""));
    });
    marker.trips = trips;
  }
}

function verificationRank(level: string): number {
  switch (level) {
    case "admin":       return 5;
    case "crew":        return 4;
    case "safe_return": return 3;
    case "checkin":     return 2;
    case "gps":         return 1;
    default:            return 0;
  }
}

/**
 * The four category buckets `buildStats` reports, keyed to the stamp SLUGS that
 * actually belong to each.
 *
 * WHY SLUGS AND NOT `stamp_definitions.category`. buildStats used to count
 * `category === "plan" | "host" | "hidden_gem" | "safe_return"`. None of those
 * four strings is a category. The seeded vocabulary (migrations 0081, 0082,
 * 0145, 0189 — and identical in production) is exactly:
 *
 *   community | event | location | rent_buddy | safety | special | trip | trust
 *
 * so all four counters were structurally ZERO for every traveller. That is not
 * only four dead numbers on GET /me/passport/stats: `hiddenGemStamps` is the
 * ONLY input to `deriveTravelSignals(..., hiddenGems)` →
 * `signals.hiddenGemCount`, and PassportTravelIdentityService:362 needs it to
 * reach 2 before it will infer the "hidden gem hunter" Travel DNA trait. A
 * permanently-zero count meant that trait could never be inferred for anyone.
 *
 * Remapping to the nearest CATEGORY would have been wrong in the other
 * direction: `safety` also contains safe_return_ready, `location` contains
 * every city/globe-trotter stamp, and `event` contains both attending and
 * hosting. The distinction the counters draw is a slug-level one, so the
 * mapping is spelled at slug level. `src/test/passportMapService.test.ts`
 * asserts every slug named here is one a migration actually seeds, so this
 * cannot rot into a second set of dead literals.
 */
export const STATS_SLUG_BUCKETS = {
  /** Attending / joining a plan or event. */
  plan: new Set(["event_participant", "first_event_joined"]),
  /** Hosting one — an event, a trip meetup, or a paid session. */
  host: new Set(["event_host", "first_event_hosted", "good_host", "first_buddy_hosted"]),
  /** Hidden gems surfaced or visited. */
  hidden_gem: new Set(["hidden_gem_hunter", "hidden_gem_explorer"]),
  /** A Safe Return actually COMPLETED — `safe_return_ready` is only opt-in. */
  safe_return: new Set(["safe_return_completed"]),
} as const;

/**
 * Compute passport stats for a user.
 */
export interface PassportStats {
  countries: number;
  cities: number;
  neighborhoods: number;
  planStamps: number;
  hostStamps: number;
  hiddenGemStamps: number;
  safeReturnStamps: number;
  totalStamps: number;
  /**
   * TRUE when the underlying `user_stamps` read FAILED, so every number above
   * is a placeholder zero rather than a measurement.
   *
   * Without this field the two cases are literally the same object: a traveller
   * who has earned nothing and a table that could not be read both produce
   * `{ countries: 0, cities: 0, totalStamps: 0, ... }`. Passport stats are a
   * CLAIM ABOUT A PERSON — "you have been to 0 countries" — so rendering the
   * second as the first is a false statement, not a degraded one. supabase-js
   * RESOLVES on a database error, so no caller could have inferred the
   * difference from a thrown exception either; this flag is the only carrier.
   */
  readFailed: boolean;
}

export async function buildStats(
  db: SupabaseClient,
  userId: string,
): Promise<PassportStats> {
  // Bug fix (2026-07-28): this previously read from `passport_stamps`, a stale
  // legacy table (last write 2026-05-10) that the live award pipeline
  // (src/routes/posts.ts trip/location-milestone stamps) never writes to.
  // Live stamp awards land in `user_stamps` — read from there instead, joined
  // to stamp_definitions for the plan/host/hidden_gem/safe_return category
  // breakdown that passport_stamps.stamp_type used to provide.
  const { data, error } = await db
    .from("user_stamps")
    .select("country, city, visibility, is_revoked, stamp_definitions(category, slug)")
    .eq("user_id", userId)
    .eq("is_revoked", false);

  if (error || !data) {
    if (error) {
      logger.error({ table: "user_stamps", op: "select", message: error.message }, "buildStats failed");
    }
    return {
      countries: 0, cities: 0, neighborhoods: 0,
      planStamps: 0, hostStamps: 0, hiddenGemStamps: 0,
      safeReturnStamps: 0, totalStamps: 0,
      // Not "this traveller has nothing" — "we could not look". See PassportStats.
      readFailed: true,
    };
  }

  const rows = data as any[];
  const countries = new Set<string>();
  const cities = new Set<string>();
  const neighborhoods = new Set<string>();
  let planStamps = 0, hostStamps = 0, hiddenGemStamps = 0, safeReturnStamps = 0;

  for (const r of rows) {
    if (r.country) countries.add(r.country);
    if (r.city) cities.add(r.city);
    // PostgREST returns an embedded to-one either as an object or, on some
    // shapes, as a single-element array. Handle both — a wrong guess here would
    // reintroduce the all-zero bug in a new disguise.
    const def = Array.isArray(r.stamp_definitions) ? r.stamp_definitions[0] : r.stamp_definitions;
    const slug: string = typeof def?.slug === "string" ? def.slug : "";
    if (STATS_SLUG_BUCKETS.plan.has(slug as never)) planStamps++;
    if (STATS_SLUG_BUCKETS.host.has(slug as never)) hostStamps++;
    if (STATS_SLUG_BUCKETS.hidden_gem.has(slug as never)) hiddenGemStamps++;
    if (STATS_SLUG_BUCKETS.safe_return.has(slug as never)) safeReturnStamps++;
  }

  return {
    countries: countries.size,
    cities: cities.size,
    neighborhoods: neighborhoods.size,
    planStamps,
    hostStamps,
    hiddenGemStamps,
    safeReturnStamps,
    totalStamps: rows.length,
    readFailed: false,
  };
}
