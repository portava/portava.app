import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";

const router = Router();

const PUBLIC_PROFILE_COLUMNS =
  "id, username, display_name, name, bio, avatar_url, home_city, home_country, travel_style, interests, verified, passport_visibility, created_at";

const PUBLIC_POSTCARD_COLUMNS =
  "id, post_id, user_id, media_url, caption, location_name, location_city, location_country, location_verified, stamp_eligible, visibility, status, pinned_at, note, created_at";

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
 * GET /users/:username/passport — public passport lookup
 * ===========================================================================
 */
router.get("/users/:username/passport", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client } = auth;

  const username = req.params.username.toLowerCase().trim();
  if (!username || username.length < 1) {
    sendError(res, "invalid_payload", "Invalid username");
    return;
  }

  const { data, error } = await client
    .from("profiles")
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq("username", username)
    .maybeSingle();

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
 * GET /users/:username/passport/postcards — public postcard wall
 * ===========================================================================
 * Only returns active public postcards. Never exposes exact GPS.
 */
router.get("/users/:username/passport/postcards", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client } = auth;

  const username = req.params.username.toLowerCase().trim();

  const { data: profile, error: profileErr } = await client
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

  const { data, error } = await client
    .from("passport_postcards")
    .select(PUBLIC_POSTCARD_COLUMNS)
    .eq("user_id", profile.id)
    .eq("status", "active")
    .eq("visibility", "public")
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    req.log.error({ err: error }, "Failed to list public postcards");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ postcards: (data ?? []).map((r) => mapPostcard(r, false)) });
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

  const { data, error } = await client
    .from("passport_postcards")
    .select(OWNER_POSTCARD_COLUMNS)
    .eq("user_id", user.id)
    .neq("status", "deleted")
    .order("pinned_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100);

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

export default router;
