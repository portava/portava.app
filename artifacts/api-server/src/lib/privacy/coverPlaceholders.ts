/**
 * Generic placeholder cover URLs used when an event or trip has
 * show_header_publicly = false.  The assets are served as static files
 * from the API server's /api/static/covers/ path.
 *
 * These are intentionally path-relative so they resolve against whatever
 * domain the API is hosted on.  Clients that already hold the API base URL
 * (EXPO_PUBLIC_API_BASE_URL) can trivially construct the full URL.
 */

export const PRIVATE_EVENT_COVER_PLACEHOLDER =
  "/api/static/covers/private-event.svg";

export const PRIVATE_TRIP_COVER_PLACEHOLDER =
  "/api/static/covers/private-trip.svg";
