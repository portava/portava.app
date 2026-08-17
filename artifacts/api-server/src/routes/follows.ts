import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { nameVisibilitySet, nameVisibleFor } from "../lib/publicIdentity";
import { decideUnfollow, isUuid } from "../lib/followDecisions";
import { normalizedFriendshipPair } from "../lib/friendDecisions";
import { resolveInteractionPermissions } from "../services/interactionPermissions";
import { getSeenIds, markAsSeen, clearSeen, dailySeed, seededShuffle } from "../lib/suggestionSeenCache";
import { isKillSwitchEngaged } from "../lib/featureFlags";
import { safeOrIlikeValue } from "../lib/postgrestFilter";

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

  if (!isUuid(target)) { sendError(res, "invalid_payload"); return; }
  if (target === user.id) { sendError(res, "invalid_payload", "You cannot follow yourself"); return; }

  const targetExists = await profileExists(client, target);
  if (!targetExists) { sendError(res, "not_found"); return; }

  // Permission engine — replaces direct block check; fail-closed on any safety error
  try {
    const perms = await resolveInteractionPermissions(client, user.id, target);
    const isBlocked = perms.reasonCodes.includes("blocked");

    if (isBlocked) {
      sendError(res, "forbidden");
      return;
    }

    // Private profile: convert follow → friend request (idempotent create/reactivate).
    // The follow cannot proceed (canViewProfile=false), but the viewer is not blocked,
    // so we transparently route this call into the friend-request flow so that clients
    // calling followUser() on a private profile get the correct SEC-01 behaviour.
    //
    // Enforce the same capability gate as POST /users/:userId/friend-request:
    // canAddFriend  — stranger can create a new request (not suspended, no cooldown,
    //                 no existing request in either direction)
    // canAcceptFriendRequest — target already has an incoming request from the viewer,
    //                 so we auto-accept rather than create a duplicate.
    if (!perms.canViewProfile && perms.reasonCodes.includes("private_profile")) {
      if (!perms.canAddFriend && !perms.canAcceptFriendRequest) {
        sendError(res, "invalid_payload", "Friend request not allowed");
        return;
      }

      // Check for an existing request in this direction
      const { data: existing } = await client
        .from("friend_requests")
        .select("id, status")
        .eq("requester_id", user.id)
        .eq("recipient_id", target)
        .maybeSingle();

      if (existing) {
        if (existing.status === "pending") {
          res.status(200).json({ following: false, userId: target, friendRequest: true, status: "outgoing_pending", idempotent: true });
          return;
        }
        if (existing.status === "accepted") {
          res.status(200).json({ following: false, userId: target, friendRequest: true, status: "friends" });
          return;
        }
        // Re-activate declined/cancelled request
        const now = new Date().toISOString();
        const { error: reactivateErr } = await client
          .from("friend_requests")
          .update({ status: "pending", responded_at: null, updated_at: now })
          .eq("id", existing.id);
        if (reactivateErr) {
          req.log.error({ err: reactivateErr }, "friend request reactivation update failed");
          sendError(res, "db_error", reactivateErr.message);
          return;
        }
        res.status(200).json({ following: false, userId: target, friendRequest: true, status: "outgoing_pending", reactivated: true });
        return;
      }

      // Check if target already sent us a request → auto-accept both sides
      const { data: incoming } = await client
        .from("friend_requests")
        .select("id")
        .eq("requester_id", target)
        .eq("recipient_id", user.id)
        .eq("status", "pending")
        .maybeSingle();

      if (incoming) {
        const now = new Date().toISOString();
        const { error: autoAcceptErr } = await client
          .from("friend_requests")
          .update({ status: "accepted", responded_at: now, updated_at: now })
          .eq("id", incoming.id);
        if (autoAcceptErr) {
          req.log.error({ err: autoAcceptErr }, "friend request auto-accept update failed");
          sendError(res, "db_error", autoAcceptErr.message);
          return;
        }
        const [ua, ub] = normalizedFriendshipPair(user.id, target);
        const { error: autoFriendshipErr } = await client
          .from("user_friendships")
          .upsert({ user_a: ua, user_b: ub, accepted_request_id: incoming.id, created_at: now });
        if (autoFriendshipErr) {
          req.log.error({ err: autoFriendshipErr }, "user_friendships upsert failed after auto-accept");
          sendError(res, "db_error", autoFriendshipErr.message);
          return;
        }
        res.status(200).json({ following: false, userId: target, friendRequest: true, status: "friends", autoAccepted: true });
        return;
      }

      // Create new friend request
      const { data: newReq, error: insertErr } = await client
        .from("friend_requests")
        .insert({ requester_id: user.id, recipient_id: target })
        .select("id")
        .single();
      if (insertErr) {
        req.log.error({ err: insertErr }, "Failed to create friend request for private profile");
        sendError(res, "db_error", insertErr.message);
        return;
      }
      res.status(201).json({ following: false, userId: target, friendRequest: true, status: "outgoing_pending", requestId: (newReq as any).id });
      return;
    }

    if (!perms.canViewProfile) {
      sendError(res, "forbidden");
      return;
    }

    if (!perms.canFollow) {
      if (perms.canUnfollow) {
        // Already following — idempotent success
        res.status(200).json({ following: true, userId: target });
        return;
      }
      sendError(res, "forbidden", "Cannot follow this user");
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for follow");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
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

  // Fire-and-forget: award social follow-count stamps (non-fatal).
  // community_connector → caller follows 10+ people.
  // popular_traveler → target reaches 50 followers.
  // travel_influencer → target reaches 500 followers.
  void (async () => {
    try {
      const { awardStamp } = await import("../services/passport/StampAwardEngine.js");
      const { getServiceClient } = await import("../lib/supabase.js");
      const { NotificationService } = await import("../services/notifications/NotificationService.js");
      const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");
      const sc = getServiceClient();
      if (!sc) return;

      const [followingRes, followersRes] = await Promise.all([
        sc.from("user_follows").select("follower_id", { count: "exact", head: true }).eq("follower_id", user.id),
        sc.from("user_follows").select("following_id", { count: "exact", head: true }).eq("following_id", target),
      ]);

      const followingCount  = followingRes.count  ?? 0;
      const followersCount  = followersRes.count  ?? 0;

      const callerAwards: Array<{ slug: string }> = [];
      if (followingCount >= 10) callerAwards.push({ slug: "community_connector" });

      const targetAwards: Array<{ slug: string }> = [];
      if (followersCount >= 50)  targetAwards.push({ slug: "popular_traveler" });
      if (followersCount >= 500) targetAwards.push({ slug: "travel_influencer" });

      const all = await Promise.allSettled([
        ...callerAwards.map(({ slug }) =>
          awardStamp(sc, { userId: user.id, definitionSlug: slug, sourceType: "follows", sourceId: target })
            .then((r) => ({ userId: user.id, slug, ...r })),
        ),
        ...targetAwards.map(({ slug }) =>
          awardStamp(sc, { userId: target, definitionSlug: slug, sourceType: "follows", sourceId: user.id })
            .then((r) => ({ userId: target, slug, ...r })),
        ),
      ]);

      // Batch one notification per user for any newly awarded stamps
      const byUser = new Map<string, string[]>();
      for (const r of all) {
        if (r.status === "fulfilled" && (r as any).value.awarded) {
          const { userId: uid, slug } = (r as any).value;
          if (!byUser.has(uid)) byUser.set(uid, []);
          byUser.get(uid)!.push(slug);
        }
      }
      await Promise.allSettled(
        [...byUser.entries()].map(async ([uid, slugs]) => {
          const notifSvc    = new NotificationService(sc);
          const notifRouter = new NotificationRouter(sc);
          const row = await notifSvc.create({
            userId:     uid,
            eventType:  "passport.stamp_earned",
            sourceType: "follows",
            sourceId:   uid === user.id ? target : user.id,
            params: { stamps: slugs.join(","), count: String(slugs.length) },
          });
          if (row) await notifRouter.route(row);
        }),
      );
    } catch {}
  })();
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

  if (!isUuid(target)) { sendError(res, "invalid_payload"); return; }
  if (target === user.id) { sendError(res, "invalid_payload", "Cannot unfollow yourself"); return; }

  // Permission engine — canUnfollow=true only when actually following; blocks don't
  // prevent unfollow (you should always be able to remove your own follow edge).
  try {
    const perms = await resolveInteractionPermissions(client, user.id, target);
    if (!perms.canUnfollow) {
      // Not currently following — idempotent success
      res.status(200).json({ following: false, userId: target });
      return;
    }
  } catch (err) {
    req.log.error({ err }, "permission engine failed for unfollow");
    sendError(res, "db_error", "Permission check failed", { exposeDetail: true });
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

  const [mine, followers, following, theyFollow] = await Promise.all([
    client.from("user_follows").select("follower_id").eq("follower_id", user.id).eq("following_id", target).maybeSingle(),
    client.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
    client.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
    client.from("user_follows").select("follower_id").eq("follower_id", target).eq("following_id", user.id).maybeSingle(),
  ]);

  res.status(200).json({
    userId: target,
    isFollowing: Boolean(mine.data),
    followsYou: Boolean(theyFollow.data),
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
const PUBLIC_PROFILE = "id, handle, name, avatar_url, is_official";

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

  const rows = data ?? [];
  if (rows.length === 0) { res.status(200).json({ users: [] }); return; }

  // Determine which of these users also follow the caller back (mutual).
  const followingIds = rows.map((r: any) => r.following_id as string);
  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  let mutualSet = new Set<string>();
  if (sc) {
    const { data: back } = await sc
      .from("user_follows")
      .select("follower_id")
      .eq("following_id", user.id)
      .in("follower_id", followingIds);
    mutualSet = new Set((back ?? []).map((r: any) => r.follower_id as string));
  }

  const allowedNamesFwd = await nameVisibilitySet(sc, rows.map((r: any) => r.profile?.id));
  res.status(200).json({
    users: rows.map((r: any) => ({ ...rowToUser(r, allowedNamesFwd, user.id), followsYou: mutualSet.has(r.following_id as string) })),
  });
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

  const rows = data ?? [];
  if (rows.length === 0) { res.status(200).json({ users: [] }); return; }

  // Determine which of these followers the caller also follows back (mutual).
  const followerIds = rows.map((r: any) => r.follower_id as string);
  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  let youFollowSet = new Set<string>();
  if (sc) {
    const { data: fwd } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", user.id)
      .in("following_id", followerIds);
    youFollowSet = new Set((fwd ?? []).map((r: any) => r.following_id as string));
  }

  const allowedNamesBack = await nameVisibilitySet(sc, rows.map((r: any) => r.profile?.id));
  res.status(200).json({
    users: rows.map((r: any) => ({ ...rowToUser(r, allowedNamesBack, user.id), youFollow: youFollowSet.has(r.follower_id as string) })),
  });
});

/* ===========================================================================
 * GET /users/:userId/followers  — followers of ANY user (public list)
 * GET /users/:userId/following  — accounts ANY user follows (public list)
 * ===========================================================================
 * Read-only social lists for another user's profile. Callers may be
 * unauthenticated. Blocked relationships and private-account visibility are
 * enforced the same way the postcard wall is: private accounts (or accounts
 * a follower-only viewer isn't authorized for) return an empty list.
 */
router.get("/users/:userId/followers", async (req, res) => {
  const target = req.params.userId;
  if (!isUuid(target)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const { getServiceClient } = await import("../lib/supabase");
  const { resolveProfileVisibility, extractBearerToken } = await import("../lib/profileVisibility");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: profile } = await sc
    .from("profiles")
    .select("id, is_private, account_status")
    .eq("id", target)
    .maybeSingle();
  if (!profile) { sendError(res, "not_found"); return; }

  let viewerId: string | null = null;
  const token = extractBearerToken(req);
  if (token) {
    try {
      const { data: { user } } = await sc.auth.getUser(token);
      viewerId = user?.id ?? null;
    } catch { /* unauthenticated */ }
  }
  const isMe = viewerId === target;

  if (!isMe) {
    try {
      const { visibility } = await resolveProfileVisibility(sc, viewerId, target, profile);
      if (visibility === "unavailable" || visibility === "blocked" || visibility === "limited_preview") {
        res.status(200).json({ users: [] });
        return;
      }
    } catch (e: any) {
      req.log.error({ err: e }, "users/:userId/followers: visibility check failed");
      sendError(res, "db_error", e.message ?? "Visibility check failed");
      return;
    }
  }

  const { data, error } = await sc
    .from("user_follows")
    .select(`follower_id, created_at, profile:profiles!user_follows_follower_id_fkey(${PUBLIC_PROFILE})`)
    .eq("following_id", target)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) { req.log.error({ err: error }, "public followers list failed"); sendError(res, "db_error", error.message); return; }

  const rows = data ?? [];
  const allowedNames = await nameVisibilitySet(sc, rows.map((r: any) => r.profile?.id));
  res.status(200).json({ users: rows.map((r: any) => rowToUser(r, allowedNames, viewerId)) });
});

router.get("/users/:userId/following", async (req, res) => {
  const target = req.params.userId;
  if (!isUuid(target)) { sendError(res, "invalid_payload", "Invalid user id"); return; }

  const { getServiceClient } = await import("../lib/supabase");
  const { resolveProfileVisibility, extractBearerToken } = await import("../lib/profileVisibility");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: profile } = await sc
    .from("profiles")
    .select("id, is_private, account_status")
    .eq("id", target)
    .maybeSingle();
  if (!profile) { sendError(res, "not_found"); return; }

  let viewerId: string | null = null;
  const token = extractBearerToken(req);
  if (token) {
    try {
      const { data: { user } } = await sc.auth.getUser(token);
      viewerId = user?.id ?? null;
    } catch { /* unauthenticated */ }
  }
  const isMe = viewerId === target;

  if (!isMe) {
    try {
      const { visibility } = await resolveProfileVisibility(sc, viewerId, target, profile);
      if (visibility === "unavailable" || visibility === "blocked" || visibility === "limited_preview") {
        res.status(200).json({ users: [] });
        return;
      }
    } catch (e: any) {
      req.log.error({ err: e }, "users/:userId/following: visibility check failed");
      sendError(res, "db_error", e.message ?? "Visibility check failed");
      return;
    }
  }

  const { data, error } = await sc
    .from("user_follows")
    .select(`following_id, created_at, profile:profiles!user_follows_following_id_fkey(${PUBLIC_PROFILE})`)
    .eq("follower_id", target)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) { req.log.error({ err: error }, "public following list failed"); sendError(res, "db_error", error.message); return; }

  const rows = data ?? [];
  const allowedNames = await nameVisibilitySet(sc, rows.map((r: any) => r.profile?.id));
  res.status(200).json({ users: rows.map((r: any) => rowToUser(r, allowedNames, viewerId)) });
});

