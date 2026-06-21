import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { decideFollow, decideUnfollow, isUuid } from "../lib/followDecisions";

const router = Router();

/* Helper: does a profile exist? (service-role read) */
async function profileExists(client: any, userId: string): Promise<boolean> {
  const { data, error } = await client.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (error) return false;
  return Boolean(data);
}

/* ===========================================================================
 * POST /users/:userId/follow  — follow a user
 * ===========================================================================
 * follower is the verified user (never client-supplied). No self-follow.
 * A follow grants NOTHING sensitive — it only inserts a social edge.
 */
router.post("/users/:userId/follow", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const target = req.params.userId;

  // (No block table yet; blocked=false. Hook left for Phase 2.)
  const targetExists = isUuid(target) ? await profileExists(client, target) : false;
  const decision = decideFollow(user.id, target, { targetExists, blocked: false });
  if (!decision.ok) {
    const map: Record<string, any> = {
      unauthenticated: "unauthenticated",
      invalid_payload: "invalid_payload",
      cannot_follow_self: "invalid_payload",
      not_found: "not_found",
      blocked: "forbidden",
    };
    sendError(res, map[decision.code], decision.code === "cannot_follow_self" ? "You cannot follow yourself" : undefined);
    return;
  }

  // Idempotent: ignore duplicate (PK conflict) and return current state.
  const { error } = await client
    .from("user_follows")
    .upsert({ follower_id: user.id, following_id: target }, { onConflict: "follower_id,following_id", ignoreDuplicates: true });
  if (error) {
    req.log.error({ err: error }, "Failed to follow");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(201).json({ following: true, userId: target });
});

/* ===========================================================================
 * DELETE /users/:userId/follow  — unfollow
 * ===========================================================================
 */
router.delete("/users/:userId/follow", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const target = req.params.userId;

  const decision = decideUnfollow(user.id, target);
  if (!decision.ok) {
    sendError(res, decision.code === "unauthenticated" ? "unauthenticated" : "invalid_payload");
    return;
  }

  const { error } = await client
    .from("user_follows")
    .delete()
    .eq("follower_id", user.id)     // only your own follow row
    .eq("following_id", target);
  if (error) {
    req.log.error({ err: error }, "Failed to unfollow");
    sendError(res, "db_error", error.message);
    return;
  }
  res.status(200).json({ following: false, userId: target });
});

/* ===========================================================================
 * GET /users/:userId/follow-status  — am I following this user? + counts
 * ===========================================================================
 */
router.get("/users/:userId/follow-status", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const target = req.params.userId;
  if (!isUuid(target)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const [mine, followers, following] = await Promise.all([
    client.from("user_follows").select("follower_id").eq("follower_id", user.id).eq("following_id", target).maybeSingle(),
    client.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
    client.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
  ]);

  res.status(200).json({
    userId: target,
    isFollowing: Boolean(mine.data),
    followersCount: followers.count ?? 0,
    followingCount: following.count ?? 0,
  });
});

/* ===========================================================================
 * GET /me/following  — users I follow
 * GET /me/followers  — users who follow me
 * ===========================================================================
 * Returns ONLY the social edge + public profile basics (id, handle, name,
 * avatar). Never private content.
 */
const PUBLIC_PROFILE = "id, handle, name, avatar_url";

router.get("/me/following", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { data, error } = await client
    .from("user_follows")
    .select(`following_id, created_at, profile:profiles!user_follows_following_id_fkey(${PUBLIC_PROFILE})`)
    .eq("follower_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) { req.log.error({ err: error }, "following list failed"); sendError(res, "db_error", error.message); return; }
  res.status(200).json({ users: (data ?? []).map(rowToUser) });
});

router.get("/me/followers", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client, user } = auth;
  const { data, error } = await client
    .from("user_follows")
    .select(`follower_id, created_at, profile:profiles!user_follows_follower_id_fkey(${PUBLIC_PROFILE})`)
    .eq("following_id", user.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) { req.log.error({ err: error }, "followers list failed"); sendError(res, "db_error", error.message); return; }
  res.status(200).json({ users: (data ?? []).map(rowToUser) });
});

function rowToUser(r: any) {
  const p = r.profile ?? {};
  return { id: p.id, handle: p.handle, name: p.name, avatarUrl: p.avatar_url ?? null, since: r.created_at };
}

/* ===========================================================================
 * GET /users/:userId  — public profile for Passport page
 * ===========================================================================
 * Returns safe public fields + follower/following counts + isFollowing state.
 * Auth optional: unauthenticated callers get counts but isFollowing=false.
 * Never returns private posts, trips, circle memberships, or location data.
 */
const PUBLIC_PASSPORT_FIELDS =
  "id, handle, name, avatar_url, bio, home_city, home_country, current_city, travel_style, interests, verified, open_to_meet, is_private, created_at, spoken_languages, default_language, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, availability_tags, planning_style";

