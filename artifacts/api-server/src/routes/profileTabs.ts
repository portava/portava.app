/**
 * Profile tab endpoints — content tabs shown on a user's public profile.
 *
 * GET /users/:username/posts    — paginated published posts (respects show_posts)
 * GET /users/:username/stamps   — paginated stamps (respects show_stamps)
 * GET /users/:username/trips    — paginated trips (respects show_past_trips / show_upcoming_trips)
 * GET /users/:username/events   — paginated public event memberships
 * GET /users/:username/circles  — paginated public circle memberships
 *
 * All endpoints:
 *   - Apply resolveProfileVisibility guard (blocked → {blocked:true}, unavailable → {unavailable:true})
 *   - Support cursor-based pagination via ?cursor=<iso-timestamp>&limit=<n>
 *   - Return { items: [...], nextCursor: string | null }
 *   - Private profiles or blocked viewers get { items: [], nextCursor: null } (no 403 leak)
 *   - No private fields (DOB, phone, emergency contact) appear in any response
 */

import { Router } from "express";
import { sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import {
  resolveProfileVisibility,
  extractBearerToken,
  type PrivacySettings,
} from "../lib/profileVisibility";

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? DEFAULT_LIMIT), 10);
  return Math.min(Math.max(isNaN(n) ? DEFAULT_LIMIT : n, 1), MAX_LIMIT);
}

async function getOptionalViewerId(sc: any, req: { headers: { authorization?: string } }): Promise<string | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  try {
    const { data: { user }, error } = await sc.auth.getUser(token);
    if (error || !user) return null;
    return user.id;
  } catch {
    return null;
  }
}

/** Resolve the target profile by username. Returns null if not found. */
async function resolveTarget(sc: any, username: string) {
  const { data, error } = await sc
    .from("profiles")
    .select("id, username, is_private, passport_visibility")
    .or(`username.eq.${username},handle.eq.${username}`)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string; username: string; is_private: boolean; passport_visibility: string };
}

/**
 * Shared guard — resolves visibility for the (viewer, target) pair and returns early
 * if the viewer is not allowed to see content at all.
 * Returns null if a response has already been sent.
 */
async function applyVisibilityGuard(
  sc: any,
  viewerId: string | null,
  targetId: string,
  targetRow: { is_private?: boolean | null; passport_visibility?: string | null },
  res: any,
): Promise<{ allowed: boolean; privacySettings: PrivacySettings | null; isOwner: boolean }> {
  const isOwner = viewerId === targetId;

  if (isOwner) {
    const { data: ps } = await sc.from("profile_privacy_settings").select("*").eq("user_id", targetId).maybeSingle().catch(() => ({ data: null }));
    return { allowed: true, privacySettings: ps ?? null, isOwner: true };
  }

  let visibility: string;
  let privacySettings: PrivacySettings | null;
  try {
    const result = await resolveProfileVisibility(sc, viewerId, targetId, targetRow);
    visibility = result.visibility;
    privacySettings = result.privacySettings;
  } catch (e: any) {
    res.status(500).json({ error: "db_error", message: e.message ?? "Visibility check failed" });
    return { allowed: false, privacySettings: null, isOwner: false };
  }

  if (visibility === "unavailable") {
    res.status(200).json({ unavailable: true, items: [], nextCursor: null });
    return { allowed: false, privacySettings: null, isOwner: false };
  }
  if (visibility === "blocked") {
    res.status(200).json({ blocked: true, items: [], nextCursor: null });
    return { allowed: false, privacySettings: null, isOwner: false };
  }
  if (visibility === "limited_preview") {
    res.status(200).json({ items: [], nextCursor: null });
    return { allowed: false, privacySettings: null, isOwner: false };
  }

  return { allowed: true, privacySettings, isOwner: false };
}

/* ===========================================================================
 * GET /users/:username/posts
 * ===========================================================================
 */
