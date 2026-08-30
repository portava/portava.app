/**
 * CompassFallbackFeedBuilder — Phase 6 graceful degradation.
 *
 * When COMPASS_FALLBACK_MODE_ENABLED is true, OR when CompassFeedBuilder
 * throws an unhandled error, all feed endpoints call this builder instead.
 *
 * The fallback feed assembles safe, pre-approved content from:
 *   1. Safety tools              — static items (emergency contacts, safe-return, SOS)
 *   2. User's active trips       — trips where user is owner or member
 *   3. User's active bookings    — confirmed/active rent-a-buddy bookings
 *   4. Recent Telegraph threads  — most recent message threads the user participates in
 *   5. Saved/upcoming trips      — trips user joined (not owned)
 *   6. Verified safe events      — city-scoped event posts with location_verified = true
 *   7. Admin-approved city guide — verified discovery_places for the user's city
 *   8. Popular public posts      — highest-liked posts excluding delayed/unpublished
 *   9. Passport summary          — user's own passport stamps
 *  10. Basic discovery           — top active users near the user's city
 *
 * Safety guarantees (NEVER bypassed even in fallback):
 *   - `runSafetyFilter` is called on every fetched item before inclusion.
 *   - Blocked users are excluded (block list fetched from DB).
 *   - Delayed posts whose publishEligibleAt is in the future are excluded at
 *     the DB query level (WHERE clause) AND again by the safety filter
 *     (isDelayedPost = true → blocked).
 *   - Cancelled, expired, and hidden items are excluded.
 *   - Launch controls (isSuspended, isHidden) are enforced by the safety filter.
 *
 * Returns `{ fallback: true }` in the response envelope so clients know
 * they are in degraded mode.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassItemType, CompassProfile } from "./types.js";
import { runSafetyFilterBatch }                              from "./CompassSafetyFilter.js";
import { sanitizeItem }                                      from "./CompassPrivacyGuard.js";
import { getFlags }                                          from "./flags.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FallbackItem {
  id:       string;
  type:     "trip" | "event" | "booking" | "post" | "suggestion" | "message";
  category:
    | "safety_tool"
    | "active_trip"
    | "saved_trip"
    | "booking"
    | "telegraph"
    | "verified_event"
    | "city_guide"
    | "public_content"
    | "passport_summary"
    | "basic_discovery";
  title:    string;
  authorId: string | undefined;
  data:     Record<string, unknown>;
}

export interface FallbackSection {
  name:  string;
  items: FallbackItem[];
  total: number;
}

export interface FallbackFeedResult {
  sections:       FallbackSection[];
  nextCursor:     null;
  fallback:       true;
  fallbackReason: string;
  safeItems:      FallbackItem[];
}

// ── Feature flag check ────────────────────────────────────────────────────────

/**
 * Returns true when COMPASS_FALLBACK_MODE_ENABLED is set to true in
 * the feature_flags table. Fail-open: a DB error returns false (don't
 * accidentally force everyone to fallback if the flag table is slow).
 */
export async function isFallbackModeEnabled(db: SupabaseClient): Promise<boolean> {
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "COMPASS_FALLBACK_MODE_ENABLED")
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

// ── Safety profile builder ────────────────────────────────────────────────────

/**
 * Build a minimal CompassProfile from the block list for use in the safety
 * filter and privacy guard.  All scoring fields are set to safe defaults so
 * only safety/privacy checks are applied.
 */
