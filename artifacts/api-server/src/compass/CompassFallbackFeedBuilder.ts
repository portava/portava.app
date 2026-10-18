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
import { isPostPublished }                                   from "../lib/postVisibility.js"; import { readBlockDirections, readMuteExclusions } from "../lib/exclusionSet.js"; // census-telegraph T220 (+T220c: mutes); on this line so no cited line moves
import { loadBoostLiftWithheld }                             from "./CompassFeedBuilder.js"; import { acceptedTripRows, acceptedMemberTrips } from "./CompassCurrentTrip.js"; import { buildTripCompassOwnedTripsProjection, type TripCompassTripSummary } from "../domain/trips/projections/TripCompassTripSummaryProjection.js"; import { buildTripCompassMemberTripsProjection } from "../domain/trips/projections/TripCompassMembershipProjection.js"; // CT-02

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
  city:       string | null, mutedIds: Set<string> = new Set(),  // census-compass §35: the viewer's mutes, so the safety filter's mute rule can fire in fallback
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
    mutedUserIds:          [...mutedIds],  // census-compass §35: was `[]` — a muted author was served by every fallback feed
    blockCount:            blockedArr.length,
    blockerCount:          0,
    trustScore:            null,
    trustLevel:            null,
    activeUserScore:       null,
    hasActiveTrip:         false,
    // This profile is SYNTHESISED, not read: no trip read happened, so there is
    // no unread trip read to report. The safe profile exists precisely because
    // the real one could not be built.
    tripStateUnread:       false,
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
  // census-telegraph T220: both directions through the shared reader, readBlockDirections —
  // each read WHOLE by key (one range-less read per direction was cut at db-max-rows, and
  // the blocks past the cut were served here) — and EVERY failure (a returned error, a
  // thrown read, an answer that is not a row list, a row naming nobody) is `ok: false`.
  const blocks = await readBlockDirections(db, userId);
  if (!blocks.ok) {
    throw new Error(
      "CompassFallbackFeedBuilder: block-list load failed — failing closed: " +
      blocks.reason,
    );
  }
  // The same throw, so buildFallbackFeed degrades to the safety tools as it always did;
  // and a block either way hides the person here: the union of the two directions.
  return new Set<string>(blocks.ids);
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

/**
 * The two trip fetchers report UNREADABILITY rather than swallowing it, the
 * same way `buildFallbackFeed` already reports an unreadable block or mute list
 * through `fallbackReason`. Returning `[]` for both "you have no trips" and
 * "your trips could not be read" is the defect: the fallback feed exists for
 * the degraded case, so it is the last surface that may present a degradation
 * as an absence.
 */
interface TripSection { items: FallbackItem[]; unread: boolean }

async function fetchActiveTrips(
  db:         SupabaseClient,
  userId:     string,
  blockedIds: Set<string>,
): Promise<TripSection> {
  try {
    // Both trips the user owns AND trips where they are a member, then
    // deduplicated so a user's own trip isn't shown twice.
    //
    // census-compass CT-02: both halves are Trips projections now, not raw reads.
    // The owned half is the trip-row projection with this section's predicate
    // (`active` / `upcoming`, CompassSocialEngine's pair; `in_progress` is not a
    // `trip_status` label and once made PostgREST reject this read 22P02), capped
    // at five. The member half is the member-trips projection — the membership
    // rows joined to their trips, unfiltered by role or status and capped at five
    // rows, exactly the join this function issued itself.
    const [ownedRes, memberRes] = await Promise.allSettled([
      buildTripCompassOwnedTripsProjection(db, userId, { statuses: ["active", "upcoming"], limit: 5 }),
      buildTripCompassMemberTripsProjection(db, userId, { limit: 5 }),
    ]);

    // The master read rule. A PostgREST failure RESOLVES as `{ data: null, error }`,
    // and `.data ?? []` once turned "the trips could not be read" into "this user
    // has no trips": the fallback feed — the surface that exists FOR the degraded
    // case — quietly dropped the user's own trip. A half is now unread when its
    // projection is unavailable (an error, a non-array body, a malformed row) OR
    // any §19.1 envelope in it is refused; a fallback that degrades silently is a
    // fallback with no floor.
    const owned = ownedRes.status === "fulfilled" ? acceptedTripRows(ownedRes.value) : null;
    const member = memberRes.status === "fulfilled" ? acceptedMemberTrips(memberRes.value) : null;
    const ownedErr = owned === null;
    const memberErr = member === null;
    if (ownedErr && memberErr) return { items: [], unread: true };

    const ownedRows: TripCompassTripSummary[] = owned ?? [];

    // A membership row whose join served no trip contributes nothing, as before.
    const memberRows: TripCompassTripSummary[] = (member ?? [])
      .map((m) => m.trip)
      .filter((t): t is TripCompassTripSummary => t !== null);

    const seen = new Set<string>();
    const allTrips: TripCompassTripSummary[] = [];
    for (const r of [...ownedRows, ...memberRows]) {
      const id = r.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      allTrips.push(r);
    }

    return {
      // Partially unread (one of the two halves failed) is still unread: the
      // list below is missing trips and nothing in it says so.
      unread: Boolean(ownedErr || memberErr),
      items: allTrips
        .filter((r) => !blockedIds.has(r.ownerId as string))
        .slice(0, 5)
        .map((r): FallbackItem => ({
          id:       r.id,
          type:     "trip",
          category: "active_trip",
          title:    r.destinationCity ?? "Active Trip",
          authorId: r.ownerId as string,
          data:     { startDate: r.startDate, endDate: r.endDate, status: r.status },
        })),
    };
    // (The projections settle their own read failures; this catch is for the
    // shaping above, and it is unread, never empty.)
  } catch { return { items: [], unread: true }; }
}

