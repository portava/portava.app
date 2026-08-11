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

const PORTAVA_UUID = "c00f4f1c-6543-4a86-81a4-35ba1c0be385";

// Fake @Portava post rows returned by the fallback query on the `posts` table.
// The shape mirrors what the posts-table select in buildFallbackResponse returns.
function makePortavaPostRow(postId: string, likeCount: number): any {
  return {
    id:               postId,
    content:          `Portava top post ${postId}`,
    location_city:    "Lisbon",
    location_country: "PT",
    author_id:        PORTAVA_UUID,
    like_count:       likeCount,
    status:           "active",
    post_status:      "published",
    post_media:       [],
    profiles: {
      id:        PORTAVA_UUID,
      username:  "portava",
      full_name: "Portava Official",
      avatar_url: null,
      verified:  true,
      is_private: false,
    },
  };
}

const PORTAVA_POST_ROWS = [
  makePortavaPostRow("pp000001-0000-0000-0000-000000000001", 900),
  makePortavaPostRow("pp000002-0000-0000-0000-000000000002", 800),
  makePortavaPostRow("pp000003-0000-0000-0000-000000000003", 700),
];

/**
 * Builds a minimal fake service client that answers the
 * portava_featured query used by GET /api/featured.
 *
 * The select string is ignored — we return SEEDED_ROWS directly so that
 * mapRow() in the route receives the expected nested shape.
 *
 * Pass `portavaPosts` to also back the fallback `posts` table query used
 * when portava_featured returns no live rows. Pass `portavaProfileMissing`
 * to simulate an environment where @portava hasn't been seeded yet.
 */
