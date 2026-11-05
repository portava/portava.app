/**
 * socialActivityNotifier — likes, comments, replies, follows and friend
 * requests notify the person they are about, through the real
 * NotificationService pipeline, and never across a block, never to the actor,
 * never naming the actor by anything but their @handle.
 *
 * Also pins the tap targets this change fixed in the templates: a mention opens
 * its post, a Find Your Circle notice opens /circle-presence, the Compass
 * "leave earlier" nudge opens /route/:id.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/socialActivityNotifications.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFakeClient } from "./telegraphCertificationHarness.js";
import {
  deliverSocialNotification,
  notifyCommentReplied,
  notifyFollowed,
  notifyFriendRequested,
  notifyPostCommented,
  notifyPostLiked,
  socialPreview,
  SOCIAL_PREVIEW_MAX,
} from "../services/notifications/socialActivityNotifier.js";
import { circlePresenceUrl, renderTemplate } from "../services/notifications/NotificationTemplateService.js";

const ALICE = "a0000000-0000-4000-8000-000000000001";
const BOB = "b0000000-0000-4000-8000-000000000002";
const CARA = "c0000000-0000-4000-8000-000000000003";
const POST = "d0000000-0000-4000-8000-000000000004";
const COMMENT = "e0000000-0000-4000-8000-000000000005";
const REPLY = "f0000000-0000-4000-8000-000000000006";
const REQ = "10000000-0000-4000-8000-000000000007";

function db(extra: Record<string, any[]> = {}) {
  return makeFakeClient({
    profiles: [
      { id: ALICE, handle: "alice_1a2b", username: "alice" },
      { id: BOB, handle: "bob_3c4d", username: "bob" },
      { id: CARA, handle: "cara_5e6f", username: null },
    ],
    blocks: [],
    notifications: [],
    posts_comments: [{ id: COMMENT, post_id: POST, user_id: CARA }],
    ...extra,
  });
}

const rows = (sc: ReturnType<typeof db>) => sc._store.notifications as Array<Record<string, any>>;

describe("socialActivityNotifier", () => {
  it("a like tells the post's author, named by @handle, and opens the post", async () => {
    const sc = db();
    assert.equal(await notifyPostLiked(sc as any, { actorId: ALICE, postId: POST, authorId: BOB }), true);
    const [n] = rows(sc);
    assert.equal(n.user_id, BOB);
    assert.equal(n.event_type, "pulse.post_liked");
    assert.equal(n.actor_id, ALICE);
    assert.equal(n.title, "@alice liked your post");
    assert.equal(n.action_url, `/post/${POST}`);
  });

  it("a burst of likes on one post is one notification inside the dedup window", async () => {
    // The like already notified a minute ago (the fake insert stamps no
    // created_at, so the earlier row is seeded with one).
    const sc = db({
      notifications: [{
        id: "n1", user_id: BOB, category: "pulse", event_type: "pulse.post_liked",
        source_type: "post_like", source_id: POST, created_at: new Date(Date.now() - 60_000).toISOString(),
      }],
    });
    assert.equal(await notifyPostLiked(sc as any, { actorId: CARA, postId: POST, authorId: BOB }), false);
    assert.equal(rows(sc).length, 1);
  });

  it("liking your own post tells nobody", async () => {
    const sc = db();
    assert.equal(await notifyPostLiked(sc as any, { actorId: BOB, postId: POST, authorId: BOB }), false);
    assert.equal(rows(sc).length, 0);
  });

  it("a block in either direction suppresses it", async () => {
    for (const block of [{ blocker_id: BOB, blocked_id: ALICE }, { blocker_id: ALICE, blocked_id: BOB }]) {
      const sc = db({ blocks: [block] });
      assert.equal(await notifyPostLiked(sc as any, { actorId: ALICE, postId: POST, authorId: BOB }), false);
      assert.equal(rows(sc).length, 0);
    }
  });

  it("an unreadable block list suppresses it (fail closed)", async () => {
    const sc = makeFakeClient(
      { profiles: [{ id: ALICE, handle: "alice_1a2b", username: "alice" }], notifications: [] },
      { errors: { blocks: { message: "boom" } as any } },
    );
    assert.equal(await notifyPostLiked(sc as any, { actorId: ALICE, postId: POST, authorId: BOB }), false);
    assert.equal((sc._store.notifications as any[]).length, 0);
  });

  it("a comment carries an excerpt and opens the post", async () => {
    const sc = db();
    await notifyPostCommented(sc as any, { actorId: ALICE, postId: POST, authorId: BOB, commentId: COMMENT, body: "  Great   shot!  " });
    const [n] = rows(sc);
    assert.equal(n.event_type, "pulse.post_comment");
    assert.equal(n.title, "@alice commented");
    assert.equal(n.body, "Great shot!");
    assert.equal(n.source_type, "comment");
    assert.equal(n.source_id, COMMENT);
    assert.equal(n.action_url, `/post/${POST}`);
  });

  it("a reply tells the comment's author and the post's author once each", async () => {
    const sc = db();
    await notifyCommentReplied(sc as any, { actorId: ALICE, postId: POST, postAuthorId: BOB, parentCommentId: COMMENT, replyId: REPLY, body: "agreed" });
    const got = rows(sc).map((n) => [n.user_id, n.title]).sort();
    assert.deepEqual(got, [[BOB, "@alice commented"], [CARA, "@alice replied to your comment"]].sort());
  });

  it("replying to your own comment on your own post tells nobody", async () => {
    const sc = db({ posts_comments: [{ id: COMMENT, post_id: POST, user_id: ALICE }] });
    await notifyCommentReplied(sc as any, { actorId: ALICE, postId: POST, postAuthorId: ALICE, parentCommentId: COMMENT, replyId: REPLY, body: "+1" });
    assert.equal(rows(sc).length, 0);
  });

  it("a follow tells the person followed and opens the follower's profile", async () => {
    const sc = db();
    await notifyFollowed(sc as any, { actorId: ALICE, targetId: BOB });
    const [n] = rows(sc);
    assert.equal(n.event_type, "trip_crew.follow");
    assert.equal(n.title, "@alice followed you");
    assert.equal(n.action_url, `/u/${ALICE}`);
  });

  it("a friend request opens the incoming-requests screen", async () => {
    const sc = db();
    await notifyFriendRequested(sc as any, { actorId: CARA, recipientId: BOB, requestId: REQ });
    const [n] = rows(sc);
    assert.equal(n.event_type, "trip_crew.friend_request");
    assert.equal(n.title, "@cara_5e6f sent a friend request", "no username falls back to the handle");
    assert.equal(n.action_url, "/follow-requests");
  });

  it("an actor with no readable profile is not named as someone else", async () => {
    const sc = db();
    const ghost = "99999999-0000-4000-8000-000000000009";
    assert.equal(await deliverSocialNotification(sc as any, {
      recipientId: BOB, actorId: ghost, eventType: "pulse.post_liked", sourceType: "post_like", sourceId: POST, params: { postId: POST },
    }), false);
    assert.equal(rows(sc).length, 0);
  });

  it("a null client never throws", async () => {
    assert.equal(await notifyPostLiked(null, { actorId: ALICE, postId: POST, authorId: BOB }), false);
  });

  it("socialPreview trims, collapses whitespace and caps the length", () => {
    assert.equal(socialPreview("  a \n b  "), "a b");
    assert.equal(socialPreview(""), undefined);
    const long = socialPreview("x".repeat(500))!;
    assert.equal(long.length, SOCIAL_PREVIEW_MAX);
    assert.ok(long.endsWith("…"));
  });
});

describe("notification tap targets that used to open a missing screen", () => {
  it("a mention opens the post it was made on, never /feed or /comment/:id", () => {
    assert.equal(renderTemplate("pulse.user_tagged", { postId: POST, sourceType: "comment", sourceId: COMMENT })?.actionUrl, `/post/${POST}`);
    assert.equal(renderTemplate("pulse.user_tagged", { sourceType: "post", sourceId: POST })?.actionUrl, `/post/${POST}`);
    assert.equal(renderTemplate("pulse.user_tagged", { sourceType: "message", sourceId: "m" })?.actionUrl, "/(tabs)/messages");
    assert.equal(renderTemplate("pulse.user_tagged", {})?.actionUrl, "/notifications");
  });

  it("every Find Your Circle notice opens circle-presence for its trip or event", () => {
    for (const eventType of ["circle.sharing_enabled", "circle.sharing_paused", "circle.need_help_host_alert"]) {
      assert.equal(
        renderTemplate(eventType, { contextType: "trip", contextId: POST, actor: "@alice" })?.actionUrl,
        `/circle-presence?contextType=trip&contextId=${POST}`,
        eventType,
      );
    }
    assert.equal(circlePresenceUrl({}), "/circle");
  });

  it("the Compass leave-earlier nudge opens the route screen", () => {
    assert.equal(renderTemplate("compass.sense.leave_earlier", { routePlanId: "p1" })?.actionUrl, "/route/p1");
  });
});
