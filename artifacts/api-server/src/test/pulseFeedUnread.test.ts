/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; sweep): GET /pulse never answers a failed read as an empty feed
 * unnamed.
 *
 * GET /pulse (the city's Pulse feed of traveller posts) answered `{ posts: [], total: 0 }` — exactly a feed with nothing
 * in it — when the viewer's block-state read failed (fail-closed, rightly: no post may be served past an unread block)
 * and when the crew tab's follows read failed (its error was discarded, so "you follow nobody"). Each now keeps that
 * fail-closed answer and names the read in `failedSources`, as GET /pulse/live does (livePulseUnreadSections LP1), so the
 * client says it could not load the feed rather than that there is nothing in it.
 *
 *   PF0 CONTROL: the crew tab, the viewer follows nobody → `posts: []`, nothing named
 *   PF1 the block-state read FAILS → `posts: []` (fail-closed, as before) and `failedSources: ["blocks"]`
 *   PF2 the crew tab's follows read FAILS → `posts: []` and `failedSources: ["user_follows"]`, never "you follow nobody"
 *   PF3 CONTROL: every read answers, one post → served, nothing named
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";

const ALICE = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
type Read = { table: string; eqs: Record<string, unknown> };
function makeClient(tables: Record<string, any[]>, fail?: (r: Read) => boolean) {
  function builder(table: string, rows: any[]) {
    let filtered = rows.map((r) => ({ ...r })); const read: Read = { table, eqs: {} };
    const settle = () => (fail?.(read) ? { data: null, error: ERR } : null);
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { read.eqs[c] = v; filtered = filtered.filter((r) => r[c] === v); return b; },
      in: (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[c])); return b; },
      neq: () => b, gt: () => b, gte: () => b, lt: () => b, lte: () => b, not: () => b, ilike: () => b, like: () => b, or: () => b, order: () => b, limit: () => b, range: () => b, contains: () => b, overlaps: () => b, is: () => b,
      maybeSingle: () => Promise.resolve(settle() ?? { data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(settle() ?? { data: filtered[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(settle() ?? { data: [...filtered], error: null }).then(res, rej),
    };
    return b;
  }
  return {
    auth: { getUser: async (t: string) => (t === "valid-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) },
    from: (t: string) => builder(t, tables[t] ?? []),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}
async function get(tables: Record<string, any[]>, path: string, fail?: (r: Read) => boolean) {
  _setTestClient(makeClient(tables, fail) as any, true); invalidateFlagsCache?.();
  const { default: pulseRouter } = await import("../routes/pulse.js");
  const app = express(); app.use(express.json());
  app.use((req: any, _r: unknown, n: () => void) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return req.log; } }; n(); });
  app.use("/api", pulseRouter);
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { headers: { Authorization: "Bearer valid-token" } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const post = { id: "p0000000-0000-4000-8000-000000000001", author_id: BOB, content: "Sunset from the fort", status: "active", visibility: "public", post_status: "published", created_at: "2026-09-30T18:00:00.000Z", post_media: [], pulse_geo_tags: null, profiles: { id: BOB, username: "bob" } };

describe("census-discovery §119 (sweep): GET /pulse names a read it could not make", () => {
  after(() => _setTestClient(null as any, false));
  it("PF0 CONTROL: the crew tab, the viewer follows nobody → empty, nothing named", async () => {
    const { status, body } = await get({ user_follows: [] }, "/api/pulse?tab=crew");
    assert.deepEqual({ status, posts: body.posts, failedSources: body.failedSources }, { status: 200, posts: [], failedSources: undefined });
  });
  it("PF1 the block-state read FAILS → empty (fail-closed) and `blocks` named", async () => {
    const { status, body } = await get({ posts: [post] }, "/api/pulse", (r) => r.table === "blocks");
    assert.deepEqual({ status, posts: body.posts, failedSources: body.failedSources }, { status: 200, posts: [], failedSources: ["blocks"] });
  });
  it("PF2 the crew tab's follows read FAILS → empty and `user_follows` named, never 'you follow nobody'", async () => {
    const { status, body } = await get({ posts: [post] }, "/api/pulse?tab=crew", (r) => r.table === "user_follows");
    assert.deepEqual({ status, posts: body.posts, failedSources: body.failedSources }, { status: 200, posts: [], failedSources: ["user_follows"] });
  });
  it("PF3 CONTROL: every read answers, one post → served, nothing named", async () => {
    const { status, body } = await get({ posts: [post] }, "/api/pulse");
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.failedSources, undefined, JSON.stringify(body));
    assert.ok((body.posts ?? []).some((p: any) => p.id === post.id), JSON.stringify(body).slice(0, 400));
  });
});
