"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPostsQuerySchema = exports.updatePostSchema = exports.createPostSchema = exports.pulseLocationVisibility = exports.locationSource = exports.postStatus = exports.postVisibility = void 0;
var zod_1 = require("zod");
/**
 * Hand-authored Zod validators for the posts API.
 *
 * NOTE: these live in the api-server (not @workspace/api-zod) on purpose —
 * @workspace/api-zod is orval-generated from the OpenAPI spec and must not be
 * hand-edited. If/when posts are added to the API spec, these can be replaced
 * by the generated equivalents. Zod v3 syntax (workspace catalog: ^3.24.2).
 */
exports.postVisibility = zod_1.z.enum(["public", "trip_only", "private"]);
exports.postStatus = zod_1.z.enum(["active", "hidden", "reported", "deleted"]);
var uuid = zod_1.z.string().uuid();
var mediaUrls = zod_1.z
    .array(zod_1.z.string().url())
    .max(10, "At most 10 media URLs")
    .optional()
    .default([]);
exports.locationSource = zod_1.z.enum(['gps', 'manual', 'none']);
/** Per-post location visibility override — user can reduce precision below their default pref. */
exports.pulseLocationVisibility = zod_1.z.enum([
    'city_only',
    'neighborhood',
    'venue_tagged',
    'exact_hidden',
    'no_location',
]);
var lat = zod_1.z.number().min(-90).max(90);
var lng = zod_1.z.number().min(-180).max(180);
/** Known filter IDs — duplicated from the mobile filter library for server-side validation. */
var KNOWN_FILTER_IDS = [
    'original', 'wanderlust', 'golden_hour', 'deep_ocean', 'mist', 'polaroid',
    'noir', 'safari', 'vivid', 'sunset', 'arctic', 'velvet',
];
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
exports.createPostSchema = zod_1.z
    .object({
    content: zod_1.z.string().max(5000).optional().default(""),
    mediaUrls: mediaUrls,
    tripId: uuid.nullish(),
    visibility: exports.postVisibility.optional().default("public"),
    // media + passport
    mediaType: zod_1.z.string().max(64).nullish(),
    addToPassport: zod_1.z.boolean().optional().default(true),
    // tagged location (what the user says)
    locationName: zod_1.z.string().max(200).nullish(),
    locationPlaceId: zod_1.z.string().max(256).nullish(),
    locationCity: zod_1.z.string().max(120).nullish(),
    locationCountry: zod_1.z.string().max(120).nullish(),
    locationLat: lat.nullish(),
    locationLng: lng.nullish(),
    // current GPS at posting time (private; used for verification only)
    userGpsLat: lat.nullish(),
    userGpsLng: lng.nullish(),
    locationSource: exports.locationSource.optional().default('none'),
    // per-post location visibility override (user can reduce precision; never increase above prefs)
    locationVisibility: exports.pulseLocationVisibility.optional(),
    // media filter fields
    filterId: zod_1.z.enum(KNOWN_FILTER_IDS).optional().default('original'),
    filterIntensity: zod_1.z.number().int().min(0).max(100).optional().default(100),
    mediaThumbnailUrl: zod_1.z.string().url().nullish(),
    mediaDurationSeconds: zod_1.z.number().int().min(0).max(10).nullish(),
})
    .superRefine(function (val, ctx) {
    var _a, _b;
    if (val.visibility === "trip_only" && !val.tripId) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ["tripId"],
            message: "tripId is required when visibility is trip_only",
        });
    }
    var hasContent = ((_a = val.content) !== null && _a !== void 0 ? _a : "").trim().length > 0;
    var hasMedia = ((_b = val.mediaUrls) !== null && _b !== void 0 ? _b : []).length > 0;
    if (!hasContent && !hasMedia) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ["content"],
            message: "A post must have content or at least one media URL",
        });
    }
});
/**
 * Update payload. All fields optional, but at least one must be present.
 * Cannot move a post's authorship; cannot set audit fields from the client.
 * Changing visibility to trip_only still requires the post to have a trip
 * (validated in the route against the existing row, since tripId may be absent
 * from the patch body).
 */
exports.updatePostSchema = zod_1.z
    .object({
    content: zod_1.z.string().max(5000).optional(),
    mediaUrls: zod_1.z.array(zod_1.z.string().url()).max(10).optional(),
    visibility: exports.postVisibility.optional(),
    status: exports.postStatus.optional(), // author may hide their own post
})
    .refine(function (v) { return Object.keys(v).length > 0; }, {
    message: "At least one field must be provided",
});
/** Query params for the global or following feed. */
exports.listPostsQuerySchema = zod_1.z.object({
    limit: zod_1.z.coerce.number().int().min(1).max(50).optional().default(20),
    before: zod_1.z.string().datetime().optional(), // cursor: created_at < before
    feed: zod_1.z.enum(["global", "following"]).optional().default("global"),
});
