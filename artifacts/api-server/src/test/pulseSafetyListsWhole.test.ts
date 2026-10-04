/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B43 and its survivor Z9): GET /pulse and
 * GET /pulse/live apply the viewer's WHOLE hide list and WHOLE block lists, never the first page PostgREST cut.
 *
 * Both routes read `post_hides` and `blocks` with one unbounded read each. PostgREST caps a response at db-max-rows
 * (1000 on this deployment) with no error, so a viewer with more than 1000 hides, or with more than 1000 block rows in
 * either direction, had only the first 1000 applied: a post they hid, or a post by someone who blocked them, was served
 * and nothing was named. A safety fail-open on a graded Discovery surface. Each list is now read whole (the plain read
 * with an exact count, then by key when the count says rows were left out), and a list that cannot be read whole fails
 * closed exactly as a failed read does.
 *
 * The double is `cappedClient` (helpers/cappedPostgrest.ts): every response is cut at 1000 rows, and a read that asks
 * for an exact count is told how many rows its filter matched.
 *
 *   HC0  CONTROL: the viewer hid two posts → neither is served, nothing named (Z9: every hide row is applied, not the first)
 *   HC1  the viewer hid 1200 posts, the one in the feed among the rows past the cap → not served, nothing named
 *   HC2  the hide list is cut and its keyed re-read FAILS → no posts (fail-closed), `post_hides` named
 *   HC3  the server's max-rows (400) is BELOW the page size → the 1200-row hide list is still read whole
 *   BC0  CONTROL: the author blocked the viewer (one row) → the post is not served
 *   BC1  1200 people blocked the viewer, the author among the rows past the cap → the post is not served
 *   BC2  the viewer blocked 1200 people, the author among the rows past the cap → the post is not served
 *   BC3  the block list is cut and its keyed re-read FAILS → no posts (fail-closed), `blocks` named
 *   BC4  CONTROL: 1200 block rows, none of them the author's → the post is served, nothing named
 *   LB0  CONTROL (GET /pulse/live): the host of an event the viewer is going to blocked the viewer (one row) → not on the rail
 *   LB1  GET /pulse/live: 1200 people blocked the viewer, that host among the rows past the cap → not on the rail
 *   LB2  CONTROL (GET /pulse/live): 1200 block rows, none of them that host's → the event is on the rail
 *   LB3  GET /pulse/live: the viewer blocked 1200 people, that host among the rows past the cap → not on the rail
 *   LB4  GET /pulse/live: a block list is cut and its keyed re-read FAILS → an empty rail (fail-closed), never the rail filtered on a prefix
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { cappedClient, seqId, type Row, type SeenRead } from "./helpers/cappedPostgrest.js";

const ALICE = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const BOB = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";
const auth = { getUser: async (t: string) => (t === "valid-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

async function get(tables: Record<string, Row[]>, path: string, opts: { fail?: (r: SeenRead) => boolean | "throw"; dbMaxRows?: number } = {}) {
  const reads: SeenRead[] = [];
  _setTestClient(cappedClient(tables, { ...opts, reads, auth }) as any, true); invalidateFlagsCache?.();
  const { default: pulseRouter } = await import("../routes/pulse.js");
  const app = express(); app.use(express.json());
  app.use((req: any, _r: unknown, n: () => void) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return req.log; } }; n(); });
  app.use("/api", pulseRouter);
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { headers: { Authorization: "Bearer valid-token" } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any, reads };
  } finally { await new Promise<void>((r) => server.close(() => r())); }
}

const postRow = (id: string, over: Row = {}): Row => ({ id, author_id: BOB, content: "Sunset from the fort", status: "active", visibility: "public", post_status: "published", created_at: "2026-09-30T18:00:00.000Z", post_media: [], pulse_geo_tags: null, profiles: { id: BOB, username: "bob" }, ...over });
// The post the feed would serve sorts LAST among the hidden ids and sits past the cap in insertion order, so neither an
// unordered first page nor an ordered one holds its hide row.
const POST = seqId("p9999999", 9999);
const POST2 = seqId("p9999999", 9998);
const served = (body: any, id: string) => ((body.posts ?? []) as any[]).some((p) => p.id === id);
const seen = (r: { status: number; body: any }) => JSON.stringify({ status: r.status, posts: (r.body.posts ?? []).map((p: any) => p.id), failedSources: r.body.failedSources }).slice(0, 400);