router.get("/users/:username/posts", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  const target = await resolveTarget(sc, username);
  if (!target) { sendError(res, "not_found", "User not found"); return; }

  const viewerId = await getOptionalViewerId(sc, req);
  const guard = await applyVisibilityGuard(sc, viewerId, target.id, target, res);
  if (!guard.allowed) return;

  if (!guard.isOwner && guard.privacySettings?.show_posts === false) {
    res.status(200).json({ items: [], nextCursor: null });
    return;
  }

  const limit = parseLimit(req.query.limit);
  const cursor = req.query.cursor as string | undefined;

  let query = sc
    .from("posts")
    .select("id, content, media_urls, location_city, location_country, trip_id, created_at, post_status")
    .eq("author_id", target.id)
    .eq("post_status", "published")
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;
  if (error) {
    if ((error as any).code === "42P01" || (error as any).code === "PGRST205") {
      res.status(200).json({ items: [], nextCursor: null });
      return;
    }
    req.log.error({ err: error }, "profile/posts: query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = data ?? [];
  const items = rows.slice(0, limit).map((r: any) => ({
    id: r.id,
    content: r.content ?? null,
    mediaUrls: r.media_urls ?? [],
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    tripId: r.trip_id ?? null,
    postStatus: r.post_status ?? "published",
    createdAt: r.created_at,
  }));
  const nextCursor = rows.length > limit ? rows[limit - 1]?.created_at ?? null : null;

  res.status(200).json({ items, nextCursor });
});

/* ===========================================================================
 * GET /users/:username/stamps
 * ===========================================================================
 */
router.get("/users/:username/stamps", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  const target = await resolveTarget(sc, username);
  if (!target) { sendError(res, "not_found", "User not found"); return; }

  const viewerId = await getOptionalViewerId(sc, req);
  const guard = await applyVisibilityGuard(sc, viewerId, target.id, target, res);
  if (!guard.allowed) return;

  if (!guard.isOwner && guard.privacySettings?.show_stamps === false) {
    res.status(200).json({ items: [], nextCursor: null });
    return;
  }

  const limit = parseLimit(req.query.limit);
  const cursor = req.query.cursor as string | undefined;

  let query = sc
    .from("stamps")
    .select("id, kind, label, sublabel, country, city, first_earned_at, check_in_count, locked")
    .eq("user_id", target.id)
    .eq("locked", false)
    .order("first_earned_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt("first_earned_at", cursor);
  }

  const { data, error } = await query;
  if (error) {
    if ((error as any).code === "PGRST205" || (error as any).code === "42P01") {
      res.status(200).json({ items: [], nextCursor: null });
      return;
    }
    req.log.error({ err: error }, "profile/stamps: query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = data ?? [];
  const items = rows.slice(0, limit).map((r: any) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    sublabel: r.sublabel ?? null,
    country: r.country ?? null,
    city: r.city ?? null,
    earnedAt: r.first_earned_at,
    checkInCount: r.check_in_count ?? 1,
  }));
  const nextCursor = rows.length > limit ? rows[limit - 1]?.first_earned_at ?? null : null;

  res.status(200).json({ items, nextCursor });
});

/* ===========================================================================
 * GET /users/:username/trips
 * ===========================================================================
 */