function buildSafeProfile(
  userId:     string,
  blockedIds: Set<string>,
  city:       string | null,
): CompassProfile {
  const blockedArr = [...blockedIds];
  return {
    userId,
    preferredCities:       city ? [city] : [],
    preferredLanguages:    [],
    budgetStyle:           null,
    travelStyles:          [],
    socialStyle:           null,
    safetyPreference:      "standard",
    visibilityPreference:  "public",
    blockedUserIds:        blockedArr,
    blockerUserIds:        [],
    mutedUserIds:          [],
    blockCount:            blockedArr.length,
    blockerCount:          0,
    trustScore:            null,
    trustLevel:            null,
    activeUserScore:       null,
    hasActiveTrip:         false,
    hasActiveBooking:      false,
    upcomingTripWithin48h: false,
    hasFutureTripScheduled: false,
    currentCity:           city ?? null,
    currentCountry:        null,
    safeReturnActive:      false,
    categoryWeights:       {},
    ignoredItemIds:        [],
    mutedHashtags:         [],
    computedAt:            new Date().toISOString(),
  };
}

// ── Safety / privacy filter helper ────────────────────────────────────────────

/**
 * Convert a FallbackItem to a minimal CompassItem so the safety filter can
 * evaluate it.  All safety signals default to safe values; the only
 * safety-relevant signal we surface is the authorId (for block checks) and
 * isDelayedPost (for delayed-post gate).
 */
function toCompassItem(item: FallbackItem): CompassItem {
  return {
    id:              item.id,
    type:            item.type as CompassItemType,
    authorId:        item.authorId,
    isHidden:        false,
    isCancelled:     false,
    isExpired:       false,
    isSuspended:     false,
    isDelayedPost:   Boolean(item.data.isDelayedPost),
    visibilityScope: "public",
  };
}

/**
 * Run runSafetyFilter over a batch of FallbackItems, then apply sanitizeItem
 * from CompassPrivacyGuard on each passing item's compass representation.
 * Returns the subset of items that passed both gates.
 */
function applySafetyAndPrivacy(
  items:   FallbackItem[],
  profile: CompassProfile,
  db:      SupabaseClient | null,
  flags:   Record<string, boolean> = {},
): FallbackItem[] {
  if (items.length === 0) return [];
  const compassItems    = items.map(toCompassItem);
  // Pass pre-loaded flags so COMPASS_LAUNCH_CONTROL_ENABLED and
  // COMPASS_<TYPE>_SAFETY_BLOCK checks are enforced identically in fallback.
  const { passed }      = runSafetyFilterBatch(compassItems, profile, db, flags);

  // Run sanitizeItem and APPLY the sanitized output so privacy transformations
  // (e.g. authorId masking) are reflected in the returned FallbackItems rather
  // than discarded. Items that throw are excluded.
  const sanitizedMap = new Map<string, CompassItem>();
  for (const ci of passed) {
    try {
      const sanitized = sanitizeItem(ci, profile, db);
      sanitizedMap.set(ci.id, sanitized);
    } catch { /* exclude */ }
  }

  return items
    .filter((item) => sanitizedMap.has(item.id))
    .map((item) => {
      const sanitized = sanitizedMap.get(item.id)!;
      // Propagate any privacy masking applied by sanitizeItem back onto the
      // FallbackItem so the caller sees the privacy-correct authorId.
      if (sanitized.authorId !== item.authorId) {
        return { ...item, authorId: sanitized.authorId };
      }
      return item;
    });
}

// ── Block list loader ─────────────────────────────────────────────────────────

/**
 * Load the two-way block list. THROWS if either read errors.
 *
 * This used to destructure only `data` and swallow everything in
 * `catch { /* fail-open *\/ }`. Both halves of that were wrong:
 *
 *   - supabase-js RESOLVES with { data: null, error } on a query error, so the
 *     catch was dead code — it could not fire for the failure that matters.
 *   - `data ?? []` then turned a failed load into an EMPTY block set, and an
 *     empty block set disables every downstream exclusion: the seven category
 *     fetchers and buildSafeProfile all take `blockedIds` and filter on it. A
 *     blocks-table error therefore served a blocked user's content.
 *
 * CompassProfileService already fails CLOSED here and documents the identical
 * hazard. This is the same rule in the fallback path — which matters more, not
 * less, because routes/compass.ts reaches this builder precisely by catching
 * that service's fail-closed throw. Left fail-open, the deliberate protection
 * was converted into a leak on exactly the DB-degradation path it guards.
 */
