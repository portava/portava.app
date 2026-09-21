/**
 * §37 — "Moderation takedowns propagate to cached Wall projections", and §31 —
 * "revalidate eligibility".
 *
 * WHAT WAS MISSING. Server-side propagation was already real: `passesEligibility`
 * drops a removed/taken-down object on every `GET /wall`. The CLIENT CACHE did
 * not: `services/wallPrefetch` persists whole projections for up to 24 h and
 * `useWallFeed` re-displays them when a live fetch fails, with no re-validation.
 * The offline page was the one path on which a taken-down object could still
 * paint. `POST /wall/revalidate` is the propagation path, and this file is its
 * proof.
 *
 * THE CONTRACT IS AN ALLOWLIST, AND THAT IS THE POINT. The endpoint answers with
 * the ids that are STILL eligible, never with the ids that were revoked. Every
 * way an object can vanish — deleted, taken down, unpublished, author
 * deactivated, block created, visibility narrowed, viewer hid it, database
 * unreadable — is expressed as absence from the answer, so a reason nobody
 * enumerated fails CLOSED instead of open. Each test below removes exactly one
 * such thing and asserts the id disappears from the answer.
 *
 * IT RE-RUNS THE REAL GATE. The route rebuilds candidates and pushes them
 * through `projectObjects` — the same eligibility → block → visibility path the
 * feed uses — so there is no second moderation predicate that can drift.
 *
 * MUTATION PROOF (each verified: revert → RED, restore → GREEN)
 *   • drop the `status === "active"` term from the route's `live` filter → the
 *     takedown test goes RED (a taken-down post is re-admitted).
 *   • drop the `post_status === "published"` term AND the `isPostPublished(r)`
 *     call → the unpublished test RED. (Removing only one leaves the other
 *     holding: the delayed-publish predicate is applied twice on purpose, once
 *     as a column comparison and once through the canonical helper.)
 *   • drop the `deleted_at == null` term → the tombstone test RED.
 *   • return `requested` instead of the projected survivors → four tests RED.
 *   • answer `{ eligibleObjectIds: requested }` on the read-error path (fail
 *     OPEN instead of closed) → the unreadable-database test RED.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import wallRouter, { MAX_REVALIDATE_IDS } from "../routes/wall.js";

const TOKEN = "tok";
const VIEWER = "viewer-1";
const AUTHOR = "author-1";

interface World {
  posts: any[];
  profiles: any[];
  blocks: any[];
  rankEvents: any[];
  follows: any[];
  errorTables: Set<string>;
}

function livePost(over: Record<string, unknown> = {}) {
  return {
    id: "post-1",
    author_id: AUTHOR,
    trip_id: null,
    visibility: "public",
    status: "active",
    post_status: "published",
    deleted_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    published_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

function freshWorld(): World {
  return {
    posts: [livePost()],
    profiles: [{ id: AUTHOR, account_status: "active" }],
    blocks: [],
    rankEvents: [],
    follows: [],
    errorTables: new Set<string>(),
  };
}

let world: World = freshWorld();

/**
 * Table-routed fake. `maybeSingle` yields the first row (loadViewerContext's
 * own `profiles` read lands there and finds no city, which is normal), a plain
 * await yields the whole list. A table in `errorTables` fails like PostgREST.
 */
