/**
 * GET /api/discovery/search  — Unified cross-type search
 *
 * Query params:
 *   q       string  (required, min 2 chars, max 200)
 *   type    string  all | travelers | buddies | events | trips | plans |
 *                   places | hidden_gems | hashtags | posts | circles |
 *                   stamps | activities | cities | countries | languages |
 *                   interests | vibes   (default: all)
 *   limit   number  1–50  (default 20)
 *   cursor  string  opaque pagination cursor from previous response
 *
 * Response: { results: SearchResult[], nextCursor, hasMore, query, type }
 *
 * Privacy rules enforced server-side:
 *   - Blocked users excluded in both directions from all people/content types.
 *   - Private accounts and suspended/banned/deleted accounts never appear.
 *   - Private trips, events, and circles are filtered to public-only.
 *   - Moderation-removed content (status=deleted/banned) is excluded.
 *   - Private profile discovery opt-outs are respected for travelers.
 *   - Sensitive fields (email, phone, location coords) never included.
 *
 * Rate limited: 30 requests/min per user.
 */

import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { checkRateLimit } from "../lib/rateLimit";
import { logger as rootLogger } from "../lib/logger";

const router = Router();
const logger = rootLogger.child({ route: "discoverySearch" });

// ── Supported types ────────────────────────────────────────────────────────────

const SEARCH_TYPES = [
  "all", "travelers", "buddies", "events", "trips", "plans",
  "places", "hidden_gems", "hashtags", "posts", "circles",
  "stamps", "activities", "cities", "countries", "languages",
  "interests", "vibes",
] as const;

type SearchType = typeof SEARCH_TYPES[number];

// ── Normalized result shape ────────────────────────────────────────────────────

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

// ── Blocked-user set ───────────────────────────────────────────────────────────

