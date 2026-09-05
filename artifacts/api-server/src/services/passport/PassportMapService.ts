/**
 * PassportMapService
 *
 * Builds the privacy-safe passport map payload.
 * INVARIANT: Never returns exact lat/lng coordinates.
 * Returns only city-level and neighborhood-zone markers aggregated from passport_stamps.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallerContext } from "./PassportPrivacyGuard.js";
import { filterStamps } from "./PassportPrivacyGuard.js";
import type { StampRow } from "./PassportPrivacyGuard.js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "PassportMapService" });

export interface MapMarker {
  country: string;
  city: string;
  neighborhood: string | null;
  stampCount: number;
  verificationLevel: string;
  /** Coarse label for UI display — never raw coordinates */
  displayLabel: string;
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
      });
    }
  }

  const markers = Array.from(cityMap.values());
  const countries = [...new Set(markers.map((m) => m.country).filter(Boolean))].sort();
  const cities = [...new Set(markers.map((m) => m.city).filter(Boolean))].sort();

  return { markers, countries, cities };
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
export async function buildStats(
  db: SupabaseClient,
  userId: string,
): Promise<{
  countries: number;
  cities: number;
  neighborhoods: number;
  planStamps: number;
  hostStamps: number;
  hiddenGemStamps: number;
  safeReturnStamps: number;
  totalStamps: number;
}> {
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
  };
}