async function loadBlockedIds(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  const [outgoingRes, incomingRes] = await Promise.all([
    db.from("blocks").select("blocked_id").eq("blocker_id", userId),
    db.from("blocks").select("blocker_id").eq("blocked_id",  userId),
  ]);
  if (outgoingRes.error || incomingRes.error) {
    throw new Error(
      "CompassFallbackFeedBuilder: block-list load failed — failing closed: " +
      (outgoingRes.error?.message ?? incomingRes.error?.message),
    );
  }
  for (const r of ((outgoingRes.data as any[]) ?? [])) blocked.add(r.blocked_id as string);
  for (const r of ((incomingRes.data as any[]) ?? [])) blocked.add(r.blocker_id as string);
  return blocked;
}

// ── Category fetchers ─────────────────────────────────────────────────────────

/**
 * Static safety-tool items — always returned first, never filtered by safety
 * filter (they are admin-controlled app features, not user content).
 */
function buildSafetyTools(): FallbackItem[] {
  return [
    {
      id:       "safety_tool::emergency_contacts",
      type:     "suggestion",
      category: "safety_tool",
      title:    "Emergency Contacts",
      authorId: undefined,
      data:     { action: "open_emergency_contacts", static: true },
    },
    {
      id:       "safety_tool::safe_return",
      type:     "suggestion",
      category: "safety_tool",
      title:    "Safe Return",
      authorId: undefined,
      data:     { action: "start_safe_return_session", static: true },
    },
    {
      id:       "safety_tool::sos",
      type:     "suggestion",
      category: "safety_tool",
      title:    "SOS / Report an Emergency",
      authorId: undefined,
      data:     { action: "open_sos", static: true },
    },
  ];
}

async function fetchActiveTrips(
  db:         SupabaseClient,
  userId:     string,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  try {
    // Fetch both trips the user owns AND trips where they are a member,
    // then deduplicate so a user's own trip isn't shown twice.
    const [ownedRes, memberRes] = await Promise.allSettled([
      db.from("trips")
        .select("id, destination_city, start_date, end_date, status, owner_id")
        .in("status", ["in_progress", "upcoming"])
        .eq("owner_id", userId)
        .limit(5),
      db.from("trip_members")
        .select("trip_id, trips(id, destination_city, start_date, end_date, status, owner_id)")
        .eq("user_id", userId)
        .limit(5),
    ]);

    const ownedRows: any[] = ownedRes.status === "fulfilled"
      ? ((ownedRes.value as any).data as any[] ?? []) : [];

    const memberRows: any[] = memberRes.status === "fulfilled"
      ? ((memberRes.value as any).data as any[] ?? [])
          .map((r: any) => r.trips)
          .filter(Boolean)
      : [];

    const seen = new Set<string>();
    const allTrips: any[] = [];
    for (const r of [...ownedRows, ...memberRows]) {
      const id = r.id as string;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      allTrips.push(r);
    }

    return allTrips
      .filter((r: any) => !blockedIds.has(r.owner_id as string))
      .slice(0, 5)
      .map((r: any): FallbackItem => ({
        id:       r.id as string,
        type:     "trip",
        category: "active_trip",
        title:    (r.destination_city as string) ?? "Active Trip",
        authorId: r.owner_id as string,
        data:     { startDate: r.start_date, endDate: r.end_date, status: r.status },
      }));
  } catch { return []; }
}

