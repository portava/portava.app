/**
 * postLikersGate — may this viewer list who liked a post, or a comment on one?
 * (census-media §54; B58 lane POSTS-LIKERS, from verifier V-739's adjacent finding)
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * GET /engagement/likes gated `post_like`, `post_reaction` and `comment_like`
 * with routes/engagement.ts `checkPostAccess`: the post's author, or
 * `visibility = 'public'`, or a `trip_members` row for a trip_only post — over a
 * `posts` read that excluded only `status = 'deleted'` and bound no error. It
 * read no `blocks`. POST /posts/:postId/like refuses a pair blocked in EITHER
 * direction with the post's own 404, while the likers of that same post were
 * listed to that same viewer. So were the likers of an ARCHIVED public post
 * (`status = 'hidden'`) and of a public post not yet published (`post_status`),
 * both of which GET /posts/:postId refuses to anyone but (for the second) the
 * author.
 *
 * ── THE RULE, IN ORDER (decidePostLikersAccess) ─────────────────────────────
 *   1. GET /posts/:postId's row read: `status = 'active'`. A failed read is
 *      `"unreadable"`, which the route answers 503 BEFORE the row's existence
 *      is known, so that refusal is no existence oracle. No row → the post's 404.
 *   2. The author → admitted. Main's rule, and GET /posts/:postId's: it serves
 *      its author every active post, published or not, at any visibility.
 *   3. Not published (`post_status`) → the post's 404 (GET's rule).
 *   4. A block in EITHER direction → the post's 404 — POST /posts/:postId/like's
 *      refusal, byte for byte. `isBlockedBetween` (lib/blockGuard) answers
 *      "blocked" when the read fails or throws, so an unreadable block state
 *      refuses too, with the same answer a missing post gets.
 *   5. `decidePostReadable` (lib/postVisibility — the function GET /posts/:postId
 *      calls), with the accepted trip membership and the follow resolved only
 *      when the tier needs them. Refused → the post's 404. A membership or
 *      follow read that fails → the same 404: GET answers that case 503, but a
 *      503 here would be served only for a post that exists and is otherwise
 *      readable, and would say so.
 *   6. NOT WIDENED. Readable, then main's likers rule over the raw row: public,
 *      or a member of a trip_only post's trip → admitted. "Member" is now GET's
 *      ACCEPTED test (requireTripMember), not main's "any trip_members row": an
 *      INVITED row no longer counts, and the trip's owner — who has no row by
 *      design, and whom GET and the like route already admit — now does. Anything else
 *      the post admits (a follower of a followers_only post; a legacy row with no
 *      visibility) → `false`, the route's 403. Whether such a reader may also see
 *      who liked the post is an owner question; the fail-closed default keeps
 *      main's narrower rule. A 403 to someone who may read the post reveals
 *      nothing they cannot already see.
 *
 * NO EXISTENCE ORACLE. Steps 1 (no row), 3, 4 and 5 return the SAME object, so a
 * post that does not exist and one this viewer may not read answer alike — as
 * they do on GET /posts/:postId.
 *
 * ── COMMENTS (decideCommentLikersAccess) ─────────────────────────────────────
 * The comment's row (not soft-deleted), then its post's rule above. Every
 * refusal is the comment's own 404 — "Comment not found", the body every comment
 * route in routes/posts.ts answers for a missing comment — so a comment on a post
 * the viewer may not read is indistinguishable from no comment at all. The block
 * read is the post AUTHOR's, as on every comment route in routes/posts.ts.
 *
 * ── THE LIKERS THEMSELVES ───────────────────────────────────────────────────
 * Unchanged and already right: the route drops every liker blocked either way
 * with the viewer (readBlockExclusions `among`, refusing 503 when unreadable).
 */
import type { Request, Response } from "express";
import { sendError, isAcceptedTripMember, TripAccessUnavailableError } from "./http.js";
import { isBlockedBetween } from "./blockGuard.js";
import { decidePostReadable, isPostPublished, needsFollowerCheck, needsTripMembershipCheck } from "./postVisibility.js";

/**
 * `true` lists the likers; `false` is the route's 403; `{ notFound }` is the
 * item's own 404 (the message is that read's); `"unreadable"` is a 503. Only
 * `true` admits — callers test `=== true`, never truthiness.
 */
export type PostLikersVerdict = boolean | "unreadable" | { readonly notFound: string };