router.get("/users/:username/trips", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  const target = await resolveTarget(sc, username);
  if (!target) { sendError(res, "not_found", "User not found"); return; }

  const viewerId = await getOptionalViewerId(sc, req);
  const guard = await applyVisibilityGuard(sc, viewerId, target.id, target, res);
  if (!guard.allowed) return;

  const pps = guard.privacySettings;
  const showPast     = guard.isOwner || (pps?.show_past_trips    !== false);
  const showUpcoming = guard.isOwner || (pps?.show_upcoming_trips !== false);

  if (!showPast && !showUpcoming) {
    res.status(200).json({ items: [], nextCursor: null });
    return;
  }

  const limit = parseLimit(req.query.limit);
  const cursor = req.query.cursor as string | undefined;
  const today = new Date().toISOString().slice(0, 10);

  let query = sc
    .from("trips")
    .select("id, title, destination_city, destination_country, start_date, end_date, status, cover_url, visibility, created_at")
    .eq("owner_id", target.id)
    .or("visibility.eq.public,visibility.is.null")
    .order("start_date", { ascending: false })
    .limit(limit + 1);

  if (!showPast && showUpcoming) {
    query = query.gte("end_date", today);
  } else if (showPast && !showUpcoming) {
    query = query.lt("end_date", today);
  }

  if (cursor) {
    query = query.lt("start_date", cursor);
  }

  const { data, error } = await query;
  if (error) {
    req.log.error({ err: error }, "profile/trips: query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = data ?? [];
  const items = rows.slice(0, limit).map((r: any) => ({
    id: r.id,
    title: r.title ?? null,
    destinationCity: r.destination_city ?? null,
    destinationCountry: r.destination_country ?? null,
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
    status: r.status ?? null,
    coverUrl: r.cover_url ?? null,
  }));
  const nextCursor = rows.length > limit ? rows[limit - 1]?.start_date ?? null : null;

  res.status(200).json({ items, nextCursor });
});

/* ===========================================================================
 * GET /users/:username/events
 * ===========================================================================
 */
router.get("/users/:username/events", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  const target = await resolveTarget(sc, username);
  if (!target) { sendError(res, "not_found", "User not found"); return; }

  const viewerId = await getOptionalViewerId(sc, req);
  const guard = await applyVisibilityGuard(sc, viewerId, target.id, target, res);
  if (!guard.allowed) return;

  const limit = parseLimit(req.query.limit);
  const cursor = req.query.cursor as string | undefined;

  let query = sc
    .from("event_attendees")
    .select("event_id, status, created_at, event:events!inner(id, title, start_time, end_time, location_city, location_country, cover_image_url, visibility)")
    .eq("user_id", target.id)
    .eq("status", "going")
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;
  if (error) {
    if ((error as any).code === "42P01" || (error as any).code === "PGRST205") {
      res.status(200).json({ items: [], nextCursor: null });
      return;
    }
    req.log.error({ err: error }, "profile/events: query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = data ?? [];
  const items = rows
    .slice(0, limit)
    .filter((r: any) => {
      const ev = r.event ?? r;
      return (ev.visibility ?? "public") === "public";
    })
    .map((r: any) => {
      const ev = r.event ?? {};
      return {
        eventId: r.event_id,
        title: ev.title ?? null,
        startTime: ev.start_time ?? null,
        endTime: ev.end_time ?? null,
        locationCity: ev.location_city ?? null,
        locationCountry: ev.location_country ?? null,
        coverImageUrl: ev.cover_image_url ?? null,
        joinedAt: r.created_at,
      };
    });
  const nextCursor = rows.length > limit ? rows[limit - 1]?.created_at ?? null : null;

  res.status(200).json({ items, nextCursor });
});

/* ===========================================================================
 * GET /users/:username/circles
 * ===========================================================================
 */
router.get("/users/:username/circles", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  const target = await resolveTarget(sc, username);
  if (!target) { sendError(res, "not_found", "User not found"); return; }

  const viewerId = await getOptionalViewerId(sc, req);
  const guard = await applyVisibilityGuard(sc, viewerId, target.id, target, res);
  if (!guard.allowed) return;

  const limit = parseLimit(req.query.limit);
  const cursor = req.query.cursor as string | undefined;

  let query = sc
    .from("circle_memberships")
    .select("owner_id, created_at, owner:profiles!circle_memberships_owner_id_fkey(id, handle, username, display_name, name, avatar_url)")
    .eq("member_id", target.id)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data, error } = await query;
  if (error) {
    if ((error as any).code === "42P01" || (error as any).code === "PGRST205") {
      res.status(200).json({ items: [], nextCursor: null });
      return;
    }
    req.log.error({ err: error }, "profile/circles: query failed");
    sendError(res, "db_error", error.message);
    return;
  }

  const rows = data ?? [];
  const items = rows.slice(0, limit).map((r: any) => {
    const owner = r.owner ?? {};
    return {
      circleOwnerId: r.owner_id,
      ownerHandle: owner.handle ?? owner.username ?? null,
      ownerDisplayName: owner.display_name ?? owner.name ?? null,
      ownerAvatarUrl: owner.avatar_url ?? null,
      joinedAt: r.created_at,
    };
  });
  const nextCursor = rows.length > limit ? rows[limit - 1]?.created_at ?? null : null;

  res.status(200).json({ items, nextCursor });
});

export default router;