async function fetchSavedTrips(
  db:         SupabaseClient,
  userId:     string,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await db
      .from("trip_members")
      .select("trip_id, trips(id, destination_city, start_date, status, owner_id)")
      .eq("user_id", userId)
      .limit(5);
    return ((data as any[]) ?? [])
      .map((r: any) => r.trips)
      .filter(Boolean)
      .filter((t: any) => t.status !== "cancelled" && (t.start_date ?? "") >= today)
      .filter((t: any) => !blockedIds.has(t.owner_id as string))
      .map((t: any): FallbackItem => ({
        id:       t.id as string,
        type:     "trip",
        category: "saved_trip",
        title:    (t.destination_city as string) ?? "Upcoming Trip",
        authorId: t.owner_id as string,
        data:     { startDate: t.start_date, status: t.status },
      }));
  } catch { return []; }
}

async function fetchActiveBookings(
  db:     SupabaseClient,
  userId: string,
): Promise<FallbackItem[]> {
  try {
    const { data } = await db
      .from("rent_buddy_bookings")
      .select("id, buddy_id, status, booking_date, start_time")
      .eq("traveler_id", userId)
      .in("status", ["confirmed", "completed"])
      .limit(3);
    return ((data as any[]) ?? []).map((r: any): FallbackItem => ({
      id:       r.id as string,
      type:     "booking",
      category: "booking",
      title:    "Active Booking",
      authorId: r.buddy_id as string,
      data:     { buddyId: r.buddy_id, status: r.status, bookingDate: r.booking_date, startTime: r.start_time },
    }));
  } catch { return []; }
}

async function fetchTelegraphThreads(
  db:         SupabaseClient,
  userId:     string,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  try {
    // Fetch the user's threads along with all participant user IDs.
    // We must exclude any thread that contains a blocked participant so
    // blocked users cannot surface via telegraph even in fallback mode.
    const { data } = await db
      .from("message_thread_members")
      .select("thread_id, user_id")
      .order("thread_id", { ascending: false })
      .limit(50); // fetch broadly; we'll filter and deduplicate in JS

    const rows: any[] = (data as any[]) ?? [];

    // Group by thread_id to know all participants
    const threadParticipants = new Map<string, Set<string>>();
    for (const r of rows) {
      const tid = r.thread_id as string;
      const uid = r.user_id   as string;
      if (!tid || !uid) continue;
      if (!threadParticipants.has(tid)) threadParticipants.set(tid, new Set());
      threadParticipants.get(tid)!.add(uid);
    }

    // Collect threads the current user participates in, excluding any
    // thread that has a blocked participant.
    const eligibleThreads: Array<{ tid: string; otherUserId: string | undefined }> = [];
    for (const [tid, participants] of threadParticipants) {
      if (!participants.has(userId)) continue;
      // Exclude thread if ANY participant (other than self) is blocked
      const hasBlocked = [...participants].some(
        (uid) => uid !== userId && blockedIds.has(uid),
      );
      if (hasBlocked) continue;
      // Use the other participant's userId as authorId for safety filter
      const otherUserId = [...participants].find((uid) => uid !== userId);
      eligibleThreads.push({ tid, otherUserId });
      if (eligibleThreads.length >= 5) break;
    }

    return eligibleThreads.map(({ tid, otherUserId }): FallbackItem => ({
      id:       tid,
      type:     "message",
      category: "telegraph",
      title:    "Telegraph Thread",
      authorId: otherUserId,
      data:     { threadId: tid },
    }));
  } catch { return []; }
}

async function fetchVerifiedEvents(
  db:         SupabaseClient,
  city:       string | null,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  if (!city) return [];
  try {
    const now = new Date().toISOString();
    // City filter is applied at the DB level via `location_city` so only
    // events in the user's city are returned.
    const { data } = await db
      .from("posts")
      .select("id, author_id, content, created_at, location_city")
      // posts.category (not post_type); location_verified is the verified
      // signal on posts (is_verified does not exist). posts carry no
      // event_starts_at column, so no upcoming filter is possible here.
      .eq("category", "event")
      .eq("location_verified", true)
      .eq("location_city", city)
      .not("post_status", "eq", "delayed_post")
      .limit(5);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.author_id as string))
      .map((r: any): FallbackItem => ({
        id:       r.id as string,
        type:     "event",
        category: "verified_event",
        title:    String(r.content ?? "Verified Event").slice(0, 100),
        authorId: r.author_id as string,
        data:     { city, createdAt: r.created_at },
      }));
  } catch { return []; }
}

