import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";

const router = Router();

const PUBLIC_PROFILE_COLUMNS =
  "id, username, display_name, name, bio, avatar_url, home_city, home_country, travel_style, interests, verified, passport_visibility, created_at";

const PUBLIC_PROFILE_COLUMNS_FALLBACK =
  "id, username, name, bio, avatar_url, home_city, home_country, travel_style, interests, verified, passport_visibility, created_at";

const PUBLIC_POSTCARD_COLUMNS =
  "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at";

/** Fallback: select everything; mapPostcard handles missing fields with ?? null. */
const PUBLIC_POSTCARD_COLUMNS_FALLBACK = "*";

function mapPublicProfile(r: any) {
  return {
    id: r.id,
    username: r.username ?? null,
    displayName: r.display_name ?? r.name ?? null,
    bio: r.bio ?? null,
    avatarUrl: r.avatar_url ?? null,
    homeCity: r.home_city ?? null,
    homeCountry: r.home_country ?? null,
    travelStyle: r.travel_style ?? null,
    interests: r.interests ?? [],
    verified: r.verified ?? false,
    passportVisibility: r.passport_visibility ?? "public",
    createdAt: r.created_at ?? null,
  };
}

function mapPostcard(r: any, includePrivate = false) {
  const base: Record<string, unknown> = {
    id: r.id,
    postId: r.post_id,
    mediaUrl: r.media_url ?? null,
    caption: r.caption ?? null,
    locationName: r.location_name ?? null,
    locationCity: r.location_city ?? null,
    locationCountry: r.location_country ?? null,
    locationVerified: r.location_verified ?? false,
    stampEligible: r.stamp_eligible ?? false,
    visibility: r.visibility ?? "public",
    status: r.status ?? "active",
    pinnedAt: r.pinned_at ?? null,
    note: r.note ?? null,
    createdAt: r.created_at ?? null,
  };
  if (includePrivate) {
    base.userId = r.user_id;
  }
  return base;
}

/* ===========================================================================
 * GET /users/:username/passport — public passport lookup (no auth required)
 * ===========================================================================
 * Uses the service-role client so unauthenticated callers can view public
 * passports. Private profiles return { private: true } — not a 403.
 */
router.get("/users/:username/passport", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  if (!username || username.length < 1) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  let { data, error } = await sc
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("username", username)
    .maybeSingle();

  if (error && (error as any).code === "42703") {
    ({ data, error } = await sc
      .from("profiles")
      .select(PUBLIC_PROFILE_COLUMNS_FALLBACK)
      .eq("username", username)
      .maybeSingle());
  }

  if (error) {
    req.log.error({ err: error }, "Failed to load public passport");
    sendError(res, "db_error", error.message);
    return;
  }
  if (!data) {
    sendError(res, "not_found", "User not found");
    return;
  }

  if (data.passport_visibility === "private") {
    res.status(200).json({ private: true });
    return;
  }

  res.status(200).json(mapPublicProfile(data));
});

/* ===========================================================================
 * GET /users/:username/passport/postcards — public postcard wall (no auth required)
 * ===========================================================================
 * Uses service-role client so recipients of a share link can view postcards
 * without logging in. Never exposes exact GPS.
 */
router.get("/users/:username/passport/postcards", async (req, res) => {
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Service client not ready");
    return;
  }

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();

  const { data: profile, error: profileErr } = await sc
    .from("profiles")
    .select("id, passport_visibility")
    .eq("username", username)
    .maybeSingle();

  if (profileErr || !profile) {
    sendError(res, "not_found", "User not found");
    return;
  }
  if (profile.passport_visibility === "private") {
    res.status(200).json({ private: true, postcards: [] });
    return;
  }

  let { data: postcards, error: postcardErr } = await sc
    .from("passport_postcards")
    .select(PUBLIC_POSTCARD_COLUMNS)
    .eq("user_id", profile.id)
    .eq("status", "active")
    .eq("visibility", "public")
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(50);

  if (postcardErr && (postcardErr as any).code === "42703") {
    const fb = await sc
      .from("passport_postcards")
      .select(PUBLIC_POSTCARD_COLUMNS_FALLBACK)
      .eq("user_id", profile.id)
      .eq("status", "active")
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .limit(50);
    postcards = fb.data as any;
    postcardErr = fb.error;
  }

  if (postcardErr) {
    req.log.error({ err: postcardErr }, "Failed to list public postcards");
    sendError(res, "db_error", postcardErr.message);
    return;
  }

  res.status(200).json({ postcards: (postcards ?? []).map((r) => mapPostcard(r, false)) });
});

