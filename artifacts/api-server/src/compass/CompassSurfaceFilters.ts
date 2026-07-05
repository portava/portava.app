/**
 * Compass surface post-filters
 *
 * Pure, side-effect-free filter helpers used by GET /api/compass/recommendations.
 * Extracted here so they can be unit-tested independently of the full pipeline.
 */

/** Surface-specific type whitelists */
export const TRIP_SURFACE_TYPES    = new Set(["event", "place", "hidden_gem", "safety_tip", "language_tip"]);
export const PASSPORT_SURFACE_TYPES = new Set(["user", "traveler", "event", "place"]);

/**
 * Returns false if the item's start date is in the past or falls outside
 * the optional trip date range window.
 * Returns true when there is no date info (let scoring decide).
 */
export function isEventInRange(
  item:      any,
  startDate: string | undefined,
  endDate:   string | undefined,
): boolean {
  const eventStart: string | undefined =
    item.data?.startsAt ?? item.data?.startDate ?? item.data?.start_date;
  if (!eventStart) return true; // no date info → include

  const eventTs = new Date(eventStart).getTime();
  const now = Date.now();

  // Exclude past events (allow 60 s grace window for in-progress events)
  if (eventTs < now - 60_000) return false;

  // If trip date range provided, only include events within that window
  if (startDate && endDate) {
    const tripStart = new Date(startDate).getTime();
    const tripEnd   = new Date(endDate).getTime() + 86_400_000; // inclusive end
    if (eventTs < tripStart || eventTs > tripEnd) return false;
  } else if (startDate) {
    const tripStart = new Date(startDate).getTime();
    if (eventTs < tripStart) return false;
  }

  return true;
}

/**
 * Returns false if the item has a non-public visibility field.
 * Works for events, places, and any item carrying a visibility property.
 */
export function isPublicItem(item: any): boolean {
  const visibility = item.data?.visibility ?? item.visibility;
  if (visibility && visibility !== "public") return false;
  return true;
}

/**
 * Trip surface filter — applies type whitelist + visibility + date-range.
 */
export function passesTripFilter(
  fi:        any,
  startDate: string | undefined,
  endDate:   string | undefined,
): boolean {
  const inner = fi.item ?? fi;
  const type  = String(inner.type ?? fi.type ?? "");
  if (!TRIP_SURFACE_TYPES.has(type)) return false;

  // Exclude private/invite-only items for ALL types
  if (!isPublicItem(inner)) return false;

  // Exclude events outside the trip date range or already past
  if (type === "event" && !isEventInRange(inner, startDate, endDate)) return false;

  return true;
}

/**
 * Passport surface filter — applies type whitelist + blocked-user exclusion.
 */
export function passesPassportFilter(fi: any, blockedIds: Set<string>): boolean {
  const inner = fi.item ?? fi;
  const type  = String(inner.type ?? fi.type ?? "");
  if (!PASSPORT_SURFACE_TYPES.has(type)) return false;

  // Resolve the author/owner for blocked-user exclusion.
  // For user/traveler types: check userId fields (profile-level block).
  // For event/place types: check authorId (host/submitter-level block) so
  // content from blocked users cannot surface via their hosted events or places.
  const authorId = inner.data?.userId ?? inner.authorId ?? inner.userId;
  if (authorId && blockedIds.has(authorId)) return false;

  return true;
}
