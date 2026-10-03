/**
 * buddyMapRead — the ONE implementation of "which Rent-a-Buddy profiles may a
 * viewer see, and which of their fields may be exposed".
 *
 * WHY THIS FILE EXISTS
 * ====================
 * The buddy layer was the last of the six the Map Intelligence Gateway could
 * not serve (Map spec §19: "the mobile client should not independently
 * reconstruct Portava intelligence rules"). It was declined for a specific and
 * correct reason: POST /api/rent-a-buddy/search had no privacy-complete
 * function to call. Its visibility predicate (the feature flag, then
 * status/admin_status), its public column allow-list (BUDDY_PUBLIC_COLUMNS) and
 * its private-field strip (stripBuddyPrivateFields → mapBuddyPublicProfile)
 * were all module-private to routes/rentABuddy.ts, interleaved with marketplace
 * ranking, pagination and an outbound Nominatim geocode.
 *
 * So the privacy-complete parts moved HERE, verbatim, and routes/rentABuddy.ts
 * now imports them. There is exactly ONE BUDDY_PUBLIC_COLUMNS and exactly ONE
 * stripBuddyPrivateFields in the server; the gateway and the marketplace cannot
 * drift about which buddy fields are public, because they are reading the same
 * constant and calling the same function.
 *
 * WHAT DELIBERATELY DID *NOT* MOVE
 * ================================
 * Marketplace ranking, pagination and `geocodeBuddyCity` stayed in the route.
 * They are not privacy: they are how the marketplace orders and pages a result
 * set, and the projection wants neither (it ranks by the §31 ladder and pages
 * the whole MapObject stream). Pulling them along would have dragged the entire
 * search endpoint — Nominatim call included — into the gateway.
 *
 * The geocode is the sharpest case. The marketplace falls back to a buddy's
 * CITY CENTRE when they have no meetup base, so it can still show a distance
 * label. A map pin is not a distance label: putting a buddy on a city centroid
 * they never chose would invent a location. So this reader serves ONLY buddies
 * who set a meetup base, and never geocodes. That is a NARROWING (fewer pins,
 * never a different or sharper one), which is the only direction an extraction
 * may move in.
 *
 * THE GATES, IN THE ORDER THEY RUN
 * ================================
 *   1. `rent_buddy_enabled` — the same flag requireRentBuddyEnabled reads. Off
 *      (or unreadable) means NO buddies, exactly as the route answers 403.
 *   2. Block set — fail-closed: `null` means block state is unknown, therefore
 *      NOBODY. Same contract as listMapTravelers and readCircleLocations, and
 *      the gateway hands all three the SAME resolved set.
 *   3. status = 'active' AND admin_status = 'active' — the marketplace's whole
 *      visibility predicate, unchanged.
 *   4. A usable meetup base, inside the viewport (see above).
 *   5. Field exposure — BUDDY_PUBLIC_COLUMNS on the select, then
 *      stripBuddyPrivateFields, then mapBuddyPublicProfile. Byte-for-byte the
 *      composition POST /api/rent-a-buddy/search applies to every row it
 *      serves; src/test/buddyMapRead.test.ts drives both paths over the same
 *      fake client and asserts they agree.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * ================================
 * No clock read (so no split-clock risk), no HTTP, no response shaping, no
 * outbound network. Read failures are RETURNED, not thrown or swallowed, so the
 * caller can tell "no buddies here" from "we could not tell".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFlagState } from "./capability/schemaCapability.js";  // census-discovery §115 (DV-83, B8): the buddy flag is read three-state
import { haversineKm } from "./canonicalLocations.js"; import { nearBox, applyNearBox } from "./nearBox.js";  // census-discovery §117 (DV-83, sweep SW16)

// ── Field exposure — the single definition ────────────────────────────────────

/**
 * Explicit column list for all public-facing buddy profile selects.
 * Intentionally excludes admin-only and private contact fields:
 *   admin_status, risk_hold, id_verification_ref, legal_name,
 *   exact_address, home_address, phone_number.
 *
 * MOVED HERE UNCHANGED from routes/rentABuddy.ts. Every public buddy read —
 * the marketplace's and the map's — selects through this one string.
 */
export const BUDDY_PUBLIC_COLUMNS =
  "id, user_id, display_name, tagline, bio, intro_video_url, languages, city, country, " +
  "categories, hourly_rate_usd, status, verified, verified_at, verification_status, " +
  "average_rating, review_count, completed_bookings, completed_count, response_time_h, " +
  "cover_photo_url, gallery_urls, vibe_tags, safety_badges, buddy_level, category_approvals, " +
  "new_buddy_public_only, new_buddy_daytime_only, new_buddy_max_hours, max_group_size, " +
  "preferred_meetup_zones, availability_blocks, meetup_base_lat, meetup_base_lng, featured, available_now, cancel_count, no_show_count, " +
  "favorites_count, created_at, updated_at, profiles!user_id(verification_level)";

