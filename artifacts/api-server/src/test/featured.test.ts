/**
 * featured.test.ts
 *
 * Confirms that GET /api/featured returns the seeded portava_featured rows
 * and that a user who has never followed @Portava sees all of them.
 *
 * The endpoint is fully public (no auth required), so the absence of a
 * follow relationship is implicit — no auth token is sent and the endpoint
 * never checks for one.
 *
 * Covers:
 *   A. total >= 5 when five live rows are seeded.
 *   B. At least one group exists for each of the four seeded categories
 *      (best_photo, best_adventure, best_hidden_gem, best_restaurant).
 *   C. Each group exposes the correct categoryLabel.
 *   D. best_adventure group (seeded twice) has >= 2 posts.
 *   E. A user without a @Portava follow relationship sees the same full
 *      result — confirmed by making the request with no Authorization header.
 *   F. Posts inside each group carry the expected shape (id, postId, author).
 *
 * Runtime: node:test  (no vitest / no supertest)
 * Run via: pnpm --filter @workspace/api-server test  (api-test workflow)
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import featuredRouter from "../routes/featured.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const PORTAVA_USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";

// Five featured row IDs
const FEAT_PHOTO       = "f1000000-0000-0000-0000-000000000001";
const FEAT_ADVENTURE_1 = "f2000000-0000-0000-0000-000000000002";
const FEAT_ADVENTURE_2 = "f3000000-0000-0000-0000-000000000003";
const FEAT_HIDDEN_GEM  = "f4000000-0000-0000-0000-000000000004";
const FEAT_RESTAURANT  = "f5000000-0000-0000-0000-000000000005";

// Corresponding post IDs
const POST_PHOTO       = "p1000000-0000-0000-0000-000000000001";
const POST_ADVENTURE_1 = "p2000000-0000-0000-0000-000000000002";
const POST_ADVENTURE_2 = "p3000000-0000-0000-0000-000000000003";
const POST_HIDDEN_GEM  = "p4000000-0000-0000-0000-000000000004";
const POST_RESTAURANT  = "p5000000-0000-0000-0000-000000000005";

// ── Fake nested rows (mirroring what Supabase returns for the joined select) ──

const BASE_PROFILE = {
  id:        PORTAVA_USER_ID,
  username:  "portava",
  full_name: "Portava Official",
  avatar_url: null,
  verified:  true,
};

function makeRow(opts: {
  id: string;
  post_id: string;
  category: string;
  postContent?: string;
}): any {
  return {
    id:          opts.id,
    post_id:     opts.post_id,
    category:    opts.category,
    featured_at: "2025-07-25T12:00:00.000Z",
    status:      "live",
    posts: {
      id:               opts.post_id,
      content:          opts.postContent ?? `Post content for ${opts.category}`,
      location_city:    "Barcelona",
      location_country: "ES",
      author_id:        PORTAVA_USER_ID,
      post_media:       [],
      profiles:         BASE_PROFILE,
    },
  };
}

const SEEDED_ROWS = [
  makeRow({ id: FEAT_PHOTO,       post_id: POST_PHOTO,       category: "best_photo",       postContent: "Golden hour light" }),
  makeRow({ id: FEAT_ADVENTURE_1, post_id: POST_ADVENTURE_1, category: "best_adventure",   postContent: "Summit sunrise #1" }),
  makeRow({ id: FEAT_ADVENTURE_2, post_id: POST_ADVENTURE_2, category: "best_adventure",   postContent: "Summit sunrise #2" }),
  makeRow({ id: FEAT_HIDDEN_GEM,  post_id: POST_HIDDEN_GEM,  category: "best_hidden_gem",  postContent: "Secret cove" }),
  makeRow({ id: FEAT_RESTAURANT,  post_id: POST_RESTAURANT,  category: "best_restaurant",  postContent: "Best pintxos in town" }),
];

// ── Fake client builder ───────────────────────────────────────────────────────

/**
 * Builds a minimal fake service client that answers the
 * portava_featured query used by GET /api/featured.
 *
 * The select string is ignored — we return SEEDED_ROWS directly so that
 * mapRow() in the route receives the expected nested shape.
 */