function makeFakeSc(rows: any[] = SEEDED_ROWS, portavaPosts: any[] = [], portavaProfileMissing = false) {
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

  // @portava's profile row, resolved by handle — used by the fallback path
  // instead of a hardcoded UUID, so tests also exercise handle-based lookup.
  const portavaProfileRows = portavaProfileMissing
    ? []
    : [{
        id:         PORTAVA_UUID,
        handle:     "portava",
        username:   "portava",
        full_name:  "Portava Official",
        avatar_url: null,
        verified:   true,
      }];

  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: "no auth" } }),
    },
    from: (table: string) => {
      if (table === "portava_featured") return makeBuilder(rows);
      if (table === "posts") return makeBuilder(portavaPosts);
      if (table === "profiles") return makeBuilder(portavaProfileRows);
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

// ── G: creatorId filter — only returns that creator's posts ───────────────────

const CREATOR_1_ID = "cccccccc-0001-0000-0000-000000000001";
const CREATOR_2_ID = "cccccccc-0002-0000-0000-000000000002";

const FEAT_C1_1 = "fc100000-0000-0000-0000-000000000001";
const FEAT_C1_2 = "fc100000-0000-0000-0000-000000000002";
const FEAT_C2_1 = "fc200000-0000-0000-0000-000000000001";

const POST_C1_1 = "pc100000-0000-0000-0000-000000000001";
const POST_C1_2 = "pc100000-0000-0000-0000-000000000002";
const POST_C2_1 = "pc200000-0000-0000-0000-000000000001";

function makeRowForCreator(opts: {
  id: string;
  post_id: string;
  category: string;
  creatorId: string;
  username: string;
}): any {
  return {
    id:          opts.id,
    post_id:     opts.post_id,
    category:    opts.category,
    featured_at: "2025-07-25T12:00:00.000Z",
    status:      "live",
    posts: {
      id:               opts.post_id,
      content:          `Post by ${opts.username}`,
      location_city:    "Madrid",
      location_country: "ES",
      author_id:        opts.creatorId,
      post_media:       [],
      profiles: {
        id:        opts.creatorId,
        username:  opts.username,
        full_name: opts.username,
        avatar_url: null,
        verified:  false,
        is_private: false,
      },
    },
  };
}

const MIXED_ROWS = [
  makeRowForCreator({ id: FEAT_C1_1, post_id: POST_C1_1, category: "best_photo",     creatorId: CREATOR_1_ID, username: "creator_one" }),
  makeRowForCreator({ id: FEAT_C1_2, post_id: POST_C1_2, category: "best_adventure", creatorId: CREATOR_1_ID, username: "creator_one" }),
  makeRowForCreator({ id: FEAT_C2_1, post_id: POST_C2_1, category: "best_video",     creatorId: CREATOR_2_ID, username: "creator_two" }),
];

describe("G: creatorId filter — only returns that creator's posts, not leaking others", () => {
  it("GET /api/featured?creatorId=creator1 returns only creator1 posts in total and groups", async () => {
    _setTestServiceClient(makeFakeSc(MIXED_ROWS) as any);

    const { status, body } = await getReq(`/api/featured?creatorId=${CREATOR_1_ID}`);

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

    // total must equal exactly 2 (the two creator1 posts)
    assert.equal(
      body.total,
      2,
      `total must be 2 (only creator1 posts), got ${body.total}`,
    );

    // All posts in every group must belong to creator1
    const groups: any[] = body.groups ?? [];
    const allPosts: any[] = groups.flatMap((g: any) => g.posts as any[]);
    assert.equal(allPosts.length, 2, `Expected 2 posts across all groups, got ${allPosts.length}`);

    for (const post of allPosts) {
      assert.equal(
        post.author.id,
        CREATOR_1_ID,
        `post ${post.postId} must belong to creator1, got author.id=${post.author.id}`,
      );
    }
  });

  it("creator2's post_id is absent from the filtered response", async () => {
    _setTestServiceClient(makeFakeSc(MIXED_ROWS) as any);

    const { status, body } = await getReq(`/api/featured?creatorId=${CREATOR_1_ID}`);

    assert.equal(status, 200);

    const groups: any[] = body.groups ?? [];
    const allPostIds: string[] = groups.flatMap((g: any) => (g.posts as any[]).map((p: any) => p.postId));

    assert.ok(
      !allPostIds.includes(POST_C2_1),
      `creator2's post ${POST_C2_1} must not appear when filtering by creator1`,
    );
  });

  it("omitting creatorId returns all three posts from both creators", async () => {
    _setTestServiceClient(makeFakeSc(MIXED_ROWS) as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200);
    assert.equal(
      body.total,
      3,
      `Without creatorId filter, total must be 3, got ${body.total}`,
    );
  });
});

// ── H: fallback when portava_featured has no live rows ────────────────────────
//
// When portava_featured returns an empty array the route must synthesise
// content from @Portava's own top posts and set isFallback:true so the mobile
// client can display a notice rather than a blank carousel.

describe("H: fallback to @Portava posts when portava_featured is empty", () => {
  it("returns isFallback:true and a portava_picks group when featured table is empty", async () => {
    // Empty portava_featured table; @Portava has 3 published posts available.
    _setTestServiceClient(makeFakeSc([], PORTAVA_POST_ROWS) as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.isFallback, true, "isFallback must be true when featured table is empty");
    assert.ok(
      Array.isArray(body.groups) && body.groups.length >= 1,
      `Expected at least one fallback group, got ${body.groups?.length}`,
    );

    const picksGroup = (body.groups as any[]).find((g: any) => g.category === "portava_picks");
    assert.ok(picksGroup, "A portava_picks group must be present in the fallback response");
    assert.ok(
      picksGroup.posts.length >= 1,
      `portava_picks group must contain at least one post, got ${picksGroup.posts.length}`,
    );
  });

  it("fallback posts carry the expected shape with synthetic fallback- id prefix", async () => {
    _setTestServiceClient(makeFakeSc([], PORTAVA_POST_ROWS) as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200);

    const picksGroup = (body.groups as any[]).find((g: any) => g.category === "portava_picks");
    assert.ok(picksGroup, "portava_picks group must exist");

    for (const post of picksGroup.posts as any[]) {
      assert.ok(
        typeof post.id === "string" && post.id.startsWith("fallback-"),
        `Fallback post id must start with 'fallback-', got '${post.id}'`,
      );
      assert.ok(typeof post.postId   === "string" && post.postId,   "postId must be a non-empty string");
      assert.ok(typeof post.category === "string" && post.category, "category must be a non-empty string");
      assert.ok(post.author,                                         "author must exist");
      assert.ok(typeof post.author.username === "string",            "author.username must be a string");
    }
  });

  it("returns isFallback:false and normal content when featured rows exist", async () => {
    _setTestServiceClient(makeFakeSc(SEEDED_ROWS, PORTAVA_POST_ROWS) as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200);
    assert.equal(body.isFallback, false, "isFallback must be false when live featured rows exist");
    assert.ok(
      (body.groups as any[]).every((g: any) => g.category !== "portava_picks"),
      "portava_picks group must not appear when real featured rows exist",
    );
  });

  it("returns empty groups with isFallback:true when both tables have no posts", async () => {
    // portava_featured empty AND @Portava has no posts
    _setTestServiceClient(makeFakeSc([], []) as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.isFallback, true, "isFallback must be true even when @Portava has no posts");
    assert.deepEqual(body.groups, [], "groups must be empty when @Portava has no posts either");
    assert.equal(body.total, 0, "total must be 0");
  });

  it("resolves @portava by handle even when its id differs from any hardcoded constant", async () => {
    // Simulate an environment where @portava was seeded with a different UUID
    // than the one this route module (or its tests) might otherwise assume.
    const ALT_PORTAVA_ID = "aaaaaaaa-9999-0000-0000-000000000099";
    const altPortavaPost = {
      id:               "pp999999-0000-0000-0000-000000000099",
      content:          "Post from an alternate @portava id",
      location_city:    "Porto",
      location_country: "PT",
      author_id:        ALT_PORTAVA_ID,
      like_count:       500,
      status:           "active",
      post_status:      "published",
      post_media:       [],
      profiles: {
        id:        ALT_PORTAVA_ID,
        username:  "portava",
        full_name: "Portava Official",
        avatar_url: null,
        verified:  true,
        is_private: false,
      },
    };

    // Build a fake client whose profiles table resolves @portava to
    // ALT_PORTAVA_ID, proving the route looks it up at request time rather
    // than trusting a hardcoded constant.
    const customSc: any = {
      auth: { getUser: async () => ({ data: { user: null }, error: { message: "no auth" } }) },
      from: (table: string) => {
        const rowsFor: Record<string, any[]> = {
          portava_featured: [],
          posts: [altPortavaPost],
          profiles: [{ id: ALT_PORTAVA_ID, handle: "portava", username: "portava", full_name: "Portava Official", avatar_url: null, verified: true }],
        };
        const source = rowsFor[table] ?? [];
        let current = source;
        const b: any = {
          select:      ()               => b,
          eq:          (col: string, val: any) => { current = current.filter((r) => r[col] === val); return b; },
          neq:         (col: string, val: any) => { current = current.filter((r) => r[col] !== val); return b; },
          order:       ()               => b,
          limit:       (n: number)      => { current = current.slice(0, n); return b; },
          is:          ()               => b,
          in:          (col: string, vals: any[]) => { current = current.filter((r) => vals.includes(r[col])); return b; },
          maybeSingle: async ()         => ({ data: current[0] ?? null, error: null }),
          single:      async ()         => ({ data: current[0] ?? null, error: null }),
          then: (onF: (v: any) => any) => Promise.resolve({ data: current, error: null }).then(onF),
        };
        return b;
      },
    };
    _setTestServiceClient(customSc);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.isFallback, true, "isFallback must be true when featured table is empty");

    const picksGroup = (body.groups as any[]).find((g: any) => g.category === "portava_picks");
    assert.ok(picksGroup, "portava_picks group must exist even with a non-canonical @portava id");
    assert.equal(
      picksGroup.posts.length,
      1,
      "the alternate-id @portava post must be picked up via handle resolution, not a hardcoded id",
    );
    assert.equal(picksGroup.posts[0].author.id, ALT_PORTAVA_ID, "author id must match the resolved (non-canonical) @portava id");
  });

  it("returns a clean empty state when @portava's profile cannot be resolved at all", async () => {
    _setTestServiceClient(makeFakeSc([], [], /* portavaProfileMissing */ true) as any);

    const { status, body } = await getReq("/api/featured");

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.isFallback, true, "isFallback must be true when @portava's profile is unresolvable");
    assert.deepEqual(body.groups, [], "groups must be empty when @portava's profile can't be found");
  });
});

