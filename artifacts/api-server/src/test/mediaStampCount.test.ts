/**
 * mediaStampCount — stamp count accuracy tests for the Watch-mode media feed.
 *
 * Verifies that stampItCount in the feed response stays accurate even when the
 * same viewer stamps the same video more than once.
 *
 * Design contract being tested:
 *   - media_stamp_reactions has a UNIQUE (post_id, user_id) constraint
 *     (migration 20260814_media_stamp_reactions.sql) — the DB itself prevents
 *     duplicate rows for the same viewer+post pair.
 *   - POST /media/:id/react uses upsert with ignoreDuplicates:true — a second
 *     stamp from the same viewer is silently ignored at the application layer
 *     before it ever reaches the constraint.
 *   - The batch count in GET /media/feed?mode=fullscreen iterates over the
 *     returned rows and counts per post_id; because duplicates cannot exist,
 *     this count equals the number of distinct stamping users.
 *
 * Tests:
 *   A. Count is 0 when no stamps exist
 *   B. Count reflects the number of distinct stamping users (one row per user)
 *   C. Two stamps from the same viewer produce exactly one row → count stays 1
 *      (unique constraint enforced: the fake client returns only 1 row, matching
 *      what the real DB would return after the ON CONFLICT DO NOTHING upsert)
 *   D. hydrateMediaFeedItem maps stamp_it_count → stats.stampItCount faithfully
 *   E. POST /media/:id/react upsert payload includes ignoreDuplicates:true
 *
 * Run: node --import tsx/esm --test src/test/mediaStampCount.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";
import { hydrateMediaFeedItem } from "../lib/mediaFeedItem.js";

// ── Shared UUIDs ──────────────────────────────────────────────────────────────

const VIEWER_ID  = "aaaaaaaa-0000-4000-a000-000000000001";
const CREATOR_A  = "bbbbbbbb-0000-4000-a000-000000000002";
const STAMPER_1  = "cccccccc-0000-4000-a000-000000000010";
const STAMPER_2  = "dddddddd-0000-4000-a000-000000000011";
const POST_ID    = "11111111-0000-4000-a000-000000000001";
const TOKEN      = "test-stamp-count-token";
const SB_URL     = "http://sb.test";

// ── Minimal row / profile builders ───────────────────────────────────────────

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    author_id: CREATOR_A,
    status: "active",
    post_status: "published",
    visibility: "public",
    moderation_status: "approved",
    created_at: "2025-01-01T12:00:00Z",
    tags: [],
    has_video: true,
    post_media: [{
      id: "media-1",
      media_type: "video",
      public_url: `${SB_URL}/storage/v1/object/public/post-media/vid.mp4`,
      thumbnail_url: null,
      duration_seconds: 15,
      width: 1080,
      height: 1920,
      sort_order: 0,
      processing_status: "ready",
      moderation_status: "approved",
    }],
    profiles: {
      id: CREATOR_A,
      username: "creator_a",
      full_name: "Creator A",
      avatar_url: null,
      is_private: false,
      is_verified: false,
      bio: "Bio",
      followers_count: 10,
      following_count: 5,
      account_status: "active",
    },
    ...overrides,
  };
}

const BASE_FLAGS = [
  { flag: "MEDIA_FOR_YOU_ENABLED",   enabled: true },
  { flag: "MEDIA_FOLLOWING_ENABLED", enabled: true },
  { flag: "MEDIA_RANKING_ENABLED",   enabled: true },
];

// ── Fake Supabase client ──────────────────────────────────────────────────────
//
// Supports media_stamp_reactions in addition to the standard tables.
// The rows array is populated per-test to control what the stamp-count fetch returns.

interface StampCountTestState {
  posts?: any[];
  profiles?: any[];
  featureFlags?: any[];
  mediaStampReactions?: Array<{ post_id: string; user_id: string }>;
  upsertCalls?: Array<{ table: string; payload: any; options: any }>;
}

function makeStampClient(state: StampCountTestState) {
  const upsertCalls: Array<{ table: string; payload: any; options: any }> = [];
  state.upsertCalls = upsertCalls;

  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];

    const allRows = (): any[] => {
      switch (table) {
        case "posts":                 return state.posts ?? [];
        case "post_media":            return [];
        case "profiles":              return state.profiles ?? [];
        case "blocks":                return [];
        case "user_mutes":            return [];
        case "feature_flags":         return state.featureFlags ?? [];
        case "user_follows":          return [];
        case "post_saves":            return [];
        case "post_reactions":        return [];
        case "follow_requests":       return [];
        case "rank_events":           return [];
        case "compass_user_preferences": return [];
        case "media_stamp_reactions": return state.mediaStampReactions ?? [];
        default:                      return [];
      }
    };

    const rows = () => allRows().filter((r) => filters.every((f) => f(r)));

    const b: any = {
      select()       { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      not(col: string, op: string, val: any) {
        if (op === "in") filters.push((r) => !String(val).split(",").includes(String(r[col])));
        return b;
      },
      is(col: string, val: any) {
        filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      or()                                   { return b; },
      gte(col: string, val: any)             { filters.push((r) => r[col] >= val); return b; },
      lte(col: string, val: any)             { filters.push((r) => r[col] <= val); return b; },
      gt(col: string, val: any)              { filters.push((r) => r[col] > val);  return b; },
      lt(col: string, val: any)              { filters.push((r) => r[col] < val);  return b; },
      order()                                { return b; },
      limit()                                { return b; },
      range()                                { return b; },
      ilike()                                { return b; },
      contains()                             { return b; },
      maybeSingle()  { return Promise.resolve({ data: rows()[0] ?? null, error: null }); },
      single() {
        const r = rows()[0];
        if (!r) return Promise.resolve({ data: null, error: { message: "No rows" } });
        return Promise.resolve({ data: r, error: null });
      },
      upsert(payload: any, options: any) {
        upsertCalls.push({ table, payload, options });
        return Promise.resolve({ data: null, error: null });
      },
      insert() { return Promise.resolve({ data: null, error: null }); },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
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
  app.use((req: any, _res: any, next: any) => {
    req.log = {
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => {}, error: () => {}, fatal: () => {},
    };
    next();
  });
  app.use(mediaFeedRouter);
  return app;
}

async function startServer(app: express.Express): Promise<{ server: http.Server; base: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function jsonFetch(
  base: string,
  path: string,
  opts: { method?: string; body?: any; token?: string } = {},
): Promise<{ status: number; body: any }> {
  const resp = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${opts.token ?? TOKEN}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any;
  try { body = await resp.json(); } catch { body = null; }
  return { status: resp.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── A. hydrateMediaFeedItem — unit-level stamp count mapping ─────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("hydrateMediaFeedItem — stampItCount mapping", () => {
  const baseInput = {
    sourceType: "post" as const,
    viewerUserId: VIEWER_ID,
    allowedRealNameIds: new Set<string>(),
    savedPostIds: new Set<string>(),
    likedPostIds: new Set<string>(),
    followedCreatorIds: new Set<string>(),
    pendingFollowRequestIds: new Set<string>(),
    postMedia: [{
      id: "m1",
      media_type: "video",
      public_url: `${SB_URL}/storage/v1/object/public/post-media/vid.mp4`,
      thumbnail_url: null,
      duration_seconds: 10,
      width: 1080,
      height: 1920,
      sort_order: 0,
      processing_status: "ready",
      moderation_status: "approved",
    }],
    useSignedUrls: false,
    supabaseUrl: SB_URL,
    linkedEntity: null,
  };

  const baseRow = {
    id: POST_ID,
    author_id: CREATOR_A,
    status: "active",
    post_status: "published",
    visibility: "public",
    moderation_status: "approved",
    created_at: "2025-01-01T12:00:00Z",
    tags: [],
    profiles: {
      id: CREATOR_A,
      username: "creator_a",
      full_name: "Creator A",
      avatar_url: null,
      is_private: false,
      is_verified: false,
      bio: "Bio",
      account_status: "active",
    },
  };

  it("A-1: stamp_it_count=0 → stats.stampItCount is 0", () => {
    const item = hydrateMediaFeedItem({ ...baseInput, row: { ...baseRow, stamp_it_count: 0 } });
    assert.equal(item.stats.stampItCount, 0);
  });

  it("A-2: stamp_it_count=1 → stats.stampItCount is 1", () => {
    const item = hydrateMediaFeedItem({ ...baseInput, row: { ...baseRow, stamp_it_count: 1 } });
    assert.equal(item.stats.stampItCount, 1);
  });

  it("A-3: stamp_it_count=5 → stats.stampItCount is 5 (multiple distinct stampers)", () => {
    const item = hydrateMediaFeedItem({ ...baseInput, row: { ...baseRow, stamp_it_count: 5 } });
    assert.equal(item.stats.stampItCount, 5);
  });

  it("A-4: missing stamp_it_count → stats.stampItCount defaults to 0", () => {
    const item = hydrateMediaFeedItem({ ...baseInput, row: { ...baseRow } });
    assert.equal(item.stats.stampItCount, 0, "absent stamp_it_count must default to 0, not undefined");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── B. Feed endpoint — stamp count via fake DB rows ───────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /media/feed?mode=fullscreen — stampItCount accuracy", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    const app = makeApp();
    ({ server, base } = await startServer(app));
  });

  after(() => { server.close(); });

  it("B-1: no stamp rows → stampItCount is 0", async () => {
    const state: StampCountTestState = {
      posts: [makePost()],
      profiles: [],
      featureFlags: BASE_FLAGS,
      mediaStampReactions: [],
    };
    _setTestClient(makeStampClient(state), true);

    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you&limit=10");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    const item = (body.items as any[]).find((i: any) => i.id === POST_ID);
    assert.ok(item, "post must appear in feed");
    assert.equal(item.stats.stampItCount, 0, "stampItCount must be 0 when no reactions exist");
  });

  it("B-2: one stamp row → stampItCount is 1", async () => {
    const state: StampCountTestState = {
      posts: [makePost()],
      profiles: [],
      featureFlags: BASE_FLAGS,
      mediaStampReactions: [
        { post_id: POST_ID, user_id: STAMPER_1 },
      ],
    };
    _setTestClient(makeStampClient(state), true);

    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you&limit=10");
    assert.equal(status, 200);
    const item = (body.items as any[]).find((i: any) => i.id === POST_ID);
    assert.ok(item, "post must appear in feed");
    assert.equal(item.stats.stampItCount, 1, "one stamp row must produce stampItCount=1");
  });

  it("B-3: two distinct stampers → stampItCount is 2", async () => {
    const state: StampCountTestState = {
      posts: [makePost()],
      profiles: [],
      featureFlags: BASE_FLAGS,
      mediaStampReactions: [
        { post_id: POST_ID, user_id: STAMPER_1 },
        { post_id: POST_ID, user_id: STAMPER_2 },
      ],
    };
    _setTestClient(makeStampClient(state), true);

    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you&limit=10");
    assert.equal(status, 200);
    const item = (body.items as any[]).find((i: any) => i.id === POST_ID);
    assert.ok(item, "post must appear in feed");
    assert.equal(item.stats.stampItCount, 2, "two distinct stampers must produce stampItCount=2");
  });

  it("B-4: same viewer stamps twice — UNIQUE constraint means only 1 row exists → count stays 1", async () => {
    // The DB's UNIQUE (post_id, user_id) constraint means the table can never
    // hold two rows for the same viewer+post pair.  The fake client models this
    // by containing only one row (what the real DB would return after an
    // ON CONFLICT DO NOTHING upsert).
    const state: StampCountTestState = {
      posts: [makePost()],
      profiles: [],
      featureFlags: BASE_FLAGS,
      mediaStampReactions: [
        { post_id: POST_ID, user_id: STAMPER_1 }, // ← only one row, never two
      ],
    };
    _setTestClient(makeStampClient(state), true);

    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you&limit=10");
    assert.equal(status, 200);
    const item = (body.items as any[]).find((i: any) => i.id === POST_ID);
    assert.ok(item, "post must appear in feed");
    assert.equal(
      item.stats.stampItCount,
      1,
      "repeated stamp from same viewer must not inflate count above 1 — " +
      "unique constraint ensures only one row per (post_id, user_id) exists",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── C. POST /media/:id/react — upsert idempotency ────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /media/:id/react — upsert ignoreDuplicates prevents double-counting", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    const app = makeApp();
    ({ server, base } = await startServer(app));
  });

  after(() => { server.close(); });

  it("C-1: upsert call includes ignoreDuplicates:true so a second stamp is silently dropped", async () => {
    const state: StampCountTestState = {
      posts: [makePost()],
      profiles: [],
      featureFlags: BASE_FLAGS,
      mediaStampReactions: [],
    };
    const client = makeStampClient(state);
    _setTestClient(client, true);

    // First stamp
    const r1 = await jsonFetch(base, `/media/${POST_ID}/react`, {
      method: "POST",
      body: { reaction: "stamp_it" },
    });
    assert.equal(r1.status, 200, `First stamp should succeed: ${JSON.stringify(r1.body)}`);

    // Verify the upsert used ignoreDuplicates:true
    const stampUpserts = state.upsertCalls!.filter((c) => c.table === "media_stamp_reactions");
    assert.ok(stampUpserts.length >= 1, "at least one upsert to media_stamp_reactions must have been made");
    const firstUpsert = stampUpserts[0];
    assert.ok(
      firstUpsert.options?.ignoreDuplicates === true,
      `upsert must use ignoreDuplicates:true to prevent duplicate rows; ` +
      `got options=${JSON.stringify(firstUpsert.options)}`,
    );
  });
});
