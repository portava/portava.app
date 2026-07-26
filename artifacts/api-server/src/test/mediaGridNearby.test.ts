/**
 * mediaGridNearby.test.ts — Nearby filter radius enforcement for the grid feed.
 *
 * Confirms that GET /api/media/feed?mode=grid&filter=nearby&lat=…&lng=…
 * returns only posts whose location_lat/location_lng fall within 50 km of the
 * viewer's coordinates, and that posts outside the radius are excluded.
 *
 * Run: node --import tsx/esm --test src/test/mediaGridNearby.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";

// ── Shared IDs ────────────────────────────────────────────────────────────────

const VIEWER_ID = "aaaaaaaa-0000-4000-a000-000000000001";
const CREATOR_A = "bbbbbbbb-0000-4000-a000-000000000002";
const TOKEN     = "test-nearby-token";

// Viewer is in Paris (~48.86°N, 2.35°E).
const VIEWER_LAT = 48.8566;
const VIEWER_LNG = 2.3522;

// Posts:
//  NEAR  — Lyon, France (~45.75°N, 4.84°E) ≈ 392 km → actually too far,
//           let's use Versailles (~48.80°N, 2.13°E) ≈ 14 km (inside).
//  FAR   — Madrid, Spain (~40.42°N, 3.70°W) ≈ 1053 km (outside).
//  NULL  — no coordinates set → always excluded from nearby.
const POST_NEAR_ID = "11111111-0000-4000-a000-000000000001";
const POST_FAR_ID  = "22222222-0000-4000-a000-000000000002";
const POST_NULL_ID = "33333333-0000-4000-a000-000000000003";

// ── Fake post/media builders ──────────────────────────────────────────────────

function makePost(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? POST_NEAR_ID,
    author_id: CREATOR_A,
    status: "active",
    post_status: "published",
    visibility: "public",
    moderation_status: "approved",
    has_video: false,
    primary_media_type: "image",
    view_count: 0,
    qualified_view_count: 0,
    location_name: overrides.location_name ?? null,
    location_city: overrides.location_city ?? null,
    location_country: overrides.location_country ?? null,
    location_lat: overrides.location_lat ?? null,
    location_lng: overrides.location_lng ?? null,
    created_at: "2024-06-01T12:00:00Z",
    publish_at: null,
    category: null,
    geo_restriction: null,
    age_restriction_enabled: false,
    age_min: null,
    age_max: null,
    tags: [],
    post_media: [
      {
        id: "media-" + (overrides.id ?? POST_NEAR_ID),
        media_type: "image",
        public_url: "https://example.com/img.jpg",
        thumbnail_url: null,
        duration_seconds: null,
        width: 800,
        height: 600,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ],
    ...overrides,
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface FakeState {
  posts?: any[];
  blocks?: any[];
  mutes?: any[];
  flagsEnabled?: string[];
}

function makeClient(state: FakeState) {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitVal = 1000;

    const rows = () =>
      (
        table === "posts"        ? state.posts ?? [] :
        table === "blocks"       ? state.blocks ?? [] :
        table === "user_mutes"   ? state.mutes ?? [] :
        table === "feature_flags"
          ? (state.flagsEnabled ?? []).map((flag) => ({ flag, enabled: true }))
          : []
      ).filter((r: any) => filters.every((f) => f(r))).slice(0, limitVal);

    const b: any = {
      select()                       { return b; },
      eq(col: string, val: any)      { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)     { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[])   { filters.push((r) => vals.includes(r[col])); return b; },
      not(col: string, op: string, val: any) {
        if (op === "in") filters.push((r) => !String(val).split(",").includes(String(r[col])));
        return b;
      },
      is(col: string, val: any)      { filters.push((r) => val === null ? r[col] == null : r[col] === val); return b; },
      or()                           { return b; },
      gte(col: string, val: any)     { filters.push((r) => r[col] != null && r[col] >= val); return b; },
      lte(col: string, val: any)     { filters.push((r) => r[col] != null && r[col] <= val); return b; },
      gt(col: string, val: any)      { filters.push((r) => r[col] > val); return b; },
      lt(col: string, val: any)      { filters.push((r) => r[col] < val); return b; },
      order()                        { return b; },
      limit(n: number)               { limitVal = n; return b; },
      maybeSingle()                  { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() {
        const r = rows()[0];
        return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: "not found" } });
      },
      then(onF: any, onR: any)       { return Promise.resolve({ data: rows(), error: null }).then(onF, onR); },
    };
    return b;
  }

  return {
    from: builder,
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(mediaFeedRouter);
  return app;
}

async function startServer(app: express.Express) {
  return new Promise<{ server: http.Server; base: string }>((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function getJson(base: string, path: string) {
  const res = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: await res.json() as any };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /media/feed?mode=grid&filter=nearby", () => {
  let server: http.Server;
  let base: string;

  const defaultState: FakeState = {
    flagsEnabled: ["MEDIA_VIEW_MODE_GRID_ENABLED"],
    blocks: [],
    mutes: [],
    posts: [
      // ~14 km from viewer (Versailles) — inside 50 km radius
      makePost({
        id: POST_NEAR_ID,
        location_lat: 48.8049,
        location_lng: 2.1204,
        location_city: "Versailles",
      }),
      // ~1053 km from viewer (Madrid) — outside 50 km radius
      makePost({
        id: POST_FAR_ID,
        location_lat: 40.4168,
        location_lng: -3.7038,
        location_city: "Madrid",
      }),
      // No coordinates — must be excluded from nearby
      makePost({
        id: POST_NULL_ID,
        location_lat: null,
        location_lng: null,
        location_city: null,
      }),
    ],
  };

  before(async () => {
    const { server: s, base: b } = await startServer(makeApp());
    server = s;
    base = b;
  });

  after(() => { server.close(); });

  beforeEach(() => {
    _setTestClient(makeClient(defaultState), true);
  });

  it("returns only the post inside the 50 km radius", async () => {
    const { status, body } = await getJson(
      base,
      `/media/feed?mode=grid&filter=nearby&lat=${VIEWER_LAT}&lng=${VIEWER_LNG}`,
    );

    assert.equal(status, 200);
    const ids: string[] = body.items.map((i: any) => i.id);
    assert.ok(ids.includes(POST_NEAR_ID), "near post should be included");
    assert.ok(!ids.includes(POST_FAR_ID), "far post should be excluded");
    assert.ok(!ids.includes(POST_NULL_ID), "null-coord post should be excluded");
  });

  it("excludes posts outside the radius regardless of order", async () => {
    const { status, body } = await getJson(
      base,
      `/media/feed?mode=grid&filter=nearby&lat=${VIEWER_LAT}&lng=${VIEWER_LNG}`,
    );
    assert.equal(status, 200);
    const ids: string[] = body.items.map((i: any) => i.id);
    assert.ok(!ids.includes(POST_FAR_ID), "Madrid post must not appear");
  });

  it("falls back to all public posts when no coordinates are supplied", async () => {
    const { status, body } = await getJson(
      base,
      `/media/feed?mode=grid&filter=nearby`,
    );
    assert.equal(status, 200);
    // With no lat/lng the bounding-box is not applied; all three posts pass the
    // visibility=public filter, but the null-coord post has no media exclusion,
    // so at least the near and far posts appear.
    const ids: string[] = body.items.map((i: any) => i.id);
    assert.ok(ids.includes(POST_NEAR_ID), "near post should appear in fallback");
    assert.ok(ids.includes(POST_FAR_ID), "far post should appear in fallback");
  });

  it("never exposes raw coordinates in any item", async () => {
    const { status, body } = await getJson(
      base,
      `/media/feed?mode=grid&filter=nearby&lat=${VIEWER_LAT}&lng=${VIEWER_LNG}`,
    );
    assert.equal(status, 200);
    for (const item of body.items) {
      assert.ok(!("location_lat" in item), "location_lat must not be in response");
      assert.ok(!("location_lng" in item), "location_lng must not be in response");
      assert.ok(!("lat" in item), "lat must not be in response");
      assert.ok(!("lng" in item), "lng must not be in response");
    }
  });

  it("returns 401 when no auth token is provided", async () => {
    const res = await fetch(`${base}/media/feed?mode=grid&filter=nearby&lat=${VIEWER_LAT}&lng=${VIEWER_LNG}`);
    assert.equal(res.status, 401);
  });
});