function makeFakeSc(rows: any[] = SEEDED_ROWS) {
  function makeBuilder(source: any[]): any {
    let current = source;
    const b: any = {
      select:      ()               => makeBuilder(current),
      eq:          (col: string, val: any) => makeBuilder(current.filter((r) => r[col] === val)),
      neq:         (col: string, val: any) => makeBuilder(current.filter((r) => r[col] !== val)),
      order:       ()               => makeBuilder(current),
      limit:       (n: number)      => makeBuilder(current.slice(0, n)),
      is:          ()               => makeBuilder(current),
      in:          (col: string, vals: any[]) => makeBuilder(current.filter((r) => vals.includes(r[col]))),
      maybeSingle: async ()         => ({ data: current[0] ?? null, error: null }),
      single:      async ()         => ({ data: current[0] ?? null, error: null }),
      then: (onF: (v: any) => any) =>
        Promise.resolve({ data: current, error: null }).then(onF),
    };
    return b;
  }

  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: "no auth" } }),
    },
    from: (table: string) => {
      if (table === "portava_featured") return makeBuilder(rows);
      return makeBuilder([]);
    },
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function getReq(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + (url.search ?? ""),
        method:   "GET",
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── Server setup ──────────────────────────────────────────────────────────────

before(async () => {
  await new Promise<void>((resolve) => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
      next();
    });
    app.use("/api", featuredRouter);
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

beforeEach(() => {
  _setTestClient(null);
  _setTestServiceClient(null as any);
});

// ── A: total count ────────────────────────────────────────────────────────────

describe("A: GET /api/featured returns total >= 5 when five live rows are seeded", () => {
  it("total is 5 for the seeded fixture", async () => {
    _setTestServiceClient(makeFakeSc() as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(
      typeof body.total === "number" && body.total >= 5,
      `total must be >= 5, got ${body.total}`,
    );
  });
});

// ── B: group coverage ─────────────────────────────────────────────────────────

describe("B: at least one group exists for each seeded category", () => {
  it("groups contain best_photo, best_adventure, best_hidden_gem, best_restaurant", async () => {
    _setTestServiceClient(makeFakeSc() as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

    const groups: any[] = body.groups ?? [];
    const categories = new Set(groups.map((g: any) => g.category));

    for (const expected of ["best_photo", "best_adventure", "best_hidden_gem", "best_restaurant"]) {
      assert.ok(
        categories.has(expected),
        `Missing group for category '${expected}'. Present: ${[...categories].join(", ")}`,
      );
    }
  });
});

// ── C: categoryLabel accuracy ─────────────────────────────────────────────────

describe("C: each group carries the correct human-readable categoryLabel", () => {
  it("categoryLabel values match the known mapping", async () => {
    _setTestServiceClient(makeFakeSc() as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200);

    const groups: any[] = body.groups ?? [];
    const labelMap: Record<string, string> = {
      best_photo:      "Best Photo",
      best_adventure:  "Best Adventure",
      best_hidden_gem: "Best Hidden Gem",
      best_restaurant: "Best Restaurant",
    };

    for (const [cat, label] of Object.entries(labelMap)) {
      const group = groups.find((g: any) => g.category === cat);
      assert.ok(group, `Group for ${cat} must exist`);
      assert.equal(
        group.categoryLabel, label,
        `categoryLabel for ${cat} should be '${label}', got '${group.categoryLabel}'`,
      );
    }
  });
});

// ── D: best_adventure has 2 posts ─────────────────────────────────────────────

describe("D: best_adventure group has >= 2 posts when seeded twice", () => {
  it("best_adventure group contains both seeded posts", async () => {
    _setTestServiceClient(makeFakeSc() as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200);

    const groups: any[] = body.groups ?? [];
    const adventureGroup = groups.find((g: any) => g.category === "best_adventure");
    assert.ok(adventureGroup, "best_adventure group must exist");
    assert.ok(
      adventureGroup.posts.length >= 2,
      `best_adventure should have >= 2 posts, got ${adventureGroup.posts.length}`,
    );
  });
});

// ── E: no-auth request (user never followed @Portava) ─────────────────────────

describe("E: a user who never followed @Portava sees the full featured list", () => {
  it("request with no Authorization header returns all groups — endpoint is public", async () => {
    _setTestServiceClient(makeFakeSc() as any);

    // No Authorization header — simulates a user who has never authenticated
    // with @Portava or followed the account.  The endpoint must not gate on
    // follow status; it is fully public.
    const { status, body } = await getReq("/api/featured", {});

    assert.equal(status, 200, `Expected 200 for unauthenticated request, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(
      body.total >= 5,
      `Unauthenticated caller must see all 5 posts, got total=${body.total}`,
    );

    const groups: any[] = body.groups ?? [];
    const categories = new Set(groups.map((g: any) => g.category));
    for (const cat of ["best_photo", "best_adventure", "best_hidden_gem", "best_restaurant"]) {
      assert.ok(categories.has(cat), `No-auth response must include group for '${cat}'`);
    }
  });
});

// ── F: post shape inside groups ───────────────────────────────────────────────

describe("F: posts inside groups carry the expected fields", () => {
  it("every post has id, postId, category, author.username and author.displayName", async () => {
    _setTestServiceClient(makeFakeSc() as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200);

    const groups: any[] = body.groups ?? [];
    const allPosts: any[] = groups.flatMap((g: any) => g.posts as any[]);
    assert.ok(allPosts.length >= 5, `Expected >= 5 posts across all groups, got ${allPosts.length}`);

    for (const post of allPosts) {
      assert.ok(typeof post.id       === "string" && post.id,       `post.id must be a non-empty string`);
      assert.ok(typeof post.postId   === "string" && post.postId,   `post.postId must be a non-empty string`);
      assert.ok(typeof post.category === "string" && post.category, `post.category must be a non-empty string`);
      assert.ok(post.author,                                         `post.author must exist`);
      assert.ok(typeof post.author.username    === "string",         `post.author.username must be a string`);
      assert.ok(typeof post.author.displayName === "string",         `post.author.displayName must be a string`);
    }
  });

  it("thisWeeksWinners carries posts featured within the last 7 days", async () => {
    // Use a featured_at timestamp that is clearly within the last 7 days
    const recentAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const recentRows = SEEDED_ROWS.map((r) => ({ ...r, featured_at: recentAt }));
    _setTestServiceClient(makeFakeSc(recentRows) as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200);
    assert.ok(
      Array.isArray(body.thisWeeksWinners) && body.thisWeeksWinners.length >= 5,
      `thisWeeksWinners should include all 5 recent posts, got ${body.thisWeeksWinners?.length}`,
    );
  });
});