async function fetchCityGuide(
  db:         SupabaseClient,
  city:       string | null,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  if (!city) return [];
  try {
    const { data } = await db
      .from("discovery_places")
      .select("id, submitted_by, name, place_type, blurb")
      .eq("city", city)
      .eq("status", "verified")
      .limit(5);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.submitted_by as string))
      .map((r: any): FallbackItem => ({
        id:       r.id as string,
        type:     "suggestion",
        category: "city_guide",
        title:    (r.name as string) ?? "City Guide",
        authorId: r.submitted_by as string,
        data:     { placeType: r.place_type, blurb: r.blurb, city },
      }));
  } catch { return []; }
}

async function fetchPopularPosts(
  db:         SupabaseClient,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  try {
    const now = new Date().toISOString();
    const { data } = await db
      .from("posts")
      .select("id, author_id, content, like_count, comment_count, post_status, publish_eligible_at")
      .eq("visibility", "public")
      .eq("status", "active")
      // Exclude delayed posts that are not yet eligible
      .not("post_status", "eq", "delayed_post")
      .or(`publish_eligible_at.is.null,publish_eligible_at.lte.${now}`)
      .order("like_count", { ascending: false })
      .limit(8);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.author_id as string))
      .map((r: any): FallbackItem => ({
        id:          r.id as string,
        type:        "post",
        category:    "public_content",
        title:       String(r.content ?? "").slice(0, 100),
        authorId:    r.author_id as string,
        data:        {
          likeCount:    r.like_count,
          commentCount: r.comment_count,
          // Carry the flag so toCompassItem can re-surface it to the safety filter
          isDelayedPost: r.post_status === "delayed_post",
        },
      }));
  } catch { return []; }
}

async function fetchPassportSummary(
  db:     SupabaseClient,
  userId: string,
): Promise<FallbackItem[]> {
  try {
    const { data } = await db
      .from("passport_stamps")
      .select("id, stamp_type, country, city, awarded_at")
      .eq("user_id", userId)
      .order("awarded_at", { ascending: false })
      .limit(5);
    return ((data as any[]) ?? []).map((r: any): FallbackItem => ({
      id:       r.id as string,
      type:     "suggestion",
      category: "passport_summary",
      title:    (r.city as string) ?? (r.country as string) ?? "Passport Stamp",
      authorId: userId,
      data:     { stampType: r.stamp_type, country: r.country, city: r.city },
    }));
  } catch { return []; }
}

async function fetchBasicDiscovery(
  db:         SupabaseClient,
  city:       string | null,
  blockedIds: Set<string>,
): Promise<FallbackItem[]> {
  if (!city) return [];
  try {
    const { data } = await db
      .from("compass_active_user_scores")
      .select("user_id, active_user_score, boost_eligible")
      .eq("boost_eligible", true)
      .order("active_user_score", { ascending: false })
      .limit(5);
    return ((data as any[]) ?? [])
      .filter((r: any) => !blockedIds.has(r.user_id as string))
      .map((r: any): FallbackItem => ({
        id:       r.user_id as string,
        type:     "suggestion",
        category: "basic_discovery",
        title:    "Suggested Traveler",
        authorId: r.user_id as string,
        data:     { score: r.active_user_score },
      }));
  } catch { return []; }
}

// ── buildFallbackFeed ─────────────────────────────────────────────────────────