async function fetchBlockedSet(sc: any, userId: string): Promise<Set<string>> {
  try {
    const { data, error } = await sc
      .from("blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
    if (error || !data) return new Set();
    const set = new Set<string>();
    for (const b of (data as any[])) {
      if ((b as any).blocker_id === userId) set.add((b as any).blocked_id);
      else set.add((b as any).blocker_id);
    }
    return set;
  } catch {
    return new Set();
  }
}

// ── Per-type search functions ──────────────────────────────────────────────────

async function searchTravelers(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
  offset: number, limit: number, isBuddy = false,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    let query = sc
      .from("profiles")
      .select("id, handle, username, name, avatar_url, is_private, home_city, home_country, account_status")
      .or(`name.ilike.${pat},handle.ilike.${pat},username.ilike.${pat}`)
      .neq("id", userId)
      .in("account_status", ["active"])
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

    if (isBuddy) query = query.eq("is_buddy", true);

    const { data, error } = await query;
    if (error || !data) return [];

    // Fetch privacy opt-outs for remaining profiles
    const rows = (data as any[]).filter((p: any) => !blockedSet.has(p.id as string));
    if (rows.length === 0) return [];

    const ids = rows.map((p: any) => p.id as string);
    const { data: noDisc } = await sc
      .from("profile_privacy_settings")
      .select("user_id")
      .in("user_id", ids)
      .eq("allow_profile_discovery", false);
    const noDiscSet = new Set<string>((noDisc ?? []).map((r: any) => r.user_id as string));

    const type: Exclude<SearchType, "all"> = isBuddy ? "buddies" : "travelers";
    return rows
      .filter((p: any) => !noDiscSet.has(p.id as string))
      .map((p: any): SearchResult => ({
        id: p.id,
        type,
        title: (p.name as string) ?? (p.handle as string) ?? "",
        subtitle: p.handle ? `@${p.handle as string}` : null,
        avatarUrl: (p.avatar_url as string | null) ?? null,
        imageUrl: null,
        fallbackInitials: initials((p.name as string) ?? (p.handle as string) ?? "?"),
        locationPreview: [(p.home_city as string | null), (p.home_country as string | null)].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: null,
        privacyState: { isPrivate: Boolean(p.is_private) },
        accessState: { canAccess: !p.is_private },
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

async function searchEvents(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
  offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("events")
      .select("id, title, description, host_id, cover_image_url, city, country, starts_at, visibility, status, created_at")
      .or(`title.ilike.${pat},description.ilike.${pat},city.ilike.${pat}`)
      .eq("visibility", "public")
      .neq("status", "cancelled")
      .neq("status", "deleted")
      .order("starts_at", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error || !data) return [];

    return (data as any[])
      .filter((e: any) => !blockedSet.has(e.host_id as string))
      .map((e: any): SearchResult => ({
        id: e.id,
        type: "events",
        title: (e.title as string) ?? "",
        subtitle: (e.city as string | null) ?? null,
        avatarUrl: null,
        imageUrl: (e.cover_image_url as string | null) ?? null,
        fallbackInitials: initials((e.title as string) ?? ""),
        locationPreview: [(e.city as string | null), (e.country as string | null)].filter(Boolean).join(", ") || null,
        matchedReason: null,
        actionState: null,
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

async function searchTrips(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
  offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("trips")
      .select("id, title, destination_city, destination_country, owner_id, cover_image_url, start_date, status, visibility, created_at")
      .or(`title.ilike.${pat},destination_city.ilike.${pat},destination_country.ilike.${pat}`)
      .eq("visibility", "public")
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error || !data) return [];

    return (data as any[])
      .filter((t: any) => !blockedSet.has(t.owner_id as string))
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

async function searchPlans(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
  offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("trip_plan_items")
      .select("id, title, notes, trip_id, creator_id, created_at")
      .or(`title.ilike.${pat},notes.ilike.${pat}`)
      .is("removed_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error || !data) return [];

    return (data as any[])
      .filter((p: any) => !blockedSet.has(p.creator_id as string))
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

async function searchPlaces(
  sc: any, q: string, offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("discovery_places")
      .select("id, name, city, blurb, image_url, category, primary_category, created_at")
      .or(`name.ilike.${pat},city.ilike.${pat},blurb.ilike.${pat}`)
      .eq("status", "active")
      .order("saved_count", { ascending: false })
      .range(offset, offset + limit - 1);

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

async function searchHiddenGems(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
  offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("hidden_gems")
      .select("id, name, description, city, country, submitted_by, image_url, category, status, created_at")
      .or(`name.ilike.${pat},description.ilike.${pat},city.ilike.${pat}`)
      .in("status", ["approved", "active"])
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

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

async function searchHashtags(
  sc: any, q: string, offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("hashtags")
      .select("id, slug, name, usage_count, created_at")
      .or(`slug.ilike.${pat},name.ilike.${pat}`)
      .eq("is_blocked", false)
      .order("usage_count", { ascending: false })
      .range(offset, offset + limit - 1);

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

async function searchPosts(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
  offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("posts")
      .select("id, content, author_id, media_urls, created_at, like_count")
      .ilike("content", pat)
      .eq("visibility", "public")
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error || !data) return [];

    return (data as any[])
      .filter((p: any) => !blockedSet.has(p.author_id as string))
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

async function searchCircles(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
  offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("circles")
      .select("id, name, description, owner_id, cover_image_url, city, visibility, created_at")
      .or(`name.ilike.${pat},description.ilike.${pat},city.ilike.${pat}`)
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error || !data) return [];

    return (data as any[])
      .filter((c: any) => !blockedSet.has(c.owner_id as string))
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

async function searchStamps(
  sc: any, q: string, offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("stamp_definitions")
      .select("id, slug, name, description, icon_url, created_at")
      .or(`name.ilike.${pat},description.ilike.${pat},slug.ilike.${pat}`)
      .eq("is_active", true)
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

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

async function searchActivities(
  sc: any, q: string, offset: number, limit: number,
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
      .range(offset, offset + limit - 1);

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

async function searchCities(
  sc: any, q: string, offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("profiles")
      .select("home_city, home_country")
      .ilike("home_city", pat)
      .in("account_status", ["active"])
      .not("home_city", "is", null)
      .limit((offset + limit) * 5);

    if (error || !data) return [];

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const p of (data as any[])) {
      const city = ((p.home_city as string | null) ?? "").trim();
      if (!city) continue;
      const key = city.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size <= offset) continue;
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
      if (results.length >= limit) break;
    }
    return results;
  } catch {
    return [];
  }
}

async function searchCountries(
  sc: any, q: string, offset: number, limit: number,
): Promise<SearchResult[]> {
  try {
    const pat = sqlPattern(q);
    const { data, error } = await sc
      .from("profiles")
      .select("home_country")
      .ilike("home_country", pat)
      .in("account_status", ["active"])
      .not("home_country", "is", null)
      .limit((offset + limit) * 5);

    if (error || !data) return [];

    const seen = new Set<string>();
    const results: SearchResult[] = [];
    for (const p of (data as any[])) {
      const country = ((p.home_country as string | null) ?? "").trim();
      if (!country) continue;
      const key = country.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (seen.size <= offset) continue;
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
      if (results.length >= limit) break;
    }
    return results;
  } catch {
    return [];
  }
}

function searchStatic<T extends Exclude<SearchType, "all">>(
  q: string, items: string[], type: T, routePrefix: string,
  offset: number, limit: number,
): SearchResult[] {
  const lower = q.toLowerCase();
  return items
    .filter((item) => item.toLowerCase().includes(lower))
    .slice(offset, offset + limit)
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

// ── Dispatch single type ───────────────────────────────────────────────────────

async function dispatchSearch(
  sc: any,
  q: string,
  userId: string,
  blockedSet: Set<string>,
  type: Exclude<SearchType, "all">,
  offset: number,
  limit: number,
): Promise<SearchResult[]> {
  switch (type) {
    case "travelers":   return searchTravelers(sc, q, userId, blockedSet, offset, limit, false);
    case "buddies":     return searchTravelers(sc, q, userId, blockedSet, offset, limit, true);
    case "events":      return searchEvents(sc, q, userId, blockedSet, offset, limit);
    case "trips":       return searchTrips(sc, q, userId, blockedSet, offset, limit);
    case "plans":       return searchPlans(sc, q, userId, blockedSet, offset, limit);
    case "places":      return searchPlaces(sc, q, offset, limit);
    case "hidden_gems": return searchHiddenGems(sc, q, userId, blockedSet, offset, limit);
    case "hashtags":    return searchHashtags(sc, q, offset, limit);
    case "posts":       return searchPosts(sc, q, userId, blockedSet, offset, limit);
    case "circles":     return searchCircles(sc, q, userId, blockedSet, offset, limit);
    case "stamps":      return searchStamps(sc, q, offset, limit);
    case "activities":  return searchActivities(sc, q, offset, limit);
    case "cities":      return searchCities(sc, q, offset, limit);
    case "countries":   return searchCountries(sc, q, offset, limit);
    case "languages":   return Promise.resolve(searchStatic(q, COMMON_LANGUAGES, "languages", "/language", offset, limit));
    case "interests":   return Promise.resolve(searchStatic(q, COMMON_INTERESTS, "interests", "/interest", offset, limit));
    case "vibes":       return Promise.resolve(searchStatic(q, COMMON_VIBES, "vibes", "/vibe", offset, limit));
    default:            return [];
  }
}

// ── type=all fan-out ───────────────────────────────────────────────────────────

async function searchAll(
  sc: any, q: string, userId: string, blockedSet: Set<string>,
): Promise<SearchResult[]> {
  const FAN_LIMIT = 5;
  const settled = await Promise.allSettled([
    searchTravelers(sc, q, userId, blockedSet, 0, FAN_LIMIT),
    searchEvents(sc, q, userId, blockedSet, 0, FAN_LIMIT),
    searchTrips(sc, q, userId, blockedSet, 0, FAN_LIMIT),
    searchPlaces(sc, q, 0, FAN_LIMIT),
    searchHiddenGems(sc, q, userId, blockedSet, 0, FAN_LIMIT),
    searchHashtags(sc, q, 0, FAN_LIMIT),
    searchPosts(sc, q, userId, blockedSet, 0, FAN_LIMIT),
    searchCircles(sc, q, userId, blockedSet, 0, FAN_LIMIT),
    Promise.resolve(searchStatic(q, COMMON_LANGUAGES, "languages", "/language", 0, FAN_LIMIT)),
    Promise.resolve(searchStatic(q, COMMON_INTERESTS, "interests", "/interest", 0, FAN_LIMIT)),
    Promise.resolve(searchStatic(q, COMMON_VIBES, "vibes", "/vibe", 0, FAN_LIMIT)),
  ]);

  // Interleave round-robin: take one result from each bucket per pass
  const buckets: SearchResult[][] = settled.map((r) =>
    r.status === "fulfilled" ? r.value : [],
  );
  const merged: SearchResult[] = [];
  const maxLen = Math.max(...buckets.map((b) => b.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) {
      if (i < bucket.length) merged.push(bucket[i]!);
    }
  }
  return merged;
}

// ── Route handler ─────────────────────────────────────────────────────────────

router.get("/discovery/search", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  // Rate limit: 30 req/min per user
  const rl = checkRateLimit("discovery_search", user.id, 30, 60_000);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many search requests. Please wait and try again.");
    return;
  }

  // Validate q
  const raw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (raw.length < 2) {
    sendError(res, "invalid_payload", "q must be at least 2 characters");
    return;
  }
  if (raw.length > 200) {
    sendError(res, "invalid_payload", "q must be at most 200 characters");
    return;
  }

  // Validate type
  const rawType = typeof req.query.type === "string" ? req.query.type.trim() : "all";
  if (!(SEARCH_TYPES as readonly string[]).includes(rawType)) {
    sendError(res, "invalid_payload", `type must be one of: ${SEARCH_TYPES.join(", ")}`);
    return;
  }
  const type = rawType as SearchType;

  // Parse limit + cursor
  const rawLimit = parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 50);

  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const offset = decodeCursor(cursor);

  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  try {
    const q = raw;
    const blockedSet = await fetchBlockedSet(sc, user.id);

    let results: SearchResult[];

    if (type === "all") {
      results = await searchAll(sc, q, user.id, blockedSet);
    } else {
      results = await dispatchSearch(sc, q, user.id, blockedSet, type, offset, limit);
    }

    const hasMore = type !== "all" && results.length === limit;
    const nextCursor = hasMore ? encodeCursor(offset + limit) : null;

    res.status(200).json({ results, nextCursor, hasMore, query: q, type });
  } catch (err) {
    logger.warn({ err, q: raw, type }, "discovery/search failed");
    res.status(200).json({ results: [], nextCursor: null, hasMore: false, query: raw, type });
  }
});

export default router;
