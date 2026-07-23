/**
 * Legacy allowlist for the async-handler guard.
 *
 * These route files pre-date the asyncHandler enforcement policy and contain
 * bare `async (req, res) =>` callbacks that have not yet been wrapped.
 * They are tracked here so the check script can skip them while still
 * catching any NEW route file that ships without asyncHandler.
 *
 * Workflow:
 *   - Do NOT add new filenames to this list.
 *   - When a file on this list is fully migrated to asyncHandler, remove it.
 *   - The goal is to shrink this list to zero over time.
 *
 * Imported by:
 *   - src/scripts/checkAsyncHandlers.ts  (standalone CI guard)
 */

/** Bare filenames (no path) of route files with known legacy bare async handlers. */
export const ASYNC_HANDLER_LEGACY_FILES = new Set([
  "adminCompass.ts",
  "adminStamps.ts",
  "admin.ts",
  "airport.ts",
  "auth.ts",
  "availability.ts",
  "blocks.ts",
  "calls.ts",
  "circleAgeSettings.ts",
  "circle.ts",
  "collections.ts",
  "compass.ts",
  "crashReport.ts",
  "dailyBrief.ts",
  "discoverySearch.ts",
  "discovery.ts",
  "events.ts",
  "follows.ts",
  "friends.ts",
  "geofence.ts",
  "hashtags.ts",
  "hiddenGems.ts",
  "highlights.ts",
  "interactionContext.ts",
  "locations.ts",
  "location.ts",
  "mapTravelers.ts",
  "meetups.ts",
  "memories.ts",
  "messaging.ts",
  "mutes.ts",
  "notifications.ts",
  "passportStamps.ts",
  "passport.ts",
  "places.ts",
  "postcards.ts",
  "posts.ts",
  "preferences.ts",
  "profileTabs.ts",
  "profile.ts",
  "pulse.ts",
  "rentABuddyMarketplace.ts",
  "rentABuddy.ts",
  "reports.ts",
  "requests.ts",
  "restrict.ts",
  "safeReturn.ts",
  "saves.ts",
  "searchHistory.ts",
  "stamps.ts",
  "tags.ts",
  "telegraphChat.ts",
  "telegraphCommands.ts",
  "telegraphFeedback.ts",
  "telegraphStream.ts",
  "telegraph.ts",
  "tripCrewLocation.ts",
  "trips-expansion.ts",
  "trips.ts",
  "trust-admin.ts",
  "wishlist.ts",
  // E2EE device management routes — added without asyncHandler wrapping;
  // tracked here so the guard still catches future new files.
  "devices.ts",
  "keyPackages.ts",
  // Verification routes — added before asyncHandler was enforced.
  "verification.ts",
]);