/**
 * Second line of defence behind BUDDY_PUBLIC_COLUMNS: a row that reached a
 * caller through some other select still loses its private fields here.
 *
 * MOVED HERE UNCHANGED from routes/rentABuddy.ts, `confirmed` parameter and
 * all. `confirmed: true` (a counterparty on a confirmed booking) returns the
 * row untouched — no map path ever passes it, and this module never does.
 */
export function stripBuddyPrivateFields(buddyRow: any, confirmed: boolean): any {
  if (!buddyRow) return null;
  if (confirmed) return buddyRow;
  const { id_verification_ref, legal_name, exact_address, home_address, phone_number, ...safe } = buddyRow;
  return safe;
}

/**
 * The public buddy DTO. MOVED HERE UNCHANGED from routes/rentABuddy.ts, where
 * it was `mapProfile`; that file now imports it under its old local name so
 * every call site is byte-identical.
 *
 * This is the actual field-exposure allow-list: a column can sit in
 * BUDDY_PUBLIC_COLUMNS and still never reach a client because it is not mapped
 * here (`featured`, `available_now`, `cancel_count`, `no_show_count`,
 * `verification_status`, `bio`… are selected for server-side use and are not
 * emitted). Keeping ONE mapper is what stops the map from quietly exposing a
 * field the marketplace does not.
 */
export function mapBuddyPublicProfile(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    tagline: row.tagline,
    bio: row.bio,
    introVideoUrl: row.intro_video_url,
    languages: row.languages ?? [],
    city: row.city,
    country: row.country,
    categories: row.categories ?? [],
    hourlyRateUsd: row.hourly_rate_usd ? Number(row.hourly_rate_usd) : null,
    status: row.status,
    verified: row.verified,
    verifiedAt: row.verified_at,
    averageRating: row.average_rating ? Number(row.average_rating) : null,
    reviewCount: row.review_count ?? 0,
    completedBookings: row.completed_count ?? row.completed_bookings ?? 0,
    responseTimeH: row.response_time_h ? Number(row.response_time_h) : null,
    coverPhotoUrl: row.cover_photo_url,
    galleryUrls: row.gallery_urls ?? [],
    vibeTags: row.vibe_tags ?? [],
    safetyBadges: row.safety_badges ?? [],
    buddyLevel: row.buddy_level,
    categoryApprovals: row.category_approvals ?? {},
    newBuddyPublicOnly: row.new_buddy_public_only,
    newBuddyDaytimeOnly: row.new_buddy_daytime_only,
    newBuddyMaxHours: row.new_buddy_max_hours,
    maxGroupSize: row.max_group_size,
    preferredMeetupZones: row.preferred_meetup_zones ?? [],
    availabilityBlocks: row.availability_blocks ?? [],
    meetupBaseLat: typeof row.meetup_base_lat === "number" ? row.meetup_base_lat : null,
    meetupBaseLng: typeof row.meetup_base_lng === "number" ? row.meetup_base_lng : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verificationLevel: (row.profiles?.verification_level as string) ?? null,
  };
}

/**
 * True when a buddy row carries a usable approximate meetup-base pin.
 * MOVED HERE UNCHANGED from routes/rentABuddy.ts, which still uses it to decide
 * which buddies need a city geocode.
 */
export function hasMeetupBase(r: Record<string, unknown>): boolean {
  return typeof r.meetup_base_lat === "number" && Number.isFinite(r.meetup_base_lat)
    && typeof r.meetup_base_lng === "number" && Number.isFinite(r.meetup_base_lng);
}

// ── The map read ──────────────────────────────────────────────────────────────

/** The already-safe row this reader emits: exactly the public buddy DTO. */
export type BuddyMapPin = NonNullable<ReturnType<typeof mapBuddyPublicProfile>>;

/** Which read failed, so the caller can log it and leave the layer unreported. */
export type BuddyMapReadStage = "profiles" | "flag" | "blocks";  // §115 (B8): an unread flag or block set is a failed read, never an empty marketplace

export type BuddyMapPinsResult =
  | { ok: true; pins: BuddyMapPin[]; /** census-discovery §115 (B8): the bbox scan or the pin cap cut the read — the layer is not whole */ capped?: true }
  | { ok: false; stage: BuddyMapReadStage; message: string };

export interface BuddyMapPinsOptions {
  lat: number;
  lng: number;
  radiusKm: number;
  /** null = block state unknown → a failed read (`ok: false`, stage `blocks`), never an empty result (§115). */
  blockedSet: Set<string> | null;
  /** Hard cap on emitted pins. */
  maxPins?: number;
}

/** How many candidate rows the bbox scan may pull before distance filtering. */
export const BUDDY_SCAN_LIMIT = 500;
/** How many pins may reach the projection from one viewport. */
export const MAX_BUDDY_PINS = 200;

/** census-discovery §117 (SW16): the viewport prefilter is lib/nearBox's box (the traveler scan's since §116 SW13); */
/** this module keeps no km-per-degree constant of its own. */

