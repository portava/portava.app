/**
 * GET /api/discovery/search  — Unified cross-type search
 *
 * Contract defined in lib/api-spec/openapi.yaml (operationId: discoverySearch).
 * Query-param validation uses the generated DiscoverySearchQueryParams Zod schema
 * from @workspace/api-zod, supplemented by a server-side sanitization pass.
 *
 * Privacy rules (server-side, fail-closed):
 *   - Private accounts (is_private=true) the viewer does not follow are
 *     returned as a LOCKED PREVIEW (no avatar/location/matchedReason,
 *     canAccess=false) — never silently excluded, so a private account is
 *     discoverable everywhere or nowhere, matching /api/users/search. See
 *     searchTravelers below; this line used to say "excluded entirely", which
 *     the code has not done since the locked-preview contract landed.
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
import { readTripWindows, fitInstantToWindows } from "../domain/trips/services/TripFreedomConsumers.js";
import {
  suggestCanonicalLocations,
  normalizeLocationName,
  type CanonicalRow,
} from "../lib/canonicalLocations";
import type { SensitivityLevel } from "../services/hiddenGems/HiddenGemPrivacyGuard.js";
import { nameVisibilitySet } from "../lib/publicIdentity";
import { buildConsumerProjection, buildListIdentityProjections } from "../services/passport/PassportConsumerProjections.js";
import { allowDiscoveryPersonCard } from "../services/passport/PassportConsumerAccess.js";
// The canonical author-side block rule for a `discovery_places` row. Shared with
// routes/discovery.ts (which re-exports it) rather than re-implemented here —
// two copies of a privacy rule is how these two serve points drifted apart in
// the first place.
import { fetchBlockedSet, submitterIsVisible } from "../lib/blocks.js";
// B05 / G277's CountryResolver. Consumed, never re-spelled — a second country
// list inside a product surface is how two lists disagree.
import { searchCountryRegistry, toCountryCode } from "../lib/countryCodes.js";
import { resolvePlaceIdBridge } from "../lib/placeIdBridge.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
// Trips' projection contract (census-discovery A10 / D3, Trips spec §25) and
// Discovery's consumer of it. Gated by the CAPABILITY
// discovery_trip_projection_enabled && trips-schema-ready, not by the flag
// alone: production has no trips.version and the readers fail closed on it, so
// a flag flipped onto missing schema would empty every trips and plans search.
// The not-ready branch is the legacy read below. See
// lib/discoveryTripProjectionConsumer.ts.
import {
  searchTripDiscoveryProjections,
  readTripDiscoveryProjections,
  tripDiscoveryAdmits,
} from "../domain/trips/contracts/tripDiscoveryProjection.js";
import {
  discoveryTripProjectionGate,
  recordDiscoveryTripSource,
  acceptTripDiscoveryProjections,
  tripCardSourceFromProjection,
  type DiscoveryTripCardSource,
  type DiscoveryPlanParentTrip,
} from "../lib/discoveryTripProjectionConsumer.js";
import {
  DiscoveryServePoint,
  searchTypeToItemKind,
} from "../lib/discoveryServeLog.js";
// D11 / `11` §9 — "A failure must not masquerade as success." One vocabulary for
// every Discovery refusal; see lib/discoveryRefusal.ts for why the status stays
// 200 and the refusal rides in the envelope. `logServeUnlessRefused` is
// deliberately used INSTEAD of logDiscoveryServe at the two serve points below:
// a refused response must not reach the exposure denominator.
import {
  discoveryRefusal,
  sendDiscoveryRefusal,
  logServeUnlessRefused,
} from "../lib/discoveryRefusal.js";

const router = Router();
const logger = rootLogger.child({ route: "discoverySearch" });

// ── SearchType enum (mirrors openapi.yaml) ────────────────────────────────────

const SEARCH_TYPES = [
  "all", "travelers", "buddies", "events", "trips", "plans",
  "places", "hidden_gems", "hashtags", "posts", "circles",
  "stamps", "activities", "cities", "countries", "languages",
  "interests", "vibes",
  // Map spec §27's ninth heading, "Saved items". The client has carried the
  // whole branch since map search was written — MAP_SEARCH_RESULT_TYPES ends in
  // 'saved', SavedSearchResult carries a savedKind discriminant, frameFor has a
  // 'saved' case — and it was unreachable because this list had no member that
  // produced one. See searchSaved below.
  "saved",
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

/**
 * Split a list of ids into pages. PostgREST puts `.in()` lists in the URL, so an
 * unbounded list becomes a request too long for the gateway to forward — a
 * failure that arrives as a resolved error and reads as "no rows".
 */
function chunkIds<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
// `fetchBlockedSet` is lib/blocks' — the one bidirectional, fail-closed block
// reader every people-exposing surface shares (map travelers, circle
// locations, the input-assistance gateway, GET /discovery). This file carried
// a byte-for-byte private copy of it until 2026-09-07. Passport §263: "Do not
// implement blocking independently per surface"; Telegraph §285: "No subsystem
// may independently 'rediscover' a blocked relationship." Two copies of a
// privacy rule agree until the day one of them is edited — which is how
// submitterIsVisible drifted between this route and the feed (see the import
// above). Re-exported so a test can assert identity rather than resemblance.
// Contract unchanged: null on any error, and callers that receive null MUST
// return [] — never expose content when the block state is unknown.
export { fetchBlockedSet };

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

// ── Buddy launch-eligibility gate (inert until seeded ON) ─────────────────────
//
// Global Input Intelligence §29 (row G71 of census-input-intelligence): a Buddy
// suggestion must pass "service category, availability, launch/safety/payment
// eligibility". `type=buddies` applied exactly one predicate —
// `buddy_verified_at IS NOT NULL` — and never asked whether the Rent-a-Buddy
// marketplace is LAUNCHED. `rent_buddy_enabled` is false in production, so a
// verified buddy was searchable on a surface whose marketplace does not exist.
//
// The launch leg is closed here. It sits behind its OWN capability flag,
// `discovery_buddy_launch_gate_enabled` (migration 2360, seeded FALSE), because
// Discovery is live and this repository's rule is that nothing changes what a
// user sees until someone deliberately flips a flag. Both reads are
// isFlagEnabled — fail-closed — and the two closures point in the SAFE
// direction each time:
//   gate absent / false / unreadable   → legacy behaviour, buddies unchanged
//   gate ON, rent_buddy_enabled false  → buddies withheld
//   gate ON, rent_buddy_enabled UNREADABLE → buddies withheld (an eligibility
//                                        gate that cannot be established is
//                                        not passed)
// The category and availability legs of G71 remain open — see
// docs/architecture/census-discovery.md B03.
//
// Applied inside searchTravelers(isBuddy) so the input-assistance gateway
// (lib/inputAssistance/gateway.ts → dispatchSearch) inherits the same rule.

/** Literal name so check-flag-polarity resolves the read. */
export const DISCOVERY_BUDDY_LAUNCH_GATE_FLAG = "discovery_buddy_launch_gate_enabled";
/** The marketplace's master switch, read by routes/rentABuddy.ts. */
const RENT_BUDDY_LAUNCH_FLAG = "rent_buddy_enabled";

// The GATE read is cached 30 s (mirrors discoveryServeLog / compass/flags.ts):
// type=all fans out through buddies on every search, and an uncached read
// would add a round-trip per search for a flag that changes once. The
// marketplace flag is read only when the gate is on, and is NOT cached, so a
// launch or un-launch is visible on the next request.
const BUDDY_GATE_TTL_MS = 30_000;
let _buddyGateCache: { value: boolean; at: number } | null = null;

/** Invalidate the gate cache. Exported for tests. */
export function invalidateBuddyLaunchGateCache(): void {
  _buddyGateCache = null;
}

async function buddyLaunchGateActive(sc: any): Promise<boolean> {
  if (_buddyGateCache && Date.now() - _buddyGateCache.at < BUDDY_GATE_TTL_MS) {
    return _buddyGateCache.value;
  }
  const value = await isFlagEnabled(sc, DISCOVERY_BUDDY_LAUNCH_GATE_FLAG);
  _buddyGateCache = { value, at: Date.now() };
  return value;
}

