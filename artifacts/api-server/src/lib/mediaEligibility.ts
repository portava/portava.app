/**
 * mediaEligibility — content eligibility filter for the Watch mode media feed.
 *
 * filterEligibleMediaCandidates enforces ALL eligibility gates BEFORE any
 * scoring occurs. Gates (in order):
 *   1. Blocks — bidirectional fail-closed
 *   2. Mutes — viewer muted the creator
 *   3. Creator account status — suspended/banned creators excluded
 *   4. Post status — only active posts
 *   5. Delayed-publish gate — post_status must be 'published' (or absent)
 *   6. Delayed-post publish_at gate — publish_at must be <= now() when set
 *   7. Visibility — public only (for_you) or followed-creator (following)
 *   8. Moderation gate — must be 'approved' (or null/unset for unmoderated content)
 *   9. Story expiration — expired stories excluded
 *  10. Media readiness gate — at least one ready, unrejected media row
 *  11. Geo-restriction gate — best-effort viewer country check
 *  12. Age-restriction gate — best-effort viewer age check
 *
 * Fail-closed: if blocks cannot be fetched, return empty (never risk surfacing
 * content from blocked users).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type FeedType = "for_you" | "following";

/**
 * Moderation states that count as DISTRIBUTABLE.
 *
 *   'approved' — the legacy shipped state on posts / post_media / media_assets.
 *   'active'   — the canonical §36 MediaModerationStatus promoted state.
 *
 * Media v2 Phase 1 reconciles media_assets.moderation_status onto the §36
 * vocabulary (migration 2250), where the promoted/distributable state is
 * 'active' rather than 'approved'. Both are admitted here so that neither
 * legacy rows (moderation_status='approved') NOR canonical rows
 * (moderation_status='active') can be silently dropped by the distribution
 * gate when the canonical read path is eventually lit — the failure mode the
 * media audits called out. Every OTHER moderation value
 * (pending / processing / flagged / limited / rejected / removed /
 * owner_deleted) stays excluded, and a null/absent value is unmoderated and
 * passes, exactly as before.
 */
export const DISTRIBUTABLE_MODERATION_STATES: ReadonlySet<string> = new Set(["approved", "active"]);

export interface ViewerCtx {
  viewerUserId: string;
  feedType: FeedType;
  /** IDs the viewer follows — required when feedType='following'. */
  followedCreatorIds: Set<string>;
  /**
   * Viewer's ISO-3166-1 alpha-2 country code — used for geo-restriction
   * enforcement. Omit when unknown; items with geo_restriction will be
   * excluded for safety.
   */
  viewerCountry?: string | null;
  /**
   * Viewer's age in full years — used for age-restriction enforcement.
   * Omit when unknown; items with age_restriction_enabled will be excluded
   * for safety.
   */
  viewerAge?: number | null;
  /**
   * Trips the viewer belongs to (as member or owner) — required to admit
   * trip_only items on the following feed. Load with loadViewerTripIds.
   * Omit or leave empty and every trip_only item is excluded, which is the
   * safe direction: following someone is not membership of their trip.
   */
  viewerTripIds?: Set<string>;
}

export interface EligibilityResult {
  eligible: MediaCandidate[];
  /**
   * True when a HARD GATE could not be evaluated — blocks (step 1) or
   * suspended/banned account status (step 3). Caller must treat as an empty
   * feed: an unevaluated hard gate means we cannot prove the page is safe to
   * serve, and both gates decide integrity outcomes rather than preferences.
   *
   * Mutes are deliberately NOT a hard gate. Losing the mute filter costs the
   * viewer a preference; losing blocks or the suspended/banned filter serves
   * content the platform has already decided must not be served.
   *
   * The name is narrower than the meaning and is kept only so that the four
   * call sites — in files owned by a concurrent workstream — do not have to be
   * touched to widen it. `gateFetchFailed` is the honest name; renaming it is
   * follow-up work, not a behaviour question.
   */
  blockFetchFailed: boolean;
}

