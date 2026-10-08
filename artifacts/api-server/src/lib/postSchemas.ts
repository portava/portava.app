import { z } from "zod"; import { postLocationDisclosureEnded } from "./postLocationDisclosureLifetime.js"; import { configuredStorageOrigin } from "./mediaUrl.js"; // census-media MD79 (lead ruling D-26f); verifier M3 D82-1: same line, so no cited line below moves

/**
 * Hand-authored Zod validators for the posts API.
 *
 * NOTE: these live in the api-server (not @workspace/api-zod) on purpose —
 * @workspace/api-zod is orval-generated from the OpenAPI spec and must not be
 * hand-edited. If/when posts are added to the API spec, these can be replaced
 * by the generated equivalents. Zod v3 syntax (workspace catalog: ^3.24.2).
 */

export const postVisibility = z.enum(["public", "trip_only", "private"]);
export type PostVisibility = z.infer<typeof postVisibility>;

export const postStatus = z.enum(["active", "hidden", "reported", "deleted"]);
export type PostStatus = z.infer<typeof postStatus>;

/** Privacy mode for the delayed geotag system. */
export const locationPrivacyMode = z.enum([
  "none",
  "hidden",
  "city_only",
  "delayed_until_exit",
  "delayed_until_time",
  "trusted_circle_only", "neighborhood_only", // §34 "Show neighborhood only" (migration 3350, census-media §36). Parsing is not permission: the routes refuse it unless media_neighborhood_only_mode_enabled (lib/media/neighborhoodOnlyMode).
]);
export type LocationPrivacyMode = z.infer<typeof locationPrivacyMode>;

/** Lifecycle status of a post in the delayed-publish pipeline. */
export const delayedPostStatus = z.enum([
  "draft",
  "private",
  "pending_location_exit",
  "pending_delay",
  "pending_safety_review",
  "published",
  "canceled",
  "expired",
]);
export type DelayedPostStatus = z.infer<typeof delayedPostStatus>;

export const locationSensitivityLevel = z.enum(["low", "medium", "high"]);
export type LocationSensitivityLevel = z.infer<typeof locationSensitivityLevel>;

const uuid = z.string().uuid();
const APP_MEDIA_BUCKETS = new Set(["post-media", "profile-media"]);
// The absolute-URL rule below is acceptedAbsoluteMediaUrl, at the end of this file (verifier M3 D82-1).
/**
 * Accept a media reference in any of these forms:
 *   1. Bare storage path: `<bucket>/<path>` (e.g. "post-media/userId/ts.jpg")
 *      — the format returned by upload endpoints; the batch-signer
 *      (appStorageUrlInfo) already understands this format.
 *   2. Relay path: `/api/media/file/<bucket>/...` (still accepted during migration)
 *   3. Absolute URL — `https:` only (old Supabase public URLs, accepted during migration); `http:` only on the
 *      configured Supabase origin (a local storage). data:, blob:, file:, javascript: and every other scheme are
 * refused (verifier M3 D82-1, census-media §50.16). Arbitrary strings like "not-a-url" are still rejected.
 */
export const appMediaRef = z.string().min(1).refine(
  (v) => {
    // Bare bucket/path: no scheme, starts with a known bucket name + "/"
    if (!v.startsWith("//") && !v.includes("://")) {
      const slash = v.indexOf("/");
      if (slash > 0 && APP_MEDIA_BUCKETS.has(v.slice(0, slash))) return true;
    }
    // Relay path
    if (v.startsWith("/api/media/file/")) return true;
    // Absolute URL (old public format): https anywhere; http only on the configured storage origin; nothing else
    return acceptedAbsoluteMediaUrl(v, configuredStorageOrigin());
  },
  { message: "Must be a valid URL, relay path, or app storage path (e.g. post-media/…)" },
);

const mediaUrls = z
  .array(appMediaRef)
  .max(10, "At most 10 media URLs")
  .optional()
  .default([]);

export const locationSource = z.enum(['gps', 'manual', 'none']);

/** Per-post location visibility override — user can reduce precision below their default pref. */
export const pulseLocationVisibility = z.enum([
  'city_only',
  'neighborhood',
  'venue_tagged',
  'exact_hidden',
  'no_location',
]);

const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

