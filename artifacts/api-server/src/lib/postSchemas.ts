import { z } from "zod";

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
  "trusted_circle_only",
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
const mediaUrls = z
  .array(z.string().url())
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
 * For city_only or high-sensitivity: only city+country.
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
  if (mode === "city_only" || sensitivity === "high") {
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
 *     geofence was cleared; location intentionally revealed.
 */
export function mapPublicPost(row: any): any {
  const mode = row.location_privacy_mode as string | null | undefined;
  if (!mode || mode === "none") return row;
  if (mode === "city_only" || mode === "hidden" || mode === "trusted_circle_only") {
    return { ...row, location_name: null };
  }
  // delayed_until_exit / delayed_until_time: suppress until published
  if (row.post_status === "published") return row;
  return { ...row, location_name: null };
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
    mediaThumbnailUrl: z.string().url().nullish(),
    mediaDurationSeconds: z.number().int().min(0).max(10).nullish(),
    // ── Delayed geotag fields ──────────────────────────────────────────────────
    locationPrivacyMode: locationPrivacyMode.optional(),
    publishAfterTime: z.string().datetime().nullish(),
    geofenceRadiusMeters: z.number().int().min(50).max(5000).nullish(),
    // venue metadata for sensitivity classification
    venueName: z.string().max(200).nullish(),
    venueId: z.string().max(256).nullish(),
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
    mediaUrls: z.array(z.string().url()).max(10).optional(),
    visibility: postVisibility.optional(),
    status: postStatus.optional(), // author may hide their own post
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