/** Minimal shape of a candidate row from the DB. */
export interface MediaCandidate {
  id: string;
  author_id: string;
  status?: string;
  post_status?: string;
  visibility?: string;
  moderation_status?: string;
  expires_at?: string | null;
  /** Scheduled publish time — when set and in the future, item is suppressed. */
  publish_at?: string | null;
  created_at: string;
  /** post_media child rows (pre-fetched). */
  post_media?: any[];
  /** Creator profile row (pre-fetched). */
  profiles?: any;
  /** Raw tags array. */
  tags?: string[];
  /**
   * Geo-restriction: comma-separated list of ISO-3166-1 alpha-2 country codes
   * that are ALLOWED to see this item.  Null/absent = no restriction.
   */
  geo_restriction?: string | null;
  /**
   * When true the item has an age restriction.  The companion age_min /
   * age_max columns specify the allowed range.
   */
  age_restriction_enabled?: boolean | null;
  age_min?: number | null;
  age_max?: number | null;
  /**
   * Owning trip for trip_only items. Absent/null on a trip_only item means
   * there is no trip to check membership against, so the item is excluded.
   */
  trip_id?: string | null;
  [key: string]: unknown;
}

/**
 * Filter a raw list of candidates down to eligible items.
 *
 * @param candidates — raw DB rows to filter
 * @param viewerCtx — viewer context including feedType and followed ids
 * @param sc — Supabase service client (for blocks + mutes lookup)
 * @param mutedCreatorIds — optional pre-fetched muted set (pass null to load from DB)
 */