export const POST_NOT_FOUND = { notFound: "Post not found" } as const; // GET /posts/:postId's body
export const COMMENT_NOT_FOUND = { notFound: "Comment not found" } as const; // the comment routes' body

/** The columns GET /posts/:postId's decision reads (POST_COLUMNS carries all of them). */
const POST_GATE_COLUMNS = "id, author_id, visibility, trip_id, status, post_status";

/** The post targets this gate answers for, and the one comment target. */
const POST_LIKE_TARGETS = new Set(["post_like", "post_reaction"]);
const COMMENT_LIKE_TARGET = "comment_like";

export async function decidePostLikersAccess(sc: any, viewerId: string, postId: string): Promise<PostLikersVerdict> {
  const { data: post, error } = await sc
    .from("posts")
    .select(POST_GATE_COLUMNS)
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();
  if (error) return "unreadable";
  if (!post) return POST_NOT_FOUND;
  const row = post as { author_id: string; visibility?: string | null; trip_id?: string | null; post_status?: string | null };

  if (row.author_id === viewerId) return true;
  if (!isPostPublished(row)) return POST_NOT_FOUND;
  if (await isBlockedBetween(sc, viewerId, row.author_id)) return POST_NOT_FOUND;

  let viewerIsTripMember = false;
  if (needsTripMembershipCheck(row, viewerId)) {
    const member = await acceptedTripMember(sc, row.trip_id as string, viewerId);
    if (member === null) return POST_NOT_FOUND; // unread membership is not "not a member" — and not a 503 either (step 5)
    viewerIsTripMember = member;
  }
  let viewerIsFollower = false;
  if (needsFollowerCheck(row, viewerId)) {
    const { data: follow, error: followErr } = await sc
      .from("user_follows")
      .select("follower_id")
      .eq("follower_id", viewerId)
      .eq("following_id", row.author_id)
      .maybeSingle();
    if (followErr) return POST_NOT_FOUND; // as the membership read above
    viewerIsFollower = !!follow;
  }

  const decision = decidePostReadable(row, viewerId, viewerIsTripMember, viewerIsFollower);
  if (!decision.readable) return POST_NOT_FOUND;
  if (row.visibility === "public") return true;
  if (row.visibility === "trip_only" && decision.reason === "trip_member") return true;
  return false;
}

export async function decideCommentLikersAccess(sc: any, viewerId: string, commentId: string): Promise<PostLikersVerdict> {
  const { data: comment, error } = await sc
    .from("posts_comments")
    .select("post_id")
    .eq("id", commentId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return "unreadable";
  if (!comment) return COMMENT_NOT_FOUND;
  const verdict = await decidePostLikersAccess(sc, viewerId, (comment as { post_id: string }).post_id);
  return typeof verdict === "object" ? COMMENT_NOT_FOUND : verdict;
}

/**
 * The route's half. For a post or comment target, answer the gate's own
 * refusal — 503 for an unreadable gate read, the item's 404 for every read
 * refusal — and return true. Otherwise return false: the route's `checkAccess`
 * then decides between the likers (200) and its 403.
 */
export async function answerPostLikersRefusal(
  req: Request,
  res: Response,
  sc: any,
  viewerId: string,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  let verdict: PostLikersVerdict;
  if (POST_LIKE_TARGETS.has(targetType)) verdict = await decidePostLikersAccess(sc, viewerId, targetId);
  else if (targetType === COMMENT_LIKE_TARGET) verdict = await decideCommentLikersAccess(sc, viewerId, targetId);
  else return false;

  if (verdict === "unreadable") {
    req.log.error(
      { targetType, targetId },
      "engagement/likes: the post gate's read failed — refusing rather than admitting or answering not_found",
    );
    sendError(res, "degraded_unavailable", "Reactions are temporarily unavailable");
    return true;
  }
  if (typeof verdict === "object") {
    sendError(res, "not_found", verdict.notFound);
    return true;
  }
  return false;
}

/** `isAcceptedTripMember`, with an unreadable membership as `null` rather than a thrown 503 (step 5). */
async function acceptedTripMember(sc: any, tripId: string, viewerId: string): Promise<boolean | null> {
  try {
    return await isAcceptedTripMember(sc, tripId, viewerId);
  } catch (err) {
    if (err instanceof TripAccessUnavailableError) return null;
    throw err;
  }
}
