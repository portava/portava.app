/**
 * GET /posts/:postId — the visibility read gate.
 *
 * The handler fetches the post with the SERVICE client, so RLS is bypassed and
 * this predicate is the only thing between a post id and its contents. It
 * previously gated on published-or-author alone and never read `visibility`,
 * even though POST_COLUMNS selects it — so any authenticated user holding an
 * id received private and trip_only posts in full.
 *
 * Run: node --import tsx/esm --test src/test/postVisibilityRead.test.ts
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import postsRouter from "../routes/posts.js";
import { _clearTestClient, _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import { makeFeedDb, type FakeFeedDb } from "./helpers/fakeFeedDb.js";
import {
  decidePostReadable,
  canReadPost,
  needsTripMembershipCheck,
  needsFollowerCheck,
} from "../lib/postVisibility.js";

const AUTHOR = "user-author";
const STRANGER = "user-stranger";
const TRIP = "trip-1";

const publicPost = { author_id: AUTHOR, visibility: "public", trip_id: null };
const privatePost = { author_id: AUTHOR, visibility: "private", trip_id: null };
const tripPost = { author_id: AUTHOR, visibility: "trip_only", trip_id: TRIP };

describe("GET /posts/:postId visibility gate", () => {
  it("public post — any authenticated viewer may read it", () => {
    const d = decidePostReadable(publicPost, STRANGER, false);
    assert.equal(d.readable, true);
    assert.equal(d.reason, "public");
  });

  it("private post — a non-author may NOT read it (the leak)", () => {
    const d = decidePostReadable(privatePost, STRANGER, false);
    assert.equal(d.readable, false, "a private post must never reach a stranger");
    assert.equal(d.reason, "private_not_author");
  });

  it("trip_only post — an accepted trip member MAY read it", () => {
    const d = decidePostReadable(tripPost, STRANGER, true);
    assert.equal(d.readable, true);
    assert.equal(d.reason, "trip_member");
  });

  it("trip_only post — a non-member may NOT read it", () => {
    const d = decidePostReadable(tripPost, STRANGER, false);
    assert.equal(d.readable, false);
    assert.equal(d.reason, "trip_only_not_member");
  });

  it("author reads their OWN private post — the gate must not lock them out", () => {
    // checkEngagePermission forbids `private` outright, including to the
    // author. Reusing it here would have traded a leak for a lockout, which is
    // why this is a separate predicate.
    const d = decidePostReadable(privatePost, AUTHOR, false);
    assert.equal(d.readable, true);
    assert.equal(d.reason, "author");
  });

  it("author reads their own trip_only post without being a trip member", () => {
    const d = decidePostReadable(tripPost, AUTHOR, false);
    assert.equal(d.readable, true);
    assert.equal(d.reason, "author");
  });
});

describe("followers_only tier (spec §5)", () => {
  const followersPost = { author_id: AUTHOR, visibility: "followers_only", trip_id: null };
  const followersRaw = { author_id: AUTHOR, visibility: "followers", trip_id: null };

  it("a FOLLOWER of the author may read a followers_only post", () => {
    const d = decidePostReadable(followersPost, STRANGER, false, /* viewerIsFollower */ true);
    assert.equal(d.readable, true, "the tier exists precisely to admit the author's followers");
    assert.equal(d.reason, "follower");
  });

  it("a NON-follower may NOT read a followers_only post (used to fail closed to everyone)", () => {
    const d = decidePostReadable(followersPost, STRANGER, false, /* viewerIsFollower */ false);
    assert.equal(d.readable, false);
    assert.equal(d.reason, "followers_only_not_follower");
  });

  it("absent viewerIsFollower defaults to a refusal (fail-closed)", () => {
    const d = decidePostReadable(followersPost, STRANGER, false);
    assert.equal(d.readable, false);
    assert.equal(d.reason, "followers_only_not_follower");
  });

  it("the raw `followers` value is the same tier as followers_only", () => {
    assert.equal(decidePostReadable(followersRaw, STRANGER, false, true).reason, "follower");
    assert.equal(decidePostReadable(followersRaw, STRANGER, false, false).reason, "followers_only_not_follower");
  });

  it("the author reads their own followers_only post without being their own follower", () => {
    const d = decidePostReadable(followersPost, AUTHOR, false, false);
    assert.equal(d.readable, true);
    assert.equal(d.reason, "author");
  });
});

