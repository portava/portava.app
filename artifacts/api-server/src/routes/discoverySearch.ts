/**
 * GET /api/discovery/search  — Unified cross-type search
 *
 * Contract defined in lib/api-spec/openapi.yaml (operationId: discoverySearch).
 * Query-param validation uses the generated DiscoverySearchQueryParams Zod schema
 * from @workspace/api-zod, supplemented by a server-side sanitization pass.
 *
 * Privacy rules (server-side, fail-closed):
 *   - Private accounts (is_private=true) excluded entirely.
 *   - Suspended/banned/deleted accounts excluded (account_status filter).
 *   - Profile-discovery opt-outs excluded (fail-closed on query error).
 *   - Blocked users excluded in both directions; block lookup failure is
 *     fail-closed — the entire search returns empty when block state is unknown.
 *   - Content owner/host account-status verified: events, trips, circles, and
 *     posts from suspended/banned/deleted owners are excluded.
 *   - Private trips/events/circles: only visibility='public' returned.
 *   - Plans: only items from public trips or caller-owned trips returned.
 *   - Moderation-removed content excluded (deleted/cancelled/banned statuses).
 *   - City/country aggregation only reads from active, non-private,
 *     non-blocked profiles so private/blocked signals cannot leak via geo.
 *   - Private fields (email, phone, location coords, safety data, verification)
 *     are never selected or included in any result.
 *   - Age-restricted content: profiles with user_privacy_settings.age_restriction_enabled=true
 *     are excluded entirely (fail-closed). Because viewer age is not available in
 *     the session, the endpoint cannot verify whether the viewer meets the age gate —
 *     so all age-restricted profiles are hidden from discovery. Content owned/hosted by
 *     an age-restricted profile is also excluded (events, trips, circles, posts).
 *     City/country aggregation excludes age-restricted profiles for the same reason.
 *     If the age-restricted set lookup fails, the search returns empty results
 *     (consistent with the block-state fail-closed pattern).
 *
 * Pagination:
 *   - Each per-type query fetches limit+1 rows from DB. hasMore is derived from
 *     overflow (results.length > limit), eliminating false-positive hasMore.
 *   - type=all: FAN_LIMIT=20 per bucket across all 17 types; merged round-robin;
 *     sliced at [offset, offset+limit]; hasMore when pool exceeds offset+limit.
 *
 * actionState per type:
 *   travelers/buddies → { isFollowing: boolean }
 *   events           → { isAttending: boolean }
 *   others           → null
 *
 * Rate limited: 30 req/min per user.
 */

import { Router } from "express";
import { DiscoverySearchQueryParams } from "@workspace/api-zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { resolveMediaForPosts } from "../lib/postMediaResolve.js";
import { isPostPublished } from "../lib/postVisibility.js";
import { checkRateLimit } from "../lib/rateLimit";
import { logger as rootLogger } from "../lib/logger";
import {
  applyAliases,
  matchTier,
  rankByMatchTier,
  rankCombined,
  parseTimeIntent,
  parseNearbyIntent,
  haversineKm,
  type SearchQueryContext,
} from "./discoverySearchHelpers.js";
import {
  suggestCanonicalLocations,
  normalizeLocationName,
  type CanonicalRow,
} from "../lib/canonicalLocations";
import type { SensitivityLevel } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import { nameVisibilitySet } from "../lib/publicIdentity";
// The canonical author-side block rule for a `discovery_places` row. Shared with
// routes/discovery.ts (which re-exports it) rather than re-implemented here —
// two copies of a privacy rule is how these two serve points drifted apart in
// the first place.
import { submitterIsVisible } from "../lib/blocks.js";
import {
  logDiscoveryServe,
  DiscoveryServePoint,
  searchTypeToItemKind,
} from "../lib/discoveryServeLog.js";

const router = Router();
const logger = rootLogger.child({ route: "discoverySearch" });

// ── SearchType enum (mirrors openapi.yaml) ────────────────────────────────────

const SEARCH_TYPES = [
  "all", "travelers", "buddies", "events", "trips", "plans",
  "places", "hidden_gems", "hashtags", "posts", "circles",
  "stamps", "activities", "cities", "countries", "languages",
  "interests", "vibes",
] as const;

// Exported (additive, behavior-preserving) so the Global Input Intelligence
// gateway (POST /input-assistance/suggest) can reuse this exact type when it
// delegates candidate generation into dispatchSearch. No route behavior changes.
export type SearchType = typeof SEARCH_TYPES[number];

// ── PostgREST injection guard ──────────────────────────────────────────────────
//
// .or() expressions in PostgREST use commas and parentheses as metacharacters.
// Strip them so user input cannot break filter syntax or bypass privacy controls.