async function fetchSavedTrips(
  db:         SupabaseClient,
  userId:     string,
  blockedIds: Set<string>,
): Promise<TripSection> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // census-compass CT-02: the membership rows joined to their trips come from
    // Trips' member-trips projection — the same unfiltered, five-row join this
    // function issued itself — not a raw `trip_members` read.
    const member = acceptedMemberTrips(await buildTripCompassMemberTripsProjection(db, userId, { limit: 5 }));
    // supabase-js RESOLVES on a database error, so an unreadable membership table
    // once returned `[]` — no saved trips — with nothing distinguishing it from a
    // user who has none. An unavailable projection, or a refused §19.1 envelope,
    // is unread here.
    if (member === null) return { items: [], unread: true };
    // A readable list is filtered here: not cancelled, starting today or later.
    return {
      unread: false,
      items: member
        .map((m) => m.trip)
        .filter((t): t is TripCompassTripSummary => t !== null)
        .filter((t) => t.status !== "cancelled" && (t.startDate ?? "") >= today)
        .filter((t) => !blockedIds.has(t.ownerId as string))
        .map((t): FallbackItem => ({
          id:       t.id,
          type:     "trip",
          category: "saved_trip",
          title:    t.destinationCity ?? "Upcoming Trip",
          authorId: t.ownerId as string,
          data:     { startDate: t.startDate, status: t.status },
        })),
    };
  } catch { return { items: [], unread: true }; }
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
    // Delayed-publish gate (§23/§37). This query used to say
    // `.not("post_status", "eq", "delayed_post")` — the same dead literal
    // fetchPopularPosts carried below. `delayed_post` is not a label of the
    // `delayed_post_status` enum that types posts.post_status (the labels are
    // draft / private / pending_location_exit / pending_delay /
    // pending_safety_review / published / canceled / expired, migration 0049),
    // so PostgREST could never match it: at best the filter excluded nothing
    // and this lane served pending posts, at worst the read failed 22P02 and
    // the best-effort catch below swallowed it. Either way there was no gate.
    //
    // This lane is keyed on `location_city` and the row it emits is titled with
    // the post's own body, so an ungated read announces "this person is in this
    // city right now" — precisely what a delayed geotag withholds.
    const { data } = await db
      .from("posts")
      .select("id, author_id, content, created_at, location_city, post_status")
      // posts.category (not post_type); location_verified is the verified
      // signal on posts (is_verified does not exist). posts carry no
      // event_starts_at column, so no upcoming filter is possible here.
      .eq("category", "event")
      .eq("location_verified", true)
      .eq("location_city", city)
      .eq("post_status", "published")
      .limit(5);
    return ((data as any[]) ?? [])
      // In-memory re-check of the same canonical predicate, as every other
      // serving surface does: a row fed past the query filter must still never
      // be served. Unlike fetchPopularPosts these items are typed "event", so
      // CompassSafetyFilter's delayed-post gate (which only inspects posts)
      // is not a second layer here — this filter is the last one.
      .filter((r: any) => isPostPublished(r))
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
    // Delayed-publish gate (§23/§37). This query used to say
    // `.not("post_status", "eq", "delayed_post")`. `delayed_post` is not a label
    // of the `delayed_post_status` enum that types posts.post_status — the
    // labels are draft / private / pending_location_exit / pending_delay /
    // pending_safety_review / published / canceled / expired (migration 0049) —
    // so PostgREST could never match it: at best the filter excluded nothing,
    // at worst the whole read failed 22P02 (invalid input value for enum) and
    // this best-effort catch swallowed it, making the popular-posts lane return
    // nothing at all. Either way the gate it was written to be did not exist.
    //
    // The eligibility-clock `or` is gone with it: post_status is the authority
    // on publication (the sweeper that sets it applies the safety-review hold
    // and the manual-release path), and a manually released post keeps a future
    // publish_eligible_at, which that clause would have wrongly excluded.
    const { data } = await db
      .from("posts")
      .select("id, author_id, content, like_count, comment_count, post_status, publish_eligible_at")
      .eq("visibility", "public")
      .eq("status", "active")
      .eq("post_status", "published")
      .order("like_count", { ascending: false })
      .limit(8);
    return ((data as any[]) ?? [])
      // No in-memory publish filter here on purpose: this module's second layer
      // IS the safety filter, and `isDelayedPost` below is what feeds it. A row
      // fed past the query predicate is refused there, so duplicating the check
      // in this map would only make one of the two guards unfalsifiable.
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
          // Carry the flag so toCompassItem can re-surface it to the safety
          // filter. Same dead literal as the query filter above: this compared
          // against `delayed_post`, which no row can hold, so the downstream
          // delayed-post gate in CompassSafetyFilter never saw a true value.
          isDelayedPost: !isPostPublished(r),
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
    const rows = ((data as any[]) ?? []).filter((r: any) => !blockedIds.has(r.user_id as string));
    // Lead ruling D-24c (2026-10-06): these people are surfaced BECAUSE their
    // boost is on (`boost_eligible` needs the boost preference). Under an active
    // messaging restriction — or when that state cannot be read — that lift is
    // withheld here exactly as on the main feed; the preference itself is kept.
    const withheld = await loadBoostLiftWithheld(db, rows.map((r: any) => r.user_id as string));
    return rows
      .filter((r: any) => !withheld.has(r.user_id as string))
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
  let blockedIds: Set<string>; let mutedIds: Set<string>;  // census-compass §35: the mute list is the second half of the hidden set, read and failed closed with the blocks
  try {
    [blockedIds, mutedIds] = await Promise.all([loadBlockedIds(db, userId), loadMutedIds(db, userId)]);
  } catch (hiddenErr) {
    return {
      sections: (() => {
        const tools = buildSafetyTools();
        return [{ name: "safety_tools", items: tools, total: tools.length }];
      })(),
      nextCursor: null,
      fallback: true,
      fallbackReason: `${reason}+${hiddenErr instanceof MuteListUnavailableError ? "mute_list_unavailable" : "block_list_unavailable"}`,  // census-compass §35: says WHICH list could not be read
      safeItems: [],
    };
  }

  const safeProf = buildSafeProfile(userId, blockedIds, city, mutedIds);

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
    [...activeTrips.items, ...savedTrips.items, ...bookings, ...threads, ...events, ...cityGuide, ...posts, ...passport, ...discovery],
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

  // The trip sources say when they could not be read, through the same
  // `fallbackReason` suffix device the block/mute refusal above already uses
  // (`${reason}+block_list_unavailable`). Without it an unreadable
  // `trip_members` produced a feed with no `active_trip` section and nothing
  // anywhere distinguishing that from a traveller who is on no trip — on the
  // surface whose entire job is to be honest about degradation.
  const tripsUnread = activeTrips.unread || savedTrips.unread;

  return {
    sections,
    nextCursor:     null,
    fallback:       true,
    fallbackReason: tripsUnread ? `${reason}+trip_sources_unavailable` : reason,
    safeItems,
  };
}

