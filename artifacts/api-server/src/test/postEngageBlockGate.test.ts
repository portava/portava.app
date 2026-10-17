/**
 * postEngageBlockGate — census-telegraph T220 (wave 5).
 *
 * POST /posts/:postId/like, POST /posts/:postId/comments and the reply door
 * (POST /posts/:postId/comments/:commentId/replies) in routes/posts.ts
 * each refuse a block in EITHER direction. Their block reads moved onto the
 * shared pair reader (`readPairExclusion` + `isExcluded`, lib/exclusionSet.ts),
 * and when they did, no suite exercised them: ignoring the block, or answering
 * an unreadable `blocks` as "no block", survived every test that imports the
 * router. This pins each door's three answers:
 *
 *   a block either way   → refused (like: 404 not_found; comment: 403 blocked_user)
 *   blocks unreadable    → refused the same way (fail-closed, never "no block")
 *   no block             → not refused by the block gate (CONTROL)
 *
 * The like door is driven end to end. The comment doors are driven only as far
 * as the block gate: the CONTROL asserts the answer is not the block refusal,
 * whatever later gates say, so the case measures this gate and nothing else.
 *
 * node:test + the shared fakeFeedDb (a real `.or()`, failures RESOLVE).
 * Run: node --import tsx/esm --test src/test/postEngageBlockGate.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";
import { makeFeedDb, type FakeFeedDbSpec } from "./helpers/fakeFeedDb.js";

const VIEWER = "aaaaaaaa-0000-4000-a000-0000000000a1";
const AUTHOR = "bbbbbbbb-0000-4000-a000-0000000000b2";
const POST = "11111111-0000-4000-a000-000000000011";
const PARENT = "22222222-0000-4000-a000-000000000022";
const TOKEN = "tok-viewer";

function seed(over: { blocks?: Array<{ blocker_id: string; blocked_id: string }>; blocksUnreadable?: boolean } = {}): FakeFeedDbSpec {
  return {
    users: { [TOKEN]: VIEWER },
    tables: {
      posts: [{
        id: POST, author_id: AUTHOR, status: "active", post_status: "published", visibility: "public",
        trip_id: null, comments_setting: "everyone", content: "hello", created_at: "2026-10-01T00:00:00Z",
      }],
      profiles: [
        { id: VIEWER, account_status: "active", username: "viewer" },
        { id: AUTHOR, account_status: "active", username: "author" },
      ],
      posts_comments: [{ id: PARENT, post_id: POST, user_id: AUTHOR, parent_comment_id: null, deleted_at: null, body: "root" }],
      blocks: over.blocks ?? [],
      feature_flags: [],
    },
    ...(over.blocksUnreadable ? { failReads: { blocks: true as const } } : {}),
  };
}

let server: http.Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
    next();
  });
  app.use("/api", postsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function use(spec: FakeFeedDbSpec) {
  _setTestClient(makeFeedDb(spec).client, true);
}

async function post(path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const EITHER_WAY = [
  ["the author blocked the viewer", { blocker_id: AUTHOR, blocked_id: VIEWER }],
  ["the viewer blocked the author", { blocker_id: VIEWER, blocked_id: AUTHOR }],
] as const;

describe("POST /posts/:postId/like — the block gate (T220)", () => {
  for (const [label, row] of EITHER_WAY) {
    it(`${label} → 404, and nothing is stamped`, async () => {
      use(seed({ blocks: [row] }));
      const r = await post(`/posts/${POST}/like`);
      assert.equal(r.status, 404, JSON.stringify(r.body));
    });
  }

  it("blocks unreadable → 404 (fail-closed), never a like", async () => {
    use(seed({ blocksUnreadable: true }));
    const r = await post(`/posts/${POST}/like`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it("CONTROL: no block → the block gate does not refuse", async () => {
    use(seed());
    const r = await post(`/posts/${POST}/like`);
    assert.notEqual(r.status, 404, JSON.stringify(r.body));
  });
});

for (const [door, path] of [["POST /posts/:postId/comments", `/posts/${POST}/comments`], ["POST /posts/:postId/comments/:commentId/replies", `/posts/${POST}/comments/${PARENT}/replies`]] as const) {
  describe(`${door} — the block gate (T220)`, () => {
    const isBlockRefusal = (r: { status: number; body: any }) => r.status === 403 && r.body?.error === "blocked_user";

    for (const [label, row] of EITHER_WAY) {
      it(`${label} → 403 blocked_user`, async () => {
        use(seed({ blocks: [row] }));
        const r = await post(path, { body: "hi" });
        assert.ok(isBlockRefusal(r), JSON.stringify(r));
      });
    }

    it("blocks unreadable → 403 blocked_user (fail-closed)", async () => {
      use(seed({ blocksUnreadable: true }));
      const r = await post(path, { body: "hi" });
      assert.ok(isBlockRefusal(r), JSON.stringify(r));
    });

    it("CONTROL: no block → not the block refusal", async () => {
      use(seed());
      const r = await post(path, { body: "hi" });
      assert.ok(!isBlockRefusal(r), JSON.stringify(r));
    });
  });
}