// Exported (additive) so the input-assistance gateway sanitizes typed input
// with the exact same PostgREST-injection guard the search path uses.
export function sanitizeQuery(s: string): string {
  return s.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

// ── Normalized result shape ────────────────────────────────────────────────────
//
// Matches the SearchResult schema in openapi.yaml.

export interface SearchResult {
  id: string;
  type: Exclude<SearchType, "all">;
  title: string;
  subtitle: string | null;
  avatarUrl: string | null;
  imageUrl: string | null;
  fallbackInitials: string | null;
  locationPreview: string | null;
  matchedReason: string | null;
  actionState: Record<string, boolean | string | number> | null;
  privacyState: { isPrivate?: boolean; isPublic?: boolean } | null;
  accessState: { canAccess: boolean } | null;
  destinationRoute: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  startsAt: string | null;
  /** True when the result user holds verified traveler status. Only set for travelers/buddies results. */
  verified?: boolean;
  /** True when this user is an @Portava Official account. Only set for travelers/buddies results. */
  isOfficial?: boolean;
}

// ── §27 map placement — the position contract ────────────────────────────────
//
// §27 ends with "Geographic results should center or frame the relevant map
// object". A search result reaches the map through the client's search adapter
// (travel-buddy-standalone/src/features/map/search/searchAdapter.ts), which
// reads coordinates out of the untyped `metadata` bag — `metadata.lat` /
// `metadata.lng`, the shape searchPlaces has always used. A result whose type
// the adapter recognises but whose metadata carries no position is DROPPED: it
// is listed, it is tappable, and it can never be placed.
//
// That asymmetry — recognised type, unusable payload — is why events, hidden
// gems, activities, cities and countries were invisible on the map while
// looking perfectly healthy in the list. Every emitter below whose type the
// adapter maps MUST put lat/lng in metadata, `null` included, so "this row has
// no position" is a value rather than a missing key.
//
// The single exception is a position the viewer is not authorized to have:
// §24 says the public map must never receive more location detail than the
// viewer may see, so a withheld position is emitted as null, never coarsened
// upward and never guessed.

/** A metadata position pair. `null` means "no position this viewer may have". */
interface MetadataPosition {
  lat: number | null;
  lng: number | null;
}

/** Narrow a raw DB numeric to a finite coordinate, else null. */
function coord(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A position is emitted only when BOTH halves survive — never half a pin. */
function position(lat: unknown, lng: unknown): MetadataPosition {
  const a = coord(lat);
  const b = coord(lng);
  return a === null || b === null ? { lat: null, lng: null } : { lat: a, lng: b };
}

// ── §24 protected location — hidden gem coordinate floor ─────────────────────
//
// The single choke point for gem coordinate disclosure is
// services/hiddenGems/HiddenGemPrivacyGuard.resolveGemCoords. For a viewer with
// no save row and no accepted-trip binding — which is every viewer on this
// endpoint, because search carries neither — its five-level rule reduces to:
//
//   protected                 → NO coordinates, ever. It is the one level that
//                               does not fall through to the approximate
//                               centroid; the guard returns nulls outright.
//   approximate               → the approx_* centroid.
//   reveal_after_save         → exact only on proof of a save; without it the
//                               guard's fallback is the approx_* centroid.
//   reveal_after_acceptance   → exact only on proof of accepted membership AND
//                               a gem↔trip binding; without both, approx_*.
//   public                    → exact.
//
// Search applies that rule AT ITS FLOOR. A search result is a list row a
// stranger produces by typing a name, and §24 exists precisely because search
// is where someone hunting a location looks — so this endpoint emits the
// APPROXIMATE pair or nothing, for every viewer including the submitter. A gem
// whose sensitivity denies placement is emitted with a null position rather
// than an approximate one, because "roughly here" is still a disclosure.
//
// The exact pair is therefore NOT in the select list. It never enters this
// process, so no future edit to the emitter below can leak it by accident —
// the guarantee is structural, not a discipline someone has to remember.

/** The five real `hidden_gem_sensitivity` enum labels (verified against the live schema). */
const GEM_SENSITIVITY_LEVELS: ReadonlySet<SensitivityLevel> = new Set<SensitivityLevel>([
  "public",
  "approximate",
  "reveal_after_save",
  "reveal_after_acceptance",
  "protected",
]);

/** Levels for which resolveGemCoords returns no coordinates at all. */
const GEM_POSITION_DENIED: ReadonlySet<SensitivityLevel> = new Set<SensitivityLevel>([
  "protected",
]);

/**
 * `hidden_gem_status` labels a gem search may return. The enum's full label set
 * is `pending | active | hidden | merged` (verified against the live schema);
 * only `active` is publicly searchable. Exported so a test can hold this filter
 * against the real enum instead of against a fixture's invented value.
 */
export const GEM_SEARCHABLE_STATUSES = ["active"] as const;

export interface GemSearchPosition extends MetadataPosition {
  /** "approximate" when a centroid is emitted; "hidden" when nothing is. Never "exact". */
  coordsPrecision: "approximate" | "hidden";
}

/**
 * The position a hidden gem may carry on the search surface.
 *
 * Reads ONLY the approximate pair — the exact columns are deliberately absent
 * from both this signature and the emitter's select list. Fails closed: a
 * missing, unrecognised, or placement-denying sensitivity yields no position.
 *
 * Exported for direct test against resolveGemCoords, so this floor cannot
 * silently drift away from the guard it is derived from.
 */
export function gemSearchPosition(g: {
  sensitivity_level?: string | null;
  approx_latitude?: number | null;
  approx_longitude?: number | null;
}): GemSearchPosition {
  const hidden: GemSearchPosition = { lat: null, lng: null, coordsPrecision: "hidden" };
  const level = g.sensitivity_level;
  if (typeof level !== "string") return hidden;
  if (!GEM_SENSITIVITY_LEVELS.has(level as SensitivityLevel)) return hidden;
  if (GEM_POSITION_DENIED.has(level as SensitivityLevel)) return hidden;

  const p = position(g.approx_latitude, g.approx_longitude);
  if (p.lat === null) return hidden;
  return { lat: p.lat, lng: p.lng, coordsPrecision: "approximate" };
}

// ── Canonical centroids for aggregated city/country rows ─────────────────────
//
// searchCities/searchCountries aggregate NAMES out of profiles, and `profiles`
// holds no coordinates — so unlike every other emitter there is no position on
// the source row to pass through. The centroid comes from the same public geo
// registry the /discovery/suggest path already uses (canonicalToCityResult),
// which is what stops the two paths from disagreeing about where a city is.
//
// Registry rows carry no user linkage, so nothing here can leak a private
// user's location. Enrichment only: any failure leaves the position null and
// the result still lists.

/** canonical_locations kinds that class as a city (mirrors canonicalLocations.kindClass). */
const CANONICAL_CITY_KINDS = ["city", "town", "district", "neighborhood"] as const;
/** canonical_locations kinds that class as a country. */
const CANONICAL_COUNTRY_KINDS = ["country"] as const;

interface CanonicalCentroid { id: string; lat: number; lng: number }

/**
 * Batched centroid lookup, keyed by `normalizeLocationName` — the same
 * normalization the registry stores in `normalized_name`, imported rather than
 * re-derived so "Đà Nẵng" and a typed "da nang" fold identically here too.
 *
 * One query for the whole page. Rows without both coordinates are skipped, so
 * a registry row that exists but has never been geocoded yields no position
 * instead of a half pin.
 */
async function canonicalCentroids(
  sc: any, names: string[], kinds: readonly string[],
): Promise<Map<string, CanonicalCentroid>> {
  const out = new Map<string, CanonicalCentroid>();
  const keys = [...new Set(names.map((n) => normalizeLocationName(n)).filter((k) => k.length > 0))];
  if (keys.length === 0) return out;
  try {
    const { data, error } = await sc
      .from("canonical_locations")
      .select("id, kind, normalized_name, lat, lng")
      .in("normalized_name", keys)
      .in("kind", kinds as unknown as string[])
      .limit(keys.length * 4);
    if (error || !data) return out;
    for (const r of data as any[]) {
      const key = typeof r.normalized_name === "string" ? r.normalized_name : null;
      if (key === null || out.has(key)) continue;
      const p = position(r.lat, r.lng);
      if (p.lat === null || p.lng === null) continue;
      out.set(key, { id: r.id as string, lat: p.lat, lng: p.lng });
    }
  } catch {
    // Enrichment is never a gate — an unreachable registry means unplaced
    // rows, not a failed search.
  }
  return out;
}

// ── Static taxonomic datasets ──────────────────────────────────────────────────

const COMMON_LANGUAGES = [
  "English","Spanish","French","German","Mandarin","Japanese","Arabic",
  "Portuguese","Russian","Hindi","Italian","Korean","Dutch","Turkish",
  "Polish","Swedish","Danish","Norwegian","Finnish","Tagalog","Indonesian",
  "Thai","Vietnamese","Malay","Swahili","Zulu","Greek","Czech","Romanian","Hungarian",
];

const COMMON_INTERESTS = [
  "Travel","Photography","Hiking","Food","Music","Art","Technology","Sports",
  "Fashion","Fitness","Cooking","Reading","Gaming","Dancing","Cinema","Nature",
  "Architecture","Surfing","Skiing","Yoga","Cycling","Running","Swimming",
  "Diving","Culture","History","Languages","Volunteering","Nightlife","Wellness",
];

const COMMON_VIBES = [
  "Adventure","Relaxation","Luxury","Budget","Solo","Family","Couple","Group",
  "Backpacking","Cultural","Beach","Mountain","City","Festival","Foodie",
  "Eco","Spiritual","LGBTQ+","Digital Nomad","Work and Travel",
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function initials(title: string): string {
  const words = title.trim().split(/\s+/).slice(0, 2);
  return words.map((w) => (w[0] ?? "").toUpperCase()).join("") || "?";
}

function sqlPattern(q: string): string {
  // The pattern is interpolated into PostgREST `.or("col.ilike.<pat>,...")`
  // filter strings, whose grammar treats `,` `(` `)` as structure — a query
  // containing them could terminate the ilike value and inject additional
  // filter clauses. They carry no search meaning here, so strip them outright;
  // then escape the LIKE wildcards `%` and `_`.
  return `%${q.replace(/[,()]/g, "").replace(/[%_]/g, "\\$&")}%`;
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const n = parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

// ── Blocked-user set (fail-closed) ────────────────────────────────────────────
//
// Returns null on any error. Callers that receive null MUST return [] —
// never expose content when the block state is unknown.

async function fetchBlockedSet(sc: any, userId: string): Promise<Set<string> | null> {
  try {
    const { data, error } = await sc
      .from("blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
    if (error) return null;
    const set = new Set<string>();
    for (const b of (data ?? [])) {
      if ((b as any).blocker_id === userId) set.add((b as any).blocked_id);
      else set.add((b as any).blocker_id);
    }
    return set;
  } catch {
    return null;
  }
}

// ── Age-restricted profile set (fail-closed) ──────────────────────────────────
//
// Returns the set of user IDs who have set age_restriction_enabled=true in their
// user_privacy_settings. Because viewer age is unavailable in this endpoint,
// all such profiles are hidden from discovery (fail-closed).
// Returns null on any DB error — callers MUST return [] in that case.

// Exported (additive) so the input-assistance gateway can apply the identical
// fail-closed age-restriction filter before projection. Behavior unchanged.
export async function fetchAgeRestrictedSet(sc: any): Promise<Set<string> | null> {
  try {
    const { data, error } = await sc
      .from("user_privacy_settings")
      .select("user_id")
      .eq("age_restriction_enabled", true);
    if (error) return null;
    return new Set<string>((data ?? []).map((r: any) => r.user_id as string));
  } catch {
    return null;
  }
}

// ── Owner account-status guard ─────────────────────────────────────────────────
//
// Fetches the set of IDs (from a candidate owner/host list) that have an
// active account. Used to exclude content from suspended/banned/deleted owners.
// Fails closed (returns empty set) on DB errors to prevent leaking owner-gated content.

async function fetchActiveOwnerSet(sc: any, ownerIds: string[]): Promise<Set<string>> {
  if (ownerIds.length === 0) return new Set();
  try {
    const { data, error } = await sc
      .from("profiles")
      .select("id")
      .in("id", ownerIds)
      .in("account_status", ["active"]);
    // Fail-closed: unknown owner status → treat all as inactive (exclude content)
    if (error) return new Set();
    return new Set<string>((data ?? []).map((p: any) => p.id as string));
  } catch {
    return new Set();  // fail-closed: prefer exclusion over leaking suspended-owner content
  }
}

// ── Per-type search functions ──────────────────────────────────────────────────
//
// Each function fetches fetchLimit = limit+1 rows so the caller can derive
// hasMore without false positives (hasMore = raw.length > limit).
// Returns [] immediately when blockedSet is null (fail-closed).

/**
 * Travelers / Buddies
 *
 * Privacy:
 *   - is_private=true accounts ARE included, but rendered as a locked preview:
 *     no avatar/location/matchedReason, canAccess=false, isFollowing=false.
 *     This matches the /api/users/search "find travelers" surface so a private
 *     account is discoverable everywhere or nowhere, never inconsistently.
 *   - Only account_status='active' (DB filter).
 *   - Profile-discovery opt-outs excluded (secondary query, fail-closed).
 *   - Blocked users excluded; returns [] on null blockedSet.
 *
 * actionState: { isFollowing: boolean, isRequestSent?: boolean }
 */
async function searchTravelers(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number, isBuddy = false,
  ctx?: SearchQueryContext,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    let query = sc
      .from("profiles")
      .select("id, handle, username, name, avatar_url, is_private, home_city, home_country, account_status, verified, is_official, show_profile_picture_publicly")
      .or(`name.ilike.${pat},handle.ilike.${pat},username.ilike.${pat}`)
      .neq("id", userId)
      .in("account_status", ["active"])
      .order("name", { ascending: true })
      .range(offset, offset + fetchLimit - 1);

    if (isBuddy) query = query.not("buddy_verified_at", "is", null);

    const { data, error } = await query;
    if (error || !data) return [];

    const rows = (data as any[]).filter(
      (p: any) => !blockedSet.has(p.id as string) && !ageRestrictedSet.has(p.id as string),
    );
    if (rows.length === 0) return [];

    const ids = rows.map((p: any) => p.id as string);

    // Fail-closed: if discovery-opt-out query fails, return nothing
    const { data: noDisc, error: noDiscErr } = await sc
      .from("profile_privacy_settings")
      .select("user_id")
      .in("user_id", ids)
      .eq("allow_profile_discovery", false);
    if (noDiscErr) return [];

    const noDiscSet = new Set<string>((noDisc ?? []).map((r: any) => r.user_id as string));
    const visible = rows.filter((p: any) => !noDiscSet.has(p.id as string));
    if (visible.length === 0) return [];

    // Universal display-name rule: batch-resolve which subjects opted in to
    // showing their real name. Hidden names must not be searchable/matchable —
    // if the query matched only the (hidden) name, drop the row so searching
    // someone's name cannot reveal it belongs to them.
    const allowedNames = await nameVisibilitySet(sc, visible.map((p: any) => p.id as string));
    const qLower = q.toLowerCase();
    const nameSafe = visible.filter((p: any) => {
      if (p.id === userId) return true;                 // viewer never redacted
      if (allowedNames.has(p.id as string)) return true;
      const h = ((p.handle as string | null) ?? "").toLowerCase();
      const un = ((p.username as string | null) ?? "").toLowerCase();
      return h.includes(qLower) || un.includes(qLower);
    });
    if (nameSafe.length === 0) return [];

    const visibleIds = nameSafe.map((p: any) => p.id as string);
    const [{ data: followEdges }, { data: pendingRequests }, { data: friendsAsA }, { data: friendsAsB }] = await Promise.all([
      sc.from("user_follows")
        .select("following_id")
        .eq("follower_id", userId)
        .in("following_id", visibleIds),
      sc.from("friend_requests")
        .select("recipient_id")
        .eq("requester_id", userId)
        .eq("status", "pending")
        .in("recipient_id", visibleIds),
      // user_friendships stores the normalized (min, max) pair (see
      // normalizedFriendshipPair in lib/friendDecisions.ts) — which side of
      // the row `userId` lands on depends on UUID comparison, not who sent
      // the request, so both directions must be queried.
      sc.from("user_friendships").select("user_b").eq("user_a", userId).in("user_b", visibleIds),
      sc.from("user_friendships").select("user_a").eq("user_b", userId).in("user_a", visibleIds),
    ]);
    const followingSet = new Set<string>((followEdges ?? []).map((e: any) => e.following_id as string));
    const pendingSet = new Set<string>((pendingRequests ?? []).map((e: any) => e.recipient_id as string));
    const friendSet = new Set<string>([
      ...(friendsAsA ?? []).map((e: any) => e.user_b as string),
      ...(friendsAsB ?? []).map((e: any) => e.user_a as string),
    ]);

    const type: Exclude<SearchType, "all"> = isBuddy ? "buddies" : "travelers";
    const mapped: SearchResult[] = nameSafe.map((p: any): SearchResult => {
      // Name defaults to @handle unless the subject opted in (or is the viewer).
      const nameAllowed = p.id === userId || allowedNames.has(p.id as string);
      const presented = nameAllowed ? ((p.name as string | null) ?? null) : null;
      const fallbackLabel = presented ?? (p.handle as string) ?? "?";
      const isFollowing = followingSet.has(p.id as string);
      const isFriend = friendSet.has(p.id as string);
      // Private accounts the viewer doesn't already follow get a locked
      // preview: no avatar/location/matchedReason leak, canAccess=false.
      // Once followed, the row behaves exactly like a public traveler.
      const isPrivate = ((p.is_private as boolean) ?? false) && !isFollowing;
      // Independent of is_private: a PUBLIC profile's owner can still opt out
      // of showing their photo to non-followers/non-friends via
      // show_profile_picture_publicly. isPrivate's own gate above already
      // covers the case where the account itself is private.
      const showAvatar = isFollowing || isFriend || (p as any).show_profile_picture_publicly !== false;
      return {
        id: p.id,
        type,
        title: presented ?? (p.handle as string) ?? "",
        subtitle: p.handle ? `@${p.handle as string}` : null,
        avatarUrl: (!isPrivate && showAvatar) ? ((p.avatar_url as string | null) ?? null) : null,
        imageUrl: null,
        fallbackInitials: initials(fallbackLabel),
        locationPreview: isPrivate
          ? null
          : [(p.home_city as string | null), (p.home_country as string | null)].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: isPrivate
          ? { isFollowing, isRequestSent: pendingSet.has(p.id as string) }
          : { isFollowing },
        privacyState: { isPrivate },
        accessState: { canAccess: !isPrivate },
        destinationRoute: p.handle
          ? `/passport/${p.handle as string}`
          : `/passport/${p.id as string}`,
        metadata: null,
        createdAt: null,
        startsAt: null,
        verified: (p.verified as boolean) ?? false,
        isOfficial: (p.is_official as boolean) ?? false,
      };
    });

    return mapped;
  } catch {
    return [];
  }
}

/**
 * Events — public only; blocked hosts excluded; suspended hosts excluded.
 * actionState: { isAttending: boolean }
 */
async function searchEvents(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
  ctx?: SearchQueryContext,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    let evQ: any = sc
      .from("events")
      // location_lat/location_lng/show_exact_location feed the §27 map position;
      // the gate below is toAuthorizedEventView's, not a second opinion.
      .select("id, title, host_id, cover_url, city, country, starts_at, visibility, state, created_at, location_lat, location_lng, show_exact_location")
      .or(`title.ilike.${pat},city.ilike.${pat}`)
      .eq("visibility", "public")
      // `event_state` is an ENUM: draft | open | full | waitlist | started |
      // completed | cancelled | archived. "deleted" and "banned" are NOT labels,
      // and Postgres rejects an unknown enum literal outright (22P02) rather
      // than matching nothing — so `.neq("state","deleted")` made every event
      // search error out and fall into the `return []` below.
      //
      // The replacement is mapSearch.loadNearbyEvents' predicate verbatim, so
      // the discovery list and the map agree about which events exist (§26).
      // Every label in it is real, and it also drops the unpublished `draft`
      // events the broken filter would have surfaced.
      .not("state", "in", '("draft","cancelled","archived")')
      .order("starts_at", { ascending: true });

    if (ctx?.startsAfter || ctx?.startsBefore) {
      // Time-intent active — apply the explicit date window and include past events in range
      if (ctx.startsAfter)  evQ = evQ.gte("starts_at", ctx.startsAfter);
      if (ctx.startsBefore) evQ = evQ.lt("starts_at",  ctx.startsBefore);
    } else {
      // Default: upcoming-first — only surface events that haven't ended (started ≤ 2h ago)
      const cutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
      evQ = evQ.gte("starts_at", cutoff);
    }

    const { data, error } = await evQ.range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const rows = (data as any[]).filter(
      (e: any) => !blockedSet.has(e.host_id as string) && !ageRestrictedSet.has(e.host_id as string),
    );
    if (rows.length === 0) return [];

    // Exclude events from suspended/banned/deleted hosts
    const hostIds = [...new Set(rows.map((e: any) => e.host_id as string))];
    const activeHostSet = await fetchActiveOwnerSet(sc, hostIds);
    const activeRows = rows.filter((e: any) => activeHostSet.has(e.host_id as string));
    if (activeRows.length === 0) return [];

    const eventIds = activeRows.map((e: any) => e.id as string);
    const { data: rsvpRows } = await sc
      .from("event_rsvps")
      .select("event_id")
      .eq("user_id", userId)
      .eq("status", "going")
      .in("event_id", eventIds);
    const attendingSet = new Set<string>((rsvpRows ?? []).map((r: any) => r.event_id as string));

    const mapped: SearchResult[] = activeRows.map((e: any): SearchResult => {
      // §24 venue disclosure. This is lib/privacy/eventSerializers'
      // toAuthorizedEventView rule verbatim —
      //   showCoords = isHost || goingRsvp || show_exact_location !== false
      // — so a search row and the event detail agree about whether this viewer
      // may see the venue. `show_exact_location` defaults to FALSE in the
      // schema, which makes the default outcome "no pin for strangers"; the
      // participant branch discloses nothing the detail route would not.
      const isHost = (e.host_id as string | null) === userId;
      const isGoing = attendingSet.has(e.id as string);
      const showVenue = isHost || isGoing || e.show_exact_location !== false;
      const pos = showVenue ? position(e.location_lat, e.location_lng) : { lat: null, lng: null };
      return {
      id: e.id,
      type: "events",
      title: (e.title as string) ?? "",
      subtitle: (e.city as string | null) ?? null,
      avatarUrl: null,
      imageUrl: (e.cover_url as string | null) ?? null,
      fallbackInitials: initials((e.title as string) ?? ""),
      locationPreview: [(e.city as string | null), (e.country as string | null)].filter(Boolean).join(", ") || null,
      matchedReason: null,
      actionState: { isAttending: attendingSet.has(e.id as string) },
      privacyState: { isPublic: true },
      accessState: { canAccess: true },
      destinationRoute: `/event/${e.id as string}`,
      metadata: { hostId: e.host_id, status: e.state, lat: pos.lat, lng: pos.lng },
      createdAt: (e.created_at as string | null) ?? null,
      startsAt: (e.starts_at as string | null) ?? null,
      };
    });

    return mapped;
  } catch {
    return [];
  }
}

/**
 * Trips — public only; blocked/suspended owners excluded.
 */
async function searchTrips(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
  ctx?: SearchQueryContext,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    let trQ: any = sc
      .from("trips")
      .select("id, title, destination_city, destination_country, owner_id, cover_url, start_date, status, visibility, created_at")
      .or(`title.ilike.${pat},destination_city.ilike.${pat},destination_country.ilike.${pat}`)
      .eq("visibility", "public")
      .eq("show_in_discovery", true)
      // `trip_status` is an ENUM: draft | planning | upcoming | active |
      // completed | cancelled | archived. "deleted" and "banned" are NOT
      // labels, and Postgres rejects an unknown enum literal outright (22P02)
      // rather than matching nothing — so `type=trips` search errored out and
      // fell into the `if (error || !data) return []` below on every request.
      //
      // Same shape as the events fix above: a denylist of real labels that also
      // drops unpublished `draft` trips the broken filter would have surfaced.
      .not("status", "in", '("draft","cancelled","archived")')
      .order("start_date", { ascending: true });
    // Apply time-intent date bounds to trip start_date when present
    if (ctx?.startsAfter)  trQ = trQ.gte("start_date", ctx.startsAfter.slice(0, 10));
    if (ctx?.startsBefore) trQ = trQ.lt("start_date",  ctx.startsBefore.slice(0, 10));
    const { data, error } = await trQ.range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const rows = (data as any[]).filter(
      (t: any) => !blockedSet.has(t.owner_id as string) && !ageRestrictedSet.has(t.owner_id as string),
    );
    if (rows.length === 0) return [];

    const ownerIds = [...new Set(rows.map((t: any) => t.owner_id as string))];
    const activeOwnerSet = await fetchActiveOwnerSet(sc, ownerIds);

    return rows
      .filter((t: any) => activeOwnerSet.has(t.owner_id as string))
      .map((t: any): SearchResult => ({
        id: t.id,
        type: "trips",
        title: (t.title as string) ?? (t.destination_city as string) ?? "",
        subtitle: [(t.destination_city as string | null), (t.destination_country as string | null)].filter(Boolean).join(", ") || null,
        avatarUrl: null,
        imageUrl: (t.cover_url as string | null) ?? null,
        fallbackInitials: initials((t.title as string) ?? ""),
        locationPreview: [(t.destination_city as string | null), (t.destination_country as string | null)].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: null,
        privacyState: { isPublic: true },
        accessState: { canAccess: true },
        destinationRoute: `/trip/${t.id as string}`,
        metadata: { ownerId: t.owner_id, status: t.status },
        createdAt: (t.created_at as string | null) ?? null,
        startsAt: (t.start_date as string | null) ?? null,
      }));
  } catch {
    return [];
  }
}

/**
 * Plan items — only from public trips or caller-owned trips (security).
 * Blocked creator excluded.
 */
async function searchPlans(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
  ctx?: SearchQueryContext,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("trip_plan_items")
      .select("id, title, trip_id, creator_id, created_at")
      .ilike("title", pat)
      .is("removed_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const items = (data as any[]).filter(
      (p: any) => !blockedSet.has(p.creator_id as string) && !ageRestrictedSet.has(p.creator_id as string),
    );
    if (items.length === 0) return [];

    const tripIds = [...new Set(items.map((p: any) => p.trip_id as string))];
    const { data: trips } = await sc
      .from("trips")
      .select("id, visibility, show_in_discovery, owner_id, status, start_date")
      .in("id", tripIds)
      // Same dead literals as searchTrips above ("deleted" / "banned" are not
      // `trip_status` labels), and worse here: the result is destructured as
      // `const { data: trips }` with the error never inspected, so `trips` was
      // undefined, `allowedTrips` empty, and EVERY plan was dropped as
      // "no allowed parent trip". `type=plans` returned [] on every request.
      .not("status", "in", '("draft","cancelled","archived")');

    const allowedTrips = (trips ?? []).filter(
      (t: any) =>
        // Public trips: also require show_in_discovery so owners who opted out are excluded.
        // Caller-owned trips are always visible regardless of the flag.
        (((t.visibility as string) === "public" && t.show_in_discovery === true) ||
          (t.owner_id as string) === userId) &&
        !blockedSet.has(t.owner_id as string) &&
        !ageRestrictedSet.has(t.owner_id as string) &&
        // Time-intent: filter by parent trip's start_date when bounds are present
        (!ctx?.startsAfter  || !(t.start_date as string | null) || (t.start_date as string) >= ctx.startsAfter.slice(0, 10)) &&
        (!ctx?.startsBefore || !(t.start_date as string | null) || (t.start_date as string) <  ctx.startsBefore.slice(0, 10)),
    );

    const allowedOwnerIds: string[] = [...new Set<string>(allowedTrips.map((t: any) => t.owner_id as string))];
    const activeTripOwnerSet = await fetchActiveOwnerSet(sc, allowedOwnerIds);

    const visibleTripIds = new Set<string>(
      allowedTrips
        .filter((t: any) => activeTripOwnerSet.has(t.owner_id as string))
        .map((t: any) => t.id as string),
    );

    return items
      .filter((p: any) => visibleTripIds.has(p.trip_id as string))
      .map((p: any): SearchResult => ({
        id: p.id,
        type: "plans",
        title: (p.title as string) ?? "",
        subtitle: null,
        avatarUrl: null,
        imageUrl: null,
        fallbackInitials: initials((p.title as string) ?? ""),
        locationPreview: null,
        matchedReason: null,
        actionState: null,
        privacyState: null,
        accessState: { canAccess: true },
        destinationRoute: `/trip/${p.trip_id as string}/plan`,
        metadata: { tripId: p.trip_id, creatorId: p.creator_id },
        createdAt: (p.created_at as string | null) ?? null,
        startsAt: null,
      }));
  } catch {
    return [];
  }
}

/**
 * Discovery places — DB-backed curated places (active only), minus the rows
 * submitted by someone the viewer is blocked with in either direction.
 *
 * The block filter is applied HERE, on this route's own `discovery_places`
 * query. routes/discovery.ts describes queryDbPlaces as "the single funnel
 * through which a discovery_places row reaches any discovery serve point" —
 * that was never true of serve points 8 and 9. `/discovery/search` and
 * `/discovery/suggest` build this query themselves, so they never passed
 * through that funnel and served a blocked submitter's row (and its blurb,
 * photo and rating) straight back to the person who blocked them, long after
 * every other surface had stopped. Both call the same `submitterIsVisible`
 * rule from lib/blocks.ts.
 *
 * `blockedSet === null` means the blocks table could not be read: return
 * nothing at all, matching every other search function in this file. Serving
 * the full unfiltered corpus on an unreadable block list is the failure mode
 * that matters.
 */
async function searchPlaces(
  sc: any, q: string, blockedSet: Set<string> | null,
  offset: number, fetchLimit: number,
  ctx?: SearchQueryContext,
): Promise<SearchResult[]> {
  if (blockedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("discovery_places")
      // submitted_by is read for the block filter below and for nothing else —
      // it is never mapped onto the SearchResult, because a submitter's user id
      // is not the client's business.
      .select("id, name, city, blurb, image_url, header_image_source, image_source_type, image_accuracy_status, category, primary_category, lat, lng, canonical_location_id, created_at, submitted_by")
      .or(`name.ilike.${pat},city.ilike.${pat},blurb.ilike.${pat}`)
      .eq("status", "active")
      .order("saved_count", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const mapped = (data as any[])
      .filter((p: any) => submitterIsVisible(p.submitted_by, blockedSet))
      .map((p: any): SearchResult => ({
      id: p.id,
      type: "places",
      title: (p.name as string) ?? "",
      subtitle: ((p.primary_category ?? p.category) as string | null) ?? null,
      avatarUrl: null,
      imageUrl: (p.image_url as string | null) ?? null,
      fallbackInitials: initials((p.name as string) ?? ""),
      locationPreview: (p.city as string | null) ?? null,
      matchedReason: null,
      actionState: null,
      privacyState: null,
      accessState: { canAccess: true },
      destinationRoute: `/place/${p.id as string}`,
      metadata: {
        category: p.primary_category ?? p.category,
        lat: (p.lat as number | null) ?? null,
        lng: (p.lng as number | null) ?? null,
        headerImageSource: (p.header_image_source as string | null) ?? null,
        imageSourceType: (p.image_source_type as string | null) ?? null,
        accuracyStatus: (p.image_accuracy_status as string | null) ?? null,
        disclaimerRequired: (p.image_accuracy_status === 'illustrative_only' || p.image_accuracy_status === 'rejected') ? true : false,
        disclaimerText: p.image_accuracy_status === 'illustrative_only'
          ? 'Illustrative image — this does not show the actual location.'
          : p.image_accuracy_status === 'rejected'
            ? 'This image may not show the actual location.'
            : null,
        // livingPageId: canonical places.id when this discovery_place has been
        // linked to the Living Destination Page.  Absent when no link exists —
        // mobile falls back to the existing Discovery sheet.
        ...(p.canonical_location_id ? { livingPageId: p.canonical_location_id as string } : {}),
      },
      createdAt: (p.created_at as string | null) ?? null,
      startsAt: null,
    }));

    // Combined sort: match-tier is always primary so exact-name matches surface
    // first regardless of location.  Haversine distance is the tiebreak when
    // user coordinates are available — nearby places win when two results share
    // the same match tier.
    if (ctx?.lat != null && ctx?.lng != null) {
      const uLat = ctx.lat!;
      const uLng = ctx.lng!;
      return [...mapped].sort((a, b) => {
        const tierA = matchTier(a.title, q);
        const tierB = matchTier(b.title, q);
        if (tierA !== tierB) return tierB - tierA;   // exact > prefix > contains
        const am = a.metadata as { lat?: number | null; lng?: number | null };
        const bm = b.metadata as { lat?: number | null; lng?: number | null };
        const ad = am.lat != null && am.lng != null ? haversineKm(uLat, uLng, am.lat, am.lng) : Infinity;
        const bd = bm.lat != null && bm.lng != null ? haversineKm(uLat, uLng, bm.lat, bm.lng) : Infinity;
        return ad - bd;
      });
    }
    return rankByMatchTier(mapped, q);
  } catch {
    return [];
  }
}

/**
 * Hidden gems — approved/active only; blocked/age-restricted/suspended submitter excluded.
 */
async function searchHiddenGems(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("hidden_gems")
      // sensitivity_level + approx_* feed gemSearchPosition. The EXACT pair
      // (latitude/longitude) is deliberately absent — see the §24 note above.
      .select("id, name, city, country, submitted_by, category, status, created_at, sensitivity_level, approx_latitude, approx_longitude")
      .or(`name.ilike.${pat},city.ilike.${pat}`)
      // `hidden_gem_status` is an ENUM: pending | active | hidden | merged.
      // "approved" is not one of its labels, and Postgres rejects an unknown
      // enum literal outright (22P02) rather than simply matching nothing — so
      // the previous `["approved", "active"]` filter made every hidden-gem
      // search error out and fall into the `return []` below. The gem lived
      // only in a fixture that invented the label.
      .in("status", GEM_SEARCHABLE_STATUSES)
      .order("created_at", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const rows = (data as any[]).filter(
      (g: any) => !blockedSet.has(g.submitted_by as string) && !ageRestrictedSet.has(g.submitted_by as string),
    );
    if (rows.length === 0) return [];

    // Exclude gems from suspended/banned/deleted submitters
    const submitterIds = [...new Set(rows.map((g: any) => g.submitted_by as string))];
    const activeSubmitterSet = await fetchActiveOwnerSet(sc, submitterIds);

    return rows
      .filter((g: any) => activeSubmitterSet.has(g.submitted_by as string))
      .map((g: any): SearchResult => {
        const pos = gemSearchPosition(g);
        return {
        id: g.id,
        type: "hidden_gems",
        title: (g.name as string) ?? "",
        subtitle: (g.category as string | null) ?? null,
        avatarUrl: null,
        imageUrl: null,
        fallbackInitials: initials((g.name as string) ?? ""),
        locationPreview: [(g.city as string | null), (g.country as string | null)].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: null,
        privacyState: null,
        accessState: { canAccess: true },
        destinationRoute: `/hidden-gem/${g.id as string}`,
        // `coordsPrecision` is the map's existing gem vocabulary (mapSearch's
        // normalizeGem badges "approx. location" off it) — the pin says what it
        // is instead of implying a precision this surface never has.
        metadata: {
          category: g.category,
          lat: pos.lat,
          lng: pos.lng,
          coordsPrecision: pos.coordsPrecision,
        },
        createdAt: (g.created_at as string | null) ?? null,
        startsAt: null,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Hashtags — non-blocked only, ordered by usage_count.
 */
async function searchHashtags(
  sc: any, q: string, offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("hashtags")
      .select("id, slug, name, usage_count, created_at")
      .or(`slug.ilike.${pat},name.ilike.${pat}`)
      .eq("is_blocked", false)
      .order("usage_count", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    return (data as any[]).map((h: any): SearchResult => ({
      id: h.id,
      type: "hashtags",
      title: `#${h.slug as string}`,
      subtitle: h.usage_count != null ? `${h.usage_count as number} posts` : null,
      avatarUrl: null,
      imageUrl: null,
      fallbackInitials: "#",
      locationPreview: null,
      matchedReason: null,
      actionState: null,
      privacyState: null,
      accessState: { canAccess: true },
      destinationRoute: `/hashtag/${h.slug as string}`,
      metadata: { usageCount: h.usage_count },
      createdAt: (h.created_at as string | null) ?? null,
      startsAt: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Posts — public only; blocked/suspended author excluded.
 */
async function searchPosts(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    // Delayed-publish gate (§23/§37). This read had no publication filter at
    // all — only "not deleted, not banned" — so a delayed-geotag post was
    // full-text searchable by its own body the instant it was created, before
    // its author had left the place. Same canonical predicate as every other
    // serving surface, at the query and again in memory
    // (lib/postVisibility.isPostPublished).
    const { data, error } = await sc
      .from("posts")
      .select("id, content, author_id, media_urls, created_at, like_count, post_status")
      .ilike("content", pat)
      .eq("visibility", "public")
      .eq("post_status", "published")
      // `post_status` (the enum typing posts.status — not the `post_status`
      // COLUMN filtered on the line above, which is `delayed_post_status`) has
      // labels active | hidden | reported | deleted. "banned" is NOT one, so
      // PostgREST rejected the literal 22P02 and `type=posts` search failed
      // whole, returning [] on every request.
      //
      // Replaced with the allowlist every other posts-serving surface uses
      // (`.eq("status","active")` — ~20 call sites incl. mediaFeed, pulse,
      // placeLiving, featured), which is strictly narrower than the denylist it
      // replaces: `hidden` and `reported` posts are now excluded too.
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const rows = (data as any[]).filter(
      (p: any) =>
        isPostPublished(p) &&
        !blockedSet.has(p.author_id as string) &&
        !ageRestrictedSet.has(p.author_id as string),
    );
    if (rows.length === 0) return [];

    const authorIds = [...new Set(rows.map((p: any) => p.author_id as string))];
    const activeAuthorSet = await fetchActiveOwnerSet(sc, authorIds);

    // post_media is canonical for storage-backed media; posts.media_urls holds
    // external references only (ruled 2026-08-12). See lib/postMediaResolve.ts.
    const mediaByPost = await resolveMediaForPosts(sc, rows as any[]);

    return rows
      .filter((p: any) => activeAuthorSet.has(p.author_id as string))
      .map((p: any): SearchResult => {
        const preview = ((p.content as string) ?? "").slice(0, 120);
        return {
          id: p.id,
          type: "posts",
          title: preview || "(media post)",
          subtitle: null,
          avatarUrl: null,
          imageUrl: (mediaByPost.get(p.id) ?? (p.media_urls as string[] | null) ?? [])[0] ?? null,
          fallbackInitials: "P",
          locationPreview: null,
          matchedReason: null,
          actionState: null,
          privacyState: { isPublic: true },
          accessState: { canAccess: true },
          destinationRoute: `/post/${p.id as string}`,
          metadata: { authorId: p.author_id, likeCount: p.like_count },
          createdAt: (p.created_at as string | null) ?? null,
          startsAt: null,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Circles — public only; blocked/suspended owner excluded.
 */
async function searchCircles(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("circles")
      .select("id, name, description, owner_id, cover_image_url, city, visibility, created_at")
      .or(`name.ilike.${pat},city.ilike.${pat}`)
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const rows = (data as any[]).filter(
      (c: any) => !blockedSet.has(c.owner_id as string) && !ageRestrictedSet.has(c.owner_id as string),
    );
    if (rows.length === 0) return [];

    const ownerIds = [...new Set(rows.map((c: any) => c.owner_id as string))];
    const activeOwnerSet = await fetchActiveOwnerSet(sc, ownerIds);

    return rows
      .filter((c: any) => activeOwnerSet.has(c.owner_id as string))
      .map((c: any): SearchResult => ({
        id: c.id,
        type: "circles",
        title: (c.name as string) ?? "",
        subtitle: (c.description as string | null)?.slice(0, 80) ?? null,
        avatarUrl: null,
        imageUrl: (c.cover_image_url as string | null) ?? null,
        fallbackInitials: initials((c.name as string) ?? ""),
        locationPreview: (c.city as string | null) ?? null,
        matchedReason: null,
        actionState: null,
        privacyState: { isPublic: true },
        accessState: { canAccess: true },
        destinationRoute: `/circle/${c.id as string}`,
        metadata: { ownerId: c.owner_id },
        createdAt: (c.created_at as string | null) ?? null,
        startsAt: null,
      }));
  } catch {
    return [];
  }
}

/**
 * Stamp definitions — active only.
 */
async function searchStamps(
  sc: any, q: string, offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("stamp_definitions")
      .select("id, slug, name, description, icon_url, created_at")
      .or(`name.ilike.${pat},description.ilike.${pat},slug.ilike.${pat}`)
      .eq("is_active", true)
      .order("name", { ascending: true })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    return (data as any[]).map((s: any): SearchResult => ({
      id: s.id,
      type: "stamps",
      title: (s.name as string) ?? "",
      subtitle: (s.description as string | null)?.slice(0, 80) ?? null,
      avatarUrl: null,
      imageUrl: (s.icon_url as string | null) ?? null,
      fallbackInitials: initials((s.name as string) ?? ""),
      locationPreview: null,
      matchedReason: null,
      actionState: null,
      privacyState: null,
      accessState: { canAccess: true },
      destinationRoute: `/stamps/${s.slug as string}`,
      metadata: { slug: s.slug },
      createdAt: (s.created_at as string | null) ?? null,
      startsAt: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Activities — discovery_places in activity-category buckets.
 *
 * An activity IS a `discovery_places` row under a category filter, so it
 * carries the same `submitted_by` and needs the same author-side block filter
 * searchPlaces applies. Without it, blocking a submitter would hide their venue
 * from the Places group and leave the identical row visible in the Activities
 * group of the very same response.
 */
async function searchActivities(
  sc: any, q: string, blockedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("discovery_places")
      // Same discovery_places table searchPlaces reads lat/lng from — an
      // activity is a Place under a category filter, and the client adapter
      // maps `activities` to the same 'place' map type, so it must carry the
      // same position or it silently drops off the map.
      // submitted_by is read for the block filter only; never mapped out.
      .select("id, name, city, blurb, image_url, header_image_source, image_source_type, image_accuracy_status, category, lat, lng, created_at, submitted_by")
      .or(`name.ilike.${pat},city.ilike.${pat},blurb.ilike.${pat}`)
      .in("category", ["activities", "sports", "adventure", "outdoors", "wellness"])
      .eq("status", "active")
      .order("saved_count", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    return (data as any[])
      .filter((p: any) => submitterIsVisible(p.submitted_by, blockedSet))
      .map((p: any): SearchResult => ({
      id: p.id,
      type: "activities",
      title: (p.name as string) ?? "",
      subtitle: (p.category as string | null) ?? null,
      avatarUrl: null,
      imageUrl: (p.image_url as string | null) ?? null,
      fallbackInitials: initials((p.name as string) ?? ""),
      locationPreview: (p.city as string | null) ?? null,
      matchedReason: null,
      actionState: null,
      privacyState: null,
      accessState: { canAccess: true },
      destinationRoute: `/place/${p.id as string}`,
      metadata: {
        category: p.category,
        lat: (p.lat as number | null) ?? null,
        lng: (p.lng as number | null) ?? null,
        headerImageSource: (p.header_image_source as string | null) ?? null,
        imageSourceType: (p.image_source_type as string | null) ?? null,
        accuracyStatus: (p.image_accuracy_status as string | null) ?? null,
        disclaimerRequired: (p.image_accuracy_status === 'illustrative_only' || p.image_accuracy_status === 'rejected') ? true : false,
        disclaimerText: p.image_accuracy_status === 'illustrative_only'
          ? 'Illustrative image — this does not show the actual location.'
          : p.image_accuracy_status === 'rejected'
            ? 'This image may not show the actual location.'
            : null,
      },
      createdAt: (p.created_at as string | null) ?? null,
      startsAt: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Cities — aggregated from active, non-private, non-blocked, non-discovery-opted-out profiles.
 * Only active public profiles without discovery opt-outs contribute to the
 * city list so private/blocked/opted-out user signals cannot leak via geo data.
 */
async function searchCities(
  sc: any, q: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const [profileResult, optOutResult] = await Promise.all([
      sc
        .from("profiles")
        .select("id, home_city, home_country")
        .ilike("home_city", pat)
        .in("account_status", ["active"])
        .eq("is_private", false)
        .not("home_city", "is", null)
        .limit((offset + fetchLimit) * 5),
      sc
        .from("profile_privacy_settings")
        .select("user_id")
        .eq("allow_profile_discovery", false),
    ]);

    if (profileResult.error || !profileResult.data) return [];
    // Fail-closed: unknown opt-out state → return nothing (location signals must not leak)
    if (optOutResult.error) return [];
    const optOutSet = new Set<string>(
      ((optOutResult.data as any[]) ?? []).map((r: any) => r.user_id as string),
    );

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    let skipped = 0;
    for (const p of (profileResult.data as any[])) {
      // Exclude blocked, age-restricted, and discovery opt-out profiles (fail-closed)
      if (
        blockedSet.has(p.id as string) ||
        ageRestrictedSet.has(p.id as string) ||
        optOutSet.has(p.id as string)
      ) continue;
      const city = ((p.home_city as string | null) ?? "").trim();
      if (!city) continue;
      const key = city.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (skipped < offset) { skipped++; continue; }
      results.push({
        id: `city:${key}`,
        type: "cities",
        title: city,
        subtitle: (p.home_country as string | null) ?? null,
        avatarUrl: null,
        imageUrl: null,
        fallbackInitials: initials(city),
        locationPreview: [(p.home_city as string | null), (p.home_country as string | null)].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: null,
        privacyState: null,
        accessState: { canAccess: true },
        destinationRoute: `/city/${encodeURIComponent(city.toLowerCase())}`,
        // Filled in below from the canonical registry — declared here so the
        // key always exists and a positionless city is a null, not a gap.
        metadata: { lat: null, lng: null, source: "profile" },
        createdAt: null,
        startsAt: null,
      });
      if (results.length >= fetchLimit) break;
    }
    await attachCentroids(sc, results, CANONICAL_CITY_KINDS);
    return results;
  } catch {
    return [];
  }
}

/**
 * Attach registry centroids to city/country rows in place, keyed off `title`
 * (the aggregated place name). One batched query for the whole page.
 * `canonicalId` appears only when the position actually came from a registry
 * row, so the provenance of the coordinates is readable on the wire.
 */
async function attachCentroids(
  sc: any, results: SearchResult[], kinds: readonly string[],
): Promise<void> {
  if (results.length === 0) return;
  const centroids = await canonicalCentroids(sc, results.map((r) => r.title), kinds);
  if (centroids.size === 0) return;
  for (const r of results) {
    const hit = centroids.get(normalizeLocationName(r.title));
    if (!hit) continue;
    r.metadata = { ...(r.metadata ?? {}), lat: hit.lat, lng: hit.lng, canonicalId: hit.id };
  }
}

/**
 * Countries — aggregated from active, non-private, non-blocked, non-discovery-opted-out profiles.
 * Same privacy model as cities.
 */
async function searchCountries(
  sc: any, q: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const [profileResult, optOutResult] = await Promise.all([
      sc
        .from("profiles")
        .select("id, home_country")
        .ilike("home_country", pat)
        .in("account_status", ["active"])
        .eq("is_private", false)
        .not("home_country", "is", null)
        .limit((offset + fetchLimit) * 5),
      sc
        .from("profile_privacy_settings")
        .select("user_id")
        .eq("allow_profile_discovery", false),
    ]);

    if (profileResult.error || !profileResult.data) return [];
    // Fail-closed: unknown opt-out state → return nothing (location signals must not leak)
    if (optOutResult.error) return [];
    const optOutSet = new Set<string>(
      ((optOutResult.data as any[]) ?? []).map((r: any) => r.user_id as string),
    );

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    let skipped = 0;
    for (const p of (profileResult.data as any[])) {
      if (
        blockedSet.has(p.id as string) ||
        ageRestrictedSet.has(p.id as string) ||
        optOutSet.has(p.id as string)
      ) continue;
      const country = ((p.home_country as string | null) ?? "").trim();
      if (!country) continue;
      const key = country.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (skipped < offset) { skipped++; continue; }
      results.push({
        id: `country:${key}`,
        type: "countries",
        title: country,
        subtitle: null,
        avatarUrl: null,
        imageUrl: null,
        fallbackInitials: initials(country),
        locationPreview: null,
        matchedReason: null,
        actionState: null,
        privacyState: null,
        accessState: { canAccess: true },
        destinationRoute: `/country/${encodeURIComponent(country.toLowerCase())}`,
        // Same contract as cities. `canonical_locations` models kind='country'
        // (canonicalLocations.kindClass maps it to the admin class) but holds
        // no country rows today, so in practice a country result carries a null
        // position until the registry is seeded — a null the client reads as
        // "not placeable", which is the honest answer rather than a centroid
        // averaged out of whatever cities happen to exist.
        metadata: { lat: null, lng: null, source: "profile" },
        createdAt: null,
        startsAt: null,
      });
      if (results.length >= fetchLimit) break;
    }
    await attachCentroids(sc, results, CANONICAL_COUNTRY_KINDS);
    return results;
  } catch {
    return [];
  }
}

/**
 * Static taxonomic lists — in-process text match; no DB query.
 */
function searchStatic<T extends Exclude<SearchType, "all">>(
  q: string, items: string[], type: T, routePrefix: string,
  offset: number, fetchLimit: number,
): SearchResult[] {
  const lower = q.toLowerCase();
  return items
    .filter((item) => item.toLowerCase().includes(lower))
    .slice(offset, offset + fetchLimit)
    .map((item): SearchResult => ({
      id: `${type}:${item.toLowerCase().replace(/\s+/g, "-")}`,
      type,
      title: item,
      subtitle: null,
      avatarUrl: null,
      imageUrl: null,
      fallbackInitials: initials(item),
      locationPreview: null,
      matchedReason: null,
      actionState: null,
      privacyState: null,
      accessState: { canAccess: true },
      destinationRoute: `${routePrefix}/${encodeURIComponent(item.toLowerCase())}`,
      metadata: null,
      createdAt: null,
      startsAt: null,
    }));
}

// ── Single-type dispatch ───────────────────────────────────────────────────────

// Exported (additive) as the single per-type candidate generator. The
// input-assistance gateway calls INTO this (same per-type query + privacy +
// ranking code paths) rather than forking a parallel search implementation.
// The existing /discovery/search and /discovery/suggest handlers are unchanged.
export async function dispatchSearch(
  sc: any,
  q: string,
  userId: string,
  blockedSet: Set<string> | null,
  ageRestrictedSet: Set<string> | null,
  type: Exclude<SearchType, "all">,
  offset: number,
  fetchLimit: number,
  ctx?: SearchQueryContext,
): Promise<SearchResult[]> {
  // For location-aware types (travelers, events, trips, plans, buddies):
  //   Fetch a larger pool (up to 3x the requested page + offset, capped at 100)
  //   so that exact-handle/exact-title matches aren't excluded by DB ordering before
  //   ranking runs.  rankCombined then applies match-tier (primary) + city boost
  //   (tiebreak) in one pass, and we slice to the caller's requested page.
  //
  // For types without location context, rankByMatchTier is sufficient.
  // searchPlaces manages its own ordering (haversine/match-tier) — skip re-sort.
  const pool = Math.min(offset + fetchLimit * 3, 100);
  switch (type) {
    case "travelers": {
      const raw = await searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, 0, pool, false, ctx);
      return rankCombined(raw, q, ctx?.userCity).slice(offset, offset + fetchLimit);
    }
    case "buddies": {
      const raw = await searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, 0, pool, true, ctx);
      return rankCombined(raw, q, ctx?.userCity).slice(offset, offset + fetchLimit);
    }
    case "events": {
      const raw = await searchEvents(sc, q, userId, blockedSet, ageRestrictedSet, 0, pool, ctx);
      return rankCombined(raw, q, ctx?.userCity, { upcomingFirst: true }).slice(offset, offset + fetchLimit);
    }
    case "trips": {
      const raw = await searchTrips(sc, q, userId, blockedSet, ageRestrictedSet, 0, pool, ctx);
      return rankCombined(raw, q, ctx?.userCity, { upcomingFirst: true }).slice(offset, offset + fetchLimit);
    }
    case "plans": {
      const raw = await searchPlans(sc, q, userId, blockedSet, ageRestrictedSet, 0, pool, ctx);
      return rankCombined(raw, q, ctx?.userCity, { upcomingFirst: true }).slice(offset, offset + fetchLimit);
    }
    case "places":      return searchPlaces(sc, q, blockedSet, offset, fetchLimit, ctx);
    case "hidden_gems": return rankByMatchTier(await searchHiddenGems(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit), q);
    case "hashtags":    return rankByMatchTier(await searchHashtags(sc, q, offset, fetchLimit),                                         q);
    case "posts":       return rankByMatchTier(await searchPosts(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit),      q);
    case "circles":     return rankByMatchTier(await searchCircles(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit),    q);
    case "stamps":      return rankByMatchTier(await searchStamps(sc, q, offset, fetchLimit),                                          q);
    case "activities":  return rankByMatchTier(await searchActivities(sc, q, blockedSet, offset, fetchLimit),                          q);
    case "cities":      return rankByMatchTier(await searchCities(sc, q, blockedSet, ageRestrictedSet, offset, fetchLimit),            q);
    case "countries":   return rankByMatchTier(await searchCountries(sc, q, blockedSet, ageRestrictedSet, offset, fetchLimit),         q);
    case "languages":   return rankByMatchTier(searchStatic(q, COMMON_LANGUAGES, "languages", "/language", offset, fetchLimit),        q);
    case "interests":   return rankByMatchTier(searchStatic(q, COMMON_INTERESTS, "interests", "/interest", offset, fetchLimit),        q);
    case "vibes":       return rankByMatchTier(searchStatic(q, COMMON_VIBES,     "vibes",     "/vibe",     offset, fetchLimit),        q);
    default:            return [];
  }
}

// ── type=all fan-out ───────────────────────────────────────────────────────────
//
// All 17 non-"all" types run in parallel at FAN_LIMIT items each.
// Results are merged round-robin so no type dominates the top.
// The merged pool is sliced at [globalOffset, globalOffset+limit].
// hasMore = pool.length > globalOffset + limit.

const FAN_LIMIT = 20;

async function searchAll(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  globalOffset: number, limit: number,
  ctx?: SearchQueryContext,
): Promise<{ results: SearchResult[]; hasMore: boolean; nextCursor: string | null }> {
  if (blockedSet === null || ageRestrictedSet === null) {
    return { results: [], hasMore: false, nextCursor: null };
  }

  const settled = await Promise.allSettled([
    searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT, false, ctx), // travelers
    searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT, true,  ctx), // buddies
    searchEvents(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT, ctx),           // events
    searchTrips(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT, ctx),            // trips
    searchPlans(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT, ctx),            // plans
    searchPlaces(sc, q, blockedSet, 0, FAN_LIMIT, ctx),                                 // places
    searchHiddenGems(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),       // hidden_gems
    searchHashtags(sc, q, 0, FAN_LIMIT),                                               // hashtags
    searchPosts(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),            // posts
    searchCircles(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),          // circles
    searchStamps(sc, q, 0, FAN_LIMIT),                                                 // stamps
    searchActivities(sc, q, blockedSet, 0, FAN_LIMIT),                                  // activities
    searchCities(sc, q, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),                   // cities
    searchCountries(sc, q, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),                // countries
    Promise.resolve(searchStatic(q, COMMON_LANGUAGES, "languages", "/language", 0, FAN_LIMIT)),
    Promise.resolve(searchStatic(q, COMMON_INTERESTS, "interests", "/interest", 0, FAN_LIMIT)),
    Promise.resolve(searchStatic(q, COMMON_VIBES, "vibes", "/vibe", 0, FAN_LIMIT)),
  ]);

  // Apply combined ranking (match-tier primary, city tiebreak) within each bucket
  // before the round-robin interleave.  rankCombined degenerates to pure match-tier
  // when userCity is absent, so it is safe for all types.
  // searchPlaces already handles its own ordering — re-ranking by title here is still
  // OK for the "all" tab because diversity matters more than proximity when mixing types.
  // upcomingFirst is a no-op for types without startsAt (travelers, places, etc.)
  const rawBuckets: SearchResult[][] = settled.map((r) => {
    const items = r.status === "fulfilled" ? r.value : [];
    return rankCombined(items, q, ctx?.userCity, { upcomingFirst: true });
  });

  // ── Intent-category promotion ─────────────────────────────────────────────
  // When the client signals an intentCategory (food, beach, adventure, etc.),
  // the places bucket (index 5) is a place-category query — move it to the front
  // so that matching place results lead the round-robin merge instead of being
  // interleaved 5 slots in.
  // intentSafety: promote verified travelers/events (buckets 0 & 2) to the front.
  const buckets = [...rawBuckets];
  const PLACE_CATS = new Set(["food", "beach", "adventure", "culture", "nightlife"]);
  if (ctx?.intentCategory && PLACE_CATS.has(ctx.intentCategory)) {
    // Index 5 is the places bucket (see settled array order above)
    const [placesBucket] = buckets.splice(5, 1);
    if (placesBucket) buckets.unshift(placesBucket);
  }
  if (ctx?.intentSafety === "true") {
    // Boost verified items to the top of their bucket by a secondary sort pass.
    // Verification is stored in metadata.verified (boolean) for travelers and events.
    for (let bi = 0; bi < buckets.length; bi++) {
      buckets[bi] = [...(buckets[bi] ?? [])].sort((a, b) => {
        const va = (a.metadata?.verified || a.metadata?.is_verified) ? 1 : 0;
        const vb = (b.metadata?.verified || b.metadata?.is_verified) ? 1 : 0;
        return vb - va;
      });
    }
  }

  // Round-robin interleave
  const merged: SearchResult[] = [];
  const maxLen = Math.max(...buckets.map((b) => b.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) {
      if (i < bucket.length) merged.push(bucket[i]!);
    }
  }

  const page = merged.slice(globalOffset, globalOffset + limit);
  const hasMore = merged.length > globalOffset + limit;
  const nextCursor = hasMore ? encodeCursor(globalOffset + limit) : null;
  return { results: page, hasMore, nextCursor };
}

// ── Route handler ─────────────────────────────────────────────────────────────

router.get("/discovery/search", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  // Explicit presence check: zod.coerce.string() converts undefined to "undefined"
  // so we must guard before passing to the generated schema.
  if (req.query.q === undefined) {
    sendError(res, "invalid_payload", "q is required");
    return;
  }

  // Generated Zod validation (from @workspace/api-zod, derived from openapi.yaml)
  const parsed = DiscoverySearchQueryParams.safeParse({
    q:      req.query.q,
    type:   req.query.type,
    limit:  req.query.limit,
    cursor: req.query.cursor,
  });

  if (!parsed.success) {
    const first = parsed.error.errors[0];
    sendError(res, "invalid_payload", first?.message ?? "Invalid search parameters");
    return;
  }

  // Strip leading @ for handle-specific searches (e.g. @alice → alice)
  const rawQ = parsed.data.q;
  const isHandleQuery = rawQ.startsWith("@");
  const qAfterHandle = isHandleQuery ? rawQ.slice(1) : rawQ;

  // Apply alias expansion (typo tolerance) before sanitization
  let q = applyAliases(qAfterHandle);
  // Apply PostgREST injection sanitization on top of Zod validation
  q = sanitizeQuery(q);
  if (q.length < 2) {
    sendError(res, "invalid_payload", "q must be at least 2 characters after sanitization");
    return;
  }

  // Parse optional location params — forwarded by the client only when permission is granted
  const rawLat = parseFloat(String(req.query.lat ?? ""));
  const rawLng = parseFloat(String(req.query.lng ?? ""));
  const lat = Number.isFinite(rawLat) && rawLat >= -90  && rawLat <= 90  ? rawLat : null;
  const lng = Number.isFinite(rawLng) && rawLng >= -180 && rawLng <= 180 ? rawLng : null;
  const tz  = typeof req.query.tz  === "string" && req.query.tz.length  <= 50 ? req.query.tz  : null;
  // Human-readable city name — mobile passes this alongside lat/lng for city-level boosting
  // of content types that have city text (events, travelers) but no lat/lng coordinate column.
  const userCity = typeof req.query.city === "string" && req.query.city.trim().length > 0
    ? req.query.city.trim().slice(0, 100) : null;

  // Parse proximity intent ("nearby", "near me") — strip it and flag ctx
  const nearbyResult = parseNearbyIntent(q);
  const qAfterNearby = nearbyResult.nearbyIntent
    ? (nearbyResult.strippedQuery.trim().length >= 2 ? nearbyResult.strippedQuery : q)
    : q;

  // Parse time intent — strip time keywords and derive UTC date bounds for events/trips
  const timeIntentResult = parseTimeIntent(qAfterNearby, tz);
  // Only use stripped query when it still meets the min-length requirement
  const effectiveQ = timeIntentResult.strippedQuery.trim().length >= 2
    ? timeIntentResult.strippedQuery
    : qAfterNearby;

  // Resolve the response timeLabel: nearby takes precedence over time intents for display
  const displayLabel = nearbyResult.nearbyIntent
    ? (lat !== null && lng !== null ? "Nearby" : "Nearby (enable location)")
    : (timeIntentResult.intent?.label ?? null);

  // ── Intent-boost params — forwarded by the mobile client's parseSearchIntent() ──
  // These are soft hints: they guide ranking and type-promotion, not hard exclusion.
  const VALID_INTENT_CATS = new Set(["nightlife", "food", "beach", "adventure", "culture"]);
  const VALID_INTENT_SOCIAL = new Set(["solo", "group", "crew"]);
  const rawIntentCat      = typeof req.query.intentCategory     === "string" ? req.query.intentCategory.trim()     : null;
  const rawIntentSocial   = typeof req.query.intentSocial       === "string" ? req.query.intentSocial.trim()       : null;
  const rawIntentBudget   = typeof req.query.intentBudget       === "string" ? req.query.intentBudget.trim()       : null;
  const rawIntentSafety   = typeof req.query.intentSafety       === "string" ? req.query.intentSafety.trim()       : null;
  const rawIntentLocHint  = typeof req.query.intentLocationHint === "string" ? req.query.intentLocationHint.trim() : null;

  const ctx: SearchQueryContext = {
    lat,
    lng,
    tz,
    startsAfter:         timeIntentResult.intent?.startsAfter  ?? null,
    startsBefore:        timeIntentResult.intent?.startsBefore ?? null,
    timeLabel:           displayLabel,
    nearbyIntent:        nearbyResult.nearbyIntent,
    userCity:            userCity ?? null,
    intentCategory:      rawIntentCat    && VALID_INTENT_CATS.has(rawIntentCat)      ? rawIntentCat    : null,
    intentSocial:        rawIntentSocial && VALID_INTENT_SOCIAL.has(rawIntentSocial) ? rawIntentSocial : null,
    intentBudget:        rawIntentBudget === "budget" ? "budget" : null,
    intentSafety:        rawIntentSafety === "true"   ? "true"   : null,
    intentLocationHint:  rawIntentLocHint && rawIntentLocHint.length <= 100 ? rawIntentLocHint : null,
  };

  const type = (parsed.data.type ?? "all") as SearchType;
  const limit = parsed.data.limit ?? 20;
  const cursor = parsed.data.cursor;

  // Rate limit: 30 req/min per user
  const rl = checkRateLimit("discovery_search", user.id, 30, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many search requests. Please wait and try again.");
    return;
  }

  const offset = decodeCursor(cursor);

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  try {
    // Fail-closed: unknown block or age-restriction state → return empty results, never leak content
    const [blockedSet, ageRestrictedSet] = await Promise.all([
      fetchBlockedSet(sc, user.id),
      fetchAgeRestrictedSet(sc),
    ]);

    // Stage 0b — serve point 8. Search ranks nothing and logs nothing today; a
    // grep of this file for rankCandidates / rankItemsForDiscovery /
    // drsRankItems / logImpression returns nothing at all.
    const logSearchServe = (results: SearchResult[]) => {
      void logDiscoveryServe(sc, {
        userId: user.id,
        servePoint: DiscoveryServePoint.SEARCH,
        route: "GET /discovery/search",
        items: results.map((r) => ({ id: r.id, kind: searchTypeToItemKind(r.type) })),
        context: { type, offset, resultCount: results.length },
      });
    };

    if (type === "all") {
      const { results, hasMore, nextCursor } = await searchAll(sc, effectiveQ, user.id, blockedSet, ageRestrictedSet, offset, limit, ctx);
      res.status(200).json({ results, nextCursor, hasMore, query: effectiveQ, type, timeLabel: ctx.timeLabel });
      logSearchServe(results);
    } else {
      // Fetch limit+1 to detect hasMore without false positives
      const fetchLimit = limit + 1;
      const raw = await dispatchSearch(sc, effectiveQ, user.id, blockedSet, ageRestrictedSet, type, offset, fetchLimit, ctx);
      const hasMore = raw.length > limit;
      const results = raw.slice(0, limit);
      const nextCursor = hasMore ? encodeCursor(offset + limit) : null;
      res.status(200).json({ results, nextCursor, hasMore, query: effectiveQ, type, timeLabel: ctx.timeLabel });
      logSearchServe(results);
    }
  } catch (err) {
    logger.warn({ err, q: effectiveQ, type }, "discovery/search failed");
    res.status(200).json({ results: [], nextCursor: null, hasMore: false, query: effectiveQ, type, timeLabel: null });
  }
});

// ── GET /api/discovery/suggest — grouped live typeahead ──────────────────────
//
// Lightweight sibling of /discovery/search for as-you-type assistance.
// Reuses dispatchSearch (same per-type query + privacy + ranking code paths —
// deliberately NOT a parallel search implementation) with small per-type
// limits, then merges canonical-location city suggestions so location rows
// normalize to the canonical registry instead of raw profile text.
//
// Groups are ordered by best match tier (exact > prefix > contains) so the
// group containing an exact hit surfaces first; ties keep the plan order
// below. Fail-soft: any internal error returns empty groups with 200 —
// typeahead must never surface an error state mid-keystroke.

const SUGGEST_PLAN: Array<{ type: Exclude<SearchType, "all">; label: string; limit: number }> = [
  { type: "travelers",   label: "Travelers",  limit: 4 },
  { type: "cities",      label: "Cities",     limit: 4 },
  { type: "hidden_gems", label: "Gems",       limit: 3 },
  { type: "events",      label: "Events",     limit: 3 },
  { type: "trips",       label: "Trips",      limit: 3 },
  { type: "buddies",     label: "Buddies",    limit: 3 },
  { type: "places",      label: "Places",     limit: 3 },
  { type: "hashtags",    label: "Hashtags",   limit: 3 },
  { type: "posts",       label: "Posts",      limit: 2 },
  { type: "stamps",      label: "Stamps",     limit: 2 },
  { type: "circles",     label: "Circles",    limit: 2 },
  { type: "plans",       label: "Plans",      limit: 2 },
  { type: "activities",  label: "Activities", limit: 2 },
  { type: "countries",   label: "Countries",  limit: 2 },
];

const MAX_SUGGEST_GROUPS = 8;

export interface SuggestGroupPayload {
  type: Exclude<SearchType, "all">;
  label: string;
  items: SearchResult[];
}

/**
 * Map a canonical-location row to a city SearchResult. Canonical rows are
 * public geo registry data with no user linkage, so nothing here can leak
 * a private user's location. Route matches searchCities' /city/:slug shape.
 */
export function canonicalToCityResult(row: CanonicalRow): SearchResult {
  const title = row.name || row.display_name;
  return {
    id: `city:${row.normalized_name}`,
    type: "cities",
    title,
    subtitle: [row.region, row.country].filter(Boolean).join(", ") || null,
    avatarUrl: null,
    imageUrl: null,
    fallbackInitials: initials(title),
    locationPreview: [title, row.country].filter(Boolean).join(", ") || null,
    matchedReason: null,
    actionState: null,
    privacyState: null,
    accessState: { canAccess: true },
    destinationRoute: `/city/${encodeURIComponent(title.toLowerCase())}`,
    metadata: { canonicalId: row.id, lat: row.lat, lng: row.lng, source: "canonical" },
    createdAt: null,
    startsAt: null,
  };
}

/**
 * Canonical city suggestions take precedence over profile-derived city rows
 * with the same name (canonical rows are normalized + carry centroids).
 * Case-insensitive title dedupe; capped at `limit`.
 */
export function mergeCitySuggestions(
  canonical: SearchResult[],
  profileCities: SearchResult[],
  limit: number,
): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of [...canonical, ...profileCities]) {
    const key = r.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Order groups so the one holding the best match leads. matchTier is
 * higher-is-better (3 exact > 2 prefix > 1 substring > 0 none), so groups
 * sort by descending best tier. Stable: equal best tiers keep SUGGEST_PLAN
 * order.
 */
export function orderSuggestGroups(
  groups: SuggestGroupPayload[],
  q: string,
): SuggestGroupPayload[] {
  return groups
    .map((g, i) => ({
      g,
      i,
      tier: g.items.length
        ? Math.max(...g.items.map((it) => matchTier(it.title, q, it.subtitle)))
        : -1,
    }))
    .sort((a, b) => (b.tier - a.tier) || (a.i - b.i))
    .map((x) => x.g);
}

router.get("/discovery/suggest", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const rawInput = typeof req.query.q === "string" ? req.query.q : "";
  // @handle queries suggest people only, mirroring /discovery/search behavior
  const isHandleQuery = rawInput.startsWith("@");
  const q = sanitizeQuery(applyAliases(isHandleQuery ? rawInput.slice(1) : rawInput)).slice(0, 80);
  if (q.length < 2) {
    res.status(200).json({ query: q, groups: [] });
    return;
  }

  // Separate bucket from discovery_search: typeahead legitimately fires more
  // often (client debounces at 250ms and caches, but fast typists still burst).
  const rl = checkRateLimit("discovery_suggest", user.id, 90, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many suggestion requests. Please wait.");
    return;
  }

  const latRaw = parseFloat(String(req.query.lat));
  const lat = Number.isFinite(latRaw) && Math.abs(latRaw) <= 90 ? latRaw : null;
  const lngRaw = parseFloat(String(req.query.lng));
  const lng = Number.isFinite(lngRaw) && Math.abs(lngRaw) <= 180 ? lngRaw : null;
  const city = typeof req.query.city === "string"
    ? (sanitizeQuery(req.query.city).slice(0, 100) || null)
    : null;

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  try {
    // Fail-closed: if block/age-restriction state is unknown, return no
    // suggestions at all — including canonical city rows — rather than
    // guessing. (The per-type search functions would already collapse to []
    // on null sets; the early return keeps canonical merging equally strict.)
    const [blockedSet, ageRestrictedSet] = await Promise.all([
      fetchBlockedSet(sc, user.id),
      fetchAgeRestrictedSet(sc),
    ]);
    if (!blockedSet || !ageRestrictedSet) {
      res.status(200).json({ query: q, groups: [] });
      return;
    }

    const ctx: SearchQueryContext = { lat, lng, userCity: city, nearbyIntent: false };
    const plan = isHandleQuery
      ? SUGGEST_PLAN.filter((p) => p.type === "travelers" || p.type === "buddies")
      : SUGGEST_PLAN;

    const [typedResults, canonicalRows] = await Promise.all([
      Promise.all(plan.map((p) =>
        dispatchSearch(sc, q, user.id, blockedSet, ageRestrictedSet, p.type, 0, p.limit, ctx)
          .catch(() => [] as SearchResult[]),
      )),
      isHandleQuery
        ? Promise.resolve([] as CanonicalRow[])
        : suggestCanonicalLocations(sc, q, 4),
    ]);

    // Cross-group dedupe by entity id: a profile must not appear in both
    // Travelers and Buddies; a discovery_place must not appear in both
    // Places and Activities. First group in plan order wins.
    const seenIds = new Set<string>();
    const groups: SuggestGroupPayload[] = [];
    plan.forEach((p, i) => {
      let items = typedResults[i] ?? [];
      if (p.type === "cities") {
        items = mergeCitySuggestions(canonicalRows.map(canonicalToCityResult), items, p.limit);
      }
      items = items.filter((it) => {
        if (seenIds.has(it.id)) return false;
        seenIds.add(it.id);
        return true;
      }).slice(0, p.limit);
      if (items.length > 0) groups.push({ type: p.type, label: p.label, items });
    });

    const servedGroups = orderSuggestGroups(groups, q).slice(0, MAX_SUGGEST_GROUPS);
    res.status(200).json({
      query: q,
      groups: servedGroups,
    });
    // Stage 0b — serve point 9. Flattened in the order the groups are served,
    // so `position` reflects what the user actually saw top to bottom.
    void logDiscoveryServe(sc, {
      userId: user.id,
      servePoint: DiscoveryServePoint.SUGGEST,
      route: "GET /discovery/suggest",
      items: servedGroups.flatMap((g) =>
        g.items.map((it) => ({ id: it.id, kind: searchTypeToItemKind(g.type) })),
      ),
      context: { groupCount: servedGroups.length },
    });
  } catch (err) {
    logger.warn({ err, q }, "discovery/suggest failed");
    res.status(200).json({ query: q, groups: [] });
  }
});

export default router;