describe("fail-closed behaviour", () => {
  it("an unrecognised visibility is NOT readable by a stranger", () => {
    const d = decidePostReadable(
      { author_id: AUTHOR, visibility: "some_future_tier", trip_id: null },
      STRANGER,
      false,
    );
    assert.equal(d.readable, false, "a new tier must not default to public");
    assert.equal(d.reason, "unknown_visibility");
  });

  it("an unrecognised visibility never locks the author out", () => {
    assert.equal(
      canReadPost({ author_id: AUTHOR, visibility: "some_future_tier", trip_id: null }, AUTHOR, false),
      true,
    );
  });

  it("a trip_only post with NO trip_id admits nobody but the author", () => {
    const malformed = { author_id: AUTHOR, visibility: "trip_only", trip_id: null };
    // Even claiming membership cannot admit a stranger — there is no trip to be
    // a member of, so a true here would mean membership of an unrelated trip.
    assert.equal(decidePostReadable(malformed, STRANGER, true).readable, false);
    assert.equal(decidePostReadable(malformed, AUTHOR, false).readable, true);
  });

  it("a legacy row with absent visibility is treated as public", () => {
    assert.equal(canReadPost({ author_id: AUTHOR, trip_id: null }, STRANGER, false), true);
    assert.equal(
      canReadPost({ author_id: AUTHOR, visibility: null, trip_id: null }, STRANGER, false),
      true,
    );
  });
});

describe("needsTripMembershipCheck — the query is only paid when it is needed", () => {
  it("is false for the author, public and private posts", () => {
    assert.equal(needsTripMembershipCheck(tripPost, AUTHOR), false, "author needs no lookup");
    assert.equal(needsTripMembershipCheck(publicPost, STRANGER), false);
    assert.equal(needsTripMembershipCheck(privatePost, STRANGER), false);
  });

  it("is true only for a trip_only post viewed by a non-author", () => {
    assert.equal(needsTripMembershipCheck(tripPost, STRANGER), true);
  });

  it("is false for a malformed trip_only post with no trip_id", () => {
    // Nothing to query, and the decision is already "refuse".
    assert.equal(
      needsTripMembershipCheck({ author_id: AUTHOR, visibility: "trip_only", trip_id: null }, STRANGER),
      false,
    );
  });
});

describe("needsFollowerCheck — the follow query is only paid when it is needed", () => {
  it("is true only for a followers_only / followers post viewed by a non-author", () => {
    assert.equal(needsFollowerCheck({ author_id: AUTHOR, visibility: "followers_only", trip_id: null }, STRANGER), true);
    assert.equal(needsFollowerCheck({ author_id: AUTHOR, visibility: "followers", trip_id: null }, STRANGER), true);
  });

  it("is false for the author, public, private and trip_only posts", () => {
    assert.equal(needsFollowerCheck({ author_id: AUTHOR, visibility: "followers_only", trip_id: null }, AUTHOR), false, "author needs no lookup");
    assert.equal(needsFollowerCheck(publicPost, STRANGER), false);
    assert.equal(needsFollowerCheck(privatePost, STRANGER), false);
    assert.equal(needsFollowerCheck(tripPost, STRANGER), false);
  });
});

describe("the route wires the predicate in", () => {
  it("GET /posts/:postId calls the gate and answers not_found on refusal", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "../routes/posts.ts"), "utf8");

    const handler = src.slice(src.indexOf('router.get("/posts/:postId"'));
    const body = handler.slice(0, handler.indexOf("\nrouter."));

    assert.match(body, /decidePostReadable\(/, "the handler must call the gate");
    assert.match(body, /needsTripMembershipCheck\(/, "membership must be conditional");
    assert.match(
      body,
      /if \(!decision\.readable\)[\s\S]{0,400}?sendError\(res, "not_found"/,
      "a refusal must answer not_found, never forbidden — forbidden confirms the post exists",
    );
  });
});