/**
 * True when buddy results must be WITHHELD: the gate is on and the marketplace
 * is not (or cannot be shown to be) launched. Exported for its unit test — the
 * route-level fake cannot fail one flag read while answering another.
 */
export async function buddiesWithheldByLaunchGate(sc: any): Promise<boolean> {
  if (!(await buddyLaunchGateActive(sc))) return false;
  return !(await isFlagEnabled(sc, RENT_BUDDY_LAUNCH_FLAG));
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
  // Launch eligibility (G71) before any row is read: a buddy the marketplace
  // has not launched is not a candidate. Inert until the gate flag is on.
  if (isBuddy && await buddiesWithheldByLaunchGate(sc)) return [];
  try {
    const pat = sqlPattern(q);
    let query = sc
      .from("profiles")
      .select("id, handle, username, name, display_name, avatar_url, is_private, home_city, home_country, account_status, verified, is_official, show_profile_picture_publicly")
      .or(`name.ilike.${pat},handle.ilike.${pat},username.ilike.${pat}`)
      .neq("id", userId)
      .in("account_status", ["active"])
      .order("name", { ascending: true })
      .range(offset, offset + fetchLimit - 1);

    if (isBuddy) query = query.not("buddy_verified_at", "is", null);

    const { data, error } = await query;
    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("profiles", error);
    if (!data) return [];

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

    // §35 / census-passport P169 — identity comes from the Passport batch
    // projection, not from this file. The name rule, the private-preview rule,
    // the picture opt-out and the badge are ONE implementation shared with the
    // Compass traveler list; what stays here is the part that is genuinely
    // Discovery's (the @handle fallback, the location preview, the follow /
    // request action state). `nameVisibilitySet` is read inside the projection,
    // so this costs no extra round trip — the same one read for the whole page.
    const identity = await buildListIdentityProjections(sc, nameSafe as any[], {
      viewerId: userId,
      following: followingSet,
      friends: friendSet,
      // Already resolved above for C09's hidden-name match rule; handing it over
      // keeps this search at ONE `profile_privacy_settings` read, not two.
      allowedRealNames: allowedNames,
    });

    const type: Exclude<SearchType, "all"> = isBuddy ? "buddies" : "travelers";
    const mapped: SearchResult[] = nameSafe.map((p: any): SearchResult => {
      const ident = identity.get(p.id as string);
      // A row the projection does not know is a row whose profile vanished
      // between the two reads. Fall back to the most restrictive answer rather
      // than to the raw columns: no name, no avatar, locked.
      const presented = ident?.presentedName ?? null;
      const fallbackLabel = presented ?? (p.handle as string) ?? "?";
      const isFollowing = followingSet.has(p.id as string);
      const isPrivate = ident ? ident.lockedPreview : true;
      return {
        id: p.id,
        type,
        title: presented ?? (p.handle as string) ?? "",
        subtitle: p.handle ? `@${p.handle as string}` : null,
        avatarUrl: ident?.avatarUrl ?? null,
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
        verified: ident?.verified ?? false,
        isOfficial: (p.is_official as boolean) ?? false,
      };
    });

    return mapped;
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("events", error);
    if (!data) return [];

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

    // Trips §7.3 (census-trips TR133): with a trip in context, each event is
    // placed against the trip's freedom windows — the engine's windows, not a
    // local notion of free time — and the ones that fit lead, stably. Windows
    // that cannot be read are reported as such on every row, never guessed.
    if (ctx?.tripId) {
      const read = await readTripWindows(sc, ctx.tripId, userId);
      for (const r of mapped) {
        const fit = read.ok ? fitInstantToWindows(read.projection, r.startsAt) : null;
        r.metadata = {
          ...(r.metadata ?? {}),
          tripFit: fit
            ? { verdict: fit.verdict, windowId: fit.windowId, conflictingCommitmentIds: fit.conflictingCommitmentIds, reason: fit.reason, decisionId: fit.decisionId, info: fit.info }
            : { verdict: "NOT_CONSULTED", windowId: null, conflictingCommitmentIds: [], reason: null, decisionId: null, info: read.ok ? "" : read.info },
        };
      }
    }

    return mapped;
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
    return [];
  }
}

/** Trips §7.3 (TR133): rows whose tripFit is FITS first, stably; untouched when nothing carries a verdict. */
function leadWithTripFit(rows: SearchResult[]): SearchResult[] {
  if (!rows.some((r) => (r.metadata as any)?.tripFit)) return rows;
  const fits = rows.filter((r) => (r.metadata as any)?.tripFit?.verdict === "FITS");
  const rest = rows.filter((r) => (r.metadata as any)?.tripFit?.verdict !== "FITS");
  return [...fits, ...rest];
}

/**
 * Trips — public only; blocked/suspended owners excluded.
 *
 * Two sources for the candidate rows, one CAPABILITY between them —
 * `discovery_trip_projection_enabled` (migration 2550, seeded FALSE) AND the
 * `trips` schema the projection reader names (migration 2420):
 *
 *   NOT READY (the seed; every failure to read the flag; and a flag that is ON
 *   over a database whose `trips` lacks a required column, which is production
 *   today) — the legacy read below, byte-identical to before: same columns,
 *   same predicates, same order, same range. Pinned by
 *   src/test/discoveryTripProjectionConsumer.test.ts.
 *
 *   READY — searchTripDiscoveryProjections, the Trip-owned contract
 *   (domain/trips/contracts/tripDiscoveryProjection.ts; Trips spec §25, census-discovery A10/D3).
 *   Discovery no longer states the visibility rule; it consumes
 *   `discoverable`. A read that fails AFTER the probe passed
 *   (TRIP_PROJECTION_UNAVAILABLE — a transient error, a revoked grant, a
 *   schema-cache lag) is `[]`, never a crash and never a leak; the capability
 *   decides the branch, so there is no silent fallback that would hide it.
 *   The owner's non-member privacy toggles then apply to a searcher; see
 *   lib/discoveryTripProjectionConsumer.ts for why that is accepted.
 *
 * Both sources feed ONE card mapping, so the two paths cannot drift in what a
 * card shows. The blocked / age-restricted / active-owner filters run on
 * both, here, on ownerId — they are Trust and Discovery rules, not Trip ones.
 */