function rowToUser(r: any, allowedNames?: Set<string>, viewerId?: string | null) {
  const p = r.profile ?? {};
  // Universal display-name rule: name only when the subject opted in (or is the viewer).
  const nameOk = !!p.id && (p.id === viewerId || (allowedNames?.has(p.id) ?? false));
  return { id: p.id, handle: p.handle, name: nameOk ? p.name : null, avatarUrl: p.avatar_url ?? null, since: r.created_at, isOfficial: (p.is_official as boolean) ?? false };
}

/* ===========================================================================
 * GET /users/search  — search travelers by name or @username
 * ===========================================================================
 * ?q=<query>&limit=<n>
 * Excludes the calling user. Blocked users excluded when the user_blocks
 * table is available (graceful no-op if not). Private profiles appear in
 * results with minimal info (name, avatar, isPrivate=true); no follow action.
 */
router.get("/users/search", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  // Strip a leading @ so users can type either "alice" or "@alice" and get the same results.
  const raw = (req.query.q as string | undefined)?.trim() ?? "";
  const q = raw.startsWith("@") ? raw.slice(1).trim() : raw;
  if (!q) { res.status(200).json({ users: [] }); return; }

  const limit = Math.min(Math.max(parseInt((req.query.limit as string) ?? "20", 10) || 20, 1), 50);
  // safeOrIlikeValue, not a bare wildcard escape: `pattern` is spliced into an
  // .or() FILTER EXPRESSION below, where `,` ends a predicate and starts the
  // next one. Escaping only %/_ leaves that structure hazard open — a query of
  // `zzz,name.ilike.` injected a bare `name.ilike.%` and returned arbitrary
  // profiles instead of search matches. See lib/postgrestFilter.ts: the two
  // hazards need two different functions and are not interchangeable.
  const pattern = `%${safeOrIlikeValue(q)}%`;

  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Emergency stop: disable_profile_search — fail-CLOSED on DB error
  if (await isKillSwitchEngaged(sc, 'disable_profile_search')) {
    res.status(200).json({ users: [] });
    return;
  }

  // Optional city/country/language/interest filters
  const filterCity     = (req.query.city     as string | undefined)?.trim() ?? null;
  const filterCountry  = (req.query.country  as string | undefined)?.trim() ?? null;
  const filterLanguage = (req.query.language as string | undefined)?.trim() ?? null;
  const filterInterest = (req.query.interest as string | undefined)?.trim() ?? null;

  // Fetch matching profiles (ILIKE on name, handle, or username), excluding the caller.
  // Exclude deactivated/suspended/banned/deleted accounts.
  let profileQuery = sc
    .from("profiles")
    .select("id, handle, username, name, avatar_url, is_private, account_status, home_city, home_country, spoken_languages, interests, verified, is_official")
    .or(`name.ilike.${pattern},handle.ilike.${pattern},username.ilike.${pattern}`)
    .neq("id", user.id)
    .in("account_status", ["active"])
    .limit(limit);

  if (filterCity)     profileQuery = profileQuery.ilike("home_city", `%${filterCity}%`);
  if (filterCountry)  profileQuery = profileQuery.ilike("home_country", `%${filterCountry}%`);
  if (filterInterest) profileQuery = profileQuery.contains("interests", [filterInterest]);
  if (filterLanguage) profileQuery = profileQuery.contains("spoken_languages", [filterLanguage]);

  const { data: profiles, error: profErr } = await profileQuery;

  if (profErr) {
    req.log.error({ err: profErr }, "user search failed");
    sendError(res, "db_error", profErr.message);
    return;
  }

  const rows = profiles ?? [];
  if (rows.length === 0) { res.status(200).json({ users: [] }); return; }

  const ids = rows.map((p: any) => p.id as string);

  // Resolve blocked-user IDs (both directions: users I blocked + users who blocked me).
  // Fail safe: any DB error suppresses all results rather than leaking a blocked
  // user's profile to the caller.
  let blockedSet = new Set<string>();
  let blockQueryFailed = false;
  try {
    const { data: blockRows, error: blockErr } = await sc
      .from("blocks")
      .select("blocked_id, blocker_id")
      .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
    if (blockErr) {
      // Any DB error: fail safe (return empty set, filter will remove all).
      blockQueryFailed = true;
      req.log.warn({ err: blockErr }, "blocks query failed; suppressing results");
    } else {
      for (const b of (blockRows ?? [])) {
        if ((b as any).blocker_id === user.id) blockedSet.add((b as any).blocked_id);
        else blockedSet.add((b as any).blocker_id);
      }
    }
  } catch (e) {
    // Network-level or unexpected error — fail safe.
    blockQueryFailed = true;
    req.log.warn({ err: e }, "blocks query threw; suppressing results");
  }

  if (blockQueryFailed) { res.status(200).json({ users: [] }); return; }

  // Exclude users who have opted out of profile discovery.
  // Fail-closed: if the privacy query fails we cannot guarantee the opt-out is
  // respected, so we return an empty result set rather than exposing opted-out users.
  try {
    const { data: noDiscovery, error: privErr } = await sc
      .from("profile_privacy_settings")
      .select("user_id")
      .in("user_id", ids)
      .eq("allow_profile_discovery", false);
    if (privErr) {
      req.log.error({ err: privErr }, "search: privacy settings query failed; returning empty results (fail-closed)");
      res.status(200).json({ users: [] });
      return;
    }
    if (noDiscovery && (noDiscovery as any[]).length > 0) {
      const noDiscoverySet = new Set((noDiscovery as any[]).map((r) => r.user_id as string));
      rows.splice(0, rows.length, ...rows.filter((p: any) => !noDiscoverySet.has(p.id as string)));
    }
  } catch (e) {
    req.log.error({ err: e }, "search: privacy settings threw; returning empty results (fail-closed)");
    res.status(200).json({ users: [] });
    return;
  }

  // Follower counts, isFollowing state, and pending friend-request state in parallel.
  const [followerEdgesRes, myFollowsRes, pendingRequestsRes] = await Promise.all([
    sc.from("user_follows").select("following_id").in("following_id", ids),
    sc.from("user_follows").select("following_id").eq("follower_id", user.id).in("following_id", ids),
    sc.from("friend_requests").select("recipient_id").eq("requester_id", user.id).eq("status", "pending").in("recipient_id", ids),
  ]);

  const followerCounts: Record<string, number> = {};
  for (const e of (followerEdgesRes.data ?? [])) {
    const fid = (e as any).following_id as string;
    followerCounts[fid] = (followerCounts[fid] ?? 0) + 1;
  }

  const followingSet = new Set<string>(
    (myFollowsRes.data ?? []).map((e: any) => e.following_id as string),
  );

  const pendingRequestSet = new Set<string>(
    (pendingRequestsRes.data ?? []).map((e: any) => e.recipient_id as string),
  );

  // Shared trip destinations: "Both going to <city>" — same logic as /users/suggestions.
  const sharedDestinations: Record<string, string> = {};
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Fetch caller's upcoming trips with destination details in 2 queries.
    // The inner join on trip_members filters out past memberships without an
    // extra round-trip, so callerCityKeys.size === 0 is a reliable short-circuit.
    const [callerMemberRes, callerOwnedRes] = await Promise.all([
      sc.from("trip_members")
        .select("trip_id, trips!inner(destination_city, destination_country)")
        .eq("user_id", user.id)
        .in("role", ["owner", "member"])
        .gte("trips.end_date", today),
      sc.from("trips")
        .select("id, destination_city, destination_country")
        .eq("owner_id", user.id)
        .gte("end_date", today),
    ]);

    const callerCityKeys = new Set<string>();
    const callerCountryKeys = new Set<string>();
    const cityDisplayMap = new Map<string, string>();

    for (const r of (callerMemberRes.data ?? [])) {
      const t = (r as any).trips as { destination_city: string | null; destination_country: string | null } | null;
      const city = t?.destination_city?.trim();
      const country = t?.destination_country?.trim();
      if (city) { const k = city.toLowerCase(); callerCityKeys.add(k); cityDisplayMap.set(k, city); }
      if (country) callerCountryKeys.add(country.toLowerCase());
    }
    for (const t of (callerOwnedRes.data ?? [])) {
      const city = ((t as any).destination_city as string | null)?.trim();
      const country = ((t as any).destination_country as string | null)?.trim();
      if (city) { const k = city.toLowerCase(); callerCityKeys.add(k); cityDisplayMap.set(k, city); }
      if (country) callerCountryKeys.add(country.toLowerCase());
    }

    if (callerCityKeys.size > 0 || callerCountryKeys.size > 0) {
      const [candMemberRes, candOwnedRes] = await Promise.all([
        sc.from("trip_members").select("trip_id, user_id").in("user_id", ids).in("role", ["owner", "member"]),
        sc.from("trips").select("id, owner_id").in("owner_id", ids).gte("end_date", today),
      ]);

      const tripToUsers = new Map<string, string[]>();
      for (const r of (candMemberRes.data ?? [])) {
        const tid = (r as any).trip_id as string;
        const uid = (r as any).user_id as string;
        if (!tripToUsers.has(tid)) tripToUsers.set(tid, []);
        tripToUsers.get(tid)!.push(uid);
      }
      for (const r of (candOwnedRes.data ?? [])) {
        const tid = (r as any).id as string;
        const uid = (r as any).owner_id as string;
        if (!tripToUsers.has(tid)) tripToUsers.set(tid, []);
        if (!tripToUsers.get(tid)!.includes(uid)) tripToUsers.get(tid)!.push(uid);
      }

      if (tripToUsers.size > 0) {
        const { data: candTrips } = await sc
          .from("trips")
          .select("id, destination_city, destination_country")
          .in("id", Array.from(tripToUsers.keys()))
          .gte("end_date", today);

        for (const trip of (candTrips ?? [])) {
          const city = ((trip as any).destination_city as string | null)?.trim();
          const country = ((trip as any).destination_country as string | null)?.trim();
          const tid = (trip as any).id as string;

          let label: string | null = null;
          if (city && callerCityKeys.has(city.toLowerCase())) {
            label = `Both going to ${cityDisplayMap.get(city.toLowerCase()) ?? city}`;
          } else if (country && callerCountryKeys.has(country.toLowerCase())) {
            label = `Both going to ${country}`;
          }

          if (label) {
            for (const uid of (tripToUsers.get(tid) ?? [])) {
              if (!sharedDestinations[uid]) sharedDestinations[uid] = label;
            }
          }
        }
      }
    }
  } catch { /* fail-safe: skip shared destinations */ }

  // Universal display-name rule: batch-resolve which subjects opted in.
  const allowedNames = await nameVisibilitySet(sc, rows.map((p: any) => p.id));
  const qLower = q.toLowerCase();
  const users = rows
    .filter((p: any) => !blockedSet.has(p.id as string))
    // Hidden names must not be searchable: if the query only matched the
    // (hidden) real name — not the handle/username — drop the row entirely,
    // otherwise searching someone's name would reveal it belongs to them.
    .filter((p: any) => {
      if (allowedNames.has(p.id as string)) return true;
      const h = ((p.handle as string | null) ?? "").toLowerCase();
      const un = ((p.username as string | null) ?? "").toLowerCase();
      return h.includes(qLower) || un.includes(qLower);
    })
    .map((p: any) => ({
      id: p.id,
      displayName: allowedNames.has(p.id as string) ? ((p.name as string | null) ?? null) : null,
      username: (p.handle as string | null) ?? null,
      avatarUrl: (p.avatar_url as string | null) ?? null,
      followerCount: followerCounts[p.id as string] ?? 0,
      isFollowing: followingSet.has(p.id as string),
      isPrivate: (p.is_private as boolean) ?? false,
      friendRequestPending: pendingRequestSet.has(p.id as string),
      reason: sharedDestinations[p.id as string] ?? null,
      verified: (p.verified as boolean) ?? false,
      isOfficial: (p.is_official as boolean) ?? false,
    }));

  res.status(200).json({ users });
});