// ── Mute list loader (census-compass §35) ─────────────────────────────────────

/**
 * Thrown by loadMutedIds when `user_mutes` cannot be read, so the fallback's
 * refusal can say which half of the hidden set was unreadable.
 */
class MuteListUnavailableError extends Error {}

/**
 * Load the ids the viewer has MUTED. THROWS if the list cannot be read — any failure (T220c).
 *
 * This builder is reached by catching getCompassProfile's throw, and a failed
 * `user_mutes` read is one of the reads that makes it throw. The fallback then
 * read only `blocks` and handed the safety filter `mutedUserIds: []`, so the
 * filter's mute rule (CompassSafetyFilter, "author_muted_by_viewer") could not
 * fire: a failed mute read served the muted author's posts, events, city-guide
 * entries and threads. With COMPASS_FALLBACK_MODE_ENABLED on it did the same
 * over a HEALTHY read. The rule here is loadBlockedIds' rule: a list that
 * cannot be read degrades the feed to the static safety tools, never to an
 * empty ("nobody is muted") list.
 */
async function loadMutedIds(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const read = await readMuteExclusions(db, userId); // census-telegraph T220c: whole, by key; never rejects — a returned error, a thrown read, a non-list answer and a row naming nobody are each !ok
  if (!read.ok) {
    throw new MuteListUnavailableError("CompassFallbackFeedBuilder: mute-list load failed — failing closed: " + read.reason);
  }
  return new Set(read.ids); // (`data ?? []` read a non-list answer as "nobody muted"; a thrown read was named block_list_unavailable)
}