async function searchTrips(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
  ctx?: SearchQueryContext,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    let cards: DiscoveryTripCardSource[];

    const gate = await discoveryTripProjectionGate(sc);
    recordDiscoveryTripSource("trips", gate);

    if (gate.source === "projection") {
      const r = await searchTripDiscoveryProjections(sc, {
        text: q,
        startsAfter: ctx?.startsAfter,
        startsBefore: ctx?.startsBefore,
        offset,
        limit: fetchLimit,
      });
      if (!r.ok) {
        logger.warn({ reason: r.reason, detail: r.detail }, "trip discovery projection unavailable; trips search returns nothing");
        return [];
      }
      const { accepted, rejected } = acceptTripDiscoveryProjections(r.projections);
      if (rejected > 0) logger.warn({ rejected }, "trip discovery projections of an unreadable schema version dropped");
      cards = accepted.map(tripCardSourceFromProjection);
    } else {
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

      // The same line P1 removed from the plans path, and for the same reason:
      // supabase-js RESOLVES on a read failure, so `error` here is a real outage
      // and `return []` makes it byte-identical to a query that matched nothing.
      // This is the branch production takes (§6 D3: 2420 unapplied, 2550 seeded
      // FALSE). `!data` without an error is a shape anomaly, not a failed read,
      // and keeps the empty answer it always had.
      if (error) throw new DiscoverySearchReadError("trips", error);
      if (!data) return [];

      cards = (data as any[]).map((t: any): DiscoveryTripCardSource => ({
        id: t.id as string,
        ownerId: t.owner_id as string,
        title: (t.title as string | null) ?? null,
        destinationCity: (t.destination_city as string | null) ?? null,
        destinationCountry: (t.destination_country as string | null) ?? null,
        coverUrl: (t.cover_url as string | null) ?? null,
        startDate: (t.start_date as string | null) ?? null,
        status: t.status as string,
        createdAt: (t.created_at as string | null) ?? null,
      }));
    }

    const rows = cards.filter(
      (t) => !blockedSet.has(t.ownerId) && !ageRestrictedSet.has(t.ownerId),
    );
    if (rows.length === 0) return [];

    const ownerIds = [...new Set(rows.map((t) => t.ownerId))];
    const activeOwnerSet = await fetchActiveOwnerSet(sc, ownerIds);

    return rows
      .filter((t) => activeOwnerSet.has(t.ownerId))
      .map((t): SearchResult => ({
        id: t.id,
        type: "trips",
        title: t.title ?? t.destinationCity ?? "",
        subtitle: [t.destinationCity, t.destinationCountry].filter(Boolean).join(", ") || null,
        avatarUrl: null,
        imageUrl: t.coverUrl ?? null,
        fallbackInitials: initials(t.title ?? ""),
        locationPreview: [t.destinationCity, t.destinationCountry].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: null,
        privacyState: { isPublic: true },
        accessState: { canAccess: true },
        destinationRoute: `/trip/${t.id}`,
        metadata: { ownerId: t.ownerId, status: t.status },
        createdAt: t.createdAt ?? null,
        startsAt: t.startDate ?? null,
      }));
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only the
    // named read error re-enters the route's catch arm and becomes a refusal.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("trip_plan_items", error);
    if (!data) return [];

    const items = (data as any[]).filter(
      (p: any) => !blockedSet.has(p.creator_id as string) && !ageRestrictedSet.has(p.creator_id as string),
    );
    if (items.length === 0) return [];

    const tripIds = [...new Set(items.map((p: any) => p.trip_id as string))];

    // The parent trips, from one of two sources behind the same capability as
    // searchTrips above (flag AND schema). Either way each candidate carries
    // `admitted` — may THIS viewer see this trip's plans — decided by Trip
    // semantics, and `ownerId` / `startDate` for the Discovery-owned filters
    // that follow.
    let parents: DiscoveryPlanParentTrip[];

    const gate = await discoveryTripProjectionGate(sc);
    recordDiscoveryTripSource("plans", gate);

    if (gate.source === "projection") {
      // Not filtered by discoverability in SQL: the by-id reader returns the
      // owner's own private trip too, and tripDiscoveryAdmits — Trips' rule,
      // not restated here — decides per viewer. A failed read is `[]`.
      const r = await readTripDiscoveryProjections(sc, tripIds);
      if (!r.ok) {
        logger.warn({ reason: r.reason, detail: r.detail }, "trip discovery projection unavailable; plans search returns nothing");
        return [];
      }
      const { accepted, rejected } = acceptTripDiscoveryProjections(r.projections);
      if (rejected > 0) logger.warn({ rejected }, "trip discovery projections of an unreadable schema version dropped");
      // startDate is the projection's — null when the owner hides exact dates,
      // in which case the time-intent bound below passes the trip exactly as
      // it passes a trip with no start_date today. The contract carries no
      // separate bounding date for the by-id reader (reported, not worked
      // around by reading `trips` here).
      parents = accepted.map((p): DiscoveryPlanParentTrip => ({
        id: p.tripId,
        ownerId: p.ownerId,
        startDate: p.startDate,
        admitted: tripDiscoveryAdmits(p, userId),
      }));
    } else {
      const { data: trips, error: tripsErr } = await sc
        .from("trips")
        .select("id, visibility, show_in_discovery, owner_id, status, start_date")
        .in("id", tripIds)
        // Same dead literals as searchTrips above ("deleted" / "banned" are not
        // `trip_status` labels). The error USED to be dropped here, and this is
        // the branch production takes (§6 D3: 2420 unapplied, 2550 seeded FALSE),
        // so a `trips` outage emptied `parents`, dropped every plan as "no
        // allowed parent trip", and answered 200 {results: []} — D11's masquerade.
        .not("status", "in", '("draft","cancelled","archived")');
      if (tripsErr) throw new DiscoverySearchReadError("trips", tripsErr);
      parents = ((trips ?? []) as any[]).map((t: any): DiscoveryPlanParentTrip => ({
        id: t.id as string,
        ownerId: t.owner_id as string,
        startDate: (t.start_date as string | null) ?? null,
        // Public trips: also require show_in_discovery so owners who opted out are excluded.
        // Caller-owned trips are always visible regardless of the flag.
        admitted:
          ((t.visibility as string) === "public" && t.show_in_discovery === true) ||
          (t.owner_id as string) === userId,
      }));
    }

    const allowedTrips = parents.filter(
      (t) =>
        t.admitted &&
        !blockedSet.has(t.ownerId) &&
        !ageRestrictedSet.has(t.ownerId) &&
        // Time-intent: filter by parent trip's start_date when bounds are present
        (!ctx?.startsAfter  || !t.startDate || t.startDate >= ctx.startsAfter.slice(0, 10)) &&
        (!ctx?.startsBefore || !t.startDate || t.startDate <  ctx.startsBefore.slice(0, 10)),
    );

    const allowedOwnerIds: string[] = [...new Set<string>(allowedTrips.map((t) => t.ownerId))];
    const activeTripOwnerSet = await fetchActiveOwnerSet(sc, allowedOwnerIds);

    const visibleTripIds = new Set<string>(
      allowedTrips
        .filter((t) => activeTripOwnerSet.has(t.ownerId))
        .map((t) => t.id),
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
  // Everything this arm swallowed before, it still swallows. The ONE thing it
  // must not swallow is the read failure it was itself hiding, re-raised so the
  } catch (err) { if (err instanceof DiscoverySearchReadError) throw err; return []; }
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("discovery_places", error);
    if (!data) return [];

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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
    return [];
  }
}

/**
 * §27 "Saved items" — the ninth search heading, and the only VIEWER-SCOPED one.
 *
 * WHY THIS EXISTS
 * ===============
 * The Map spec §27 lists nine result headings and the client has carried all
 * nine since map search was written: `MAP_SEARCH_RESULT_TYPES` ends in
 * `'saved'`, `SavedSearchResult` carries a `savedKind` discriminant,
 * `frameFor` has a `case 'saved'` with its own FOCUS_TRIP / FOCUS_AREA /
 * FOCUS_PLACE ladder, and `SERVER_TYPE_TO_MAP_TYPE` holds `saved` and
 * `wishlist` keys. Every one of those was unreachable: `SEARCH_TYPES` — the
 * wire vocabulary the client's own coverage test derives from this file — had
 * no `saved` member, so no result of that type could ever arrive. census-map
 * M201 recorded the whole heading as BUILT-BUT-WRONG for exactly that reason.
 *
 * THE TWO TABLES SAVES ACTUALLY LAND IN
 * =====================================
 * Not `public.saved_places`. That table has zero writers anywhere in the repo
 * (see lib/mapProducers/savedPlaceProducer.ts, which was moved off it by #446,
 * and scripts/checkWriterlessReads). Real saves land in:
 *
 *   `wishlist_places`        POST /api/wishlist — every TripWishlistPicker save,
 *                            including the Map's own long-press. `place_id` is
 *                            TEXT in the SERVED id space (`db/<uuid>`,
 *                            `comm/<uuid>`, an OSM key), with a `place_data`
 *                            snapshot beside it.
 *   `discovery_place_saves`  POST /api/discovery/community/:id/save — the
 *                            DiscoveryWall bookmark. `place_id` is a
 *                            `discovery_places.id` uuid.
 *
 * Neither is a superset of the other, so reading one alone loses a whole save
 * path. Both are read here, bridged onto one venue key, and deduped.
 *
 * WHY IT DOES NOT CALL `readSavedPlacePins`
 * =========================================
 * That function is the map gateway's PRIVACY-COMPLETE saved read, and
 * src/test/gatewayBypassGuard.test.ts names routes/mapProjection.ts as its one
 * approved caller. Search is not a projection: it has no viewport, no §24
 * protection pass and no MapObject envelope. Calling it from here would either
 * break that guard or widen it to a caller that does none of the work it
 * guarantees. So this lane issues its own, narrower read of the same two
 * tables and produces a plain SearchResult like every other lane.
 *
 * WHAT IT DOES NOT DO. A save is private to the person who made it, so this
 * lane never reads another user's rows: `user_id` is the authenticated
 * viewer's and nothing widens it. A blocked submitter's venue is filtered out
 * with the same `submitterIsVisible` rule searchPlaces applies — blocking
 * someone should not be undone by having saved their venue earlier.
 */