function fakeClient() {
  function builder(table: string) {
    const eqs: Record<string, unknown> = {};
    let single = false;
    const rowsFor = (): any[] => {
      switch (table) {
        case "posts":
          return world.posts;
        case "profiles":
          return world.profiles;
        case "blocks":
          return world.blocks;
        case "rank_events":
          return world.rankEvents;
        case "user_follows":
          return world.follows;
        default:
          return [];
      }
    };
    const resolve = () => {
      if (table === "feature_flags") {
        return { data: { enabled: String(eqs.flag) === "wall_enabled" }, error: null };
      }
      if (world.errorTables.has(table)) {
        return { data: null, error: { code: "PGRST100", message: "boom" } };
      }
      const rows = rowsFor();
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        eqs[c] = v;
        return b;
      },
      in: () => b, is: () => b, or: () => b, ilike: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b,
      insert: () => Promise.resolve({ error: null }),
      maybeSingle: () => {
        single = true;
        return Promise.resolve().then(resolve);
      },
      then: (onF: any, onR: any) => Promise.resolve().then(resolve).then(onF, onR),
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

let server: http.Server;
let baseUrl = "";

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": String(payload.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const revalidate = (ids: string[]) => post("/api/wall/revalidate", { objectIds: ids });

describe("POST /wall/revalidate — takedowns reach the cached page (§31/§37)", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
    await new Promise<void>((r) => {
      server = app.listen(0, "127.0.0.1", () => r());
    });
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    world = freshWorld();
    _resetRateLimit();
    _setTestClient(fakeClient() as any, true);
  });

  // ── The positive control ──────────────────────────────────────────────────
  it("re-admits an object that is still eligible", async () => {
    const res = await revalidate(["post-1"]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.eligibleObjectIds, ["post-1"]);
    assert.equal(typeof res.json.generatedAt, "string");
  });

  // ── The requirement itself ────────────────────────────────────────────────
  it("a MODERATION TAKEDOWN removes the id from the answer", async () => {
    world.posts = [livePost({ status: "removed" })];
    const res = await revalidate(["post-1"]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.eligibleObjectIds, []);
  });

  it("a soft-deleted (tombstoned) object is not re-admitted", async () => {
    world.posts = [livePost({ deleted_at: "2026-09-02T00:00:00.000Z" })];
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  it("an object pulled back to unpublished is not re-admitted", async () => {
    world.posts = [livePost({ post_status: "pending_location_exit" })];
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  it("an id that no longer exists at all is not re-admitted", async () => {
    world.posts = [];
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  // ── The other ways an object stops being showable ─────────────────────────
  it("a deactivated author's object is not re-admitted (§23 allowlist)", async () => {
    world.profiles = [{ id: AUTHOR, account_status: "deactivated" }];
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  it("a block created since the page was cached removes the id", async () => {
    world.blocks = [{ blocker_id: VIEWER, blocked_id: AUTHOR }];
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  it("a visibility tier the viewer has fallen out of removes the id", async () => {
    // followers_only + the viewer follows nobody ⇒ not readable any more.
    world.posts = [livePost({ visibility: "followers_only" })];
    world.follows = [];
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  it("an object the viewer marked not-interested is not re-admitted", async () => {
    world.rankEvents = [{ item_id: "post-1" }];
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  // ── Fail CLOSED ───────────────────────────────────────────────────────────
  it("an unreadable posts table re-admits NOTHING (fails closed, not open)", async () => {
    world.errorTables.add("posts");
    const res = await revalidate(["post-1"]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.eligibleObjectIds, []);
  });

  it("an unreadable blocks table re-admits nothing (the block gate fails closed)", async () => {
    world.errorTables.add("blocks");
    assert.deepEqual((await revalidate(["post-1"])).json.eligibleObjectIds, []);
  });

  // ── Mixed pages keep the survivors ────────────────────────────────────────
  it("keeps the survivors of a mixed page and drops only the revoked", async () => {
    world.posts = [
      livePost({ id: "post-1" }),
      livePost({ id: "post-2", status: "takedown" }),
      livePost({ id: "post-3" }),
    ];
    const res = await revalidate(["post-1", "post-2", "post-3"]);
    assert.deepEqual(res.json.eligibleObjectIds, ["post-1", "post-3"]);
  });

  it("answers in the REQUESTED order, and never invents an id", async () => {
    world.posts = [livePost({ id: "post-3" }), livePost({ id: "post-1" })];
    const res = await revalidate(["post-1", "post-3"]);
    assert.deepEqual(res.json.eligibleObjectIds, ["post-1", "post-3"]);
  });

  // ── Contract guards ───────────────────────────────────────────────────────
  it("rejects an empty or oversized id list", async () => {
    assert.equal((await revalidate([])).status, 400);
    const tooMany = Array.from({ length: MAX_REVALIDATE_IDS + 1 }, (_, i) => `p${i}`);
    assert.equal((await revalidate(tooMany)).status, 400);
  });

  it("requires authentication", async () => {
    const url = new URL(baseUrl + "/api/wall/revalidate");
    const payload = Buffer.from(JSON.stringify({ objectIds: ["post-1"] }));
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(payload.length) },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
    assert.equal(status, 401);
  });
});
