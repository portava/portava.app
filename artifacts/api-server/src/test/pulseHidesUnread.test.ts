/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B40): GET /pulse never serves a post the viewer hid over
 * a failed hide read.
 *
 * GET /pulse read the viewer's `post_hides` rows with no error bound, inside `catch { /* best-effort *\/ }`, and took the
 * empty set as the viewer's whole hide list: a failed read was "you hid nothing", and the post the viewer hid was served
 * with nothing named. A safety fail-open on a graded Discovery surface. The hide read now fails closed exactly as the
 * block read does: `posts: []` and `failedSources: ["post_hides"]`, which the client says as a feed it could not load.
 *
 *   PH0 CONTROL: the viewer hid the post → not served, nothing named
 *   PH1 the post_hides read FAILS → nothing served, `post_hides` named (fail-closed)
 *   PH2 the post_hides read THROWS → the same
 *   PH3 CONTROL: the viewer hid nothing → the post is served, nothing named
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
const THROW = Symbol("throw");
function makeClient(tables: Record<string, any[]>, fail?: (r: Read) => boolean | typeof THROW) {
  function builder(table: string, rows: any[]) {
    let filtered = rows.map((r) => ({ ...r })); const read: Read = { table, eqs: {} };
    const settle = (): any => { const f = fail?.(read); if (f === THROW) throw new Error("socket hang up"); return f ? { data: null, error: ERR } : null; };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { read.eqs[c] = v; filtered = filtered.filter((r) => r[c] === v); return b; },
      in: (c: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[c])); return b; },
      not: (c: string, op: string, v: any) => { if (op === "in") { const ids = String(v).replace(/[()]/g, "").split(","); filtered = filtered.filter((r) => !ids.includes(r[c])); } return b; },
      neq: () => b, gt: () => b, gte: () => b, lt: () => b, lte: () => b, ilike: () => b, like: () => b, or: () => b, order: () => b, limit: () => b, range: () => b, contains: () => b, overlaps: () => b, is: () => b,
      maybeSingle: () => Promise.resolve().then(() => settle() ?? { data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve().then(() => settle() ?? { data: filtered[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve().then(() => settle() ?? { data: [...filtered], error: null }).then(res, rej),
    };
    return b;
  }
  return {
    auth: { getUser: async (t: string) => (t === "valid-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) },
    from: (t: string) => builder(t, tables[t] ?? []),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}
async function get(tables: Record<string, any[]>, path: string, fail?: (r: Read) => boolean | typeof THROW) {
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

describe("census-discovery §122 (B40): GET /pulse never serves a hidden post over a failed hide read", () => {
  after(() => _setTestClient(null as any, false));
  const hides = [{ user_id: ALICE, post_id: post.id }];
  it("PH0 CONTROL: the viewer hid the post → not served, nothing named", async () => {
    const { status, body } = await get({ posts: [post], post_hides: hides }, "/api/pulse");
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal((body.posts ?? []).some((p: any) => p.id === post.id), false, JSON.stringify(body).slice(0, 300));
    assert.equal(body.failedSources, undefined);
  });
  it("PH1 the post_hides read FAILS → nothing served (fail-closed) and `post_hides` named", async () => {
    const { status, body } = await get({ posts: [post], post_hides: hides }, "/api/pulse", (r) => r.table === "post_hides");
    assert.deepEqual({ status, posts: body.posts, failedSources: body.failedSources }, { status: 200, posts: [], failedSources: ["post_hides"] });
  });
  it("PH2 the post_hides read THROWS → nothing served (fail-closed) and `post_hides` named", async () => {
    const { status, body } = await get({ posts: [post], post_hides: hides }, "/api/pulse", (r) => (r.table === "post_hides" ? THROW : false));
    assert.deepEqual({ status, posts: body.posts, failedSources: body.failedSources }, { status: 200, posts: [], failedSources: ["post_hides"] });
  });
  it("PH3 CONTROL: the viewer hid nothing → the post is served, nothing named", async () => {
    const { status, body } = await get({ posts: [post], post_hides: [] }, "/api/pulse");
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.failedSources, undefined, JSON.stringify(body));
    assert.ok((body.posts ?? []).some((p: any) => p.id === post.id), JSON.stringify(body).slice(0, 300));
  });
});
