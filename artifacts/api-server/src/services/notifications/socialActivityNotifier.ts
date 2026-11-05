/**
 * socialActivityNotifier — the producers for the social templates that had
 * none.
 *
 * NotificationTemplateService has carried `pulse.post_liked`,
 * `pulse.post_comment`, `trip_crew.follow` and `trip_crew.friend_request`
 * since the notifications pipeline was built, but no route ever created them:
 * the only notifications the post, comment, reply and follow handlers wrote
 * were @mentions and stamp awards. A traveller whose post was liked, commented
 * on or followed heard nothing, in the app or by push.
 *
 * Every function here is fire-and-forget from the caller's point of view: it
 * runs AFTER the response is sent, never throws, and a failure only logs.
 *
 * What each one refuses to do:
 *   - notify the actor about their own action;
 *   - notify across a block in either direction, or when the block list
 *     cannot be read (isExcluded answers true for an unreadable pair);
 *   - name the actor by anything but their public @handle (the display name
 *     has its own visibility rules, lib/publicIdentity.ts).
 *
 * Repeats are bounded by NotificationService's own dedup, which suppresses a
 * second row with the same (recipient, category, source_type, source_id)
 * inside its rolling window. Likes use the post as the source, so a burst of
 * likes on one post is one notification per window; comments and replies use
 * the comment as the source, so each one is its own notification, and a
 * comment that also @mentions the post's author (source 'comment', same id)
 * is not notified twice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isExcluded, readPairExclusion } from "../../lib/exclusionSet.js";
import { NotificationService } from "./NotificationService.js";
import { NotificationRouter } from "./NotificationRouter.js";

const logger = rootLogger.child({ service: "socialActivityNotifier" });

/** Longest comment / caption excerpt carried into a notification body. */
export const SOCIAL_PREVIEW_MAX = 80;

export function socialPreview(text: string | null | undefined): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > SOCIAL_PREVIEW_MAX ? `${t.slice(0, SOCIAL_PREVIEW_MAX - 1)}…` : t;
}

async function actorHandle(sc: SupabaseClient, actorId: string): Promise<string | null> {
  const { data, error } = await sc.from("profiles").select("handle, username").eq("id", actorId).maybeSingle();
  if (error || !data) return null;
  const handle = (data as any).username ?? (data as any).handle ?? null;
  return typeof handle === "string" && handle.length > 0 ? `@${handle}` : null;
}

interface Delivery {
  recipientId: string;
  actorId: string;
  eventType: string;
  sourceType: string;
  sourceId: string;
  params: Record<string, string>;
  /** Overrides the template's title; given the actor's @handle. */
  title?: (actor: string) => string;
  actionUrl?: string;
}

/**
 * The one write path: self, block and handle checks, then the full
 * NotificationService pipeline (dedup, privacy guard, persist) and the router
 * (per-channel preferences, push). Answers whether a row was written.
 */
export async function deliverSocialNotification(sc: SupabaseClient | null, d: Delivery): Promise<boolean> {
  try {
    if (!sc || !d.recipientId || !d.actorId || d.recipientId === d.actorId) return false;
    if (isExcluded(await readPairExclusion(sc, d.actorId, d.recipientId), d.recipientId)) return false;
    const actor = await actorHandle(sc, d.actorId);
    if (!actor) return false;
    const svc = new NotificationService(sc);
    const row = await svc.create({
      userId: d.recipientId,
      eventType: d.eventType,
      actorId: d.actorId,
      senderId: d.actorId,
      sourceType: d.sourceType,
      sourceId: d.sourceId,
      params: { actor, ...d.params },
      ...(d.title ? { title: d.title(actor) } : {}),
      ...(d.actionUrl ? { actionUrl: d.actionUrl } : {}),
    });
    if (!row) return false;
    await new NotificationRouter(sc).route(row);
    return true;
  } catch (err) {
    logger.warn({ err, eventType: d.eventType }, "social notification failed (non-fatal)");
    return false;
  }
}

/** Someone liked (stamped) a post: tell its author. */
export function notifyPostLiked(
  sc: SupabaseClient | null,
  a: { actorId: string; postId: string; authorId: string },
): Promise<boolean> {
  return deliverSocialNotification(sc, {
    recipientId: a.authorId,
    actorId: a.actorId,
    eventType: "pulse.post_liked",
    sourceType: "post_like",
    sourceId: a.postId,
    params: { postId: a.postId },
  });
}

/** Someone commented on a post: tell its author. */
export function notifyPostCommented(
  sc: SupabaseClient | null,
  a: { actorId: string; postId: string; authorId: string; commentId: string; body: string },
): Promise<boolean> {
  const comment = socialPreview(a.body);
  return deliverSocialNotification(sc, {
    recipientId: a.authorId,
    actorId: a.actorId,
    eventType: "pulse.post_comment",
    sourceType: "comment",
    sourceId: a.commentId,
    params: { postId: a.postId, ...(comment ? { comment } : {}) },
  });
}

/**
 * Someone replied to a comment: tell the comment's author, and the post's
 * author when that is a third person (one notification each, never two for
 * the same person).
 */
export async function notifyCommentReplied(
  sc: SupabaseClient | null,
  a: { actorId: string; postId: string; postAuthorId: string; parentCommentId: string; replyId: string; body: string },
): Promise<void> {
  if (!sc) return;
  let parentAuthorId: string | null = null;
  try {
    const { data, error } = await sc.from("posts_comments").select("user_id").eq("id", a.parentCommentId).maybeSingle();
    if (!error && data) parentAuthorId = ((data as any).user_id as string) ?? null;
  } catch (err) {
    logger.warn({ err }, "reply notification: parent comment read failed (non-fatal)");
  }
  const comment = socialPreview(a.body);
  const params: Record<string, string> = { postId: a.postId, ...(comment ? { comment } : {}) };
  const sent = new Set<string>();
  if (parentAuthorId) {
    sent.add(parentAuthorId);
    await deliverSocialNotification(sc, {
      recipientId: parentAuthorId,
      actorId: a.actorId,
      eventType: "pulse.post_comment",
      sourceType: "comment",
      sourceId: a.replyId,
      params,
      title: (actor) => `${actor} replied to your comment`,
    }).then(() => undefined);
  }
  if (a.postAuthorId && !sent.has(a.postAuthorId)) {
    await deliverSocialNotification(sc, {
      recipientId: a.postAuthorId,
      actorId: a.actorId,
      eventType: "pulse.post_comment",
      sourceType: "comment",
      sourceId: a.replyId,
      params,
    });
  }
}

/** Someone started following a public profile: tell the person followed. */
export function notifyFollowed(
  sc: SupabaseClient | null,
  a: { actorId: string; targetId: string },
): Promise<boolean> {
  return deliverSocialNotification(sc, {
    recipientId: a.targetId,
    actorId: a.actorId,
    eventType: "trip_crew.follow",
    sourceType: "follow",
    sourceId: a.actorId,
    params: { userId: a.actorId },
  });
}

/** Someone asked to connect (a friend request, or a follow of a private profile). */
export function notifyFriendRequested(
  sc: SupabaseClient | null,
  a: { actorId: string; recipientId: string; requestId: string },
): Promise<boolean> {
  return deliverSocialNotification(sc, {
    recipientId: a.recipientId,
    actorId: a.actorId,
    eventType: "trip_crew.friend_request",
    sourceType: "friend_request",
    sourceId: a.requestId,
    params: {},
    // The incoming-requests screen is where they are accepted or declined.
    actionUrl: "/follow-requests",
  });
}