/** Known filter IDs — duplicated from the mobile filter library for server-side validation. */
const KNOWN_FILTER_IDS = [
  'original', 'wanderlust', 'golden_hour', 'deep_ocean', 'mist', 'polaroid',
  'noir', 'safari', 'vivid', 'sunset', 'arctic', 'velvet',
] as const;

// ── Sensitivity classifier ────────────────────────────────────────────────────

/** Venue category keywords that map to each sensitivity tier. */
const HIGH_SENSITIVITY_KEYWORDS = [
  'hotel', 'motel', 'hostel', 'lodge', 'home', 'house', 'apartment', 'flat',
  'residence', 'workplace', 'office', 'clinic', 'hospital', 'shelter',
];
const MEDIUM_SENSITIVITY_KEYWORDS = [
  'bar', 'nightclub', 'club', 'lounge', 'karaoke', 'casino',
  'pharmacy', 'medical', 'school', 'church', 'mosque', 'temple',
];

/**
 * Classify a venue name or category string into a sensitivity tier.
 * High-sensitivity venues (hotels, home, workplace) get stricter geofence radii
 * and default to city_only mode.
 */
export function sensitivityLevel(venueName: string | null | undefined): LocationSensitivityLevel {
  if (!venueName) return "low";
  const lower = venueName.toLowerCase();
  if (HIGH_SENSITIVITY_KEYWORDS.some((kw) => lower.includes(kw))) return "high";
  if (MEDIUM_SENSITIVITY_KEYWORDS.some((kw) => lower.includes(kw))) return "medium";
  return "low";
}

/**
 * Geofence radius in meters, scaled by sensitivity.
 * Stricter radius for sensitive venues to prevent precise location inference.
 */
export function geofenceRadius(level: LocationSensitivityLevel, userOverride?: number): number {
  if (userOverride != null && userOverride > 0) return userOverride;
  if (level === "high")   return 800;
  if (level === "medium") return 600;
  return 400;
}

/**
 * Default privacy mode for a geotagged post based on sensitivity.
 * High-sensitivity venues default to city_only; others default to delayed_until_exit.
 */
export function defaultPrivacyMode(
  locationSrc: string,
  sensitivity: LocationSensitivityLevel,
): LocationPrivacyMode {
  if (locationSrc === "none") return "none";
  if (sensitivity === "high") return "city_only";
  return "delayed_until_exit";
}

// ── Safe location label ───────────────────────────────────────────────────────

/**
 * Return a safe public label that never exposes exact GPS coordinates.
 * For city_only, neighborhood_only, trusted_circle_only or high-sensitivity: only city+country.
 * Otherwise: the venue name or city.
 */
export function safeLocationLabel(
  locationName: string | null | undefined,
  locationCity: string | null | undefined,
  locationCountry: string | null | undefined,
  mode: LocationPrivacyMode,
  sensitivity: LocationSensitivityLevel,
): string | null {
  if (mode === "hidden") return null;
  if (mode === "city_only" || mode === "neighborhood_only" || mode === "trusted_circle_only" || sensitivity === "high") { // census-media §36: neighborhood_only has no neighbourhood label at write time, and trusted_circle_only used to store the VENUE here
    return [locationCity, locationCountry].filter(Boolean).join(", ") || null;
  }
  return locationName ?? ([locationCity, locationCountry].filter(Boolean).join(", ") || null);
}

/**
 * Redact sensitive location fields for public-facing responses.
 *
 * Rule: when a location_privacy_mode is active, the raw location_name
 * (exact venue) is suppressed — consumers should use public_location_label.
 *
 * Exceptions:
 *   - mode null / 'none' → no privacy; pass through unchanged.
 *   - delayed_until_exit / delayed_until_time + post_status 'published' →
 *     geofence was cleared; location intentionally revealed (delayed_until_exit: for 24 h after published_at, then the city — census-media MD79).
 */
