/**
 * GET /api/pulse — page 2 loads, and each post carries its real likes and comments.
 *
 * THE TWO DEFECTS
 * ===============
 * 1. The "load more" cursor is the last post's `createdAt`, which the route serves
 *    straight from Postgres: `2026-10-22T10:00:00.123456+00:00`. The query schema
 *    validated `before` with `z.string().datetime()`, whose default refuses any
 *    offset, so every page-2 request was a 400 and the Pulse Wall never got past
 *    its first page.
 * 2. The client's pulsePostToFeedItem reads `likeCount`, `commentCount` and
 *    `likedByMe`. The route never set them, so every Pulse card showed 0 likes,
 *    0 comments and an unliked heart whatever the post had.
 *
 * WHAT IS PINNED
 * ==============
 *   A. The schema accepts the +00:00 cursor (and Z), and still refuses garbage.
 *   B. Through the route: that cursor answers 200 and reaches the posts query as
 *      the `created_at <` bound.
 *   C. Through the route: counts come from the same tables the global feed uses
 *      (content_stamps for likes, live posts_comments for comments), likedByMe is
 *      the viewer's own stamp.
 *   D. A like read that fails serves null (unknown), never 0, and names its table
 *      in failedSources.
 *
 * Run: node --import tsx/esm --test src/test/pulseCursorAndEngagement.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { pulseQuerySchema } from "../routes/pulse.js";

const VIEWER = "aaaaaaaa-0000-4000-8000-000000000001";
const AUTHOR = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER = "cccccccc-0000-4000-8000-000000000003";
const P1 = "11111111-0000-4000-8000-000000000001";
const P2 = "22222222-0000-4000-8000-000000000002";
const TOKEN = "pulse-cursor-token";
// What PostgREST serves for a timestamptz, and therefore what the client sends back as `before`.
const PG_CURSOR = "2026-10-22T10:00:00.123456+00:00";

function postRow(id: string): Record<string, any> {
  return {
    id, author_id: AUTHOR, content: `post ${id.slice(0, 4)}`, trip_id: null, media_urls: [],
    visibility: "public", status: "active", post_status: "published",
    created_at: "2026-10-22T09:00:00.000000+00:00", updated_at: null,
    location_name: null, location_city: "Da Nang", location_country: "VN", location_source: "manual",
    canonical_place_id: null, location_privacy_mode: null, published_at: null,
    post_media: [], pulse_geo_tags: null,
    profiles: { id: AUTHOR, username: "author", full_name: "Author", avatar_url: null, verified: false, is_official: false },
  };
}

interface Calls { postsLt: Array<[string, string]> }

function makeClient(opts: { failTable?: string } = {}) {
  const calls: Calls = { postsLt: [] };
  const db: Record<string, any[]> = {
    posts: [postRow(P1), postRow(P2)],
    content_stamps: [
      { id: "s1", entity_type: "post", entity_id: P1, user_id: VIEWER },
      { id: "s2", entity_type: "post", entity_id: P1, user_id: OTHER },
      { id: "s3", entity_type: "media", entity_id: P2, user_id: OTHER }, // not a post stamp: does not count
    ],
    posts_comments: [
      { id: "c1", post_id: P1, deleted_at: null },
      { id: "c2", post_id: P1, deleted_at: null },
      { id: "c3", post_id: P1, deleted_at: "2026-10-21T00:00:00Z" }, // deleted: does not count
    ],
  };
  function builder(table: string): any {
    let rows = [...(db[table] ?? [])];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { rows = rows.filter((r) => r[col] === undefined || r[col] === val); return b; },
      neq: () => b, not: () => b, ilike: () => b, gte: () => b, lte: () => b, gt: () => b,
      in: (col: string, vals: any[]) => { rows = rows.filter((r) => r[col] === undefined || vals.includes(r[col])); return b; },
      is: (col: string, val: any) => { rows = rows.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      lt: (col: string, val: string) => { if (table === "posts") calls.postsLt.push([col, val]); return b; },
      order: () => b, limit: () => b, range: () => b,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: rows[0] ?? null, error: null }),
      then: (onF: (v: any) => any, onR?: (e: any) => any) =>
        Promise.resolve(
          opts.failTable === table
            ? { data: null, error: { message: `${table} unreadable`, code: "XX000" }, count: null }
            : { data: rows, error: null, count: rows.length },
        ).then(onF, onR),
    };
    return b;
  }
  const client = {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } },
    },
    from: (table: string) => builder(table),
    rpc: async () => ({ data: null, error: null }),
  };
  return { client, calls };
}

async function getPulse(client: any, query: string): Promise<{ status: number; body: any }> {
  _setTestClient(client, true);
  const { default: pulseRouter } = await import("../routes/pulse.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", pulseRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pulse${query}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("A. the cursor schema", () => {
  it("accepts the +00:00 timestamp Postgres serves as createdAt, and a Z timestamp", () => {
    assert.equal(pulseQuerySchema.safeParse({ before: PG_CURSOR }).success, true, "the +00:00 cursor the route itself hands out");
    assert.equal(pulseQuerySchema.safeParse({ before: "2026-10-22T10:00:00.123Z" }).success, true);
  });
  it("still refuses a cursor that is not a timestamp", () => {
    assert.equal(pulseQuerySchema.safeParse({ before: "yesterday" }).success, false);
    assert.equal(pulseQuerySchema.safeParse({ before: "2026-10-22" }).success, false);
  });
});

describe("B. page 2 through the route", () => {
  it("before=<+00:00 cursor> answers 200 and bounds the posts query by it", async () => {
    const { client, calls } = makeClient();
    const r = await getPulse(client, `?before=${encodeURIComponent(PG_CURSOR)}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls.postsLt, [["created_at", PG_CURSOR]]);
  });
});

describe("C/D. likes and comments on each Pulse post", () => {
  it("C. likeCount, commentCount and likedByMe are the measured values", async () => {
    const { client } = makeClient();
    const r = await getPulse(client, "");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const byId = new Map<string, any>((r.body.posts as any[]).map((p) => [p.id, p]));
    assert.equal(byId.get(P1)?.likeCount, 2);
    assert.equal(byId.get(P1)?.commentCount, 2, "the deleted comment does not count");
    assert.equal(byId.get(P1)?.likedByMe, true);
    assert.equal(byId.get(P2)?.likeCount, 0, "a media stamp is not a like on the post");
    assert.equal(byId.get(P2)?.commentCount, 0);
    assert.equal(byId.get(P2)?.likedByMe, false);
    assert.equal(r.body.failedSources, undefined, "a healthy page names no failed source");
  });

  it("D. an unreadable content_stamps serves null likes — never 0 — and is named", async () => {
    const { client } = makeClient({ failTable: "content_stamps" });
    const r = await getPulse(client, "");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p1 = (r.body.posts as any[]).find((p) => p.id === P1);
    assert.equal(p1.likeCount, null);
    assert.equal(p1.likedByMe, null);
    assert.equal(p1.commentCount, 2, "the read that worked still answers");
    assert.deepEqual(r.body.failedSources, ["content_stamps"]);
  });
});