/** `n` hide rows of ALICE's, the hide of `target` at insertion index `at`. */
function hides(n: number, target: string, at: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push({ user_id: ALICE, post_id: i === at ? target : seqId("p0000000", i) });
  return out;
}
/** `n` block rows in one direction, `who` at insertion index `at` (or absent when `at` is -1). */
function blocks(n: number, dir: "blockedViewer" | "viewerBlocked", who: string, at: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const other = i === at ? who : seqId("c0000000", i);
    out.push(dir === "blockedViewer" ? { blocker_id: other, blocked_id: ALICE } : { blocker_id: ALICE, blocked_id: other });
  }
  return out;
}

describe("census-discovery §123 (B43): GET /pulse applies the viewer's whole hide list", () => {
  after(() => _setTestClient(null as any, false));
  it("HC0 CONTROL: the viewer hid two posts → neither is served, nothing named (Z9)", async () => {
    const r = await get({ posts: [postRow(POST), postRow(POST2)], post_hides: [{ user_id: ALICE, post_id: POST2 }, { user_id: ALICE, post_id: POST }] }, "/api/pulse");
    assert.equal(r.status, 200, seen(r));
    assert.equal(served(r.body, POST), false, seen(r));
    assert.equal(served(r.body, POST2), false, seen(r));
    assert.equal(r.body.failedSources, undefined, seen(r));
  });
  it("HC0b CONTROL: one of two posts hidden → the other is served", async () => {
    const r = await get({ posts: [postRow(POST), postRow(POST2)], post_hides: [{ user_id: ALICE, post_id: POST2 }] }, "/api/pulse");
    assert.equal(served(r.body, POST), true, seen(r));
    assert.equal(served(r.body, POST2), false, seen(r));
  });
  it("HC1 1200 hides, the feed's post among the rows past the cap → not served, nothing named", async () => {
    const r = await get({ posts: [postRow(POST)], post_hides: hides(1200, POST, 1100) }, "/api/pulse");
    assert.equal(r.status, 200, seen(r));
    assert.equal(served(r.body, POST), false, `a post the viewer hid was served: ${seen(r)}`);
    assert.equal(r.body.failedSources, undefined, seen(r));
  });
  it("HC2 the hide list is cut and its keyed re-read FAILS → no posts (fail-closed), post_hides named", async () => {
    const r = await get({ posts: [postRow(POST)], post_hides: hides(1200, POST, 1100) }, "/api/pulse", { fail: (x) => x.table === "post_hides" && x.ordered });
    assert.deepEqual({ status: r.status, posts: r.body.posts, failedSources: r.body.failedSources }, { status: 200, posts: [], failedSources: ["post_hides"] });
  });
  it("HC3 the server's max-rows (400) is below the page size → the hide list is still read whole", async () => {
    const r = await get({ posts: [postRow(POST)], post_hides: hides(1200, POST, 1100) }, "/api/pulse", { dbMaxRows: 400 });
    assert.equal(served(r.body, POST), false, `a post the viewer hid was served: ${seen(r)}`);
    assert.equal(r.body.failedSources, undefined, seen(r));
  });
});

describe("census-discovery §123 (B43): GET /pulse applies both of the viewer's block lists whole", () => {
  after(() => _setTestClient(null as any, false));
  it("BC0 CONTROL: the author blocked the viewer (one row) → the post is not served", async () => {
    const r = await get({ posts: [postRow(POST)], blocks: blocks(1, "blockedViewer", BOB, 0) }, "/api/pulse");
    assert.equal(r.status, 200, seen(r));
    assert.equal(served(r.body, POST), false, seen(r));
  });
  it("BC1 1200 people blocked the viewer, the author among the rows past the cap → the post is not served", async () => {
    const r = await get({ posts: [postRow(POST)], blocks: blocks(1200, "blockedViewer", BOB, 1100) }, "/api/pulse");
    assert.equal(r.status, 200, seen(r));
    assert.equal(served(r.body, POST), false, `a post by someone who blocked the viewer was served: ${seen(r)}`);
  });
  it("BC2 the viewer blocked 1200 people, the author among the rows past the cap → the post is not served", async () => {
    const r = await get({ posts: [postRow(POST)], blocks: blocks(1200, "viewerBlocked", BOB, 1100) }, "/api/pulse");
    assert.equal(served(r.body, POST), false, `a post by someone the viewer blocked was served: ${seen(r)}`);
  });
  it("BC3 the block list is cut and its keyed re-read FAILS → no posts (fail-closed), blocks named", async () => {
    const r = await get({ posts: [postRow(POST)], blocks: blocks(1200, "blockedViewer", BOB, 1100) }, "/api/pulse", { fail: (x) => x.table === "blocks" && x.ordered });
    assert.deepEqual({ status: r.status, posts: r.body.posts, failedSources: r.body.failedSources }, { status: 200, posts: [], failedSources: ["blocks"] });
  });
  it("BC4 CONTROL: 1200 block rows, none of them the author's → the post is served, nothing named", async () => {
    const r = await get({ posts: [postRow(POST)], blocks: blocks(1200, "blockedViewer", BOB, -1) }, "/api/pulse");
    assert.equal(served(r.body, POST), true, seen(r));
    assert.equal(r.body.failedSources, undefined, seen(r));
  });
});

