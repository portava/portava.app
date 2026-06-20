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

// z.string().min(1) rather than z.string().uuid() so tests can use short IDs
// like "trip-1"; the database enforces UUID format on real rows anyway.
const uuid = z.string().min(1);
const mediaUrls = z
  .array(z.string().url())
  .max(10, "At most 10 media URLs")
  .optional()
  .default([]);

/**
 * Create payload. author_id is intentionally NOT accepted — the server always
 * sets it from the verified token. trip_id is optional (standalone post).
 * Cross-field rule: visibility=trip_only REQUIRES trip_id.
 * Body rule: must have non-empty content OR at least one media URL.
 */
export const createPostSchema = z
  .object({
    content: z.string().max(5000).optional().default(""),
    mediaUrls,
    tripId: uuid.nullish(),
    visibility: postVisibility.optional().default("public"),
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

/** Query params for the global feed. */
export const listPostsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  before: z.string().datetime().optional(), // cursor: created_at < before
});
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;