// ── I: creatorId + privacy guard — private-profile post excluded even when creator matches ──

const CREATOR_PRIV_ID = "cccccccc-0099-0000-0000-000000000099";

const FEAT_PRIV_PUBLIC  = "fp000000-0000-0000-0000-000000000001";
const FEAT_PRIV_PRIVATE = "fp000000-0000-0000-0000-000000000002";

const POST_PRIV_PUBLIC  = "pp000000-0000-0000-0000-000000000001";
const POST_PRIV_PRIVATE = "pp000000-0000-0000-0000-000000000002";

function makeRowWithPrivacy(opts: {
  id: string;
  post_id: string;
  category: string;
  creatorId: string;
  isPrivate: boolean;
}): any {
  return {
    id:          opts.id,
    post_id:     opts.post_id,
    category:    opts.category,
    featured_at: "2025-07-25T12:00:00.000Z",
    status:      "live",
    posts: {
      id:               opts.post_id,
      content:          `Post from ${opts.isPrivate ? "private" : "public"} profile`,
      location_city:    "Rome",
      location_country: "IT",
      author_id:        opts.creatorId,
      post_media:       [],
      profiles: {
        id:         opts.creatorId,
        username:   "creator_priv_test",
        full_name:  "Creator Privacy Test",
        avatar_url: null,
        verified:   false,
        is_private: opts.isPrivate,
      },
    },
  };
}