const SAVED_SOURCE_ROW_CAP = 200;
const SAVED_ID_CHUNK = 50;

interface WishlistSaveRow { place_id?: unknown; place_data?: unknown; saved_at?: unknown }
interface DiscoverySaveRow { place_id?: unknown; saved_at?: unknown }

/** The snapshot `place_data` shape this lane reads. Every field optional. */
function snapshotOf(raw: unknown): { name: string | null; city: string | null; lat: number | null; lng: number | null } {
  const d = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  return {
    name: str(d.name) ?? str(d.title),
    city: str(d.city) ?? str(d.locationPreview),
    lat: num(d.lat) ?? num(d.latitude),
    lng: num(d.lng) ?? num(d.longitude),
  };
}

/** Case-insensitive substring match, the in-memory twin of the SQL `ilike`. */
function matchesQuery(q: string, ...fields: Array<string | null>): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === "") return false;
  return fields.some((f) => typeof f === "string" && f.toLowerCase().includes(needle));
}

/**
 * What `searchSaved` could not read, named. Empty means the shelf is COMPLETE
 * and its emptiness is trustworthy; non-empty means the rows returned are real
 * but are not all of them.
 *
 * These strings ride out on `refusal.failedSources` exactly as `searchAll`'s do,
 * so a client has one vocabulary for "part of this answer is missing" whether
 * the missing part is a whole search type or one table inside a type.
 */
type SavedCoverage = { results: SearchResult[]; degradedSources: string[] };

