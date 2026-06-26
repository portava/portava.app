import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { decideFollow, decideUnfollow, isUuid } from "../lib/followDecisions";
import { getSeenIds, markAsSeen, clearSeen, dailySeed, seededShuffle } from "../lib/suggestionSeenCache";

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

  const targetExists = isUuid(target) ? await profileExists(client, target) : false;
  // Block check — `client` here is the service-role client (bypasses RLS) so both
  // directions are visible regardless of which user is blocker_id.
  let blocked = false;
  if (targetExists) {
    const { data: blockRow } = await client
      .from("blocks")
      .select("blocker_id")
      .or(`and(blocker_id.eq.${user.id},blocked_id.eq.${target}),and(blocker_id.eq.${target},blocked_id.eq.${user.id})`)
      .limit(1)
      .maybeSingle();
    blocked = Boolean(blockRow);
  }
  const decision = decideFollow(user.id, target, { targetExists, blocked });
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

  res.status(200).json({
    users: rows.map((r: any) => ({ ...rowToUser(r), followsYou: mutualSet.has(r.following_id as string) })),
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

  res.status(200).json({
    users: rows.map((r: any) => ({ ...rowToUser(r), youFollow: youFollowSet.has(r.follower_id as string) })),
  });
});

function rowToUser(r: any) {
  const p = r.profile ?? {};
  return { id: p.id, handle: p.handle, name: p.name, avatarUrl: p.avatar_url ?? null, since: r.created_at };
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
  const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;

  const { getServiceClient } = await import("../lib/supabase");
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Fetch matching profiles (ILIKE on name or handle), excluding the caller.
  const { data: profiles, error: profErr } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url, is_private")
    .or(`name.ilike.${pattern},handle.ilike.${pattern}`)
    .neq("id", user.id)
    .limit(limit);

  if (profErr) {
    req.log.error({ err: profErr }, "user search failed");
    sendError(res, "db_error", profErr.message);
    return;
  }

  const rows = profiles ?? [];
  if (rows.length === 0) { res.status(200).json({ users: [] }); return; }

  const ids = rows.map((p: any) => p.id as string);

  // Resolve blocked-user IDs.
  // user_blocks may not exist yet; check .error explicitly (Supabase returns
  // errors in the response object, not as thrown exceptions).
  // If the query errors for any reason, fail safe by excluding ALL result users
  // — we'd rather show no results than leak a blocked user's profile.
  let blockedSet = new Set<string>();
  let blockQueryFailed = false;
  try {
    const { data: blockRows, error: blockErr } = await sc
      .from("user_blocks")
      .select("blocked_id, blocker_id")
      .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
    if (blockErr) {
      // Table missing (PGRST204 / 42P01) is expected — treat as no blocks.
      // Any other DB error: fail safe (return empty set, filter will remove all).
      const isTableMissing =
        blockErr.code === "42P01" ||
        blockErr.code === "PGRST204" ||
        (blockErr.message ?? "").toLowerCase().includes("does not exist");
      if (!isTableMissing) {
        blockQueryFailed = true;
        req.log.warn({ err: blockErr }, "user_blocks query failed; suppressing results");
      }
    } else {
      for (const b of (blockRows ?? [])) {
        if ((b as any).blocker_id === user.id) blockedSet.add((b as any).blocked_id);
        else blockedSet.add((b as any).blocker_id);
      }
    }
  } catch (e) {
    // Network-level or unexpected error — fail safe.
    blockQueryFailed = true;
    req.log.warn({ err: e }, "user_blocks query threw; suppressing results");
  }

  if (blockQueryFailed) { res.status(200).json({ users: [] }); return; }

  // Follower counts and isFollowing state in parallel (single query each).
  const [followerEdgesRes, myFollowsRes] = await Promise.all([
    sc.from("user_follows").select("following_id").in("following_id", ids),
    sc.from("user_follows").select("following_id").eq("follower_id", user.id).in("following_id", ids),
  ]);

  const followerCounts: Record<string, number> = {};
  for (const e of (followerEdgesRes.data ?? [])) {
    const fid = (e as any).following_id as string;
    followerCounts[fid] = (followerCounts[fid] ?? 0) + 1;
  }

  const followingSet = new Set<string>(
    (myFollowsRes.data ?? []).map((e: any) => e.following_id as string),
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

  const users = rows
    .filter((p: any) => !blockedSet.has(p.id as string))
    .map((p: any) => ({
      id: p.id,
      displayName: (p.name as string | null) ?? null,
      username: (p.handle as string | null) ?? null,
      avatarUrl: (p.avatar_url as string | null) ?? null,
      followerCount: followerCounts[p.id as string] ?? 0,
      isFollowing: followingSet.has(p.id as string),
      isPrivate: (p.is_private as boolean) ?? false,
      reason: sharedDestinations[p.id as string] ?? null,
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

  // 1. Resolve blocks up-front (fail-safe: on error continue with empty set)
  let blockedSet = new Set<string>();
  try {
    const { data: blockRows, error: blockErr } = await sc
      .from("user_blocks")
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
  const { data: poolProfiles, error: profErr } = await sc
    .from("profiles")
    .select("id, handle, name, avatar_url, is_private, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, planning_style")
    .in("id", safeIds);

  if (profErr) {
    req.log.error({ err: profErr }, "suggestions profiles query failed");
    res.status(200).json({ users: [] });
    return;
  }

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
  const poolProfileMap = new Map((poolProfiles ?? []).map((p: any) => [p.id as string, p]));

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
    safeIds.map((id) => [id, interestScore(poolProfileMap.get(id) ?? {})])
  );

  // 7. Mutual connections: people the caller follows who also follow each candidate.
  //    Computed over the full pool (before the 10-item slice) so that high-mutual
  //    candidates deeper in the shuffle can still surface in the final list.
  const mutualCounts: Record<string, number> = {};
  const myFollowingList = Array.from(alreadyFollowingSet);
  const validSafeIds = safeIds.filter((id) => poolProfileMap.has(id));
  if (myFollowingList.length > 0) {
    try {
      const { data: mutualRows } = await sc
        .from("user_follows")
        .select("following_id, follower_id")
        .in("following_id", validSafeIds)
        .in("follower_id", myFollowingList);
      for (const r of (mutualRows ?? [])) {
        const cid = (r as any).following_id as string;
        mutualCounts[cid] = (mutualCounts[cid] ?? 0) + 1;
      }
    } catch { /* fail-safe: proceed with zero mutual counts */ }
  }

  // Combined score: mutual connections are a stronger trust signal than style
  // overlap, so they carry 3× weight.  Equal combined scores preserve the
  // seeded-shuffle order (Array.prototype.sort is stable in V8).
  const MUTUAL_WEIGHT = 3;
  safeIds = validSafeIds
    .sort((a, b) => {
      const scoreB = (mutualCounts[b] ?? 0) * MUTUAL_WEIGHT + (interestScores.get(b) ?? 0);
      const scoreA = (mutualCounts[a] ?? 0) * MUTUAL_WEIGHT + (interestScores.get(a) ?? 0);
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
        reason = mc === 1 ? "1 mutual connection" : `${mc} mutual connections`;
      } else if ((interestScores.get(p.id as string) ?? 0) > 0) {
        reason = "Shares your travel style";
      }
      return {
        id: p.id,
        displayName: (p.name as string | null) ?? null,
        username: (p.handle as string | null) ?? null,
        avatarUrl: (p.avatar_url as string | null) ?? null,
        followerCount: followerCounts[p.id as string] ?? 0,
        isFollowing: false,
        isPrivate: (p.is_private as boolean) ?? false,
        mutualCount: mc,
        reason,
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
  "id, handle, name, avatar_url, bio, home_city, home_country, current_city, travel_style, interests, verified, verification_status, verified_at, open_to_meet, is_private, created_at, spoken_languages, default_language, travel_styles, travel_pace, budget_style, travel_group_style, looking_for, comfort_level, availability_tags, planning_style";

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

  // Is the authenticated caller already following this user? Also fetch match reason.
  let isFollowing = false;
  let reason: string | null = null;
  if (callerId && callerId !== target) {
    const [edgeRes, reasonResult] = await Promise.all([
      sc.from("user_follows").select("follower_id")
        .eq("follower_id", callerId).eq("following_id", target).maybeSingle(),
      getSharedDestinationReason(sc, callerId, target),
    ]);
    isFollowing = Boolean(edgeRes.data);
    reason = reasonResult;
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
    verificationStatus: p.verification_status ?? 'unverified',
    verifiedAt: p.verified_at ?? null,
    openToMeet: p.open_to_meet ?? false,
    isPrivate: p.is_private ?? false,
    memberSince: p.created_at,
    followersCount: followersRes.count ?? 0,
    followingCount: followingRes.count ?? 0,
    isFollowing,
    isOwnProfile: callerId === target,
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
  let reason: string | null = null;
  if (callerId && callerId !== target) {
    const [edgeRes, reasonResult] = await Promise.all([
      sc.from("user_follows").select("follower_id")
        .eq("follower_id", callerId).eq("following_id", target).maybeSingle(),
      getSharedDestinationReason(sc, callerId, target),
    ]);
    isFollowing = Boolean(edgeRes.data);
    reason = reasonResult;
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
    verificationStatus: p.verification_status ?? 'unverified',
    verifiedAt: p.verified_at ?? null,
    openToMeet: p.open_to_meet ?? false,
    isPrivate: p.is_private ?? false,
    memberSince: p.created_at,
    followersCount: followersRes.count ?? 0,
    followingCount: followingRes.count ?? 0,
    isFollowing,
    isOwnProfile: callerId === target,
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
  });
});

export default router;