const PRIVACY_ROWS = [
  makeRowWithPrivacy({ id: FEAT_PRIV_PUBLIC,  post_id: POST_PRIV_PUBLIC,  category: "best_photo",     creatorId: CREATOR_PRIV_ID, isPrivate: false }),
  makeRowWithPrivacy({ id: FEAT_PRIV_PRIVATE, post_id: POST_PRIV_PRIVATE, category: "best_adventure", creatorId: CREATOR_PRIV_ID, isPrivate: true  }),
];

describe("I: creatorId filter also excludes private-profile posts from that creator", () => {
  it("only the public post appears when the same creator has one public and one private-profile post", async () => {
    _setTestServiceClient(makeFakeSc(PRIVACY_ROWS) as any);

    const { status, body } = await getReq(`/api/featured?creatorId=${CREATOR_PRIV_ID}`);

    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

    assert.equal(
      body.total,
      1,
      `total must be 1 (only the public post), got ${body.total}`,
    );

    const groups: any[] = body.groups ?? [];
    const allPosts: any[] = groups.flatMap((g: any) => g.posts as any[]);
    assert.equal(allPosts.length, 1, `Expected exactly 1 post across all groups, got ${allPosts.length}`);

    assert.equal(
      allPosts[0].postId,
      POST_PRIV_PUBLIC,
      `The only returned post must be the public one (${POST_PRIV_PUBLIC}), got ${allPosts[0].postId}`,
    );
  });

  it("the private-profile post's postId is absent from the filtered response", async () => {
    _setTestServiceClient(makeFakeSc(PRIVACY_ROWS) as any);

    const { status, body } = await getReq(`/api/featured?creatorId=${CREATOR_PRIV_ID}`);

    assert.equal(status, 200);

    const groups: any[] = body.groups ?? [];
    const allPostIds: string[] = groups.flatMap((g: any) => (g.posts as any[]).map((p: any) => p.postId));

    assert.ok(
      !allPostIds.includes(POST_PRIV_PRIVATE),
      `Private-profile post ${POST_PRIV_PRIVATE} must not appear even when its creator matches the creatorId filter`,
    );
  });
});

// ── J: media references are emitted as bare bucket/path, not unusable public URLs ──
//
// `post-media` is a private bucket. A stored `public_url` pointing into it does
// not serve, so returning one gives the client a guaranteed-broken image. The
// client hydrates a bare `<bucket>/<path>` reference through useHydratedMedia,
// which signs it via POST /media/sign. Both selects in routes/featured.ts have
// carried storage_path/storage_bucket since the bucket-privacy prep and never
// read them; these tests hold the route to that shape.