router.get("/users/:userId", async (req, res) => {
  const target = req.params.userId;
  if (!isUuid(target)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  // Auth is optional — extract token manually, fall back gracefully.
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  // We always need a service client for DB reads. Use the global one directly.
  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Resolve caller identity (best-effort; null if unauthenticated or token invalid).
  let callerId: string | null = null;
  if (token) {
    const { data } = await sc.auth.getUser(token);
    callerId = data?.user?.id ?? null;
  }

  // Fetch profile + counts in parallel.
  const [profileRes, followersRes, followingRes] = await Promise.all([
    sc.from("profiles").select(PUBLIC_PASSPORT_FIELDS).eq("id", target).maybeSingle(),
    sc.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
    sc.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
  ]);

  if (profileRes.error || !profileRes.data) {
    sendError(res, "not_found", "User not found");
    return;
  }

  // Is the authenticated caller already following this user?
  let isFollowing = false;
  if (callerId && callerId !== target) {
    const { data: edge } = await sc
      .from("user_follows")
      .select("follower_id")
      .eq("follower_id", callerId)
      .eq("following_id", target)
      .maybeSingle();
    isFollowing = Boolean(edge);
  }

  const p = profileRes.data as any;
  res.status(200).json({
    id: p.id,
    handle: p.handle,
    name: p.name,
    avatarUrl: p.avatar_url ?? null,
    bio: p.bio ?? null,
    homeCity: p.home_city ?? null,
    homeCountry: p.home_country ?? null,
    currentCity: p.current_city ?? null,
    travelStyle: p.travel_style ?? null,
    interests: p.interests ?? [],
    verified: p.verified ?? false,
    openToMeet: p.open_to_meet ?? false,
    isPrivate: p.is_private ?? false,
    memberSince: p.created_at,
    followersCount: followersRes.count ?? 0,
    followingCount: followingRes.count ?? 0,
    isFollowing,
    isOwnProfile: callerId === target,
    spokenLanguages: p.spoken_languages ?? [],
    defaultLanguage: p.default_language ?? null,
    travelStyles: p.travel_styles ?? [],
    travelPace: p.travel_pace ?? null,
    budgetStyle: p.budget_style ?? null,
    travelGroupStyle: p.travel_group_style ?? [],
    lookingFor: p.looking_for ?? [],
    comfortLevel: p.comfort_level ?? null,
    availabilityTags: p.availability_tags ?? [],
    planningStyle: p.planning_style ?? null,
  });
});

/* ===========================================================================
 * GET /users/by-handle/:handle  — look up a public profile by handle
 * ===========================================================================
 * Same response shape as GET /users/:userId. Handle lookup is case-insensitive.
 * Used by the profile page which routes by handle, not UUID.
 */
router.get("/users/by-handle/:handle", async (req, res) => {
  const handle = req.params.handle?.toLowerCase().trim();
  if (!handle) { sendError(res, "invalid_payload", "handle is required"); return; }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  let callerId: string | null = null;
  if (token) {
    const { data } = await sc.auth.getUser(token);
    callerId = data?.user?.id ?? null;
  }

  const profileRes = await sc
    .from("profiles")
    .select(PUBLIC_PASSPORT_FIELDS)
    .ilike("handle", handle)
    .maybeSingle();

  if (profileRes.error || !profileRes.data) {
    sendError(res, "not_found", "User not found");
    return;
  }

  const target = (profileRes.data as any).id;

  const [followersRes, followingRes] = await Promise.all([
    sc.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
    sc.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
  ]);

  let isFollowing = false;
  if (callerId && callerId !== target) {
    const { data: edge } = await sc
      .from("user_follows").select("follower_id")
      .eq("follower_id", callerId).eq("following_id", target).maybeSingle();
    isFollowing = Boolean(edge);
  }

  const p = profileRes.data as any;
  res.status(200).json({
    id: p.id,
    handle: p.handle,
    name: p.name,
    avatarUrl: p.avatar_url ?? null,
    bio: p.bio ?? null,
    homeCity: p.home_city ?? null,
    homeCountry: p.home_country ?? null,
    currentCity: p.current_city ?? null,
    travelStyle: p.travel_style ?? null,
    interests: p.interests ?? [],
    verified: p.verified ?? false,
    openToMeet: p.open_to_meet ?? false,
    isPrivate: p.is_private ?? false,
    memberSince: p.created_at,
    followersCount: followersRes.count ?? 0,
    followingCount: followingRes.count ?? 0,
    isFollowing,
    isOwnProfile: callerId === target,
    spokenLanguages: p.spoken_languages ?? [],
    defaultLanguage: p.default_language ?? null,
    travelStyles: p.travel_styles ?? [],
    travelPace: p.travel_pace ?? null,
    budgetStyle: p.budget_style ?? null,
    travelGroupStyle: p.travel_group_style ?? [],
    lookingFor: p.looking_for ?? [],
    comfortLevel: p.comfort_level ?? null,
    availabilityTags: p.availability_tags ?? [],
    planningStyle: p.planning_style ?? null,
  });
});

export default router;