/* ===========================================================================
 * DELETE /users/suggestions/seen  — reset the seen-suggestions cache
 * ===========================================================================
 * Clears both the in-memory L1 cache and the DB L2 row for the calling user
 * so the next GET /users/suggestions returns a fully fresh pool.
 */
router.delete("/users/suggestions/seen", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  clearSeen(user.id);
  res.status(200).json({ cleared: true });
});

/* ===========================================================================
 * GET /users/suggestions  — "people you may know" when search is empty
 * ===========================================================================
 * Primary: followers the caller hasn't followed back yet, excluding blocked.
 * Fallback: when the caller has no followers (new user), returns a sample of
 * recently-joined or popular profiles so the list is never empty.
 */
router.get("/users/suggestions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // 1. Resolve blocks up-front — both directions (fail-safe: on error continue with empty set)
  let blockedSet = new Set<string>();
  try {
    const { data: blockRows, error: blockErr } = await sc
      .from("blocks")
      .select("blocked_id, blocker_id")
      .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
    if (!blockErr) {
      for (const b of (blockRows ?? [])) {
        if ((b as any).blocker_id === user.id) blockedSet.add((b as any).blocked_id);
        else blockedSet.add((b as any).blocker_id);
      }
    }
  } catch { /* fail safe */ }

  // 2. Who follows me? + caller's travel-interest profile (in parallel).
  // Followers are ordered by follower_id for deterministic seededShuffle input —
  // without an explicit ORDER BY Postgres row order is undefined and can vary per
  // request, breaking same-day stability even with a seeded shuffle.
  const [followerResult, callerProfileResult] = await Promise.all([
    sc.from("user_follows")
      .select("follower_id")
      .eq("following_id", user.id)
      .order("follower_id", { ascending: true })
      .limit(50),
    sc.from("profiles")
      .select("travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, planning_style")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  const { data: followerRows, error: follErr } = followerResult;

  if (follErr) {
    req.log.error({ err: follErr }, "suggestions followers query failed");
    res.status(200).json({ users: [] });
    return;
  }

  // Extract caller interest fields — gracefully absent when profile is sparse.
  const callerTravelStyles: string[] = (callerProfileResult.data as any)?.travel_styles ?? [];
  const callerTravelPace: string | null = (callerProfileResult.data as any)?.travel_pace ?? null;
  const callerBudgetStyle: string | null = (callerProfileResult.data as any)?.budget_style ?? null;
  const callerTravelGroupStyle: string[] = (callerProfileResult.data as any)?.travel_group_style ?? [];
  const callerLookingFor: string[] = (callerProfileResult.data as any)?.looking_for ?? [];
  const callerComfortLevel: string | null = (callerProfileResult.data as any)?.comfort_level ?? null;
  const callerPlanningStyle: string | null = (callerProfileResult.data as any)?.planning_style ?? null;

  const followerIds = (followerRows ?? []).map((r: any) => r.follower_id as string);

  // 3. Who do I already follow? (fetch all, not just intersection with followers)
  const { data: myFollowRows } = await sc
    .from("user_follows")
    .select("following_id")
    .eq("follower_id", user.id)
    .limit(500);

  const alreadyFollowingSet = new Set<string>(
    (myFollowRows ?? []).map((r: any) => r.following_id as string),
  );

  // 4. Follow-back candidates: my followers I haven't followed back, not blocked.
  // Seeded daily shuffle: same user + same UTC calendar day → same base order,
  // different ordering the next day so the strip feels fresh without a scheduler.
  const unshuffled = followerIds.filter(
    (id) => !alreadyFollowingSet.has(id) && !blockedSet.has(id),
  );

  // Deprioritise candidates already shown within the seen window (default 7 days).
  // Fresh candidates come first; if all have been seen, the cache is cleared and
  // the full set is used so the list never goes empty.
  const primarySeenIds = await getSeenIds(user.id);
  let freshCandidates = unshuffled.filter((id) => !primarySeenIds.has(id));
  if (freshCandidates.length === 0 && unshuffled.length > 0) {
    clearSeen(user.id);
    freshCandidates = unshuffled;
  }

  // Keep the full shuffled list; interest scoring will select the final 10 below.
  const candidateIds = seededShuffle(freshCandidates, dailySeed(user.id));

  // 5. If no follow-back candidates, fall back to a sample of popular/recent profiles
  let safeIds: string[];
  if (candidateIds.length > 0) {
    safeIds = candidateIds;
  } else {
    const { data: fallbackRows, error: fbErr } = await sc
      .from("profiles")
      .select("id")
      .neq("id", user.id)
      .in("account_status", ["active"])
      .order("created_at", { ascending: false })
      .limit(100);

    if (fbErr) {
      req.log.error({ err: fbErr }, "suggestions fallback query failed");
      res.status(200).json({ users: [] });
      return;
    }

    const seenIds = await getSeenIds(user.id);

    const pool = (fallbackRows ?? [])
      .map((r: any) => r.id as string)
      .filter((id) => !blockedSet.has(id) && !alreadyFollowingSet.has(id));

    // Exclude recently-seen IDs so each refresh surfaces genuinely fresh faces.
    // If excluding seen IDs would empty the pool, clear the cache and use the
    // full pool instead — the user has exhausted all available suggestions.
    let freshPool = pool.filter((id) => !seenIds.has(id));
    if (freshPool.length === 0 && pool.length > 0) {
      clearSeen(user.id);
      freshPool = pool;
    }

    // Seeded daily shuffle: same user + same UTC calendar day → same base order,
    // so the strip feels stable within a session but rotates to a completely
    // different set of faces the next day.  The seen-IDs exclusion above still
    // advances the window within the same day when the user pulls to refresh.
    const seed = dailySeed(user.id);
    freshPool = seededShuffle(freshPool, seed);

    // Keep the full shuffled list; interest scoring will select the final 10 below.
    safeIds = freshPool;
  }

  if (safeIds.length === 0) { res.status(200).json({ users: [] }); return; }

  // 6. Fetch pool profiles (display fields + interest fields) for scoring and rendering.
  //    We fetch the full pool here and slice to 10 after scoring, so that higher-overlap
  //    candidates from deeper in the shuffle can still surface in the final list.
  //    Only active accounts (deactivated/suspended/banned users may appear in the follower
  //    list after status changes — filter them out here).
  const { data: poolProfiles, error: profErr } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url, is_private, account_status, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, planning_style, verified, is_official")
    .in("id", safeIds)
    .in("account_status", ["active"]);

  if (profErr) {
    req.log.error({ err: profErr }, "suggestions profiles query failed");
    res.status(200).json({ users: [] });
    return;
  }

  // Filter out users who opted out of discovery.
  // Fail-closed: if the privacy query fails we cannot guarantee the opt-out is
  // respected, so we return an empty result set rather than exposing opted-out users.
  const fetchedIds = (poolProfiles ?? []).map((p: any) => p.id as string);
  let discoveryOptedOutSet = new Set<string>();
  if (fetchedIds.length > 0) {
    const { data: privRows, error: privErr } = await sc
      .from("profile_privacy_settings")
      .select("user_id")
      .in("user_id", fetchedIds)
      .eq("allow_profile_discovery", false);
    if (privErr) {
      req.log.error({ err: privErr }, "suggestions: privacy settings query failed; returning empty results (fail-closed)");
      res.status(200).json({ users: [] });
      return;
    }
    for (const row of (privRows ?? [])) {
      discoveryOptedOutSet.add((row as any).user_id as string);
    }
  }
  const visiblePoolProfiles = (poolProfiles ?? []).filter(
    (p: any) => !discoveryOptedOutSet.has(p.id as string)
  );
  // Rebuild safeIds to match the filtered pool (preserves original shuffle order).
  const visibleIdSet = new Set(visiblePoolProfiles.map((p: any) => p.id as string));
  const filteredSafeIds = safeIds.filter((id) => visibleIdSet.has(id));

  // Score each candidate by travel-interest overlap with the caller.
  // Returns 0 for all when the caller's profile is sparse — no change in ordering.
  const callerStylesSet = new Set<string>(callerTravelStyles);
  const callerGroupStyleSet = new Set<string>(callerTravelGroupStyle);
  const callerLookingForSet = new Set<string>(callerLookingFor);
  const hasCallerInterests =
    callerStylesSet.size > 0 ||
    !!callerTravelPace ||
    !!callerBudgetStyle ||
    callerGroupStyleSet.size > 0 ||
    callerLookingForSet.size > 0 ||
    !!callerComfortLevel ||
    !!callerPlanningStyle;
  const poolProfileMap = new Map(visiblePoolProfiles.map((p: any) => [p.id as string, p]));

  function interestScore(p: any): number {
    if (!hasCallerInterests) return 0;
    let s = 0;
    // Array fields: +1 per matching entry
    for (const style of ((p.travel_styles as string[] | null) ?? [])) {
      if (callerStylesSet.has(style)) s++;
    }
    for (const gs of ((p.travel_group_style as string[] | null) ?? [])) {
      if (callerGroupStyleSet.has(gs)) s++;
    }
    for (const lf of ((p.looking_for as string[] | null) ?? [])) {
      if (callerLookingForSet.has(lf)) s++;
    }
    // Scalar fields: +1 on exact match
    if (callerTravelPace && p.travel_pace === callerTravelPace) s++;
    if (callerBudgetStyle && p.budget_style === callerBudgetStyle) s++;
    if (callerComfortLevel && p.comfort_level === callerComfortLevel) s++;
    if (callerPlanningStyle && p.planning_style === callerPlanningStyle) s++;
    return s;
  }

  // Map id → interest score before sorting (reused later for reason label).
  const interestScores = new Map<string, number>(
    filteredSafeIds.map((id) => [id, interestScore(poolProfileMap.get(id) ?? {})])
  );

  // 7. Mutual connections: people the caller follows who also follow each candidate.
  //    Computed over the full pool (before the 10-item slice) so that high-mutual
  //    candidates deeper in the shuffle can still surface in the final list.
  //    We track the specific mutual IDs per candidate so we can apply interaction decay.
  const mutualCounts: Record<string, number> = {};
  const mutualsByCandidate = new Map<string, string[]>();
  const myFollowingList = Array.from(alreadyFollowingSet);
  const validSafeIds = filteredSafeIds.filter((id) => poolProfileMap.has(id));
  if (myFollowingList.length > 0) {
    try {
      const { data: mutualRows } = await sc
        .from("user_follows")
        .select("following_id, follower_id")
        .in("following_id", validSafeIds)
        .in("follower_id", myFollowingList);
      for (const r of (mutualRows ?? [])) {
        const cid = (r as any).following_id as string;
        const mid = (r as any).follower_id as string;
        mutualCounts[cid] = (mutualCounts[cid] ?? 0) + 1;
        const arr = mutualsByCandidate.get(cid) ?? [];
        arr.push(mid);
        mutualsByCandidate.set(cid, arr);
      }
    } catch { /* fail-safe: proceed with zero mutual counts */ }
  }

  // Interaction decay with recency weighting: a mutual you shared a trip with
  // recently is a much stronger endorsement than one you crossed paths with
  // two years ago.  Weight = max(DECAY_BASE, exp(-daysSince / HALF_LIFE_DAYS)).
  // At day 0 the weight is 1.0; at the half-life (90 days) it is ~0.37, which
  // rounds to DECAY_BASE; beyond that it stays at DECAY_BASE — same as not
  // interacted.  Non-interacted mutuals always use DECAY_BASE (0.5).
  const DECAY_BASE = 0.5;
  const HALF_LIFE_DAYS = 90;
  const nowMs = Date.now();

  // Per-mutual best (highest) recency-weighted interaction score.
  // Absent entry → not interacted → falls back to DECAY_BASE.
  const mutualInteractionWeights = new Map<string, number>();
  // Mutuals who shared a *recent* trip with the caller (trip weight > DECAY_BASE).
  // Populated only by the trip-based block; message threads are intentionally excluded
  // so the "Traveled together recently" label is specific to actual travel.
  const recentlyTraveledMutuals = new Set<string>();
  const allMutualIds = Array.from(
    new Set(Array.from(mutualsByCandidate.values()).flat()),
  );
  if (allMutualIds.length > 0) {
    try {
      const { data: callerTripRows } = await sc
        .from("trip_members")
        .select("trip_id")
        .eq("user_id", user.id);
      const callerTripIds = (callerTripRows ?? []).map((r: any) => r.trip_id as string);
      if (callerTripIds.length > 0) {
        // Fetch shared trip members including trip_id for recency lookup.
        const { data: sharedRows } = await sc
          .from("trip_members")
          .select("user_id, trip_id")
          .in("trip_id", callerTripIds)
          .in("user_id", allMutualIds);

        // Fetch trip dates to anchor the recency computation.
        // Prefer end_date (when travel actually ended) for accuracy — created_at
        // is only when the row was inserted and may be wrong for backfilled trips.
        // Priority: end_date → start_date → created_at (last resort).
        const sharedTripIds = [
          ...new Set((sharedRows ?? []).map((r: any) => r.trip_id as string)),
        ];
        const tripDateMap = new Map<string, number>(); // trip_id → ms
        if (sharedTripIds.length > 0) {
          const { data: tripDateRows } = await sc
            .from("trips")
            .select("id, end_date, start_date, created_at")
            .in("id", sharedTripIds);
          for (const t of (tripDateRows ?? [])) {
            const raw =
              (t.end_date as string | null) ??
              (t.start_date as string | null) ??
              (t.created_at as string | null);
            const ts = raw ? new Date(raw).getTime() : NaN;
            if (!isNaN(ts)) tripDateMap.set(t.id as string, ts);
          }
        }

        // For each (mutual, shared-trip) pair compute the recency weight and
        // keep the best score for that mutual across all shared trips.
        for (const r of (sharedRows ?? [])) {
          const mid = (r as any).user_id as string;
          const tripTs = tripDateMap.get((r as any).trip_id as string);
          const daysSince = tripTs !== undefined
            ? (nowMs - tripTs) / (1000 * 60 * 60 * 24)
            : null;
          const weight = daysSince !== null
            ? Math.max(DECAY_BASE, Math.exp(-daysSince / HALF_LIFE_DAYS))
            : DECAY_BASE; // no date available → treat same as non-interacted
          const prev = mutualInteractionWeights.get(mid) ?? 0;
          if (weight > prev) mutualInteractionWeights.set(mid, weight);
          // Recency label threshold: any trip within HALF_LIFE_DAYS (90 days) is
          // considered "recent" regardless of the decay weight at that point.
          // (weight > DECAY_BASE would only fire at ~62 days, not 90.)
          if (daysSince !== null && daysSince <= HALF_LIFE_DAYS) {
            recentlyTraveledMutuals.add(mid);
          }
        }
      }
    } catch { /* fail-safe: all mutuals get base decay weight */ }

    // Message threads: a mutual who shares a message thread with the caller
    // is an active connection — give full weight (1.0) regardless of thread age.
    // This runs as a separate try/catch so a thread-lookup failure never
    // degrades the trip-based weights already computed above.
    try {
      const { data: callerThreadRows } = await sc
        .from("message_thread_members")
        .select("thread_id")
        .eq("user_id", user.id);
      const callerThreadIds = (callerThreadRows ?? []).map((r: any) => r.thread_id as string);
      if (callerThreadIds.length > 0) {
        const { data: sharedThreadRows } = await sc
          .from("message_thread_members")
          .select("user_id")
          .in("thread_id", callerThreadIds)
          .in("user_id", allMutualIds);
        for (const r of (sharedThreadRows ?? [])) {
          const mid = (r as any).user_id as string;
          mutualInteractionWeights.set(mid, 1.0);
        }
      }
    } catch { /* fail-safe: proceed without message-thread signal */ }
  }

  // Sum the per-mutual recency-weighted scores for each candidate.
  const decayedMutualScores: Record<string, number> = {};
  for (const [cid, mids] of mutualsByCandidate.entries()) {
    decayedMutualScores[cid] = mids.reduce(
      (sum, mid) => sum + (mutualInteractionWeights.get(mid) ?? DECAY_BASE),
      0,
    );
  }

  // Combined score: interaction-decayed mutual connections are a stronger trust
  // signal than style overlap, so they carry 3× weight.  Equal combined scores
  // preserve the seeded-shuffle order (Array.prototype.sort is stable in V8).
  const MUTUAL_WEIGHT = 3;
  safeIds = validSafeIds
    .sort((a, b) => {
      const scoreB = (decayedMutualScores[b] ?? 0) * MUTUAL_WEIGHT + (interestScores.get(b) ?? 0);
      const scoreA = (decayedMutualScores[a] ?? 0) * MUTUAL_WEIGHT + (interestScores.get(a) ?? 0);
      return scoreB - scoreA;
    })
    .slice(0, 10);

  const profiles = safeIds.map((id) => poolProfileMap.get(id)!);

  // 8. Follower counts for the candidate profiles
  const { data: countRows } = await sc
    .from("user_follows")
    .select("following_id")
    .in("following_id", safeIds);

  const followerCounts: Record<string, number> = {};
  for (const r of (countRows ?? [])) {
    const fid = (r as any).following_id as string;
    followerCounts[fid] = (followerCounts[fid] ?? 0) + 1;
  }

  // 9. Shared trip destinations: "Both going to <city>" when caller and candidate
  //    share an upcoming or active trip destination (same city, or same country
  //    as fallback). This takes priority over all other reason labels.
  const sharedDestinations: Record<string, string> = {};
  try {
    const today = new Date(nowMs).toISOString().slice(0, 10);

    // Fetch caller's upcoming trips with destination details in 2 queries.
    // The inner join on trip_members filters out past memberships without an
    // extra round-trip, so callerCityKeys.size === 0 is a reliable short-circuit.
    const [callerMemberRes, callerOwnedRes] = await Promise.all([
      sc.from("trip_members")
        .select("trip_id, trips!inner(destination_city, destination_country)")
        .eq("user_id", user.id)
        .in("role", ["owner", "member"])
        .gte("trips.end_date", today),
      sc.from("trips")
        .select("id, destination_city, destination_country")
        .eq("owner_id", user.id)
        .gte("end_date", today),
    ]);

    // Build lookup sets from caller's destinations.
    const callerCityKeys = new Set<string>();
    const callerCountryKeys = new Set<string>();
    const cityDisplayMap = new Map<string, string>(); // lowercase key → display label

    for (const r of (callerMemberRes.data ?? [])) {
      const t = (r as any).trips as { destination_city: string | null; destination_country: string | null } | null;
      const city = t?.destination_city?.trim();
      const country = t?.destination_country?.trim();
      if (city) { const k = city.toLowerCase(); callerCityKeys.add(k); cityDisplayMap.set(k, city); }
      if (country) callerCountryKeys.add(country.toLowerCase());
    }
    for (const t of (callerOwnedRes.data ?? [])) {
      const city = ((t as any).destination_city as string | null)?.trim();
      const country = ((t as any).destination_country as string | null)?.trim();
      if (city) { const k = city.toLowerCase(); callerCityKeys.add(k); cityDisplayMap.set(k, city); }
      if (country) callerCountryKeys.add(country.toLowerCase());
    }

    if (callerCityKeys.size > 0 || callerCountryKeys.size > 0) {
      // Fetch candidate trips — both owned and joined as member.
      const [candMemberRes, candOwnedRes] = await Promise.all([
        sc.from("trip_members").select("trip_id, user_id").in("user_id", safeIds).in("role", ["owner", "member"]),
        sc.from("trips").select("id, owner_id").in("owner_id", safeIds).gte("end_date", today),
      ]);

      // Build tripId → [userId] map so one trip can credit multiple candidates.
      const tripToUsers = new Map<string, string[]>();
      for (const r of (candMemberRes.data ?? [])) {
        const tid = (r as any).trip_id as string;
        const uid = (r as any).user_id as string;
        if (!tripToUsers.has(tid)) tripToUsers.set(tid, []);
        tripToUsers.get(tid)!.push(uid);
      }
      for (const r of (candOwnedRes.data ?? [])) {
        const tid = (r as any).id as string;
        const uid = (r as any).owner_id as string;
        if (!tripToUsers.has(tid)) tripToUsers.set(tid, []);
        if (!tripToUsers.get(tid)!.includes(uid)) tripToUsers.get(tid)!.push(uid);
      }

      if (tripToUsers.size > 0) {
        const { data: candTrips } = await sc
          .from("trips")
          .select("id, destination_city, destination_country")
          .in("id", Array.from(tripToUsers.keys()))
          .gte("end_date", today);

        for (const trip of (candTrips ?? [])) {
          const city = ((trip as any).destination_city as string | null)?.trim();
          const country = ((trip as any).destination_country as string | null)?.trim();
          const tid = (trip as any).id as string;

          let label: string | null = null;
          if (city && callerCityKeys.has(city.toLowerCase())) {
            label = `Both going to ${cityDisplayMap.get(city.toLowerCase()) ?? city}`;
          } else if (country && callerCountryKeys.has(country.toLowerCase())) {
            label = `Both going to ${country}`;
          }

          if (label) {
            for (const uid of (tripToUsers.get(tid) ?? [])) {
              // First match wins — keeps one label per candidate.
              if (!sharedDestinations[uid]) sharedDestinations[uid] = label;
            }
          }
        }
      }
    }
  } catch { /* fail-safe: skip shared destinations, fall through to other reasons */ }

  // Which candidates follow the caller back (primary path)
  const followerSet = new Set(followerIds);

  // Re-order profiles to match the (possibly shuffled) safeIds order
  const profileById = new Map((profiles ?? []).map((p: any) => [p.id as string, p]));
  // Universal display-name rule: suggestions show @handle unless opted in.
  const allowedSuggestionNames = await nameVisibilitySet(sc, safeIds);

  // Pending follow-requests: fetch once for the whole batch so we can surface
  // "Requested" state on private-account suggestion cards without an extra
  // round-trip per row.
  let pendingSuggestionRequestSet = new Set<string>();
  if (safeIds.length > 0) {
    try {
      const { data: pendingRows } = await sc
        .from("friend_requests")
        .select("recipient_id")
        .eq("requester_id", user.id)
        .eq("status", "pending")
        .in("recipient_id", safeIds);
      for (const r of (pendingRows ?? [])) {
        pendingSuggestionRequestSet.add((r as any).recipient_id as string);
      }
    } catch { /* fail-safe: no pending state shown */ }
  }

  const users = safeIds
    .map((id) => profileById.get(id))
    .filter(Boolean)
    .map((p: any) => {
      const mc = mutualCounts[p.id as string] ?? 0;
      const sharedDest = sharedDestinations[p.id as string] ?? null;
      let reason: string | null = null;
      const follows = followerSet.has(p.id as string);
      if (sharedDest && follows) {
        reason = `Follows you · ${sharedDest}`; // both signals: combined label
      } else if (sharedDest) {
        reason = sharedDest;
      } else if (follows) {
        reason = "Follows you";
      } else if (mc > 0) {
        const mutualLabel = mc === 1 ? "1 mutual connection" : `${mc} mutual connections`;
        const hasRecentTrip = (mutualsByCandidate.get(p.id as string) ?? []).some(
          (mid) => recentlyTraveledMutuals.has(mid),
        );
        reason = hasRecentTrip ? `${mutualLabel} · Traveled together recently` : mutualLabel;
      } else if ((interestScores.get(p.id as string) ?? 0) > 0) {
        reason = "Shares your travel style";
      }
      // Private accounts the viewer hasn't followed yet get a locked preview:
      // no avatar, no display name. This matches the locked-preview pattern used
      // in /api/discovery/search and /api/users/search so a private profile is
      // consistently discoverable everywhere or nowhere.
      const isPrivate = (p.is_private as boolean) ?? false;
      return {
        id: p.id,
        displayName: (!isPrivate && allowedSuggestionNames.has(p.id as string))
          ? ((p.name as string | null) ?? null)
          : null,
        username: (p.handle as string | null) ?? null,
        avatarUrl: isPrivate ? null : ((p.avatar_url as string | null) ?? null),
        followerCount: followerCounts[p.id as string] ?? 0,
        isFollowing: false,
        isPrivate,
        friendRequestPending: pendingSuggestionRequestSet.has(p.id as string),
        mutualCount: mc,
        reason: isPrivate ? null : reason,
        verified: (p.verified as boolean) ?? false,
        isOfficial: (p.is_official as boolean) ?? false,
      };
    });

  // Record served IDs so the next fallback request excludes them.
  const servedIds = users.map((u: any) => u.id as string);
  if (servedIds.length > 0) markAsSeen(user.id, servedIds);

  res.status(200).json({ users });
});

/* ===========================================================================
 * getSharedDestinationReason  — shared helper
 * ===========================================================================
 * Returns "Both going to <city/country>" if caller and target share an upcoming
 * trip destination, null otherwise.  Fails open (returns null) on any error.
 */
async function getSharedDestinationReason(
  sc: any,
  callerId: string,
  targetId: string,
): Promise<string | null> {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const [callerMemberRes, callerOwnedRes] = await Promise.all([
      sc.from("trip_members")
        .select("trip_id, trips!inner(destination_city, destination_country)")
        .eq("user_id", callerId)
        .in("role", ["owner", "member"])
        .gte("trips.end_date", today),
      sc.from("trips")
        .select("id, destination_city, destination_country")
        .eq("owner_id", callerId)
        .gte("end_date", today),
    ]);

    const callerCityKeys = new Set<string>();
    const callerCountryKeys = new Set<string>();
    const cityDisplayMap = new Map<string, string>();

    for (const r of (callerMemberRes.data ?? [])) {
      const t = (r as any).trips as { destination_city: string | null; destination_country: string | null } | null;
      const city = t?.destination_city?.trim();
      const country = t?.destination_country?.trim();
      if (city) { const k = city.toLowerCase(); callerCityKeys.add(k); cityDisplayMap.set(k, city); }
      if (country) callerCountryKeys.add(country.toLowerCase());
    }
    for (const t of (callerOwnedRes.data ?? [])) {
      const city = ((t as any).destination_city as string | null)?.trim();
      const country = ((t as any).destination_country as string | null)?.trim();
      if (city) { const k = city.toLowerCase(); callerCityKeys.add(k); cityDisplayMap.set(k, city); }
      if (country) callerCountryKeys.add(country.toLowerCase());
    }

    if (callerCityKeys.size === 0 && callerCountryKeys.size === 0) return null;

    const [targetMemberRes, targetOwnedRes] = await Promise.all([
      sc.from("trip_members")
        .select("trip_id, trips!inner(destination_city, destination_country)")
        .eq("user_id", targetId)
        .in("role", ["owner", "member"])
        .gte("trips.end_date", today),
      sc.from("trips")
        .select("id, destination_city, destination_country")
        .eq("owner_id", targetId)
        .gte("end_date", today),
    ]);

    for (const r of (targetMemberRes.data ?? [])) {
      const t = (r as any).trips as { destination_city: string | null; destination_country: string | null } | null;
      const city = t?.destination_city?.trim();
      const country = t?.destination_country?.trim();
      if (city && callerCityKeys.has(city.toLowerCase())) return `Both going to ${cityDisplayMap.get(city.toLowerCase()) ?? city}`;
      if (country && callerCountryKeys.has(country.toLowerCase())) return `Both going to ${country}`;
    }
    for (const t of (targetOwnedRes.data ?? [])) {
      const city = ((t as any).destination_city as string | null)?.trim();
      const country = ((t as any).destination_country as string | null)?.trim();
      if (city && callerCityKeys.has(city.toLowerCase())) return `Both going to ${cityDisplayMap.get(city.toLowerCase()) ?? city}`;
      if (country && callerCountryKeys.has(country.toLowerCase())) return `Both going to ${country}`;
    }
    return null;
  } catch { return null; }
}