export async function filterEligibleMediaCandidates(
  candidates: MediaCandidate[],
  viewerCtx: ViewerCtx,
  sc: SupabaseClient,
  mutedCreatorIds?: Set<string> | null,
): Promise<EligibilityResult> {
  if (candidates.length === 0) {
    return { eligible: [], blockFetchFailed: false };
  }

  // ── Step 1: Blocks (fail-closed) ───────────────────────────────────────────
  let blockFetchFailed = false;
  const blockedSet = new Set<string>();
  try {
    const [blockedRes, blockerRes] = await Promise.all([
      sc.from("blocks").select("blocked_id").eq("blocker_id", viewerCtx.viewerUserId),
      sc.from("blocks").select("blocker_id").eq("blocked_id", viewerCtx.viewerUserId),
    ]);
    if (blockedRes.error || blockerRes.error) {
      blockFetchFailed = true;
    } else {
      for (const r of (blockedRes.data as any[]) ?? []) blockedSet.add(r.blocked_id as string);
      for (const r of (blockerRes.data as any[]) ?? []) blockedSet.add(r.blocker_id as string);
    }
  } catch {
    blockFetchFailed = true;
  }

  if (blockFetchFailed) {
    return { eligible: [], blockFetchFailed: true };
  }

  // ── Step 2: Mutes ──────────────────────────────────────────────────────────
  let muteSet = mutedCreatorIds ?? new Set<string>();
  if (mutedCreatorIds === null || mutedCreatorIds === undefined) {
    try {
      const { data: muteRows, error: muteErr } = await sc
        .from("user_mutes")
        .select("muted_id")
        .eq("muter_id", viewerCtx.viewerUserId);
      // "No mutes" and "the mute query was rejected" both leave muteSet empty,
      // and the difference is the whole gate: on a schema/query error every
      // muted creator's media becomes eligible again. PostgREST returns such
      // errors in `error` rather than throwing, so the catch below never sees
      // them — bind and log, or the failure is invisible.
      if (muteErr) {
        console.warn(
          "filterEligibleMediaCandidates: user_mutes read failed — mute gate is OFF for this request",
          { viewerUserId: viewerCtx.viewerUserId, code: (muteErr as any)?.code, message: (muteErr as any)?.message },
        );
      }
      for (const r of (muteRows as any[]) ?? []) muteSet.add(r.muted_id as string);
    } catch (err) {
      console.warn(
        "filterEligibleMediaCandidates: user_mutes read rejected — mute gate is OFF for this request",
        { viewerUserId: viewerCtx.viewerUserId, err },
      );
    }
  }

  // ── Step 3: Collect unique creator ids to check account status ────────────
  const creatorIds = [...new Set(candidates.map((c) => c.author_id))];
  const suspendedCreatorIds = new Set<string>();
  if (creatorIds.length > 0) {
    try {
      const { data: profileRows, error: statusErr } = await sc
        .from("profiles")
        .select("id, account_status")
        .in("id", creatorIds)
        .in("account_status", ["suspended", "banned"]);
      // Same shape as the mute read above, with a heavier consequence: an empty
      // result means "nobody on this page is suspended", and a rejected query
      // means "we do not know" — indistinguishable here, so a schema/query
      // error would silently serve suspended and banned creators' media.
      //
      // The 2026-08-31 audit made this failure visible but left it best-effort,
      // and recorded the asymmetry it could not resolve from inside an audit:
      // step 1 of THIS function treats an unknown block state as fail-closed and
      // returns an empty feed, while this read served the page anyway. Both are
      // integrity gates and serving a banned creator's media is the same
      // category of harm, so the asymmetry was a gap rather than a decision.
      // It is now closed in the direction step 1 already set.
      if (statusErr) {
        console.warn(
          "filterEligibleMediaCandidates: profiles account_status read failed — suspended/banned gate could not be evaluated, failing closed to an empty feed",
          { creatorCount: creatorIds.length, code: (statusErr as any)?.code, message: (statusErr as any)?.message },
        );
        return { eligible: [], blockFetchFailed: true };
      }
      for (const r of (profileRows as any[]) ?? []) {
        suspendedCreatorIds.add(r.id as string);
      }
    } catch (err) {
      console.warn(
        "filterEligibleMediaCandidates: profiles account_status read rejected — suspended/banned gate could not be evaluated, failing closed to an empty feed",
        { creatorCount: creatorIds.length, err },
      );
      return { eligible: [], blockFetchFailed: true };
    }
  }

  // ── Step 4: Per-item eligibility gates ────────────────────────────────────
  const now = Date.now();
  const eligible = candidates.filter((c) => {
    const authorId = c.author_id;

    // Block gate
    if (blockedSet.has(authorId)) return false;

    // Mute gate
    if (muteSet.has(authorId)) return false;

    // Creator suspension gate
    if (suspendedCreatorIds.has(authorId)) return false;

    // Post/story status gate
    const status = c.status ?? "active";
    if (status !== "active") return false;

    // Delayed-publish gate: post_status must be published (or null for non-delayed posts)
    const postStatus = c.post_status;
    if (postStatus && postStatus !== "published") return false;

    // publish_at gate: if set, must be <= now (delayed post not yet due)
    if (c.publish_at) {
      const publishAt = new Date(c.publish_at).getTime();
      if (publishAt > now) return false;
    }

    // Visibility gate
    const visibility = c.visibility ?? "public";
    if (viewerCtx.feedType === "following") {
      // Following feed: creator must be followed OR be the viewer themselves
      if (authorId !== viewerCtx.viewerUserId && !viewerCtx.followedCreatorIds.has(authorId)) {
        return false;
      }
      // A follow is NOT consent to private posts and is NOT membership of the
      // author's trip. This branch used to stop at the follow check and never
      // read `visibility` at all, so a single follow admitted both trip_only
      // and private items into the Watch and grid feeds. The viewer's own
      // items are exempt — they are always allowed to see what they posted.
      if (authorId !== viewerCtx.viewerUserId) {
        if (visibility === "private") return false;
        if (visibility === "trip_only") {
          // Fail closed on either missing piece: an item with no trip_id has
          // nothing to check membership against, and an absent viewerTripIds
          // means the caller never loaded it (or both reads failed).
          const tripId = c.trip_id;
          if (!tripId) return false;
          if (!viewerCtx.viewerTripIds?.has(tripId)) return false;
        }
      }
    } else {
      // For-you feed: only public items
      if (visibility !== "public") return false;
    }

    // Moderation gate: must be a DISTRIBUTABLE state ('approved' legacy OR
    // 'active' canonical §36), or unmoderated (null/absent). Items with any
    // other moderation status (pending, processing, flagged, limited, rejected,
    // removed, owner_deleted, …) are excluded.
    const modStatus = c.moderation_status;
    if (modStatus && !DISTRIBUTABLE_MODERATION_STATES.has(modStatus)) return false;

    // Expiration gate (for stories)
    if (c.expires_at) {
      const expiresAt = new Date(c.expires_at).getTime();
      if (expiresAt <= now) return false;
    }

    // Media readiness gate: item must have at least one ready, unrejected media row
    const rawMedia = c.post_media ?? [];
    if (rawMedia.length === 0) {
      // No media attached — skip (Watch mode requires media)
      return false;
    }
    const readyMedia = rawMedia.filter(
      (m: any) =>
        m.processing_status === "ready" &&
        m.moderation_status !== "rejected" &&
        m.moderation_status !== "flagged",
    );
    if (readyMedia.length === 0) return false;

    // Geo-restriction gate: when present, viewer's country must be in the allow-list.
    // Fail-closed: if geo_restriction is set and viewer country is unknown, exclude.
    if (c.geo_restriction) {
      const allowedCountries = (c.geo_restriction as string)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (allowedCountries.length > 0) {
        if (!viewerCtx.viewerCountry) return false;
        if (!allowedCountries.includes(viewerCtx.viewerCountry.toUpperCase())) return false;
      }
    }

    // Age-restriction gate: when enabled, viewer's age must be within [age_min, age_max].
    // Fail-closed: if age_restriction_enabled is true and viewer age is unknown, exclude.
    if (c.age_restriction_enabled) {
      if (viewerCtx.viewerAge == null) return false;
      const ageMin = c.age_min ?? 0;
      const ageMax = c.age_max ?? Number.MAX_SAFE_INTEGER;
      if (viewerCtx.viewerAge < ageMin || viewerCtx.viewerAge > ageMax) return false;
    }

    return true;
  });

  return { eligible, blockFetchFailed: false };
}