const in2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
const in3days = new Date(Date.now() + 3 * 86_400_000).toISOString();
const EV2 = "ec000000-0000-4000-8000-000000000012";
function liveWorld(blockRows: Row[]): Record<string, Row[]> {
  return {
    feature_flags: [{ flag: "safe_return_enabled", enabled: false }, { flag: "hidden_gems_enabled", enabled: false }, { flag: "find_your_circle_enabled", enabled: false }],
    events: [{ id: EV2, host_id: BOB, title: "Night market", starts_at: in2h, ends_at: in3days, city: "Manila", state: "open", visibility: "public", going_count: 1, max_attendees: 10 }],
    event_rsvps: [{ event_id: EV2, user_id: ALICE, status: "going" }],
    event_saves: [], trip_members: [], trips: [], trip_join_requests: [], safe_return_sessions: [],
    blocks: blockRows,
  };
}
const onRail = (body: any, id: string) => ((body.items ?? []) as any[]).some((i) => i.item_id === id);
const railSeen = (r: { status: number; body: any }) => JSON.stringify({ status: r.status, items: (r.body.items ?? []).map((i: any) => i.item_id), failedSources: r.body.failedSources }).slice(0, 400);

describe("census-discovery §123 (B43): GET /pulse/live applies both of the viewer's block lists whole", () => {
  after(() => _setTestClient(null as any, false));
  it("LB0 CONTROL: the host blocked the viewer (one row) → the event is not on the rail", async () => {
    const r = await get(liveWorld(blocks(1, "blockedViewer", BOB, 0)), "/api/pulse/live");
    assert.equal(r.status, 200, railSeen(r));
    assert.equal(onRail(r.body, EV2), false, railSeen(r));
  });
  it("LB1 1200 people blocked the viewer, the host among the rows past the cap → the event is not on the rail", async () => {
    const r = await get(liveWorld(blocks(1200, "blockedViewer", BOB, 1100)), "/api/pulse/live");
    assert.equal(r.status, 200, railSeen(r));
    assert.equal(onRail(r.body, EV2), false, `an event hosted by someone who blocked the viewer is on the rail: ${railSeen(r)}`);
  });
  it("LB2 CONTROL: 1200 block rows, none of them the host's → the event is on the rail, nothing named", async () => {
    const r = await get(liveWorld(blocks(1200, "blockedViewer", BOB, -1)), "/api/pulse/live");
    assert.equal(onRail(r.body, EV2), true, railSeen(r));
    assert.equal((r.body.failedSources ?? []).includes("blocks"), false, railSeen(r));
  });
  it("LB3 the viewer blocked 1200 people, the host among the rows past the cap → the event is not on the rail", async () => {
    const r = await get(liveWorld(blocks(1200, "viewerBlocked", BOB, 1100)), "/api/pulse/live");
    assert.equal(r.status, 200, railSeen(r));
    assert.equal(onRail(r.body, EV2), false, `an event hosted by someone the viewer blocked is on the rail: ${railSeen(r)}`);
  });
  it("LB4 a block list is cut and its keyed re-read FAILS → the rail is empty (fail-closed)", async () => {
    const r = await get(liveWorld(blocks(1200, "viewerBlocked", BOB, -1)), "/api/pulse/live", { fail: (x) => x.table === "blocks" && x.ordered });
    assert.equal(onRail(r.body, EV2), false, `a rail filtered on a cut block list was served: ${railSeen(r)}`);
  });
});
