/**
 * CompassPrivacyGuard — Phase 2 privacy scrubbing gate.
 *
 * Runs AFTER Safety + Eligibility gates, BEFORE Scoring.
 * Sanitizes any CompassItem before its data can influence scoring or leave the server.
 *
 * Scrubbing rules:
 *   - exactLat, exactLng → removed (coordinates scrubbed to city-level)
 *   - exactAddress, hotelAddress → removed
 *   - safeReturnRoute → removed
 *   - emergencyContacts → removed
 *   - adminNotes → removed
 *   - idDocument fields → removed
 *   - privateBookingNotes → removed
 *   - Pending delayed-post coordinates → removed (publishEligibleAt not yet passed)
 *   - locationText → rewritten to privacy-safe phrasing when GPS was present
 *   - unpublishedContent → removed
 *
 * Privacy-safe location text phrase list:
 *   - Has city + neighbourhood → "around [neighbourhood], [city]"
 *   - Has city only             → "in [city]"
 *   - Has country only          → "somewhere in [country]"
 *   - No location at all        → "nearby" (most conservative)
 *
 * Scrubbing events are logged to compass_privacy_guard_logs (fire-and-forget).
 * This function NEVER throws — returns the item as-is if something goes wrong.
 * The returned object is a NEW object (no mutation of the input).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompassItem, CompassProfile } from "./types.js";

/** Fields that are always stripped before an item is used downstream. */
const ALWAYS_STRIP: (keyof CompassItem)[] = [
  "exactLat",
  "exactLng",
  "exactAddress",
  "hotelAddress",
  "safeReturnRoute",
  "emergencyContacts",
  "adminNotes",
  "idDocument",
  "privateBookingNotes",
];

/** Build a privacy-safe location text phrase from available city/neighbourhood/country data. */
export function buildPrivacySafeLocationText(
  city?: string | null,
  neighbourhood?: string | null,
  country?: string | null,
): string {
  if (city && neighbourhood) return `around ${neighbourhood}, ${city}`;
  if (city)                  return `in ${city}`;
  if (country)               return `somewhere in ${country}`;
  return "nearby";
}

/** Fire-and-forget log to DB. Never throws. */
function logScrub(
  db: SupabaseClient | null,
  viewerId: string,
  item: CompassItem,
  scrubbedFields: string[],
): void {
  if (!db || scrubbedFields.length === 0) return;
  db.from("compass_privacy_guard_logs")
    .insert({
      viewer_id:       viewerId,
      item_id:         item.id,
      item_type:       item.type,
      scrubbed_fields: scrubbedFields,
    })
    .then(() => {}, () => {});
}

/**
 * Sanitize a single CompassItem — strips private fields and rewrites location text.
 *
 * @param item     The item to sanitize (not mutated)
 * @param profile  The calling user's Compass profile
 * @param db       Optional Supabase client for logging (null in tests)
 * @returns        A new sanitized copy of the item
 */
export function sanitizeItem(
  item: CompassItem,
  profile: CompassProfile,
  db: SupabaseClient | null = null,
): CompassItem {
  try {
    const sanitized: CompassItem = { ...item };
    const scrubbedFields: string[] = [];

    // Always strip sensitive fields
    for (const field of ALWAYS_STRIP) {
      if (field in sanitized && sanitized[field] !== undefined) {
        delete sanitized[field];
        scrubbedFields.push(field as string);
      }
    }

    // Strip unpublished content body
    if (sanitized.isUnpublished && sanitized.authorId !== profile.userId) {
      delete sanitized.contentBody;
      delete sanitized.contentUrl;
      scrubbedFields.push("contentBody", "contentUrl");
    }

    // Strip delayed post coordinates if not yet eligible
    const hasDelayedCoords = item.type === "post" && item.isDelayedPost;
    const publishTime = item.publishEligibleAt
      ? new Date(item.publishEligibleAt).getTime()
      : null;
    if (hasDelayedCoords && (publishTime === null || publishTime > Date.now())) {
      delete sanitized.publicLat;
      delete sanitized.publicLng;
      delete sanitized.publicLocationLabel;
      scrubbedFields.push("publicLat", "publicLng", "publicLocationLabel");
    }

    // Rewrite locationText to privacy-safe phrasing when GPS was present
    const hadGps = "exactLat" in item || "exactLng" in item;
    if (hadGps) {
      sanitized.locationText = buildPrivacySafeLocationText(
        item.city,
        item.neighbourhood,
        item.country,
      );
      if (!scrubbedFields.includes("locationText")) {
        scrubbedFields.push("locationText:rewritten");
      }
    }

    logScrub(db, profile.userId, item, scrubbedFields);
    return sanitized;
  } catch {
    // Never propagate — return original item if sanitization fails
    return { ...item };
  }
}

/**
 * Sanitize a batch of CompassItems through the Privacy Guard.
 */
export function sanitizeBatch(
  items: CompassItem[],
  profile: CompassProfile,
  db: SupabaseClient | null = null,
): CompassItem[] {
  return items.map((item) => sanitizeItem(item, profile, db));
}