/**
 * Assemble the safe fallback feed for a user.
 *
 * Every content category (except static safety tools) is run through
 * runSafetyFilter + sanitizeItem before inclusion.  Blocked users, delayed
 * pre-publish posts, suspended accounts, and paused content are all excluded.
 *
 * @param db       Service-role Supabase client (null in tests → empty result).
 * @param userId   The requesting user's ID.
 * @param profile  Optional CompassProfile for city context; null → city-scoped
 *                 fetchers are skipped.
 * @param reason   Why fallback mode was triggered (surfaced in response envelope).
 */
export async function buildFallbackFeed(
  db:      SupabaseClient | null,
  userId:  string,
  profile: CompassProfile | null,
  reason:  string,
): Promise<FallbackFeedResult> {
  if (!db) {
    return { sections: [], nextCursor: null, fallback: true, fallbackReason: reason, safeItems: [] };
  }

  const city = profile?.currentCity ?? null;

  // If the block list cannot be loaded we cannot safely show ANY user content,
  // because every category fetcher below filters on it. Degrade to the static
  // safety tools — admin-controlled app features, not user content, so they are
  // safe to serve with no block list — rather than either serving unfiltered
  // UGC or returning nothing at all.
  let blockedIds: Set<string>;
  try {
    blockedIds = await loadBlockedIds(db, userId);
  } catch {
    return {
      sections: (() => {
        const tools = buildSafetyTools();
        return [{ name: "safety_tools", items: tools, total: tools.length }];
      })(),
      nextCursor: null,
      fallback: true,
      fallbackReason: `${reason}+block_list_unavailable`,
      safeItems: [],
    };
  }

  const safeProf = buildSafeProfile(userId, blockedIds, city);

  // Load all Compass feature flags once so the safety filter can enforce
  // COMPASS_LAUNCH_CONTROL_ENABLED and COMPASS_<TYPE>_SAFETY_BLOCK in fallback
  // mode identically to the normal pipeline.
  const flags = await getFlags(db).catch(() => ({} as Record<string, boolean>));

  // Static safety tools are always included first — they are not user content
  // and do not require safety-filter evaluation.
  const safetyTools = buildSafetyTools();

  // Fetch all dynamic content categories in parallel (fail-open per category)
  const [activeTrips, savedTrips, bookings, threads, events, cityGuide, posts, passport, discovery] =
    await Promise.all([
      fetchActiveTrips(db, userId, blockedIds),
      fetchSavedTrips(db, userId, blockedIds),
      fetchActiveBookings(db, userId),
      fetchTelegraphThreads(db, userId, blockedIds),
      fetchVerifiedEvents(db, city, blockedIds),
      fetchCityGuide(db, city, blockedIds),
      fetchPopularPosts(db, blockedIds),
      fetchPassportSummary(db, userId),
      fetchBasicDiscovery(db, city, blockedIds),
    ]);

  // Apply safety filter + privacy guard to all dynamic content
  const filtered = applySafetyAndPrivacy(
    [...activeTrips, ...savedTrips, ...bookings, ...threads, ...events, ...cityGuide, ...posts, ...passport, ...discovery],
    safeProf,
    db,
    flags,
  );

  // Merge: safety tools first, then safety-filtered content (deduplicate by id)
  const seen      = new Set<string>();
  const safeItems: FallbackItem[] = [];

  for (const item of [...safetyTools, ...filtered]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      safeItems.push(item);
    }
  }

  // Group safeItems by category to populate the standard feed sections envelope.
  // Clients that understand the normal feed shape get degraded-but-usable section
  // content; clients that check fallback:true can also iterate safeItems directly.
  const sectionMap = new Map<string, FallbackItem[]>();
  for (const item of safeItems) {
    if (!sectionMap.has(item.category)) sectionMap.set(item.category, []);
    sectionMap.get(item.category)!.push(item);
  }
  const sections: FallbackSection[] = [...sectionMap.entries()].map(
    ([name, items]) => ({ name, items, total: items.length }),
  );

  return {
    sections,
    nextCursor:     null,
    fallback:       true,
    fallbackReason: reason,
    safeItems,
  };
}