const FEAT_MEDIA_IMAGE  = "fa000000-0000-0000-0000-000000000001";
const FEAT_MEDIA_VIDEO  = "fa000000-0000-0000-0000-000000000002";
const FEAT_MEDIA_LEGACY = "fa000000-0000-0000-0000-000000000003";

const POST_MEDIA_IMAGE  = "pa000000-0000-0000-0000-000000000001";
const POST_MEDIA_VIDEO  = "pa000000-0000-0000-0000-000000000002";
const POST_MEDIA_LEGACY = "pa000000-0000-0000-0000-000000000003";

const LEGACY_PUBLIC_URL =
  "https://proj.supabase.co/storage/v1/object/public/post-media/legacy/old.jpg";

/** A featured row whose post carries exactly one post_media row. */
function makeRowWithMedia(opts: { id: string; post_id: string; category: string; media: any }): any {
  return {
    id:          opts.id,
    post_id:     opts.post_id,
    category:    opts.category,
    featured_at: "2025-07-25T12:00:00.000Z",
    status:      "live",
    posts: {
      id:               opts.post_id,
      content:          "media shape fixture",
      location_city:    "Porto",
      location_country: "PT",
      author_id:        PORTAVA_USER_ID,
      post_media:       [opts.media],
      profiles:         BASE_PROFILE,
    },
  };
}

const MEDIA_IMAGE_ROW = {
  id:               "m0000000-0000-0000-0000-000000000001",
  media_type:       "image",
  sort_order:       0,
  processing_status: "ready",
  // A public_url that cannot serve — the bucket is private.
  public_url:       "https://proj.supabase.co/storage/v1/object/public/post-media/u1/photo.jpg",
  thumbnail_url:    null,
  storage_bucket:   "post-media",
  storage_path:     "u1/photo.jpg",
  thumbnail_storage_path: null,
};

const MEDIA_VIDEO_ROW = {
  id:               "m0000000-0000-0000-0000-000000000002",
  media_type:       "video",
  sort_order:       0,
  processing_status: "ready",
  public_url:       "https://proj.supabase.co/storage/v1/object/public/post-media/u1/clip.mp4",
  thumbnail_url:    null,
  storage_bucket:   "post-media",
  storage_path:     "u1/clip.mp4",
  thumbnail_storage_path: "u1/clip_poster.jpg",
};

// Predates the storage columns: nothing but a public URL to fall back on.
const MEDIA_LEGACY_ROW = {
  id:               "m0000000-0000-0000-0000-000000000003",
  media_type:       "image",
  sort_order:       0,
  processing_status: "ready",
  public_url:       LEGACY_PUBLIC_URL,
  thumbnail_url:    null,
  storage_bucket:   null,
  storage_path:     null,
  thumbnail_storage_path: null,
};

const MEDIA_ROWS = [
  makeRowWithMedia({ id: FEAT_MEDIA_IMAGE,  post_id: POST_MEDIA_IMAGE,  category: "best_photo",  media: MEDIA_IMAGE_ROW }),
  makeRowWithMedia({ id: FEAT_MEDIA_VIDEO,  post_id: POST_MEDIA_VIDEO,  category: "best_video",  media: MEDIA_VIDEO_ROW }),
  makeRowWithMedia({ id: FEAT_MEDIA_LEGACY, post_id: POST_MEDIA_LEGACY, category: "best_photo",  media: MEDIA_LEGACY_ROW }),
];

/** Flatten every post in the response and index it by postId. */
function postsById(body: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const g of (body.groups ?? []) as any[]) {
    for (const p of (g.posts ?? []) as any[]) out[p.postId] = p;
  }
  return out;
}

