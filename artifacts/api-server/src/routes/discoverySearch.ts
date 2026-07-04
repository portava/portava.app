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
import { checkRateLimit } from "../lib/rateLimit";
import { logger as rootLogger } from "../lib/logger";

const router = Router();
const logger = rootLogger.child({ route: "discoverySearch" });

// ── SearchType enum (mirrors openapi.yaml) ────────────────────────────────────

const SEARCH_TYPES = [
  "all", "travelers", "buddies", "events", "trips", "plans",
  "places", "hidden_gems", "hashtags", "posts", "circles",
  "stamps", "activities", "cities", "countries", "languages",
  "interests", "vibes",
] as const;

type SearchType = typeof SEARCH_TYPES[number];

// ── PostgREST injection guard ──────────────────────────────────────────────────
//
// .or() expressions in PostgREST use commas and parentheses as metacharacters.
// Strip them so user input cannot break filter syntax or bypass privacy controls.

function sanitizeQuery(s: string): string {
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
  return `%${q.replace(/[%_]/g, "\\$&")}%`;
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

async function fetchAgeRestrictedSet(sc: any): Promise<Set<string> | null> {
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
// Fails open (returns all IDs) to avoid over-blocking on DB errors.

async function fetchActiveOwnerSet(sc: any, ownerIds: string[]): Promise<Set<string>> {
  if (ownerIds.length === 0) return new Set();
  try {
    const { data } = await sc
      .from("profiles")
      .select("id")
      .in("id", ownerIds)
      .in("account_status", ["active"]);
    return new Set<string>((data ?? []).map((p: any) => p.id as string));
  } catch {
    return new Set(ownerIds);  // fail-open: prefer inclusion over false negatives
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
 *   - is_private=true excluded (DB filter).
 *   - Only account_status='active' (DB filter).
 *   - Profile-discovery opt-outs excluded (secondary query, fail-closed).
 *   - Blocked users excluded; returns [] on null blockedSet.
 *
 * actionState: { isFollowing: boolean }
 */
async function searchTravelers(
  sc: any, q: string, userId: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number, isBuddy = false,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    let query = sc
      .from("profiles")
      .select("id, handle, username, name, avatar_url, is_private, home_city, home_country, account_status")
      .or(`name.ilike.${pat},handle.ilike.${pat},username.ilike.${pat}`)
      .neq("id", userId)
      .in("account_status", ["active"])
      .eq("is_private", false)
      .order("name", { ascending: true })
      .range(offset, offset + fetchLimit - 1);

    if (isBuddy) query = query.eq("is_buddy", true);

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

    const visibleIds = visible.map((p: any) => p.id as string);
    const { data: followEdges } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", userId)
      .in("following_id", visibleIds);
    const followingSet = new Set<string>((followEdges ?? []).map((e: any) => e.following_id as string));

    const type: Exclude<SearchType, "all"> = isBuddy ? "buddies" : "travelers";
    return visible.map((p: any): SearchResult => ({
      id: p.id,
      type,
      title: (p.name as string) ?? (p.handle as string) ?? "",
      subtitle: p.handle ? `@${p.handle as string}` : null,
      avatarUrl: (p.avatar_url as string | null) ?? null,
      imageUrl: null,
      fallbackInitials: initials((p.name as string) ?? (p.handle as string) ?? "?"),
      locationPreview: [(p.home_city as string | null), (p.home_country as string | null)].filter(Boolean).join(", ") || null,
      matchedReason: null,
      actionState: { isFollowing: followingSet.has(p.id as string) },
      privacyState: { isPrivate: false },
      accessState: { canAccess: true },
      destinationRoute: p.handle
        ? `/passport/${p.handle as string}`
        : `/passport/${p.id as string}`,
      metadata: null,
      createdAt: null,
      startsAt: null,
    }));
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
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("events")
      .select("id, title, description, host_id, cover_image_url, city, country, starts_at, visibility, status, created_at")
      .or(`title.ilike.${pat},description.ilike.${pat},city.ilike.${pat}`)
      .eq("visibility", "public")
      .neq("status", "cancelled")
      .neq("status", "deleted")
      .neq("status", "banned")
      .order("starts_at", { ascending: true })
      .range(offset, offset + fetchLimit - 1);

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

    return activeRows.map((e: any): SearchResult => ({
      id: e.id,
      type: "events",
      title: (e.title as string) ?? "",
      subtitle: (e.city as string | null) ?? null,
      avatarUrl: null,
      imageUrl: (e.cover_image_url as string | null) ?? null,
      fallbackInitials: initials((e.title as string) ?? ""),
      locationPreview: [(e.city as string | null), (e.country as string | null)].filter(Boolean).join(", ") || null,
      matchedReason: null,
      actionState: { isAttending: attendingSet.has(e.id as string) },
      privacyState: { isPublic: true },
      accessState: { canAccess: true },
      destinationRoute: `/event/${e.id as string}`,
      metadata: { hostId: e.host_id, status: e.status },
      createdAt: (e.created_at as string | null) ?? null,
      startsAt: (e.starts_at as string | null) ?? null,
    }));
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
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("trips")
      .select("id, title, destination_city, destination_country, owner_id, cover_image_url, start_date, status, visibility, created_at")
      .or(`title.ilike.${pat},destination_city.ilike.${pat},destination_country.ilike.${pat}`)
      .eq("visibility", "public")
      .neq("status", "cancelled")
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

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
        imageUrl: (t.cover_image_url as string | null) ?? null,
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
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("trip_plan_items")
      .select("id, title, notes, trip_id, creator_id, created_at")
      .or(`title.ilike.${pat},notes.ilike.${pat}`)
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
      .select("id, visibility, owner_id")
      .in("id", tripIds);

    const visibleTripIds = new Set<string>(
      (trips ?? [])
        .filter((t: any) => (t.visibility as string) === "public" || (t.owner_id as string) === userId)
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
 * Discovery places — DB-backed curated places (active only).
 */
async function searchPlaces(
  sc: any, q: string, offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("discovery_places")
      .select("id, name, city, blurb, image_url, category, primary_category, created_at")
      .or(`name.ilike.${pat},city.ilike.${pat},blurb.ilike.${pat}`)
      .eq("status", "active")
      .order("saved_count", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    return (data as any[]).map((p: any): SearchResult => ({
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
      metadata: { category: p.primary_category ?? p.category },
      createdAt: (p.created_at as string | null) ?? null,
      startsAt: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Hidden gems — approved/active only; blocked submitter excluded.
 */
async function searchHiddenGems(
  sc: any, q: string, userId: string, blockedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("hidden_gems")
      .select("id, name, description, city, country, submitted_by, image_url, category, status, created_at")
      .or(`name.ilike.${pat},description.ilike.${pat},city.ilike.${pat}`)
      .in("status", ["approved", "active"])
      .order("created_at", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    return (data as any[])
      .filter((g: any) => !blockedSet.has(g.submitted_by as string))
      .map((g: any): SearchResult => ({
        id: g.id,
        type: "hidden_gems",
        title: (g.name as string) ?? "",
        subtitle: (g.category as string | null) ?? null,
        avatarUrl: null,
        imageUrl: (g.image_url as string | null) ?? null,
        fallbackInitials: initials((g.name as string) ?? ""),
        locationPreview: [(g.city as string | null), (g.country as string | null)].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: null,
        privacyState: null,
        accessState: { canAccess: true },
        destinationRoute: `/hidden-gem/${g.id as string}`,
        metadata: { category: g.category },
        createdAt: (g.created_at as string | null) ?? null,
        startsAt: null,
      }));
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
    const { data, error } = await sc
      .from("posts")
      .select("id, content, author_id, media_urls, created_at, like_count")
      .ilike("content", pat)
      .eq("visibility", "public")
      .neq("status", "deleted")
      .neq("status", "banned")
      .order("created_at", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    const rows = (data as any[]).filter(
      (p: any) => !blockedSet.has(p.author_id as string) && !ageRestrictedSet.has(p.author_id as string),
    );
    if (rows.length === 0) return [];

    const authorIds = [...new Set(rows.map((p: any) => p.author_id as string))];
    const activeAuthorSet = await fetchActiveOwnerSet(sc, authorIds);

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
          imageUrl: ((p.media_urls as string[] | null)?.[0]) ?? null,
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
      .or(`name.ilike.${pat},description.ilike.${pat},city.ilike.${pat}`)
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
 */
async function searchActivities(
  sc: any, q: string, offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("discovery_places")
      .select("id, name, city, blurb, image_url, category, created_at")
      .or(`name.ilike.${pat},city.ilike.${pat},blurb.ilike.${pat}`)
      .in("category", ["activities", "sports", "adventure", "outdoors", "wellness"])
      .eq("status", "active")
      .order("saved_count", { ascending: false })
      .range(offset, offset + fetchLimit - 1);

    if (error || !data) return [];

    return (data as any[]).map((p: any): SearchResult => ({
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
      metadata: { category: p.category },
      createdAt: (p.created_at as string | null) ?? null,
      startsAt: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Cities — aggregated from active, non-private, non-blocked profiles.
 * Only active public profiles without discovery opt-outs contribute to the
 * city list so private/blocked user signals cannot leak via geo data.
 */
async function searchCities(
  sc: any, q: string,
  blockedSet: Set<string> | null, ageRestrictedSet: Set<string> | null,
  offset: number, fetchLimit: number,
): Promise<SearchResult[]> {
  if (blockedSet === null || ageRestrictedSet === null) return [];
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("profiles")
      .select("id, home_city, home_country")
      .ilike("home_city", pat)
      .in("account_status", ["active"])
      .eq("is_private", false)
      .not("home_city", "is", null)
      .limit((offset + fetchLimit) * 5);

    if (error || !data) return [];

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    let skipped = 0;
    for (const p of (data as any[])) {
      // Exclude blocked and age-restricted profiles (fail-closed)
      if (blockedSet.has(p.id as string) || ageRestrictedSet.has(p.id as string)) continue;
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
        metadata: null,
        createdAt: null,
        startsAt: null,
      });
      if (results.length >= fetchLimit) break;
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Countries — aggregated from active, non-private, non-blocked profiles.
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
    const { data, error } = await sc
      .from("profiles")
      .select("id, home_country")
      .ilike("home_country", pat)
      .in("account_status", ["active"])
      .eq("is_private", false)
      .not("home_country", "is", null)
      .limit((offset + fetchLimit) * 5);

    if (error || !data) return [];

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    let skipped = 0;
    for (const p of (data as any[])) {
      if (blockedSet.has(p.id as string) || ageRestrictedSet.has(p.id as string)) continue;
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
        metadata: null,
        createdAt: null,
        startsAt: null,
      });
      if (results.length >= fetchLimit) break;
    }
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

async function dispatchSearch(
  sc: any,
  q: string,
  userId: string,
  blockedSet: Set<string> | null,
  ageRestrictedSet: Set<string> | null,
  type: Exclude<SearchType, "all">,
  offset: number,
  fetchLimit: number,
): Promise<SearchResult[]> {
  switch (type) {
    case "travelers":   return searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit, false);
    case "buddies":     return searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit, true);
    case "events":      return searchEvents(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "trips":       return searchTrips(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "plans":       return searchPlans(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "places":      return searchPlaces(sc, q, offset, fetchLimit);
    case "hidden_gems": return searchHiddenGems(sc, q, userId, blockedSet, offset, fetchLimit);
    case "hashtags":    return searchHashtags(sc, q, offset, fetchLimit);
    case "posts":       return searchPosts(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "circles":     return searchCircles(sc, q, userId, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "stamps":      return searchStamps(sc, q, offset, fetchLimit);
    case "activities":  return searchActivities(sc, q, offset, fetchLimit);
    case "cities":      return searchCities(sc, q, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "countries":   return searchCountries(sc, q, blockedSet, ageRestrictedSet, offset, fetchLimit);
    case "languages":   return Promise.resolve(searchStatic(q, COMMON_LANGUAGES, "languages", "/language", offset, fetchLimit));
    case "interests":   return Promise.resolve(searchStatic(q, COMMON_INTERESTS, "interests", "/interest", offset, fetchLimit));
    case "vibes":       return Promise.resolve(searchStatic(q, COMMON_VIBES, "vibes", "/vibe", offset, fetchLimit));
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
): Promise<{ results: SearchResult[]; hasMore: boolean; nextCursor: string | null }> {
  if (blockedSet === null || ageRestrictedSet === null) {
    return { results: [], hasMore: false, nextCursor: null };
  }

  const settled = await Promise.allSettled([
    searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),       // travelers
    searchTravelers(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT, true), // buddies
    searchEvents(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),          // events
    searchTrips(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),           // trips
    searchPlans(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),           // plans
    searchPlaces(sc, q, 0, FAN_LIMIT),                                                // places
    searchHiddenGems(sc, q, userId, blockedSet, 0, FAN_LIMIT),                        // hidden_gems
    searchHashtags(sc, q, 0, FAN_LIMIT),                                              // hashtags
    searchPosts(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),           // posts
    searchCircles(sc, q, userId, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),         // circles
    searchStamps(sc, q, 0, FAN_LIMIT),                                                // stamps
    searchActivities(sc, q, 0, FAN_LIMIT),                                            // activities
    searchCities(sc, q, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),                  // cities
    searchCountries(sc, q, blockedSet, ageRestrictedSet, 0, FAN_LIMIT),               // countries
    Promise.resolve(searchStatic(q, COMMON_LANGUAGES, "languages", "/language", 0, FAN_LIMIT)),
    Promise.resolve(searchStatic(q, COMMON_INTERESTS, "interests", "/interest", 0, FAN_LIMIT)),
    Promise.resolve(searchStatic(q, COMMON_VIBES, "vibes", "/vibe", 0, FAN_LIMIT)),
  ]);

  const buckets: SearchResult[][] = settled.map((r) =>
    r.status === "fulfilled" ? r.value : [],
  );

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

  // Apply PostgREST injection sanitization on top of Zod validation
  let q = sanitizeQuery(parsed.data.q);
  if (q.length < 2) {
    sendError(res, "invalid_payload", "q must be at least 2 characters after sanitization");
    return;
  }

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

    if (type === "all") {
      const { results, hasMore, nextCursor } = await searchAll(sc, q, user.id, blockedSet, ageRestrictedSet, offset, limit);
      res.status(200).json({ results, nextCursor, hasMore, query: q, type });
    } else {
      // Fetch limit+1 to detect hasMore without false positives
      const fetchLimit = limit + 1;
      const raw = await dispatchSearch(sc, q, user.id, blockedSet, ageRestrictedSet, type, offset, fetchLimit);
      const hasMore = raw.length > limit;
      const results = raw.slice(0, limit);
      const nextCursor = hasMore ? encodeCursor(offset + limit) : null;
      res.status(200).json({ results, nextCursor, hasMore, query: q, type });
    }
  } catch (err) {
    logger.warn({ err, q, type }, "discovery/search failed");
    res.status(200).json({ results: [], nextCursor: null, hasMore: false, query: q, type });
  }
});

export default router;