export function mapPublicPost(row: any, nowMs: number = Date.now()): any {
  const mode = row.location_privacy_mode as string | null | undefined;
  if (!mode || mode === "none") return row;
  // A delayed post, once RELEASED: the geofence cleared, the place is revealed by design. Only the two delayed modes reach this branch.
  if (mode === "delayed_until_exit" && row.post_status === "published" && postLocationDisclosureEnded(row, nowMs)) return releasedPlaceEnded(row); // census-media MD79 (lead rulings D-26f/D-26g): a "Publish after I leave" post shows its place for 24 h after release, then the city; an unreadable or unselected published_at has ENDED
  if ((mode === "delayed_until_exit" || mode === "delayed_until_time") && row.post_status === "published") return row;
  // Every other mode withholds the venue: city_only, hidden, trusted_circle_only, neighborhood_only (§34, 3350), an unreleased delayed post — AND a value this function does not know. An unknown mode used to fall through to the branch above and serve the venue of any published row (census-media §36).
  // The public label is rebuilt from city/country, never trusted: safeLocationLabel stored the VENUE as the label of every trusted_circle_only post, and adminPortavaPosts can store it for city_only. Hidden keeps no label, as it is written.
  const label = mode === "hidden" ? null : ([row.location_city, row.location_country].filter(Boolean).join(", ") || null);
  return { ...row, location_name: null, ...("public_location_label" in row ? { public_location_label: label } : {}) };
}

/**
 * census-media MD79 (lead rulings D-26f/D-26g): a released "Publish after I
 * leave" post whose 24-hour place window has ended falls to the CITY, exactly as
 * "City only" does — the venue and its label go, and so do the public
 * coordinates, which lib/delayedPostPublisher set to the EXACT point on release.
 * Only keys the row already carries are touched.
 */
function releasedPlaceEnded(row: any): any {
  const label = [row.location_city, row.location_country].filter(Boolean).join(", ") || null;
  return {
    ...row,
    location_name: null,
    ...("public_location_label" in row ? { public_location_label: label } : {}),
    ...("public_lat" in row ? { public_lat: null } : {}),
    ...("public_lng" in row ? { public_lng: null } : {}),
  };
}

// ── Create schema ─────────────────────────────────────────────────────────────

/**
 * Create payload. author_id is intentionally NOT accepted — the server always
 * sets it from the verified token. trip_id is optional (standalone post).
 * Cross-field rule: visibility=trip_only REQUIRES trip_id.
 * Body rule: must have non-empty content OR at least one media URL.
 *
 * Location/GPS/passport fields are accepted as INPUTS, but the server decides
 * location_verified / stamp_eligible — it NEVER trusts client verification flags
 * (those aren't even in this schema).
 */
export const createPostSchema = z
  .object({
    content: z.string().max(5000).optional().default(""),
    mediaUrls,
    tripId: uuid.nullish(),
    visibility: postVisibility.optional().default("public"),
    // media + passport
    mediaType: z.string().max(64).nullish(),
    addToPassport: z.boolean().optional().default(true),
    // tagged location (what the user says)
    locationName: z.string().max(200).nullish(),
    locationPlaceId: z.string().max(256).nullish(),
    locationCity: z.string().max(120).nullish(),
    locationCountry: z.string().max(120).nullish(),
    locationLat: lat.nullish(),
    locationLng: lng.nullish(),
    // current GPS at posting time (private; used for verification only)
    userGpsLat: lat.nullish(),
    userGpsLng: lng.nullish(),
    locationSource: locationSource.optional().default('none'),
    // per-post location visibility override (user can reduce precision; never increase above prefs)
    locationVisibility: pulseLocationVisibility.optional(),
    // media filter fields
    filterId: z.enum(KNOWN_FILTER_IDS).optional().default('original'),
    filterIntensity: z.number().int().min(0).max(100).optional().default(100),
    mediaThumbnailUrl: appMediaRef.nullish(),
    mediaDurationSeconds: z.number().int().min(0).max(10).nullish(),
    // ── Delayed geotag fields ──────────────────────────────────────────────────
    locationPrivacyMode: locationPrivacyMode.optional(),
    publishAfterTime: z.string().datetime().nullish(),
    geofenceRadiusMeters: z.number().int().min(50).max(5000).nullish(),
    // venue metadata for sensitivity classification
    venueName: z.string().max(200).nullish(),
    venueId: z.string().max(256).nullish(),
    // editorial category (food, nightlife, beach, etc.)
    category: z.string().max(64).nullish(),
    // §12 perspective group the contributor names (census-media §36, MD82–MD85).
    // Parsed as text; lib/media/perspectiveVantage decides whether it may be
    // written (flag) and whether it is one of the category's §12 groups.
    perspectiveVantage: z.string().max(32).nullish(),
  })
  .superRefine((val, ctx) => {
    if (val.visibility === "trip_only" && !val.tripId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tripId"],
        message: "tripId is required when visibility is trip_only",
      });
    }
    const hasContent = (val.content ?? "").trim().length > 0;
    const hasMedia = (val.mediaUrls ?? []).length > 0;
    if (!hasContent && !hasMedia) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "A post must have content or at least one media URL",
      });
    }
    // delayed_until_time requires publishAfterTime
    if (val.locationPrivacyMode === "delayed_until_time" && !val.publishAfterTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publishAfterTime"],
        message: "publishAfterTime is required for delayed_until_time mode",
      });
    }
  });