describe("BLOCKS-POSTS: post detail and comment-list authorization over HTTP", () => {
  const viewerId = "aaaaaaaa-0000-4000-a000-000000000001";
  const authorId = "bbbbbbbb-0000-4000-a000-000000000002";
  const commenterId = "cccccccc-0000-4000-a000-000000000003";
  const postId = "11111111-0000-4000-a000-000000000001";
  const missingId = "11111111-0000-4000-a000-000000000002";
  const tripId = "22222222-0000-4000-a000-000000000001";
  const commentId = "33333333-0000-4000-a000-000000000001";
  let database: FakeFeedDb;
  let server: http.Server;
  let baseUrl: string;
  let readFault: ((table: string, result: any) => any) | undefined;
  let throwFrom: string | undefined;

  before(async () => {
    const app = express();
    app.use((request: any, _response, next) => {
      request.log = { info() {}, warn() {}, error() {}, debug() {} };
      next();
    });
    app.use(postsRouter);
    app.use(globalErrorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    _setTestServiceClient(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    readFault = undefined;
    throwFrom = undefined;
    database = makeFeedDb({
      users: { viewer: viewerId, author: authorId },
      tables: {
        profiles: [viewerId, authorId, commenterId].map((id) => ({
          id, handle: `traveler-${id}`, name: "Traveler", account_status: "active",
        })),
        posts: [{
          id: postId, author_id: authorId, status: "active", post_status: "published",
          visibility: "public", trip_id: null, content: "Protected post content",
          created_at: "2026-10-01T00:00:00Z",
        }],
        posts_comments: [
          { id: commentId, post_id: postId, user_id: commenterId, body: "Visible comment", deleted_at: null, parent_comment_id: null, created_at: "2026-10-01T01:00:00Z" },
          { id: "deleted-comment", post_id: postId, user_id: commenterId, body: "Deleted comment", deleted_at: "2026-10-02T00:00:00Z", parent_comment_id: null },
        ],
        blocks: [],
        trip_members: [],
        trips: [{ id: tripId, owner_id: authorId }],
        user_follows: [],
      },
    });
    const originalFrom = database.client.from.bind(database.client);
    database.client.from = (table: string) => {
      if (throwFrom === table) throw new Error("lookup construction failed");
      const query = originalFrom(table);
      const originalThen = query.then.bind(query);
      const originalSingle = query.maybeSingle.bind(query);
      const originalSelect = query.select.bind(query);
      let selectedColumns = "*";
      query.select = (columns = "*", options?: any) => {
        selectedColumns = columns;
        return originalSelect(columns, options);
      };
      const transform = (result: any) => {
        if (table === "posts" && result.data && selectedColumns !== "*") {
          const columns = selectedColumns.split(",").map((column) => column.trim());
          result = { ...result, data: Object.fromEntries(Object.entries(result.data).filter(([column]) => columns.includes(column))) };
        }
        return readFault ? readFault(table, result) : result;
      };
      query.then = (fulfilled: any, rejected: any) => originalThen(transform).then(fulfilled, rejected);
      query.maybeSingle = () => originalSingle().then(transform);
      return query;
    };
    _setTestClient(database.client, true);
  });

  async function request(suffix: string, id = postId, token: string | null = "viewer") {
    const response = await fetch(`${baseUrl}/posts/${id}${suffix}`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
    };
  }

  async function assertNotFound(suffix: string) {
    const response = await request(suffix);
    assert.equal(response.status, 404, response.text);
    assert.deepEqual(JSON.parse(response.text), { error: "not_found", message: "Post not found" });
    assert.ok(!database.reads.some((read) => ["posts_comments", "post_media", "post_saves", "content_stamps", "comment_likes"].includes(read.table)), "refusal must precede content, identities and engagement reads");
    assert.deepEqual(response, await request(suffix, missingId));
    assert.equal(database.writes.length, 0);
  }

  const blockFaults: Array<[string, () => any]> = [
    ["returned error", () => ({ data: null, error: { message: "unreadable blocks" } })],
    ["error even with empty data", () => ({ data: [], error: { message: "unreadable blocks" } })],
    ["rejected lookup", () => { throw new Error("blocks read rejected"); }],
    ["null data without error", () => ({ data: null, error: null })],
    ["missing data", () => ({ error: null })],
    ["object instead of rows", () => ({ data: {}, error: null })],
    ["string instead of rows", () => ({ data: "[]", error: null })],
    ["missing envelope", () => undefined],
    ["a malformed deny row", () => ({ data: [null], error: null })],
  ];

  for (const suffix of ["", "/comments"]) {
    describe(`GET /posts/:postId${suffix}`, () => {
      for (const direction of ["outgoing", "incoming", "mutual"]) {
        it(`refuses a ${direction} viewer/author block exactly like a missing post`, async () => {
          if (direction !== "incoming") database.tables.blocks.push({ blocker_id: viewerId, blocked_id: authorId });
          if (direction !== "outgoing") database.tables.blocks.push({ blocker_id: authorId, blocked_id: viewerId });
          await assertNotFound(suffix);
        });
      }

      for (const [name, fault] of blockFaults) {
        it(`fails closed on ${name}`, async () => {
          readFault = (table, result) => table === "blocks" ? fault() : result;
          await assertNotFound(suffix);
        });
      }

      it("fails closed when constructing the block lookup throws", async () => {
        throwFrom = "blocks";
        await assertNotFound(suffix);
      });

      it("does not treat an absent post author as a clear block lookup", async () => {
        database.tables.posts[0].author_id = null;
        await assertNotFound(suffix);
      });

      it("serves allowed public content and ignores unrelated block edges", async () => {
        database.tables.blocks.push(
          { blocker_id: viewerId, blocked_id: commenterId },
          { blocker_id: commenterId, blocked_id: authorId },
        );
        const response = await request(suffix);
        assert.equal(response.status, 200, response.text);
        const body = JSON.parse(response.text);
        if (suffix === "") {
          assert.equal(body.content, "Protected post content");
          assert.equal(body.author.id, authorId);
          assert.equal(body.commentCount, 1);
        } else {
          assert.deepEqual(body.comments.map((comment: any) => comment.id), [commentId]);
          assert.equal(body.comments[0].body, "Visible comment");
          assert.equal(body.comments[0].author.id, commenterId);
        }
        assert.equal(database.writes.length, 0);
      });

      for (const token of [null, "invalid"]) {
        it(`refuses ${token === null ? "anonymous" : "invalid-token"} access before reading the post`, async () => {
          assert.equal((await request(suffix, postId, token)).status, 401);
          assert.ok(!database.reads.some((read) => read.table === "posts" || read.table === "blocks"));
        });
      }

      for (const status of ["deleted", "hidden"]) {
        it(`refuses a ${status} post even to its author`, async () => {
          database.tables.posts[0].status = status;
          await assertNotFound(suffix);
          assert.equal((await request(suffix, postId, "author")).status, 404);
          assert.ok(!database.reads.some((read) => read.table === "blocks"));
        });
      }

      it("refuses a non-author's private post without confirming its existence", async () => {
        database.tables.posts[0].visibility = "private";
        await assertNotFound(suffix);
      });

      it("admits the post author without consulting blocks", async () => {
        throwFrom = "blocks";
        const response = await request(suffix, postId, "author");
        assert.equal(response.status, 200, response.text);
        assert.ok(!database.reads.some((read) => read.table === "blocks"));
      });

      it("admits accepted trip members but still refuses a blocked member", async () => {
        Object.assign(database.tables.posts[0], { visibility: "trip_only", trip_id: tripId });
        database.tables.trip_members.push({ trip_id: tripId, user_id: viewerId, role: "member", status: "accepted" });
        assert.equal((await request(suffix)).status, 200);
        database.reads.length = 0;
        database.tables.blocks.push({ blocker_id: authorId, blocked_id: viewerId });
        await assertNotFound(suffix);
        assert.ok(!database.reads.some((read) => read.table === "trip_members"));
      });

      it("does not admit an invited trip member", async () => {
        Object.assign(database.tables.posts[0], { visibility: "trip_only", trip_id: tripId });
        database.tables.trip_members.push({ trip_id: tripId, user_id: viewerId, role: "invited", status: "invited" });
        await assertNotFound(suffix);
      });

      for (const table of ["trip_members", "trips"]) {
        for (const thrown of [false, true]) {
          it(`withholds content when ${table} lookup ${thrown ? "throws" : "returns an error"}`, async () => {
            Object.assign(database.tables.posts[0], { visibility: "trip_only", trip_id: tripId });
            readFault = (source, result) => {
              if (source !== table) return result;
              if (thrown) throw new Error("membership read rejected");
              return { data: null, error: { message: "unreadable membership" } };
            };
            const response = await request(suffix);
            assert.equal(response.status, thrown ? 500 : 503, response.text);
            assert.ok(!database.reads.some((read) => read.table === "posts_comments" || read.table === "post_media"));
          });
        }
      }

      it("reports a failed post lookup as an error, not absence", async () => {
        readFault = (table, result) => table === "posts" ? { data: null, error: { message: "post read unavailable" } } : result;
        const response = await request(suffix);
        assert.equal(response.status, 500, response.text);
        assert.equal(JSON.parse(response.text).error, "db_error");
        assert.deepEqual(response, await request(suffix, missingId));
        assert.ok(!database.reads.some((read) => read.table === "blocks" || read.table === "posts_comments"));
      });

      it("withholds content when the post lookup rejects", async () => {
        readFault = (table, result) => {
          if (table === "posts") throw new Error("post read rejected");
          return result;
        };
        assert.equal((await request(suffix)).status, 500);
        assert.ok(!database.reads.some((read) => read.table === "blocks" || read.table === "posts_comments"));
      });
    });
  }

  describe("comment reads inherit the post's publication and visibility decision", () => {
    for (const publication of ["draft", "private", "pending_location_exit", "pending_delay", "pending_safety_review", "canceled", "expired"]) {
      it(`refuses comments on ${publication} posts to non-authors, but preserves author access`, async () => {
        database.tables.posts[0].post_status = publication;
        await assertNotFound("/comments");
        assert.deepEqual(await request("/comments"), await request(""));
        const response = await request("/comments", postId, "author");
        assert.equal(response.status, 200, response.text);
        assert.equal(JSON.parse(response.text).comments[0].body, "Visible comment");
      });
    }

    for (const publication of ["published", null, undefined]) {
      it(`preserves legacy/public comments with publication ${String(publication)}`, async () => {
        database.tables.posts[0].post_status = publication;
        assert.equal((await request("/comments")).status, 200);
        assert.ok(!database.reads.some((read) => read.table === "user_follows" || read.table === "trip_members"));
      });
    }

    for (const visibility of ["followers_only", "followers"]) {
      it(`refuses ${visibility} comments to a non-follower despite reversed or unrelated follows`, async () => {
        database.tables.posts[0].visibility = visibility;
        database.tables.user_follows.push(
          { follower_id: authorId, following_id: viewerId },
          { follower_id: viewerId, following_id: commenterId },
          { follower_id: commenterId, following_id: authorId },
        );
        await assertNotFound("/comments");
        assert.deepEqual(await request("/comments"), await request(""));
      });

      it(`admits the ${visibility} author's follower, except across either block direction`, async () => {
        database.tables.posts[0].visibility = visibility;
        database.tables.user_follows.push({ follower_id: viewerId, following_id: authorId });
        const response = await request("/comments");
        assert.equal(response.status, 200, response.text);
        assert.equal(JSON.parse(response.text).comments[0].id, commentId);
        for (const [blocker_id, blocked_id] of [[viewerId, authorId], [authorId, viewerId]]) {
          database.tables.blocks = [{ blocker_id, blocked_id }];
          database.reads.length = 0;
          await assertNotFound("/comments");
          assert.ok(!database.reads.some((read) => read.table === "user_follows"));
        }
      });

      it(`admits the ${visibility} author without looking up follows`, async () => {
        database.tables.posts[0].visibility = visibility;
        throwFrom = "user_follows";
        assert.equal((await request("/comments", postId, "author")).status, 200);
        assert.ok(!database.reads.some((read) => read.table === "user_follows"));
      });
    }

    for (const failure of ["returned", "returned-with-data", "thrown"]) {
      it(`withholds comments on ${failure} follow lookup failure, matching detail`, async () => {
        database.tables.posts[0].visibility = "followers_only";
        readFault = (table, result) => {
          if (table !== "user_follows") return result;
          if (failure === "thrown") throw new Error("follow read rejected");
          return { data: failure === "returned-with-data" ? { follower_id: viewerId } : null, error: { message: "follow read unavailable" } };
        };
        const response = await request("/comments");
        assert.equal(response.status, failure === "thrown" ? 500 : 503, response.text);
        assert.deepEqual(response, await request(""));
        assert.ok(!database.reads.some((read) => read.table === "posts_comments" || read.table === "comment_likes"));
      });
    }

    for (const visibility of ["followers_only", "trip_only"]) {
      it(`does not let an admitted ${visibility} viewer bypass unpublished state`, async () => {
        Object.assign(database.tables.posts[0], { visibility, trip_id: tripId, post_status: "pending_delay" });
        database.tables.user_follows.push({ follower_id: viewerId, following_id: authorId });
        database.tables.trip_members.push({ trip_id: tripId, user_id: viewerId, role: "member", status: "accepted" });
        await assertNotFound("/comments");
        assert.ok(!database.reads.some((read) => read.table === "user_follows" || read.table === "trip_members"));
      });
    }

    for (const membership of [null, { role: "member", status: "declined" }, { role: "member", status: "pending" }]) {
      it(`refuses trip-only comments with membership ${JSON.stringify(membership)}`, async () => {
        Object.assign(database.tables.posts[0], { visibility: "trip_only", trip_id: tripId });
        if (membership) database.tables.trip_members.push({ trip_id: tripId, user_id: viewerId, ...membership });
        await assertNotFound("/comments");
        assert.deepEqual(await request("/comments"), await request(""));
      });
    }

    it("admits the trip owner without an explicit trip membership", async () => {
      Object.assign(database.tables.posts[0], { visibility: "trip_only", trip_id: tripId });
      database.tables.trips[0].owner_id = viewerId;
      assert.equal((await request("/comments")).status, 200);
      assert.equal(database.reads.filter((read) => read.table === "trip_members").length, 1);
    });

    it("preserves the existing trip-author engagement restriction", async () => {
      Object.assign(database.tables.posts[0], { visibility: "trip_only", trip_id: tripId });
      database.tables.trips[0].owner_id = commenterId;
      assert.equal((await request("/comments", postId, "author")).status, 403);
      assert.ok(!database.reads.some((read) => read.table === "posts_comments"));
    });

    it("refuses a trip-only post without a trip id", async () => {
      Object.assign(database.tables.posts[0], { visibility: "trip_only", trip_id: null });
      await assertNotFound("/comments");
      assert.ok(!database.reads.some((read) => read.table === "trip_members"));
    });

    it("fails closed for an unknown visibility rather than serving its comments", async () => {
      database.tables.posts[0].visibility = "future_visibility";
      await assertNotFound("/comments");
    });
  });

  for (const direction of ["outgoing", "incoming"]) {
    it(`preserves comment-author visibility for an ${direction} block (LR-B58-6; no new comment-only policy)`, async () => {
      const beforeDetail = await request("");
      const beforeComments = await request("/comments");
      database.tables.blocks.push(direction === "outgoing"
        ? { blocker_id: viewerId, blocked_id: commenterId }
        : { blocker_id: commenterId, blocked_id: viewerId });
      assert.deepEqual(await request(""), beforeDetail);
      assert.deepEqual(await request("/comments"), beforeComments);
    });
  }

  it("keeps an author's private detail readable without a block lookup", async () => {
    database.tables.posts[0].visibility = "private";
    throwFrom = "blocks";
    assert.equal((await request("", postId, "author")).status, 200);
    assert.equal((await request("/comments", postId, "author")).status, 403);
  });

  it("keeps unpublished detail author-only", async () => {
    database.tables.posts[0].post_status = "pending_delay";
    await assertNotFound("");
    assert.equal((await request("", postId, "author")).status, 200);
  });

  it("admits a follower to detail but still refuses either block direction", async () => {
    database.tables.posts[0].visibility = "followers_only";
    database.tables.user_follows.push({ follower_id: viewerId, following_id: authorId });
    assert.equal((await request("")).status, 200);
    for (const [blocker_id, blocked_id] of [[viewerId, authorId], [authorId, viewerId]]) {
      database.tables.blocks = [{ blocker_id, blocked_id }];
      database.reads.length = 0;
      await assertNotFound("");
      assert.ok(!database.reads.some((read) => read.table === "user_follows"));
    }
  });

  for (const thrown of [false, true]) {
    it(`withholds detail when the follow lookup ${thrown ? "throws" : "returns an error"}`, async () => {
      database.tables.posts[0].visibility = "followers_only";
      readFault = (table, result) => {
        if (table !== "user_follows") return result;
        if (thrown) throw new Error("follow read rejected");
        return { data: null, error: { message: "follow read unavailable" } };
      };
      assert.equal((await request("")).status, thrown ? 500 : 503);
      assert.ok(!database.reads.some((read) => read.table === "posts_comments" || read.table === "post_media"));
    });
  }
});