/* ===========================================================================
 * GET /me/passport/postcards — owner's own full postcard list
 * ===========================================================================
 */
router.get("/me/passport/postcards", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const OWNER_POSTCARD_COLUMNS =
    "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, stamp_reason, verification_method, visibility, status, pinned_at, note, created_at";

  /** Fallback: select everything; mapper handles missing fields with ?? null. */
  const OWNER_POSTCARD_COLUMNS_FALLBACK = "*";

  let { data, error } = await client
    .from("passport_postcards")
    .select(OWNER_POSTCARD_COLUMNS)
    .eq("user_id", user.id)
    .neq("status", "deleted")
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

  if (error && (error as any).code === "42703") {
    const fb = await client
      .from("passport_postcards")
      .select(OWNER_POSTCARD_COLUMNS_FALLBACK)
      .eq("user_id", user.id)
      .neq("status", "deleted")
      .order("created_at", { ascending: false })
      .limit(100);
    data = fb.data as any;
    error = fb.error;
  }

  if (error) {
    req.log.error({ err: error }, "Failed to list own postcards");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({
    postcards: (data ?? []).map((r) => ({
      id: r.id,
      postId: r.post_id,
      mediaUrl: r.media_url ?? null,
      caption: r.caption ?? null,
      locationName: r.location_name ?? null,
      locationCity: r.location_city ?? null,
      locationCountry: r.location_country ?? null,
      locationVerified: r.location_verified ?? false,
      stampEligible: r.stamp_eligible ?? false,
      stampReason: r.stamp_reason ?? null,
      verificationMethod: r.verification_method ?? null,
      visibility: r.visibility ?? "public",
      status: r.status ?? "active",
      pinnedAt: r.pinned_at ?? null,
      note: r.note ?? null,
      createdAt: r.created_at ?? null,
    })),
  });
});

/* ===========================================================================
 * PATCH /passport/postcards/:id — update postcard (owner only)
 * ===========================================================================
 * Updates note, visibility, pinned_at. Pinning enforces one-per-user.
 */
const patchPostcardSchema = z.object({
  note: z.string().max(500).nullable().optional(),
  visibility: z.enum(["public", "private", "trip_only"]).optional(),
  pin: z.boolean().optional(),
});

router.patch("/passport/postcards/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postcardId = req.params.id;
  const parsed = patchPostcardSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { data: existing, error: loadErr } = await client
    .from("passport_postcards")
    .select("id, user_id, status")
    .eq("id", postcardId)
    .maybeSingle();

  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Postcard not found"); return; }
  if (existing.user_id !== user.id) { sendError(res, "forbidden", "Not your postcard"); return; }

  const patch: Record<string, unknown> = {};
  if (parsed.data.note !== undefined) patch.note = parsed.data.note;
  if (parsed.data.visibility !== undefined) patch.visibility = parsed.data.visibility;

  if (parsed.data.pin === true) {
    await client
      .from("passport_postcards")
      .update({ pinned_at: null })
      .eq("user_id", user.id)
      .not("id", "eq", postcardId);
    patch.pinned_at = new Date().toISOString();
  } else if (parsed.data.pin === false) {
    patch.pinned_at = null;
  }

  if (Object.keys(patch).length === 0) {
    sendError(res, "invalid_payload", "At least one field must be provided");
    return;
  }

  const { data, error } = await client
    .from("passport_postcards")
    .update(patch)
    .eq("id", postcardId)
    .eq("user_id", user.id)
    .select("id, post_id, media_url, caption, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "Failed to update postcard");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json(data);
});

/* ===========================================================================
 * PATCH /passport/postcards/:id/remove — remove from passport (owner only)
 * ===========================================================================
 * Sets status to removed_from_passport — does NOT delete the original post.
 */
