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
import { resolveMediaForPosts } from "../lib/postMediaResolve.js";
import { nameVisibilitySet } from "../lib/publicIdentity";
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

const UUID_RE = /^[0-9a-f-]{36}$/i;
function isUuid(s: string) { return UUID_RE.test(s); }

/** Resolve the target profile by username or UUID. Returns null if not found. */
async function resolveTarget(sc: any, username: string) {
  const col = isUuid(username) ? "id" : "handle";
  const { data, error } = await sc
    .from("profiles")
    .select("id, username, is_private, passport_visibility")
    .eq(col, username)
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
    // NOTE: the supabase-js query builder is only a `then`-able (PostgrestBuilder does
    // not extend Promise), so chaining `.catch()` directly on it throws
    // "...catch is not a function" synchronously — it is not a valid error guard.
    // Wrap the awaited call in try/catch instead.
    let ps: PrivacySettings | null = null;
    try {
      const { data } = await sc.from("profile_privacy_settings").select("*").eq("user_id", targetId).maybeSingle();
      ps = data ?? null;
    } catch {
      ps = null;
    }
    return { allowed: true, privacySettings: ps, isOwner: true };
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
  // post_media is canonical for storage-backed media; posts.media_urls holds
  // external references only (ruled 2026-08-12). One query per page, then a
  // pure merge — see lib/postMediaResolve.ts.
  const mediaByPost = await resolveMediaForPosts(sc, rows.slice(0, limit) as any[]);
  const items = rows.slice(0, limit).map((r: any) => ({
    id: r.id,
    content: r.content ?? null,
    mediaUrls: mediaByPost.get(r.id) ?? r.media_urls ?? [],
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

  // Live passport_stamps columns: stamp_type / city / country / awarded_at
  // (no kind/label/sublabel/first_earned_at/check_in_count/locked).
  let query = sc
    .from("passport_stamps")
    .select("id, stamp_type, country, city, awarded_at")
    .eq("user_id", target.id)
    .order("awarded_at", { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt("awarded_at", cursor);
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
    kind: r.stamp_type,
    label: r.city ?? r.country ?? r.stamp_type,
    sublabel: r.city ? (r.country ?? null) : null,
    country: r.country ?? null,
    city: r.city ?? null,
    earnedAt: r.awarded_at,
    checkInCount: 1,
  }));
  const nextCursor = rows.length > limit ? rows[limit - 1]?.awarded_at ?? null : null;

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
  const isOwner = viewerId === target.id;

  // Events hosted by this user — cursor applied server-side on starts_at.
  let hostedQuery = sc
    .from("events")
    .select("id, title, starts_at, ends_at, city, country, cover_url, visibility, created_at")
    .eq("host_id", target.id)
    .eq("visibility", "public")
    .order("starts_at", { ascending: false });
  if (cursor) hostedQuery = hostedQuery.lt("starts_at", cursor);
  const { data: hostedRowsRaw, error: hostedErr } = await hostedQuery.limit(limit + 1);
  const hostedRows = (hostedRowsRaw ?? []) as any[];

  // Events this user is RSVP'd as going to.
  // Visibility is filtered in JS so the fake client in tests still works.
  // Fetch extra rows so client-side cursor filtering doesn't under-fill the page.
  const { data: rsvpRowsRaw, error: rsvpErr } = await sc
    .from("event_rsvps")
    .select("event_id, created_at, event:events!inner(id, title, starts_at, ends_at, city, country, cover_url, visibility)")
    .eq("user_id", target.id)
    .eq("status", "going")
    .eq("event.visibility", "public")
    .order("created_at", { ascending: false })
    .limit(limit * 2 + 1);
  const rsvpRows = ((rsvpRowsRaw ?? []) as any[]).filter((r: any) => {
    if ((r.event?.visibility ?? r.visibility) !== "public") return false;
    if (!cursor) return true;
    const startsAt = (r.event ?? r).starts_at;
    return startsAt ? startsAt < cursor : true;
  });

  // Events this user has been added to as an attendee (legacy/test data uses this shape).
  const { data: attendeeRowsRaw, error: attendeeErr } = await sc
    .from("event_attendees")
    .select("event_id, added_at, event:events!inner(id, title, starts_at, ends_at, city, country, cover_url, visibility)")
    .eq("user_id", target.id)
    .order("added_at", { ascending: false })
    .limit(limit * 2 + 1);
  const attendeeRows = ((attendeeRowsRaw ?? []) as any[]).filter((r: any) => {
    if ((r.event?.visibility ?? r.visibility) !== "public") return false;
    if (!cursor) return true;
    const startsAt = (r.event ?? r).starts_at;
    return startsAt ? startsAt < cursor : true;
  });

  const queryError = hostedErr || rsvpErr || attendeeErr;
  if (queryError) {
    if ((queryError as any)?.code === "42P01" || (queryError as any)?.code === "PGRST205") {
      res.status(200).json({ items: [], nextCursor: null });
      return;
    }
    req.log.error({ err: queryError }, "profile/events: query failed");
    sendError(res, "db_error", (queryError as any)?.message ?? "DB error");
    return;
  }

  const mapRow = (r: any, isHosted: boolean) => {
    const ev = r.event ?? r;
    // Support both live schema field names and legacy/test field names.
    const title = ev.title ?? null;
    const startTime = ev.starts_at ?? ev.start_time ?? null;
    const endTime = ev.ends_at ?? ev.end_time ?? null;
    const locationCity = ev.city ?? ev.location_city ?? null;
    const locationCountry = ev.country ?? ev.location_country ?? null;
    const coverImageUrl = ev.cover_url ?? ev.cover_image_url ?? null;
    const joinedAt = r.created_at ?? r.added_at ?? null;
    return {
      eventId: ev.id ?? r.event_id,
      title,
      startTime,
      endTime,
      locationCity,
      locationCountry,
      coverImageUrl,
      joinedAt,
      isHosted,
    };
  };

  const seen = new Set<string>();
  const items: any[] = [];
  for (const r of hostedRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    items.push(mapRow(r, true));
  }
  for (const r of rsvpRows ?? []) {
    const ev = r.event ?? {};
    const id = ev.id ?? r.event_id;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(mapRow(r, false));
  }
  for (const r of attendeeRows ?? []) {
    const ev = r.event ?? {};
    const id = ev.id ?? r.event_id;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push(mapRow(r, false));
  }

  // Sort merged set by start time descending, then apply limit + cursor.
  items.sort((a, b) => {
    const ta = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tb = b.startTime ? new Date(b.startTime).getTime() : 0;
    return tb - ta;
  });
  const nextCursor = items.length > limit ? items[limit - 1]?.startTime ?? null : null;
  const result = items.slice(0, limit);
  res.status(200).json({ items: result, nextCursor });
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
    .select("user_id, created_at, owner:profiles!circle_memberships_user_id_fkey(id, handle, username, display_name, name, avatar_url)")
    .eq("other_id", target.id)
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
  // Universal display-name rule: circle owners show @handle unless opted in.
  const allowedOwnerNames = await nameVisibilitySet(sc, rows.map((r: any) => r.user_id));
  const items = rows.slice(0, limit).map((r: any) => {
    const owner = r.owner ?? {};
    const nameOk = r.user_id === viewerId || allowedOwnerNames.has(r.user_id as string);
    return {
      circleOwnerId: r.user_id,
      ownerHandle: owner.handle ?? owner.username ?? null,
      ownerDisplayName: nameOk ? (owner.display_name ?? owner.name ?? null) : null,
      ownerAvatarUrl: owner.avatar_url ?? null,
      joinedAt: r.created_at,
    };
  });
  const nextCursor = rows.length > limit ? rows[limit - 1]?.created_at ?? null : null;

  res.status(200).json({ items, nextCursor });
});

export default router;
