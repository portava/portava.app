/**
 * PassportPrivacyGuard
 *
 * Server-side utility called by every passport service before returning data.
 * Rules:
 *   - Exact coordinates are NEVER exposed (we store city/neighborhood labels only)
 *   - Safe Return stamps default to private visibility
 *   - Hidden gems with is_sensitive=true have place details redacted
 *   - hotel_blur_enabled in user_location_preferences blurs hotel/private-stay location names
 *   - Visibility tiers: public > circle_only > trip_crew > private
 */

export type VisibilityTier = "public" | "circle_only" | "trip_crew" | "private";

/** What the caller is allowed to see, based on their relationship to the owner. */
export type CallerContext =
  | "owner"         // viewing own passport
  | "circle"        // in owner's trusted circle
  | "trip_crew"     // on a trip together with owner
  | "public";       // no special relationship

/**
 * Returns true when an item with the given visibility should be shown to a
 * caller with the given context.
 */
export function isVisible(
  visibility: VisibilityTier,
  callerCtx: CallerContext,
): boolean {
  if (callerCtx === "owner") return true;
  if (visibility === "public") return true;
  if (visibility === "circle_only") return callerCtx === "circle";
  if (visibility === "trip_crew") return callerCtx === "trip_crew";
  return false; // private
}

export interface StampRow {
  id: string;
  stamp_type: string;
  country: string | null;
  city: string | null;
  neighborhood: string | null;
  place_id: string | null;
  plan_id: string | null;
  trip_id: string | null;
  source_type: string;
  verification_level: string;
  visibility: VisibilityTier;
  /**
   * Live passport_stamps column is `awarded_at`; services select it with an
   * `earned_at:awarded_at` alias so rows keep this key (see
   * PassportStampService.loadStamps / PassportMapService).
   */
  earned_at: string;
  created_at: string;
}

export interface MemoryRow {
  id: string;
  status: "suggested" | "active" | "dismissed";
  title: string | null;
  description: string | null;
  country: string | null;
  city: string | null;
  neighborhood: string | null;
  category: string | null;
  visibility: VisibilityTier;
  verification_level: string;
  source_type: string | null;
  source_id: string | null;
  photo_url: string | null;
  media_type: string | null;
  plan_id: string | null;
  trip_id: string | null;
  place_id: string | null;
  suggestion_reason: string | null;
  earned_at: string;
  created_at: string;
}

const HOTEL_SENSITIVE_TYPES = new Set(["hotel", "private_stay", "home", "accommodation"]);

/**
 * Apply privacy rules to a stamp row.
 * Returns null if the stamp should be hidden entirely (caller lacks access).
 */
export function guardStamp(
  stamp: StampRow,
  callerCtx: CallerContext,
  opts: { hotelBlurEnabled?: boolean } = {},
): StampRow | null {
  if (!isVisible(stamp.visibility, callerCtx)) return null;

  // Safe Return stamps: suppress neighborhood detail for public callers
  if (stamp.stamp_type === "safe_return" && callerCtx === "public") {
    return { ...stamp, neighborhood: null, place_id: null };
  }

  // Hotel blur
  if (opts.hotelBlurEnabled && HOTEL_SENSITIVE_TYPES.has(stamp.source_type)) {
    return { ...stamp, neighborhood: null, place_id: null };
  }

  // Never expose place_id to public callers for sensitive stamp types
  const sensitiveTypes = new Set(["hidden_gem", "safe_return"]);
  if (sensitiveTypes.has(stamp.stamp_type) && callerCtx === "public") {
    return { ...stamp, place_id: null };
  }

  return stamp;
}

/**
 * Apply privacy rules to a memory row.
 * Returns null if the memory should be hidden entirely.
 */
export function guardMemory(
  memory: MemoryRow,
  callerCtx: CallerContext,
  opts: { hotelBlurEnabled?: boolean } = {},
): MemoryRow | null {
  // Suggested memories are NEVER visible to non-owners
  if (memory.status !== "active" && callerCtx !== "owner") return null;
  if (!isVisible(memory.visibility, callerCtx)) return null;

  let result = { ...memory };

  // Hotel blur: hide neighborhood for hotel-sourced memories
  if (opts.hotelBlurEnabled && memory.source_type && HOTEL_SENSITIVE_TYPES.has(memory.source_type)) {
    result = { ...result, neighborhood: null, place_id: null };
  }

  // suggestion_reason is owner-only
  if (callerCtx !== "owner") {
    result = { ...result, suggestion_reason: null };
  }

  return result;
}

/**
 * Filter an array of stamps by visibility, applying guardStamp to each.
 */
export function filterStamps(
  stamps: StampRow[],
  callerCtx: CallerContext,
  opts: { hotelBlurEnabled?: boolean } = {},
): StampRow[] {
  return stamps
    .map((s) => guardStamp(s, callerCtx, opts))
    .filter((s): s is StampRow => s !== null);
}

/**
 * Filter an array of memories by visibility, applying guardMemory to each.
 */
export function filterMemories(
  memories: MemoryRow[],
  callerCtx: CallerContext,
  opts: { hotelBlurEnabled?: boolean } = {},
): MemoryRow[] {
  return memories
    .map((m) => guardMemory(m, callerCtx, opts))
    .filter((m): m is MemoryRow => m !== null);
}

// ── Stamp v2 filtering ────────────────────────────────────────────────────────
// The v2 stamp system uses a different visibility tier set from the v1 passport
// stamps: "public" | "friends_only" | "private" (no circle_only or trip_crew).
// This helper applies CallerContext-based visibility using the v2 tiers.

export type StampV2VisibilityTier = "public" | "friends_only" | "private";

/**
 * Returns true when a v2 stamp with the given visibility should be shown to a
 * caller with the given context.
 *
 * - "owner" sees all visibility tiers.
 * - "circle" and "trip_crew" contexts see "friends_only" (friendship is the circle proxy).
 * - "public" context sees only "public" stamps.
 */
export function isVisibleV2(
  visibility: StampV2VisibilityTier,
  callerCtx: CallerContext,
): boolean {
  if (callerCtx === "owner") return true;
  if (visibility === "public") return true;
  if (visibility === "friends_only") return callerCtx === "circle" || callerCtx === "trip_crew";
  return false; // private
}

/**
 * Filter an array of v2 stamp rows by visibility using CallerContext.
 * Metadata is intentionally NOT redacted here — callers must ensure they
 * exclude metadata from non-owner responses at the query/format layer.
 */
export function filterStampsV2<T extends { visibility: string }>(
  stamps: T[],
  callerCtx: CallerContext,
): T[] {
  return stamps.filter((s) =>
    isVisibleV2(s.visibility as StampV2VisibilityTier, callerCtx),
  );
}