/** Trip roles that count as genuine membership. Mirrors circleAccessGuard. */
const ACCEPTED_TRIP_ROLES = ["owner", "co_host", "member", "viewer"];

/**
 * Load the set of trip ids the viewer may see trip_only content for — trips
 * they are an accepted member of, unioned with trips they own.
 *
 * ## Why allSettled, and why each result is admitted independently
 *
 * These are two separate grants: membership OR ownership is sufficient on its
 * own. `Promise.all` inside one try/catch would couple them — it rejects on the
 * first rejection, so a failure of the rarer ownership read would discard an
 * already-successful membership result and drop every trip_only post for every
 * genuine accepted member. That turns a partial outage of one query into a
 * silent content blackout for the majority case.
 *
 * So each read is admitted on its own merits, and a read counts as failed in
 * BOTH of the ways it can actually fail: the promise rejecting (network/client
 * throw) and the resolved `{ data, error }` tuple carrying an error, which is
 * what postgrest actually produces for a query error — it resolves, it does not
 * reject. Checking only one of those would let the other pass silently.
 *
 * Only a DOUBLE failure yields an empty set, which fails closed: callers treat
 * an empty set as "no trip_only content admitted".
 */
export async function loadViewerTripIds(
  sc: SupabaseClient,
  viewerUserId: string,
): Promise<Set<string>> {
  const tripIds = new Set<string>();

  const [memberOutcome, ownerOutcome] = await Promise.allSettled([
    sc.from("trip_members").select("trip_id").eq("user_id", viewerUserId).in("role", ACCEPTED_TRIP_ROLES),
    sc.from("trips").select("id").eq("owner_id", viewerUserId),
  ]);

  if (memberOutcome.status === "fulfilled") {
    const { data, error } = (memberOutcome.value ?? {}) as { data?: any[] | null; error?: unknown };
    if (error) {
      console.warn("loadViewerTripIds: trip_members read failed (non-fatal):", error);
    } else {
      for (const row of data ?? []) {
        const id = (row as any)?.trip_id;
        if (id) tripIds.add(String(id));
      }
    }
  } else {
    console.warn("loadViewerTripIds: trip_members read rejected (non-fatal):", memberOutcome.reason);
  }

  if (ownerOutcome.status === "fulfilled") {
    const { data, error } = (ownerOutcome.value ?? {}) as { data?: any[] | null; error?: unknown };
    if (error) {
      console.warn("loadViewerTripIds: trips ownership read failed (non-fatal):", error);
    } else {
      for (const row of data ?? []) {
        const id = (row as any)?.id;
        if (id) tripIds.add(String(id));
      }
    }
  } else {
    console.warn("loadViewerTripIds: trips ownership read rejected (non-fatal):", ownerOutcome.reason);
  }

  return tripIds;
}