describe("J: GET /api/featured emits bare bucket/path media references", () => {
  it("an image row yields '<bucket>/<storage_path>', not the non-serving public_url", async () => {
    _setTestServiceClient(makeFakeSc(MEDIA_ROWS) as any);

    const { status, body } = await getReq("/api/featured");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);

    const post = postsById(body)[POST_MEDIA_IMAGE];
    assert.ok(post, `Expected a post for ${POST_MEDIA_IMAGE}`);
    assert.equal(
      post.thumbnailUrl,
      "post-media/u1/photo.jpg",
      "image media must be emitted as a bare bucket/path reference the client can sign",
    );
  });

  it("a video row yields the poster object, never the video file itself", async () => {
    _setTestServiceClient(makeFakeSc(MEDIA_ROWS) as any);

    const { status, body } = await getReq("/api/featured");
    assert.equal(status, 200);

    const post = postsById(body)[POST_MEDIA_VIDEO];
    assert.ok(post, `Expected a post for ${POST_MEDIA_VIDEO}`);
    assert.equal(
      post.thumbnailUrl,
      "post-media/u1/clip_poster.jpg",
      "video posters live at thumbnail_storage_path — storage_path is the .mp4 and must never be sent as an image",
    );
    assert.ok(
      !String(post.thumbnailUrl).endsWith(".mp4"),
      `thumbnailUrl must not be the video file, got ${post.thumbnailUrl}`,
    );
  });

  it("a legacy row with no storage columns still falls back to its public_url", async () => {
    _setTestServiceClient(makeFakeSc(MEDIA_ROWS) as any);

    const { status, body } = await getReq("/api/featured");
    assert.equal(status, 200);

    const post = postsById(body)[POST_MEDIA_LEGACY];
    assert.ok(post, `Expected a post for ${POST_MEDIA_LEGACY}`);
    assert.equal(
      post.thumbnailUrl,
      LEGACY_PUBLIC_URL,
      "rows predating the storage columns must keep working, not go blank",
    );
  });

  it("no returned thumbnailUrl is a raw /object/public/ URL into a private bucket", async () => {
    _setTestServiceClient(makeFakeSc([MEDIA_ROWS[0], MEDIA_ROWS[1]]) as any);

    const { status, body } = await getReq("/api/featured");
    assert.equal(status, 200);

    for (const post of Object.values(postsById(body))) {
      assert.ok(
        !String((post as any).thumbnailUrl ?? "").includes("/object/public/post-media/"),
        `thumbnailUrl still points at the private bucket over a public URL: ${(post as any).thumbnailUrl}`,
      );
    }
  });
});

// ── K: the @Portava fallback path emits the same shape ────────────────────────
//
// buildFallbackResponse has its own select and its own mapper. It carried the
// same unread storage columns, so it needs the same guarantee — otherwise every
// image silently breaks exactly when portava_featured is empty and the fallback
// is the only thing on screen.

describe("K: the fallback response emits bare bucket/path media references too", () => {
  it("fallback posts carry '<bucket>/<storage_path>' rather than the public_url", async () => {
    const fallbackPost = {
      ...makePortavaPostRow("pf000001-0000-0000-0000-000000000001", 500),
      post_media: [MEDIA_IMAGE_ROW],
    };
    _setTestServiceClient(makeFakeSc([], [fallbackPost]) as any);

    const { status, body } = await getReq("/api/featured");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.isFallback, true, "this fixture must exercise the fallback path");

    const posts: any[] = (body.groups ?? []).flatMap((g: any) => g.posts as any[]);
    assert.equal(posts.length, 1, `Expected exactly 1 fallback post, got ${posts.length}`);
    assert.equal(
      posts[0].thumbnailUrl,
      "post-media/u1/photo.jpg",
      "the fallback mapper must emit the same bare reference as the main mapper",
    );
  });

  it("a fallback video post yields its poster, not the video file", async () => {
    const fallbackPost = {
      ...makePortavaPostRow("pf000002-0000-0000-0000-000000000002", 400),
      post_media: [MEDIA_VIDEO_ROW],
    };
    _setTestServiceClient(makeFakeSc([], [fallbackPost]) as any);

    const { status, body } = await getReq("/api/featured");
    assert.equal(status, 200);

    const posts: any[] = (body.groups ?? []).flatMap((g: any) => g.posts as any[]);
    assert.equal(
      posts[0].thumbnailUrl,
      "post-media/u1/clip_poster.jpg",
      "fallback video posters must come from thumbnail_storage_path",
    );
  });
});