export async function readBuddyMapPins(
  sc: SupabaseClient | any,
  viewerId: string,
  opts: BuddyMapPinsOptions,
): Promise<BuddyMapPinsResult> {
  // 1. The marketplace's own feature gate. `isFlagEnabled` is the shared
  //    fail-closed reader of the SAME `rent_buddy_enabled` row that
  //    requireRentBuddyEnabled reads; an absent or disabled row means "no
  //    buddies" (the route's 403). An UNREADABLE row is a failed read (§115, B8):
  //    it exposes nobody and is never named as a whole, empty layer.
  const buddyFlag = await readFlagState(sc, "rent_buddy_enabled"); if (buddyFlag === "unreadable") return { ok: false, stage: "flag", message: "rent_buddy_enabled could not be read" }; if (buddyFlag !== "on") return { ok: true, pins: [] };

  // 2. Fail-closed blocks. Unknown block state → nobody, never "no blocks".
  const blocked = opts.blockedSet;
  if (blocked === null) return { ok: false, stage: "blocks", message: "block state unknown" };  // §115: exposes nobody, and is not an empty marketplace

  // 4. Viewport prefilter: the circle's exact box on haversineKm's 6371 km
  //    sphere (lib/nearBox) — two longitude ranges when the circle crosses the
  //    180th meridian, every longitude when it holds a pole. It replaces
  //    lat ± r/111.32, lng ± r/(111.32·max(0.2, cos lat)), which was narrower
  const box = nearBox(opts.lat, opts.lng, opts.radiusKm);  // than the circle everywhere,
  //    did not wrap, and dropped buddies inside the radius while the layer was
  //    still named whole (census-discovery §117, DV-83 sweep SW16).

  // 3. The marketplace's visibility predicate, unchanged: status AND
  //    admin_status must both be 'active'. Ordering matches the search
  //    endpoint's default so the cap keeps the same buddies it would.
  const { data, error } = await applyNearBox(sc
    .from("rent_buddy_profiles")
    .select(BUDDY_PUBLIC_COLUMNS)
    .eq("status", "active")
    .eq("admin_status", "active")
    .not("meetup_base_lat", "is", null)
    .not("meetup_base_lng", "is", null),
    box,
    "meetup_base_lat",
    "meetup_base_lng",
  )  // §117 (SW16): the box is still in the query, ahead of the scan cap
    .order("review_count", { ascending: false })
    .limit(BUDDY_SCAN_LIMIT);

  if (error) return { ok: false, stage: "profiles", message: error.message };

  const maxPins = opts.maxPins ?? MAX_BUDDY_PINS;
  const pins: BuddyMapPin[] = []; let capped = (data ?? []).length >= BUDDY_SCAN_LIMIT;  // census-discovery §115 (B8): a scan that filled its cap was cut

  for (const raw of (data ?? []) as any[]) {
    if (pins.length >= maxPins) { capped = true; break; }  // §115 (B8): rows past the pin cap were never read
    // A buddy the viewer blocked in either direction is not on their map. The
    // marketplace search has no block filter at all (see the note below); this
    // is an ADDITIONAL narrowing the map layer applies, matching every other
    // people-bearing layer in the gateway.
    if (raw?.user_id && blocked.has(String(raw.user_id))) continue;

    // Belt and braces even though the bbox already excluded nulls: a row
    // without a usable base has no honest pin position, and this reader will
    // not substitute one.
    if (!hasMeetupBase(raw)) continue;

    const km = haversineKm(
      opts.lat,
      opts.lng,
      raw.meetup_base_lat as number,
      raw.meetup_base_lng as number,
    );
    if (km > opts.radiusKm) continue;

    // 5. THE field-exposure composition, identical to the search endpoint's.
    const pin = mapBuddyPublicProfile(stripBuddyPrivateFields(raw, false));
    if (pin) pins.push(pin);
  }

  return capped ? { ok: true, pins, capped: true } : { ok: true, pins };
}

/**
 * NOTE ON THE MARKETPLACE'S BLOCK FILTER — reported here, since fixed.
 *
 * When this reader was extracted, POST /api/rent-a-buddy/search applied no
 * block filter at all: a buddy the viewer had blocked, or who had blocked the
 * viewer, still appeared in marketplace results. The map layer added the
 * filter for its own pins and deliberately left the endpoint alone, because
 * changing behaviour inside an extraction is how a behaviour change ships
 * disguised as a refactor.
 *
 * That separate change has since happened. Search now resolves the same
 * fetchBlockedSet this reader consumes, so the two share one definition of who
 * is hidden rather than two that can drift.
 *
 * The narrowing recorded below is therefore no longer that the map filters and
 * the marketplace does not. It is that search resolves the viewer through
 * optionalUser and stays public, while this reader is always called with a
 * viewer in hand.
 *
 * STILL OPEN, and not this module's to fix: GET /api/rent-a-buddy/sections has
 * no block filter either — the same defect class on a different endpoint.
 */
