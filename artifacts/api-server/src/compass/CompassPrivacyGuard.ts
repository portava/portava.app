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
 *   - Unpublished item coordinates (publicLat/Lng/LocationLabel) → always removed
 *     for items not authored by the viewer, regardless of delayed-post status
 *   - Pending delayed-post coordinates → also removed (publishEligibleAt not yet passed)
 *   - locationText → rewritten to privacy-safe phrasing when GPS was present
 *   - unpublishedContent body/url → removed for non-author viewers
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

    // Strip unpublished content body and coordinates for non-author viewers.
    // This covers ALL unpublished items (drafts, scheduled, delayed posts, etc.).
    if (sanitized.isUnpublished && sanitized.authorId !== profile.userId) {
      delete sanitized.contentBody;
      delete sanitized.contentUrl;
      // Also strip any public/sanitized coordinate fields — unpublished location
      // must never leave the server even in "public" form.
      const unpubCoordFields = ["publicLat", "publicLng", "publicLocationLabel"] as const;
      for (const f of unpubCoordFields) {
        if (f in sanitized) {
          delete sanitized[f];
          scrubbedFields.push(f);
        }
      }
      scrubbedFields.push("contentBody", "contentUrl");
    }

    // Defense-in-depth: also strip delayed-post coordinates when the post is not
    // yet eligible for publication (publishEligibleAt in the future or unset).
    // This catches cases where isUnpublished may not be set but the post is still
    // in a pending delayed state.
    const isDelayedPending =
      item.type === "post" &&
      item.isDelayedPost &&
      (item.publishEligibleAt === undefined ||
        new Date(item.publishEligibleAt as string).getTime() > Date.now());
    if (isDelayedPending) {
      const delayedCoordFields = ["publicLat", "publicLng", "publicLocationLabel"] as const;
      for (const f of delayedCoordFields) {
        if (f in sanitized) {
          delete sanitized[f];
          if (!scrubbedFields.includes(f)) scrubbedFields.push(f);
        }
      }
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
    // Fail-CLOSED: never propagate the exception, but never return the RAW item
    // either — returning `{ ...item }` skipped the ALWAYS_STRIP pass and would
    // leak exact coordinates / addresses / emergency + ID fields if any later
    // step threw. Hard-strip the always-sensitive fields before returning.
    const safe: CompassItem = { ...item };
    for (const field of ALWAYS_STRIP) {
      if (field in safe) delete (safe as Record<string, unknown>)[field];
    }
    return safe;
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