async function searchSaved(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SavedCoverage> {
  const degradedSources: string[] = [];
  if (blockedSet === null) return { results: [], degradedSources };
  try {
    const [wishRes, dpsRes] = await Promise.all([
      sc.from("wishlist_places")
        .select("place_id, place_data, saved_at")
        .eq("user_id", userId)
        .order("saved_at", { ascending: false })
        .limit(SAVED_SOURCE_ROW_CAP),
      sc.from("discovery_place_saves")
        .select("place_id, saved_at")
        .eq("user_id", userId)
        .order("saved_at", { ascending: false })
        .limit(SAVED_SOURCE_ROW_CAP),
    ]);

    // supabase-js RESOLVES on a DB error, so an unreadable table and an empty
    // one arrive identically. Read each independently: one table being
    // unreadable must not silently turn the other's saves into "no saves".
    //
    // READING THEM INDEPENDENTLY WAS ONLY HALF OF IT. The comment above was
    // true of the DIRECTION and false of the mechanism: `error` was never
    // bound, so an unreadable table was not detected at all — it was treated
    // as empty. When BOTH were unreadable the lane answered `[]`, which the
    // route serves as `200 { results: [] }` with no `refusal`: a claim that
    // this person has saved nothing, made without reading either table that
    // holds their saves. `saved` is the one VIEWER-SCOPED search type, so it is
    // the heading whose emptiness the user knows for a fact is wrong.
    //
    // A total outage rejects. ONE unreadable table still serves the other's
    // rows, which is a real half-answer rather than a lie — the two tables are
    // written by paths that never write each other's.
    //
    // THAT HALF-ANSWER IS NO LONGER SILENT. It used to be, and the reason was
    // structural rather than chosen: `dispatchSearch` returned a bare array
    // with no channel to carry `coverage: "partial"`, so the lane's only two
    // vocabulary words were "here are some rows" and "nothing was readable" —
    // and the second is an untruth in the other direction when one table DID
    // answer. The channel exists now (`SavedCoverage` above,
    // `dispatchSearchWithCoverage` below), so the lane says which table it
    // could not read and the route turns that into `coverage: "partial"` with
    // `failedSources`. The user is told their shelf is incomplete instead of
    // being shown a short one that looks whole.
    //
    // The REFUSAL is unchanged and deliberately not relaxed: both tables
    // unreadable still throws, because then there is no half to serve. Pinned
    // both ways by `src/test/discoverySavedRefusal.test.ts` (R1 and R5).
    const wishUnreadable = !!wishRes?.error;
    const dpsUnreadable = !!dpsRes?.error;
    if (wishUnreadable && dpsUnreadable) {
      throw new DiscoverySearchReadError(
        "wishlist_places+discovery_place_saves",
        wishRes?.error ?? dpsRes?.error,
      );
    }
    if (wishUnreadable) degradedSources.push("wishlist_places");
    if (dpsUnreadable) degradedSources.push("discovery_place_saves");
    const wishRows: WishlistSaveRow[] = Array.isArray(wishRes?.data) ? wishRes.data : [];
    const dpsRows: DiscoverySaveRow[] = Array.isArray(dpsRes?.data) ? dpsRes.data : [];

    const savedAtOf = (r: { saved_at?: unknown }): string | null =>
      typeof r.saved_at === "string" ? r.saved_at : null;

    /** venueId (a discovery_places.id) → the most recent moment it was saved. */
    const byVenue = new Map<string, string | null>();
    const noteVenue = (id: string, at: string | null): void => {
      const prev = byVenue.get(id);
      if (prev === undefined) { byVenue.set(id, at); return; }
      if (at && (!prev || at > prev)) byVenue.set(id, at);
    };

    for (const r of dpsRows) {
      if (typeof r.place_id === "string" && r.place_id !== "") noteVenue(r.place_id, savedAtOf(r));
    }

    /** Wishlist rows that reach no discovery_places row — snapshot only. */
    const snapshotOnly: Array<{ servedId: string; savedAt: string | null; snap: ReturnType<typeof snapshotOf> }> = [];
    const wishlist = wishRows.filter((r): r is WishlistSaveRow & { place_id: string } =>
      typeof r.place_id === "string" && r.place_id !== "");

    const servedIds = [...new Set(wishlist.map((r) => r.place_id))];
    const bridged = new Map<string, Set<string>>();
    for (const page of chunkIds(servedIds, SAVED_ID_CHUNK)) {
      // noCache: an OSM venue's discovery_places row is created lazily on first
      // save, so a cached known-empty from before that save would drop it.
      const { toCanonical, degraded } = await resolvePlaceIdBridge(sc, page, { noCache: true });
      // A degraded bridge does not lose the save — an unbridged wishlist row
      // falls through to `snapshotOnly` below and still lists from the snapshot
      // the save itself recorded. What it loses is the AUTHORITATIVE row: the
      // venue's current name, category, photo and coordinates. That is a real
      // degradation of this shelf and it is reported rather than absorbed,
      // because before `lib/placeIdBridge.ts` bound its error there was nothing
      // here that could tell "this place has no discovery_places row" from
      // "we could not find out".
      if (degraded && !degradedSources.includes("discovery_places")) {
        degradedSources.push("discovery_places");
      }
      for (const [served, ids] of toCanonical) bridged.set(served, ids);
    }

    for (const r of wishlist) {
      const ids = bridged.get(r.place_id);
      if (ids && ids.size > 0) {
        // Deterministic when one served id mirrors onto several rows.
        noteVenue([...ids].sort()[0] as string, savedAtOf(r));
        continue;
      }
      snapshotOnly.push({ servedId: r.place_id, savedAt: savedAtOf(r), snap: snapshotOf(r.place_data) });
    }

    // ── resolve the authoritative venue rows, filtered by the query ──────────
    const pat = sqlPattern(q);
    const venues: any[] = [];
    for (const page of chunkIds([...byVenue.keys()], SAVED_ID_CHUNK)) {
      const { data, error } = await sc
        .from("discovery_places")
        .select("id, name, city, blurb, image_url, primary_category, category, lat, lng, submitted_by")
        .in("id", page)
        .eq("status", "active")
        .or(`name.ilike.${pat},city.ilike.${pat},blurb.ilike.${pat}`);
      // `discovery_places` is the authoritative row behind every venue save, and
      // there is no second source for it. `continue` dropped every save in a
      // failed page with no signal at all — the same masquerade, one level down.
      // Every OTHER reader of this table in this file throws here: `searchPlaces`
      // and `searchActivities` both do. `searchSaved` was the one that did not.
      if (error) throw new DiscoverySearchReadError("discovery_places", error);
      if (!Array.isArray(data)) continue;
      venues.push(...data);
    }

    const out: SearchResult[] = [];
    for (const v of venues) {
      if (!v || typeof v.id !== "string") continue;
      if (!submitterIsVisible(v.submitted_by, blockedSet)) continue;
      const name = (v.name as string | null) ?? "";
      out.push({
        id: v.id,
        type: "saved",
        title: name,
        subtitle: ((v.primary_category ?? v.category) as string | null) ?? null,
        avatarUrl: null,
        imageUrl: (v.image_url as string | null) ?? null,
        fallbackInitials: initials(name),
        locationPreview: (v.city as string | null) ?? null,
        matchedReason: "Saved",
        actionState: { isSaved: true },
        privacyState: null,
        accessState: { canAccess: true },
        destinationRoute: `/place/${v.id}`,
        metadata: {
          // The client's SavedSearchResult discriminant. Stated by the server
          // rather than assumed by the adapter, so a future saved Trip or Area
          // can arrive through the same heading without a second wire type.
          savedKind: "place",
          category: v.primary_category ?? v.category,
          lat: (v.lat as number | null) ?? null,
          lng: (v.lng as number | null) ?? null,
          savedAt: byVenue.get(v.id) ?? null,
        },
        createdAt: byVenue.get(v.id) ?? null,
        startsAt: null,
      });
    }

    // ── the snapshot tail ────────────────────────────────────────────────────
    // A wishlist save whose served id reaches no discovery_places row is still
    // a save the person made, and dropping it would make the heading lie about
    // its own contents. It is matched against the snapshot the save recorded
    // and placed from the snapshot's coordinates — never from anywhere else.
    for (const s of snapshotOnly) {
      if (!matchesQuery(q, s.snap.name, s.snap.city)) continue;
      const name = s.snap.name ?? "";
      if (name === "") continue;
      out.push({
        id: s.servedId,
        type: "saved",
        title: name,
        subtitle: null,
        avatarUrl: null,
        imageUrl: null,
        fallbackInitials: initials(name),
        locationPreview: s.snap.city,
        matchedReason: "Saved",
        actionState: { isSaved: true },
        privacyState: null,
        accessState: { canAccess: true },
        destinationRoute: `/place/${s.servedId}`,
        metadata: {
          savedKind: "place",
          lat: s.snap.lat,
          lng: s.snap.lng,
          savedAt: s.savedAt,
          fromSnapshot: true,
        },
        createdAt: s.savedAt,
        startsAt: null,
      });
    }

    // Most recently saved first, then the caller's page. Match-tier ranking is
    // applied by dispatchSearch, as it is for every other non-place lane.
    out.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return { results: out.slice(offset, offset + fetchLimit), degradedSources };
  } catch (err) {
    // Re-raise ONLY the named read error, on `searchPlans`' precedent: the arm
    // keeps swallowing everything it already swallowed, and lets the one thing
    // that means "a table could not be read" reach the route's catch arm and
    // become a refusal. A bare `catch { return []; }` here undid both throws
    // above without leaving a trace.
    if (err instanceof DiscoverySearchReadError) throw err;
    return { results: [], degradedSources };
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("hidden_gems", error);
    if (!data) return [];

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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("hashtags", error);
    if (!data) return [];

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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("posts", error);
    if (!data) return [];

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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("circles", error);
    if (!data) return [];

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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("stamp_definitions", error);
    if (!data) return [];

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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    // supabase-js RESOLVES on a read failure, so `error` here is an outage and
    // `return []` makes it byte-identical to a query that matched nothing —
    // `11` §9's masquerade, through the back door of a destructure. `!data`
    // without an error is a shape anomaly, not a failed read, and keeps the
    // empty answer it always had.
    if (error) throw new DiscoverySearchReadError("discovery_places", error);
    if (!data) return [];

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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

    if (profileResult.error) throw new DiscoverySearchReadError("profiles", profileResult.error);
    if (!profileResult.data) return [];
    // Fail-closed: unknown opt-out state → return nothing (location signals must
    // not leak). The DIRECTION was right and stays right — a refusal serves the
    // same empty collection. What changes is that it SAYS so: `return []` alone
    // was byte-identical to "no city matched", so a caller could not tell a
    // privacy-preserving refusal from a search result, which is the masquerade
    // D11 forbids whichever way the default leans.
    if (optOutResult.error) throw new DiscoverySearchReadError("profile_privacy_settings", optOutResult.error);
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
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

/** Build one `countries` row. Shared by both legs so the shape cannot fork. */
function countryResult(
  name: string,
  source: "registry" | "profile",
  countryCode: string | null,
): SearchResult {
  const key = name.toLowerCase();
  return {
    id: `country:${key}`,
    type: "countries",
    title: name,
    subtitle: null,
    avatarUrl: null,
    imageUrl: null,
    fallbackInitials: initials(name),
    locationPreview: null,
    matchedReason: null,
    actionState: null,
    privacyState: null,
    accessState: { canAccess: true },
    destinationRoute: `/country/${encodeURIComponent(key)}`,
    // §27's position contract: `lat`/`lng` are always PRESENT, null included, so
    // "this row has no position" is a value rather than a missing key.
    // `canonical_locations` models kind='country' but holds no country rows
    // today, so in practice a country carries a null position until the registry
    // is seeded — the honest answer rather than a centroid averaged out of
    // whatever cities happen to exist. `attachCentroids` fills it when it can.
    //
    // `source` is provenance and it is load-bearing: `registry` means the row
    // came from the ISO-3166-1 table and is the same for every viewer;
    // `profile` means no canonical country resolved and the row exists only
    // because somebody typed it into `home_country`.
    metadata: { lat: null, lng: null, source, countryCode },
    createdAt: null,
    startsAt: null,
  };
}

/**
 * Countries — the canonical ISO-3166-1 registry, joined with the free-text
 * names `profiles.home_country` carries that the registry cannot resolve.
 *
 * WHY THE REGISTRY LEG EXISTS (census-discovery B05 / GII G277)
 * ============================================================
 * This function used to aggregate `profiles.home_country` and nothing else, so
 * the set of countries that EXISTED as a suggestion was a function of who had
 * signed up: Iceland was not a country on this surface until an Icelander was.
 * B05 is careful to call that a CONSTRUCTION defect rather than a leak — the
 * read was and is opt-out filtered — and its stated blocker was that the fix
 * "needs a canonical country registry Discovery does not own".
 *
 * That blocker is no longer true. `lib/countryCodes.ts` is ISO-3166-1 alpha-2
 * with canonical English names, an alias index and a diacritic-insensitive
 * fold; it is pure data with no I/O, it is in this package, and
 * `lib/stamps/countryLookup.ts` already consumes it. Discovery consumes the
 * SAME module rather than growing a second country list — the rule C32 and
 * DC-24 exist to enforce, applied to names instead of ranking.
 *
 * THE PROFILE LEG IS KEPT, and keeping it is the point. A traveller may have
 * typed a home country the ISO table has no row for. Dropping that row to make
 * the function tidy would delete a real answer, so a free-text name the
 * registry cannot resolve still lists, carrying `source: "profile"`.
 *
 * WHY A FAILED PRIVACY READ STILL REFUSES THE WHOLE BUCKET
 * =======================================================
 * The registry leg needs no privacy read, so the obvious next move is to serve
 * it when `profiles` or `profile_privacy_settings` could not be read. It does
 * not, and that is deliberate: a registry-only page is missing every free-text
 * country only `profiles` knows, and a body that is short by an unknown amount
 * is indistinguishable from a complete one. That is exactly the masquerade D11
 * forbids — "we did not look" served as "we looked, and this is all there is".
 * The bucket has one answer and one refusal; making half of it answerable
 * would need an intra-bucket partial the response envelope does not have.
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

    if (profileResult.error) throw new DiscoverySearchReadError("profiles", profileResult.error);
    if (!profileResult.data) return [];
    // Fail-closed: unknown opt-out state → return nothing (location signals must
    // not leak). The DIRECTION was right and stays right — a refusal serves the
    // same empty collection. What changes is that it SAYS so: `return []` alone
    // was byte-identical to "no city matched", so a caller could not tell a
    // privacy-preserving refusal from a search result, which is the masquerade
    // D11 forbids whichever way the default leans.
    if (optOutResult.error) throw new DiscoverySearchReadError("profile_privacy_settings", optOutResult.error);
    const optOutSet = new Set<string>(
      ((optOutResult.data as any[]) ?? []).map((r: any) => r.user_id as string),
    );

    // ── Leg 1: the canonical registry. Pure, viewer-independent, no I/O. ──────
    // Asked for the whole page the caller could reach, because the offset is
    // applied to the MERGED list below and not to either leg on its own.
    const registry = searchCountryRegistry(q, offset + fetchLimit);
    const takenCodes = new Set<string>(registry.map((m) => m.code));
    const takenKeys = new Set<string>(registry.map((m) => m.name.toLowerCase()));
    const merged: SearchResult[] = registry.map((m) => countryResult(m.name, "registry", m.code));

    // ── Leg 2: free-text names the registry could not resolve. ───────────────
    // Same privacy model as before, unchanged: blocked, age-restricted and
    // discovery-opted-out profiles contribute nothing.
    const tail: SearchResult[] = [];
    for (const p of (profileResult.data as any[])) {
      if (
        blockedSet.has(p.id as string) ||
        ageRestrictedSet.has(p.id as string) ||
        optOutSet.has(p.id as string)
      ) continue;
      const country = ((p.home_country as string | null) ?? "").trim();
      if (!country) continue;
      // A typed name the registry DOES know is the same country under a
      // different spelling ("japan", "Holland"), so it folds into the canonical
      // row instead of appearing beside it.
      const code = toCountryCode(country);
      if (code !== null && takenCodes.has(code)) continue;
      const key = country.toLowerCase();
      if (takenKeys.has(key)) continue;
      takenKeys.add(key);
      if (code !== null) takenCodes.add(code);
      tail.push(countryResult(country, "profile", code));
    }

    // The registry head is ALREADY ranked, by rungs that know how each row was
    // reached. The tail is not, so it is match-tier ranked here — the ordering
    // `dispatchSearch` used to apply to the whole bucket, kept for the half it
    // is still the right answer for.
    merged.push(...rankByMatchTier(tail, q));

    const results = merged.slice(offset, offset + fetchLimit);
    await attachCentroids(sc, results, CANONICAL_COUNTRY_KINDS);
    return results;
  } catch (err) {
    // Everything this function already swallowed, it keeps swallowing. Only
    // the named read error re-enters the route's catch arm and refuses.
    if (err instanceof DiscoverySearchReadError) throw err;
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

/**
 * A single-type search plus what it could not read.
 *
 * `results` are REAL rows in every case — a degraded source removes rows from
 * the answer, it never fabricates them. `degradedSources` empty means the
 * answer is complete and its emptiness is trustworthy.
 */
export interface DispatchCoverage {
  results: SearchResult[];
  degradedSources: string[];
}

/**
 * Exported (additive) as the single per-type candidate generator. The
 * input-assistance gateway calls INTO this (same per-type query + privacy +
 * ranking code paths) rather than forking a parallel search implementation.
 *
 * SIGNATURE DELIBERATELY UNCHANGED. This is now a thin projection of
 * `dispatchSearchWithCoverage` onto its `results`, because the alternative —
 * widening the return type — is a change across eighteen call sites and four
 * censuses' citations for the benefit of the one caller that can act on the
 * extra field. A caller that only wants rows keeps getting rows.
 *
 * WHAT THIS WRAPPER DROPS, SAID PLAINLY: the coverage. A caller of
 * `dispatchSearch` cannot distinguish a complete answer from a partial one, and
 * that is a real limitation of this form rather than an absence of the
 * information. `GET /discovery/search` uses the coverage form below for exactly
 * that reason. Anything that renders results to a person should too.
 */
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
  const { results } = await dispatchSearchWithCoverage(
    sc, q, userId, blockedSet, ageRestrictedSet, type, offset, fetchLimit, ctx,
  );
  return results;
}

/**
 * The coverage-bearing form. Same search, same privacy gate, same ranking —
 * it additionally reports which of the type's underlying tables could not be
 * read, so a route can answer `coverage: "partial"` instead of serving a short
 * list that looks whole.
 *
 * Only `saved` can be intra-type partial today, and that is a property of the
 * data rather than of this function: it is the one type whose rows come from
 * two independently-written tables, either of which can fail while the other
 * answers. Every other type reads one corpus, so its failure is total and
 * arrives as a `DiscoverySearchReadError` that the route turns into
 * `coverage: "nothing"`. The `sink` is threaded through the switch rather than
 * special-cased above it so that a second multi-source type acquires the
 * behaviour by pushing into it, not by growing a second mechanism.
 */
export async function dispatchSearchWithCoverage(
  sc: any,
  q: string,
  userId: string,
  blockedSet: Set<string> | null,
  ageRestrictedSet: Set<string> | null,
  type: Exclude<SearchType, "all">,
  offset: number,
  fetchLimit: number,
  ctx?: SearchQueryContext,
): Promise<DispatchCoverage> {
  const degradedSources: string[] = [];
  const results = await dispatchOne(
    sc, q, userId, blockedSet, ageRestrictedSet, type, offset, fetchLimit, degradedSources, ctx,
  );
  return { results, degradedSources };
}

async function dispatchOne(
  sc: any,
  q: string,
  userId: string,
  blockedSet: Set<string> | null,
  ageRestrictedSet: Set<string> | null,
  type: Exclude<SearchType, "all">,
  offset: number,
  fetchLimit: number,
  degradedSink: string[],
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
      // Trips §7.3 (TR133): after the match-tier ranking, the events that fit
      // the trip's windows lead — a stable partition, so the ranking's order
      // survives within each half. A no-op when no trip was in context.
      return leadWithTripFit(rankCombined(raw, q, ctx?.userCity, { upcomingFirst: true })).slice(offset, offset + fetchLimit);
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
    // Already ordered most-recently-saved-first inside the lane; rankByMatchTier
    // is a stable sort, so an exact-name save still leads without losing that.
    case "saved": {
      const saved = await searchSaved(sc, q, userId, blockedSet, offset, fetchLimit);
      for (const s of saved.degradedSources) if (!degradedSink.includes(s)) degradedSink.push(s);
      return rankByMatchTier(saved.results, q);
    }
    case "hidden_gems": return rankByMatchTier(await searchHiddenGems(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit), q);
    case "hashtags":    return rankByMatchTier(await searchHashtags(sc, q, offset, fetchLimit),                                         q);
    case "posts":       return rankByMatchTier(await searchPosts(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit),      q);
    case "circles":     return rankByMatchTier(await searchCircles(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit),    q);
    case "stamps":      return rankByMatchTier(await searchStamps(sc, q, offset, fetchLimit),                                          q);
    case "activities":  return rankByMatchTier(await searchActivities(sc, q, blockedSet, offset, fetchLimit),                          q);
    case "cities":      return rankByMatchTier(await searchCities(sc, q, blockedSet, ageRestrictedSet, offset, fetchLimit),            q);
    // Countries manage their own ordering, on `searchPlaces`' precedent two
    // lines above, and the reason is a defect a test caught rather than a
    // preference. `rankByMatchTier` scores the TITLE against the raw query, so
    // it cannot see that a row was reached through an ALIAS: "United Kingdom"
    // does not contain "uk", so every country a person names colloquially —
    // uk, holland, bali, dubai — scored tier 0 and sorted behind any country
    // whose spelling happened to contain the letters. `searchCountries` ranks
    // the registry head by rungs that know how each row was reached, and
    // match-tier ranks the free-text tail itself.
    case "countries":   return searchCountries(sc, q, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "languages":   return rankByMatchTier(searchStatic(q, COMMON_LANGUAGES, "languages", "/language", offset, fetchLimit),        q);
    case "interests":   return rankByMatchTier(searchStatic(q, COMMON_INTERESTS, "interests", "/interest", offset, fetchLimit),        q);
    case "vibes":       return rankByMatchTier(searchStatic(q, COMMON_VIBES,     "vibes",     "/vibe",     offset, fetchLimit),        q);
    default:            return [];
  }
}

// ── type=all fan-out ───────────────────────────────────────────────────────────
//
// 17 of the 18 non-"all" types run in parallel at FAN_LIMIT items each.
//
// `saved` is the one deliberately LEFT OUT. It is the only viewer-scoped type
// — the person's own saves, not a public corpus — and this fan-out feeds the
// app's ONE global search as well as the map's. Folding a private, always-
// matching bucket into "All" would change what every other surface shows, and
// what census-discovery and census-input-intelligence measure, for the sake of
// one Map spec heading. Map search asks for it explicitly alongside `all`
// instead (src/components/map/MapSearchSheet.tsx), which is a decision this
// lane can make about its own surface. Whether "All" should include your saves
// is an owner's call, not a side effect.
// Results are merged round-robin so no type dominates the top.
// The merged pool is sliced at [globalOffset, globalOffset+limit].
// hasMore = pool.length > globalOffset + limit.

const FAN_LIMIT = 20;

/**
 * The 17 buckets, in the exact order of the `settled` array below.
 *
 * A bucket that REJECTS is named from here rather than merely counted: "some of
 * this answer is missing" without saying which part is not a usable answer
 * either. These strings ride out on `refusal.failedSources`.
 */
const FAN_SOURCES = [
  "travelers", "buddies", "events", "trips", "plans", "places", "hidden_gems",
  "hashtags", "posts", "circles", "stamps", "activities", "cities", "countries",
  "languages", "interests", "vibes",
] as const;

async function searchAll(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  globalOffset: number, limit: number,
  ctx?: SearchQueryContext,
): Promise<{
  results: SearchResult[]; hasMore: boolean; nextCursor: string | null;
  /** Buckets whose read FAILED. Empty on the healthy path. */
  unreadableSources: string[];
}> {
  if (blockedSet === null || ageRestrictedSet === null) {
    return { results: [], hasMore: false, nextCursor: null, unreadableSources: [] };
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
  // A REJECTED bucket used to become `[]` right here, and that `[]` then merged
  // into the answer indistinguishably from a bucket that was read and matched
  // nothing. `DiscoverySearchReadError` exists precisely so a swallowed
  // supabase-js read error re-enters the route's catch arm and becomes a
  // refusal — and `Promise.allSettled` catches it before that arm ever sees it.
  // So `type=all`, which is the DEFAULT type and what the global search bar
  // sends, answered `200 { results: [...] }` with a silently missing bucket and
  // no refusal on it: D11's masquerade, on the route where a user is most
  // likely to meet it. The names go out on the refusal instead.
  const unreadableSources: string[] = [];
  const rawBuckets: SearchResult[][] = settled.map((r, i) => {
    if (r.status !== "fulfilled") {
      const source = FAN_SOURCES[i] ?? `bucket_${i}`;
      logger.warn({ err: r.reason, source }, "discovery/search type=all: source unreadable");
      unreadableSources.push(source);
      return [];
    }
    return rankCombined(r.value, q, ctx?.userCity, { upcomingFirst: true });
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
  return { results: page, hasMore, nextCursor, unreadableSources };
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

  // Trips §7.3 (TR133): a trip in context, for the event results. UUID or nothing.
  const rawTripId = typeof req.query.tripId === "string" ? req.query.tripId.trim() : "";
  const ctxTripId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawTripId) ? rawTripId : null;

  const ctx: SearchQueryContext = {
    tripId: ctxTripId,
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
    // Fail-closed: unknown block or age-restriction state → serve NOTHING, never
    // leak content. `fetchBlockedSet` returns null for "could not be read", not
    // for "there are none", and the two must not be confused.
    //
    // D11: the fail-closed DIRECTION was always right and is unchanged. What was
    // wrong is that it was SILENT — the per-type search functions collapse a null
    // set to [], so a transient blocks-table failure left this route answering
    // `200 { results: [] }`, the same body it gives a query that genuinely
    // matches nothing. The read is refused explicitly now, so the caller is told
    // the difference instead of being handed a search result that is not one.
    const [blockedSet, ageRestrictedSet] = await Promise.all([
      fetchBlockedSet(sc, user.id),
      fetchAgeRestrictedSet(sc),
    ]);
    if (!blockedSet || !ageRestrictedSet) {
      sendDiscoveryRefusal(
        res,
        { results: [], nextCursor: null, hasMore: false, query: effectiveQ, type, timeLabel: ctx.timeLabel },
        discoveryRefusal("transient_db", "visibility_state_unreadable", "GET /discovery/search"),
      );
      return;
    }

    // Stage 0b — serve point 8. Search ranks nothing and logs nothing today; a
    // grep of this file for rankCandidates / rankItemsForDiscovery /
    // drsRankItems / logImpression returns nothing at all.
    const logSearchServe = (results: SearchResult[]) => {
      logServeUnlessRefused(res, sc, {
        userId: user.id,
        servePoint: DiscoveryServePoint.SEARCH,
        route: "GET /discovery/search",
        items: results.map((r) => ({ id: r.id, kind: searchTypeToItemKind(r.type) })),
        context: { type, offset, resultCount: results.length },
      });
    };

    if (type === "all") {
      const { results, hasMore, nextCursor, unreadableSources } =
        await searchAll(sc, effectiveQ, user.id, blockedSet, ageRestrictedSet, offset, limit, ctx);
      const body = { results, nextCursor, hasMore, query: effectiveQ, type, timeLabel: ctx.timeLabel };
      if (unreadableSources.length > 0) {
        // "partial" as long as ANY source answered, even when this page happens
        // to be empty: the buckets that were read are a real result, and their
        // emptiness is trustworthy. Only a fan-out where every source failed
        // carries "nothing" — an empty collection that is empty BECAUSE of the
        // failure, which is what that word means. `failedSources` says which
        // absences are not evidence of absence.
        sendDiscoveryRefusal(
          res,
          body,
          discoveryRefusal(
            "transient_db", "search_sources_unreadable", "GET /discovery/search",
            unreadableSources.length === FAN_SOURCES.length ? "nothing" : "partial",
            unreadableSources,
          ),
        );
      } else {
        res.status(200).json(body);
      }
      // Not suppressed on a partial: those items really were served, and
      // dropping them would under-count exposure — see logServeUnlessRefused.
      logSearchServe(results);
    } else {
      // Fetch limit+1 to detect hasMore without false positives
      const fetchLimit = limit + 1;
      const { results: raw, degradedSources } =
        await dispatchSearchWithCoverage(sc, effectiveQ, user.id, blockedSet, ageRestrictedSet, type, offset, fetchLimit, ctx);
      const hasMore = raw.length > limit;
      const results = raw.slice(0, limit);
      const nextCursor = hasMore ? encodeCursor(offset + limit) : null;
      const body = { results, nextCursor, hasMore, query: effectiveQ, type, timeLabel: ctx.timeLabel };
      if (degradedSources.length > 0) {
        // INTRA-TYPE PARTIAL. The `type=all` branch above has carried this since
        // 2026-09-14 for a whole bucket that failed; this is the same statement
        // one level down, for a table that failed INSIDE a bucket.
        //
        // `saved` is why it exists and is the only type that can reach it today:
        // its rows come from `wishlist_places` and `discovery_place_saves`, two
        // tables written by two paths that never write each other's, so one can
        // fail while the other answers. Before this, that answered
        // `200 { results: [...] }` with no `refusal` — a SHORT shelf presented
        // as a WHOLE one, on the single search heading whose contents the person
        // knows for a fact, because they are their own saves. Silence there is
        // not a small defect: it is the `11` §9 masquerade with some rows in
        // front of it, which is harder to notice than the empty version.
        //
        // "partial", never "nothing": rows WERE served and they are real.
        // Refusing whole here would be the untruth in the opposite direction,
        // and the total-outage case already has its own throw in `searchSaved`.
        sendDiscoveryRefusal(
          res,
          body,
          discoveryRefusal(
            "transient_db", "search_sources_unreadable", "GET /discovery/search",
            "partial", degradedSources,
          ),
        );
      } else {
        res.status(200).json(body);
      }
      // Not suppressed on a partial, for the same reason the `all` branch is
      // not: those items really were served, and dropping them from the serve
      // log would under-count exposure.
      logSearchServe(results);
    }
  } catch (err) {
    logger.warn({ err, q: effectiveQ, type }, "discovery/search failed");
    // D11 / `11` §9. Same body as before plus the one key that tells the caller
    // this is a failure and not a search that found nothing.
    sendDiscoveryRefusal(
      res,
      { results: [], nextCursor: null, hasMore: false, query: effectiveQ, type, timeLabel: null },
      discoveryRefusal("transient_db", "search_failed", "GET /discovery/search"),
    );
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
    // `11` §9 class 1, VALIDATION — and the one place in this lane where a
    // validation refusal is NOT a 4xx. This fires on every keystroke of a
    // typeahead; a 400 here would turn normal typing into a stream of client
    // errors, and the input is not invalid, it is merely not yet enough. So the
    // 200 stays and the refusal names why the groups are empty. Contrast
    // /discovery/search, whose `q` is a required parameter and whose
    // `invalid_payload` 400 is left exactly as it is.
    sendDiscoveryRefusal(
      res,
      { query: q, groups: [] },
      discoveryRefusal("validation", "query_too_short", "GET /discovery/suggest"),
    );
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
      // D11: the early return and its fail-closed direction are unchanged; only
      // the silence is fixed. This body used to be byte-identical to the two
      // others this route can send (too-short query, and the catch below), which
      // is the row C14 certified as correct and the owner's D11 ruling
      // supersedes.
      sendDiscoveryRefusal(
        res,
        { query: q, groups: [] },
        discoveryRefusal("transient_db", "visibility_state_unreadable", "GET /discovery/suggest"),
      );
      return;
    }

    const ctx: SearchQueryContext = { lat, lng, userCity: city, nearbyIntent: false };
    const plan = isHandleQuery
      ? SUGGEST_PLAN.filter((p) => p.type === "travelers" || p.type === "buddies")
      : SUGGEST_PLAN;

    // The same back door `searchAll` had: a REJECTED type became an empty group,
    // indistinguishable from a type that was read and matched nothing, so a
    // typeahead could lose a whole category to an outage and say nothing about
    // it. Collected by PLAN INDEX rather than pushed, so the names come out in
    // plan order however the parallel reads finish.
    const unreadableAt = new Array<string | null>(plan.length).fill(null);
    const [typedResults, canonicalRows] = await Promise.all([
      Promise.all(plan.map((p, i) =>
        dispatchSearch(sc, q, user.id, blockedSet, ageRestrictedSet, p.type, 0, p.limit, ctx)
          .catch((err: unknown) => {
            logger.warn({ err, type: p.type, q }, "discovery/suggest: type unreadable");
            unreadableAt[i] = p.type;
            return [] as SearchResult[];
          }),
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
    const unreadableTypes = unreadableAt.filter((t): t is string => t !== null);
    const body = { query: q, groups: servedGroups };
    if (unreadableTypes.length > 0) {
      // "partial" while ANY type answered: those groups are real, and
      // `useSearchSuggestions` renders and caches a partial for exactly that
      // reason while refusing to cache a "nothing". Only a fan-out where every
      // type failed carries "nothing".
      sendDiscoveryRefusal(
        res,
        body,
        discoveryRefusal(
          "transient_db", "suggest_sources_unreadable", "GET /discovery/suggest",
          unreadableTypes.length === plan.length ? "nothing" : "partial",
          unreadableTypes,
        ),
      );
    } else {
      res.status(200).json(body);
    }
    // Stage 0b — serve point 9. Flattened in the order the groups are served,
    // so `position` reflects what the user actually saw top to bottom.
    logServeUnlessRefused(res, sc, {
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
    sendDiscoveryRefusal(
      res,
      { query: q, groups: [] },
      discoveryRefusal("transient_db", "suggest_failed", "GET /discovery/suggest"),
    );
  }
});

// ── GET /api/discovery/people/:userId/passport ────────────────────────────────
//
// §21 TABLE 22, Discovery row: "identity, verification, availability, Open to
// Plans, shared context, permitted trust summary". That is the discovery_card
// variant verbatim, so this route builds NOTHING — it authorises the request and
// returns what the one Passport assembler produced for this viewer (§35).
//
// The search list above ranks people; this is the card one of those rows opens.
// The two agree by construction: the same subject the list withholds
// (`allow_profile_discovery = false`, or age-restricted) is refused here by the
// shared gate, and blocking / account status are settled inside the assembler,
// which answers a blocked relationship with the variant's restricted shape
// rather than a 404 — the client must not be able to tell "blocked" from
// "does not exist" by the status code.
router.get("/discovery/people/:userId/passport", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { userId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    sendError(res, "invalid_payload", "Invalid user id");
    return;
  }

  const rl = checkRateLimit("discovery_person_card", user.id, 60, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many requests. Please wait.");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const gate = await allowDiscoveryPersonCard(sc, userId);
  if (!gate.allowed) { sendError(res, "not_found", "User not found"); return; }

  try {
    const passport = await buildConsumerProjection(sc, "discovery_card", userId, user.id);
    if (!passport) { sendError(res, "not_found", "User not found"); return; }
    res.status(200).json({ passport });
  } catch (err) {
    logger.warn({ err, userId }, "discovery person card projection failed");
    sendError(res, "db_error", "Could not load person card");
  }
});

export default router;

// ─────────────────────────────────────────────────────────────────────────────
// A read this file MUST NOT answer with an empty list.
//
// DECLARED HERE, AT THE END OF THE FILE, ON PURPOSE. 37 census rows and four
// sibling censuses cite `routes/discoverySearch.ts` by line. Declaring this
// type next to its use shifted 79 of those anchors, and repointing 79
// citations across documents this lane does not own — to fix a defect in one
// function — is a worse trade than one out-of-place declaration. Class bodies
// are evaluated at module load and this one is referenced only from a request
// handler, so the ordering is a reading inconvenience and not a TDZ hazard.
//
// WHAT IT IS FOR. Every per-type search function in this file swallows its own
// failures and returns `[]`. For most of them the DIRECTION is a deliberate
// fail-closed choice and is right. What it costs is the one thing owner ruling
// D11 and `11` §9 forbid: that `[]` is byte-identical to the `[]` a query which
// genuinely matched nothing produces, so the route answers `200 { results: [] }`
// for an outage, with no `refusal` on it.
//
// supabase-js RESOLVES on a read failure. A discarded `error` therefore does not
// throw, never reaches the route's catch arm, and never becomes a refusal — the
// masquerade arrives through the back door of a destructure rather than through
// the front door the refusal envelope guards.
//
// Throwing this type is how such a read re-enters the front door: the route's
// catch arm answers it with `transient_db` / `search_failed` and
// `coverage: "nothing"`, which is the truth. It is a NAMED type rather than a
// bare Error so the per-type catch arms keep swallowing everything they already
// swallowed and re-raise only this.
// ─────────────────────────────────────────────────────────────────────────────
export class DiscoverySearchReadError extends Error {
  /** The relation that could not be read, for the log and the alert. */
  readonly relation: string;
  constructor(relation: string, cause?: unknown) {
    super(`discovery search: ${relation} could not be read`, { cause });
    this.name = "DiscoverySearchReadError";
    this.relation = relation;
  }
}
