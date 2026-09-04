/**
 * postVisibility — who may READ a post.
 *
 * GET /posts/:postId fetched the post with the SERVICE client (RLS bypassed),
 * filtered on `status = 'active'`, and then gated on published-or-author only.
 * It never read `visibility`, even though POST_COLUMNS selects it. Any
 * authenticated user holding a post id received a `private` or `trip_only`
 * post in full — content, location, media, author profile.
 *
 * This is the third instance of one shape: a field is SELECTED and then never
 * READ. Selecting it is what makes the omission invisible in review — the
 * column is right there in the query, so the handler looks like it considers
 * visibility.
 *
 * ## Why this is a separate predicate from checkEngagePermission
 *
 * routes/posts.ts already has checkEngagePermission, which gates commenting,
 * reacting and saving. It cannot be reused here, because it forbids `private`
 * outright — including to the AUTHOR. That is right for engagement (there is
 * nobody to engage with on your own private post) and wrong for reading (an
 * author must be able to open their own private post). Reusing it would have
 * traded a leak for a lockout.
 *
 * ## Why absence fails closed
 *
 * An unrecognised visibility value is treated as NOT readable by non-authors.
 * A new visibility tier added later is then invisible to strangers until someone
 * teaches this function about it, rather than public by default. The author is
 * always admitted, so a new tier cannot lock a user out of their own post.
 *
 * ## followers_only
 *
 * `followers_only` (equivalently the raw value `followers`) is readable by the
 * author's FOLLOWERS — not the public, and not strangers. Like the trip_only
 * membership flag, the caller supplies `viewerIsFollower` (the result of a
 * "does the viewer follow the author" check) rather than this function fetching
 * it, so the common cases still cost no query and the function stays pure. It
 * used to fall through to `unknown_visibility` and fail closed to everyone but
 * the author, so a followers_only post reached NOBODY but its author even though
 * the tier exists — this admits the followers it is meant for.
 */

/** Visibility values this predicate understands. Anything else fails closed. */
export const READABLE_VISIBILITIES = ["public", "private", "trip_only", "followers_only"] as const;

export interface ReadablePost {
  author_id: string;
  /** May be absent on legacy rows — absent is treated as public. */
  visibility?: string | null;
  trip_id?: string | null;
}

export interface ReadDecision {
  readable: boolean;
  /**
   * Why, for logging and tests. Never sent to a client: the route answers
   * not_found for every refusal so a private post's existence is not
   * confirmed to someone who cannot read it.
   */
  reason:
    | "author"
    | "public"
    | "trip_member"
    | "private_not_author"
    | "trip_only_not_member"
    | "unknown_visibility";
}

/**
 * Decide whether `viewerId` may read `post`.
 *
 * `viewerIsTripMember` must be the result of an ACCEPTED-membership check for
 * `post.trip_id`. The caller supplies it rather than this function fetching it,
 * so the common cases (author, public) cost no query at all — and so this
 * function stays pure and directly testable.
 */
export function decidePostReadable(
  post: ReadablePost,
  viewerId: string,
  viewerIsTripMember: boolean,
): ReadDecision {
  // The author always reads their own post, at any visibility, published or not.
  if (post.author_id === viewerId) return { readable: true, reason: "author" };

  // Legacy rows predate the column; absent has always meant public.
  const visibility = post.visibility ?? "public";

  if (visibility === "public") return { readable: true, reason: "public" };

  if (visibility === "private") {
    return { readable: false, reason: "private_not_author" };
  }

  if (visibility === "trip_only") {
    // No trip_id on a trip_only post is malformed — admit nobody but the author.
    if (!post.trip_id) return { readable: false, reason: "trip_only_not_member" };
    return viewerIsTripMember
      ? { readable: true, reason: "trip_member" }
      : { readable: false, reason: "trip_only_not_member" };
  }

  return { readable: false, reason: "unknown_visibility" };
}

/**
 * Delayed-publish gate — is this post PUBLISHED, i.e. servable to anyone but
 * its author?
 *
 * `posts.post_status` is the publication state machine (enum
 * delayed_post_status: draft / private / pending_location_exit / pending_delay /
 * pending_safety_review / published / canceled / expired). POST /posts inserts a
 * delayed-geotag post with `status = 'active'` and a PENDING post_status, and
 * a sweeper flips it to 'published' later. `status = 'active'` is therefore NOT
 * enough to serve a post: every feed reader must also gate on post_status, or
 * it serves a post whose author asked for it to stay hidden until they had
 * left the place (§23 / §37).
 *
 * This is the SAME predicate the canonical readers already apply —
 * lib/mediaEligibility (`if (postStatus && postStatus !== "published")`),
 * GET /posts/:postId (`!post.post_status || post.post_status === "published"`)
 * and POST /media/feed/view — lifted here so the Wall readers use the one
 * definition instead of each restating it. Absent is treated as published: the
 * column is NOT NULL DEFAULT 'published' in the schema, so absence only ever
 * means a legacy row or a caller that did not select the column, never a
 * pending post. The DB-side form is `.eq("post_status", "published")` (the
 * Following / global feeds in routes/posts.ts); callers apply that on the
 * query AND this in memory, so a row fed past the query filter cannot leak.
 *
 * Deliberately separate from decidePostReadable: that decides WHO may read a
 * post given its visibility (and admits the author to their own pending post);
 * this decides whether the post is published at all. The Wall never shows a
 * viewer their own posts, so it applies both.
 */
export function isPostPublished(post: { post_status?: string | null }): boolean {
  return !post.post_status || post.post_status === "published";
}

/** Convenience boolean for call sites that do not need the reason. */
export function canReadPost(
  post: ReadablePost,
  viewerId: string,
  viewerIsTripMember: boolean,
): boolean {
  return decidePostReadable(post, viewerId, viewerIsTripMember).readable;
}

/**
 * Does this post need a trip-membership lookup before the decision can be made?
 *
 * Lets a route skip the query for the author, for public posts and for private
 * posts — the only case that needs it is a trip_only post viewed by someone
 * else.
 */
export function needsTripMembershipCheck(post: ReadablePost, viewerId: string): boolean {
  if (post.author_id === viewerId) return false;
  return (post.visibility ?? "public") === "trip_only" && !!post.trip_id;
}