/* ===========================================================================
 * GET /users/:userId  — public profile for Passport page
 * ===========================================================================
 * Returns safe public fields + follower/following counts + isFollowing state.
 * Auth optional: unauthenticated callers get counts but isFollowing=false.
 * Never returns private posts, trips, circle memberships, or location data.
 */
const PUBLIC_PASSPORT_FIELDS =
  "id, handle, name, avatar_url, bio, home_city, home_country, current_city, travel_style, interests, verified, verification_status, verified_at, open_to_meet, is_private, created_at, spoken_languages, default_language, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, availability_tags, planning_style, account_status, is_official";

/** Build the public passport JSON payload from a profile row + context. */
function buildPassportResponse(
  p: any,
  followersCount: number,
  followingCount: number,
  isFollowing: boolean,
  isOwnProfile: boolean,
  reason: string | null,
  allowRealName = false,
): object {
  // Universal display-name rule: name only for the owner or opted-in subjects.
  const nameOk = isOwnProfile || allowRealName;
  const isPrivate = p.is_private ?? false;
  // Private profile viewed by a non-follower non-owner: redact rich fields.
  if (isPrivate && !isOwnProfile && !isFollowing) {
    return {
      id: p.id,
      handle: p.handle,
      name: nameOk ? p.name : null,
      avatarUrl: p.avatar_url ?? null,
      isPrivate: true,
      isOwnProfile,
      followersCount,
      followingCount,
      isFollowing,
      reason,
      memberSince: p.created_at,
      isOfficial: (p.is_official as boolean) ?? false,
    };
  }
  return {
    id: p.id,
    handle: p.handle,
    name: nameOk ? p.name : null,
    avatarUrl: p.avatar_url ?? null,
    bio: p.bio ?? null,
    homeCity: p.home_city ?? null,
    homeCountry: p.home_country ?? null,
    currentCity: p.current_city ?? null,
    travelStyle: p.travel_style ?? null,
    interests: p.interests ?? [],
    verified: p.verified ?? false,
    verificationStatus: p.verification_status ?? "unverified",
    verifiedAt: p.verified_at ?? null,
    openToMeet: p.open_to_meet ?? false,
    isPrivate,
    memberSince: p.created_at,
    followersCount,
    followingCount,
    isFollowing,
    isOwnProfile,
    reason,
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
    isOfficial: (p.is_official as boolean) ?? false,
  };
}

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

  const isOwnProfile = callerId === target;
  const needBlockCheck = !!callerId && !isOwnProfile;

  // Fetch profile + counts + blocks in one parallel sweep.
  const [profileRes, followersRes, followingRes, callerBlockedTargetRes, targetBlockedCallerRes] =
    await Promise.all([
      sc.from("profiles").select(PUBLIC_PASSPORT_FIELDS).eq("id", target).maybeSingle(),
      sc.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
      sc.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
      needBlockCheck
        ? sc.from("blocks").select("blocker_id", { count: "exact", head: true })
            .eq("blocker_id", callerId!).eq("blocked_id", target)
        : Promise.resolve({ count: 0 }),
      needBlockCheck
        ? sc.from("blocks").select("blocker_id", { count: "exact", head: true })
            .eq("blocker_id", target).eq("blocked_id", callerId!)
        : Promise.resolve({ count: 0 }),
    ]);

  if (profileRes.error || !profileRes.data) {
    sendError(res, "not_found", "User not found");
    return;
  }

  const p = profileRes.data as any;

  // Guard: deleted / banned / suspended accounts return an unavailable sentinel.
  const acctStatus = (p.account_status ?? "active") as string;
  if (acctStatus === "deleted" || acctStatus === "banned" || acctStatus === "suspended") {
    res.status(404).json({ unavailable: true, reason: "deleted" });
    return;
  }
  // Deactivated is also unavailable unless it is the owner checking their own profile.
  if (acctStatus === "deactivated" && !isOwnProfile) {
    res.status(404).json({ unavailable: true, reason: "deleted" });
    return;
  }

  // Guard: blocks. Caller blocked target → they can still see the stub (to unblock).
  //         Target blocked caller → profile is fully hidden (reason only).
  const callerBlockedTarget = ((callerBlockedTargetRes as any).count ?? 0) > 0;
  const targetBlockedCaller = ((targetBlockedCallerRes as any).count ?? 0) > 0;
  if (targetBlockedCaller) {
    res.status(200).json({ unavailable: true, reason: "blocked", isBlocker: false });
    return;
  }
  if (callerBlockedTarget) {
    res.status(200).json({ unavailable: true, reason: "blocked", isBlocker: true });
    return;
  }

  // Is the authenticated caller already following this user? Also fetch match reason.
  let isFollowing = false;
  let reason: string | null = null;
  if (callerId && !isOwnProfile) {
    const [edgeRes, reasonResult] = await Promise.all([
      sc.from("user_follows").select("follower_id")
        .eq("follower_id", callerId).eq("following_id", target).maybeSingle(),
      getSharedDestinationReason(sc, callerId, target),
    ]);
    isFollowing = Boolean(edgeRes.data);
    reason = reasonResult;
  }

  const allowRealName = await nameVisibleFor(sc, target);
  res.status(200).json(
    buildPassportResponse(p, followersRes.count ?? 0, followingRes.count ?? 0, isFollowing, isOwnProfile, reason, allowRealName),
  );
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

  const p = profileRes.data as any;
  const target = p.id as string;
  const isOwnProfile = callerId === target;
  const needBlockCheck = !!callerId && !isOwnProfile;

  // Guard: deleted / banned / suspended accounts return an unavailable sentinel.
  const acctStatus = (p.account_status ?? "active") as string;
  if (acctStatus === "deleted" || acctStatus === "banned" || acctStatus === "suspended") {
    res.status(404).json({ unavailable: true, reason: "deleted" });
    return;
  }
  if (acctStatus === "deactivated" && !isOwnProfile) {
    res.status(404).json({ unavailable: true, reason: "deleted" });
    return;
  }

  const [followersRes, followingRes, callerBlockedTargetRes, targetBlockedCallerRes] =
    await Promise.all([
      sc.from("user_follows").select("*", { count: "exact", head: true }).eq("following_id", target),
      sc.from("user_follows").select("*", { count: "exact", head: true }).eq("follower_id", target),
      needBlockCheck
        ? sc.from("blocks").select("blocker_id", { count: "exact", head: true })
            .eq("blocker_id", callerId!).eq("blocked_id", target)
        : Promise.resolve({ count: 0 }),
      needBlockCheck
        ? sc.from("blocks").select("blocker_id", { count: "exact", head: true })
            .eq("blocker_id", target).eq("blocked_id", callerId!)
        : Promise.resolve({ count: 0 }),
    ]);

  // Guard: blocks.
  const callerBlockedTarget = ((callerBlockedTargetRes as any).count ?? 0) > 0;
  const targetBlockedCaller = ((targetBlockedCallerRes as any).count ?? 0) > 0;
  if (targetBlockedCaller) {
    res.status(200).json({ unavailable: true, reason: "blocked", isBlocker: false });
    return;
  }
  if (callerBlockedTarget) {
    res.status(200).json({ unavailable: true, reason: "blocked", isBlocker: true });
    return;
  }

  let isFollowing = false;
  let reason: string | null = null;
  if (callerId && !isOwnProfile) {
    const [edgeRes, reasonResult] = await Promise.all([
      sc.from("user_follows").select("follower_id")
        .eq("follower_id", callerId).eq("following_id", target).maybeSingle(),
      getSharedDestinationReason(sc, callerId, target),
    ]);
    isFollowing = Boolean(edgeRes.data);
    reason = reasonResult;
  }

  const allowRealName = await nameVisibleFor(sc, target);
  res.status(200).json(
    buildPassportResponse(p, followersRes.count ?? 0, followingRes.count ?? 0, isFollowing, isOwnProfile, reason, allowRealName),
  );
});

export default router;
