/**
 * GET /posts/:postId — the visibility read gate.
 *
 * The handler fetches the post with the SERVICE client, so RLS is bypassed and
 * this predicate is the only thing between a post id and its contents. It
 * previously gated on published-or-author alone and never read `visibility`,
 * even though POST_COLUMNS selects it — so any authenticated user holding an
 * id received private and trip_only posts in full.
 *
 * Tests are against the pure decision function rather than the Express
 * handler, because the property is a decision, not a response shape: five
 * viewer/visibility combinations, each of which must be admitted or refused
 * for a NAMED reason.
 *
 * Run: node --import tsx/esm --test src/test/postVisibilityRead.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decidePostReadable,
  canReadPost,
  needsTripMembershipCheck,
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

describe("fail-closed behaviour", () => {
  it("an unrecognised visibility is NOT readable by a stranger", () => {
    const d = decidePostReadable(
      { author_id: AUTHOR, visibility: "followers_only", trip_id: null },
      STRANGER,
      false,
    );
    assert.equal(d.readable, false, "a new tier must not default to public");
    assert.equal(d.reason, "unknown_visibility");
  });

  it("an unrecognised visibility never locks the author out", () => {
    assert.equal(
      canReadPost({ author_id: AUTHOR, visibility: "followers_only", trip_id: null }, AUTHOR, false),
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