router.patch("/passport/postcards/:id/remove", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;

  const postcardId = req.params.id;

  const { data: existing, error: loadErr } = await client
    .from("passport_postcards")
    .select("id, user_id")
    .eq("id", postcardId)
    .maybeSingle();

  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!existing) { sendError(res, "not_found", "Postcard not found"); return; }
  if (existing.user_id !== user.id) { sendError(res, "forbidden", "Not your postcard"); return; }

  const { error } = await client
    .from("passport_postcards")
    .update({ status: "removed_from_passport", pinned_at: null })
    .eq("id", postcardId)
    .eq("user_id", user.id);

  if (error) {
    req.log.error({ err: error }, "Failed to remove postcard");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(204).send();
});

/* ===========================================================================
 * GET /users/:username/profile — public profile card (for share link preview)
 * ===========================================================================
 * Returns displayName, username, avatarUrl, coverUrl, tripCount, stampCount,
 * and visibility. Returns 404 for unknown usernames. Returns a minimal stub
 * for private profiles instead of a full 403.
 */
router.get("/users/:username/profile", async (req, res) => {
  const sc = getServiceClient();

  const username = req.params.username.replace(/^@/, "").toLowerCase().trim();
  if (!username) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const { data: profile, error: profileErr } = sc
    ? await sc.from("profiles")
        .select("id, username, display_name, name, avatar_url, cover_photo_url, passport_visibility, bio")
        .eq("username", username)
        .maybeSingle()
    : { data: null, error: new Error("No service client") };

  if (profileErr || !profile) {
    res.status(404).json({ error: "not_found", message: "User not found" });
    return;
  }

  if (profile.passport_visibility === "private") {
    res.status(200).json({
      private: true,
      username: profile.username,
      displayName: profile.display_name ?? profile.name ?? null,
      avatarUrl: null,
      coverUrl: null,
      tripCount: 0,
      stampCount: 0,
      visibility: "private",
    });
    return;
  }

  const [tripResult, stampResult] = await Promise.all([
    sc
      ? sc.from("trips").select("id", { count: "exact", head: true }).eq("owner_id", profile.id)
      : Promise.resolve({ count: 0, error: null }),
    sc
      ? sc.from("stamps").select("id", { count: "exact", head: true }).eq("user_id", profile.id).eq("locked", false)
      : Promise.resolve({ count: 0, error: null }),
  ]);
  const tripCount = tripResult.count;
  // PGRST205 = stamps table not yet migrated — treat as 0
  const stampCount = (stampResult as any).error?.code === "PGRST205" ? 0 : stampResult.count;

  res.status(200).json({
    id: profile.id,
    username: profile.username ?? null,
    displayName: profile.display_name ?? profile.name ?? null,
    bio: profile.bio ?? null,
    avatarUrl: profile.avatar_url ?? null,
    coverUrl: profile.cover_photo_url ?? null,
    tripCount: tripCount ?? 0,
    stampCount: stampCount ?? 0,
    visibility: profile.passport_visibility ?? "public",
  });
});

/* ===========================================================================
 * GET /me/stamps  — caller's earned stamps
 * ===========================================================================
 * Returns only unlocked stamps (locked=false). Ordered most-recently-earned
 * first. The response shape matches PassportStamp on the mobile client.
 */
router.get("/me/stamps", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data, error } = await sc
    .from("stamps")
    .select("id, kind, label, sublabel, first_earned_at, last_earned_at, check_in_count, locked")
    .eq("user_id", user.id)
    .order("first_earned_at", { ascending: false });

  if (error) {
    // PGRST205 = table not found in schema cache (migration pending) — return empty gracefully
    if ((error as any).code === "PGRST205") {
      res.status(200).json({ stamps: [] });
      return;
    }
    req.log.error({ err: error }, "Failed to load stamps");
    sendError(res, "db_error", error.message);
    return;
  }

  const stamps = (data ?? []).map((r: any) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    sublabel: r.sublabel ?? null,
    earnedAt: r.first_earned_at,
    checkInCount: r.check_in_count ?? 1,
    locked: r.locked ?? false,
  }));

  res.status(200).json({ stamps });
});

export default router;