export type CreatePostInput = z.infer<typeof createPostSchema>;

/**
 * Update payload. All fields optional, but at least one must be present.
 * Cannot move a post's authorship; cannot set audit fields from the client.
 * Changing visibility to trip_only still requires the post to have a trip
 * (validated in the route against the existing row, since tripId may be absent
 * from the patch body).
 */
export const updatePostSchema = z
  .object({
    content: z.string().max(5000).optional(),
    mediaUrls: z.array(appMediaRef).max(10).optional(),
    visibility: postVisibility.optional(),
    status: postStatus.optional(), // author may hide their own post
    /** Update or clear the editorial category. Pass null to remove it. */
    category: z.string().max(64).nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

/** Location-privacy change payload. */
export const locationPrivacyPatchSchema = z.object({
  locationPrivacyMode: locationPrivacyMode,
  publishAfterTime: z.string().datetime().nullish(),
});
export type LocationPrivacyPatch = z.infer<typeof locationPrivacyPatchSchema>;

/** Query params for the global or following feed. */
export const listPostsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  before: z.string().datetime().optional(), // cursor: created_at < before
  feed: z.enum(["global", "following"]).optional().default("global"),
});
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;

// ── census-media §42: mapPublicPost's decision, for post readers outside Media ─
// Appended at the tail so no cited line above moves; function declarations hoist.
/**
 * Does mapPublicPost withhold this post's place from a viewer who is not its
 * author? Derived FROM mapPublicPost, which hands back the very row it was given
 * when, and only when, it redacts nothing, so this predicate and the redactor
 * cannot drift apart: a mode mapPublicPost learns to withhold is withheld here.
 *
 * true ⇒ nothing finer than the post's city and country may reach a non-owner:
 * not the venue (`posts.location_name`, or a copy of it such as
 * `pulse_geo_tags.venue_name`), not a district, not the canonical place id, not
 * coordinates, and not a listing chosen BECAUSE of the post's place.
 * false for `none`, an absent mode and a RELEASED delayed post; true for an
 * unreleased delayed post and for any mode mapPublicPost does not know.
 *
 * The caller applies the owner bypass: an author always sees their own post.
 * The caller must SELECT `location_privacy_mode`: like mapPublicPost, a row
 * without the key reads as `none`.
 */
export function postPlaceWithheld(row: { location_privacy_mode?: unknown; post_status?: unknown; published_at?: unknown }): boolean { // published_at: census-media MD79 — a released "Publish after I leave" row without it reads as ENDED (withheld)
  return mapPublicPost(row) !== row;
}

// ── appMediaRef's absolute URLs (verifier M3 D82-1, census-media §50.16) ─────
// Appended at the tail so no cited line above moves.
//
// `new URL()` parses data:, blob:, file:, javascript: and every other scheme,
// and a held photo re-encoded as a data: URI rode past the D-82 hold (which can
// hold only app-storage objects). An absolute media URL is accepted over https,
// or over http only on the configured storage origin (a local Supabase, and the
// package test line's http://127.0.0.1:9). A foreign https URL is still accepted
// (the migration-era form) and names no app object.

/** Whether `v` is an absolute media URL appMediaRef accepts, given the configured storage origin. */
export function acceptedAbsoluteMediaUrl(v: string, storageOrigin: string | null): boolean {
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && storageOrigin !== null && u.origin === storageOrigin;
}
