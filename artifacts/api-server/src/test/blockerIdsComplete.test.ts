/**
 * blockerIdsComplete — GET /me/blocker-ids answers with EVERY account that
 * blocked the caller, or refuses; never a silent prefix (census-media §54;
 * B58 lane POSTS-LIKERS, BLOCKS-2's "found, not fixed" item 2).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * The route read `.from("blocks").select("blocker_id").eq("blocked_id", me)
 * .limit(500)` and answered `{ ids }`. The 501st blocker and every one after it
 * were simply absent, and nothing on the response said the list had stopped.
 * PostgREST also cuts any read at db-max-rows (1000 hosted) with no error, so
 * raising the limit would only have moved the cut. The client's
 * BlockedIdsContext takes `ids` as THE set of people who blocked the viewer.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *  - every inbound block is listed, past 500, past the server's row cap, and
 *    past a row cap BELOW the walk's page size (the walk ends only on an empty
 *    page, never on a short one);
 *  - up to the ceiling (10,000) the list is served whole; past it the route
 *    refuses (503) instead of serving the first 10,000 — a 200 is always the
 *    complete set;
 *  - a page that fails mid-walk fails the whole answer: no prefix is served;
 *  - outbound blocks and other people's blocks are never listed (controls).
 *
 * The double caps every response at `maxRows` (db-max-rows) whatever `.limit()`
 * asks for, and honours `.order` / `.gt` / `.limit`, so a walk that trusted a
 * short page, or a read that never paged, is caught.
 *
 * Run: node --import tsx/esm --test src/test/blockerIdsComplete.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import blocksRouter from "../routes/blocks.js";

const ME = "aabbccdd-0001-0002-0003-0000000000e1";
const SOMEONE = "aabbccdd-0001-0002-0003-0000000000e2";
const TOKEN = "tok-blocker-ids";

const FAIL = { message: "canceling statement due to statement timeout", code: "57014" };

/** A distinct blocker id per index, ordered like its index. */
const blockerId = (i: number) => `b10c0000-0000-4000-a000-${String(i).padStart(12, "0")}`;

interface Spec {
  rows: Array<{ id: string; blocker_id: string; blocked_id: string }>;
  /** db-max-rows: no response carries more rows than this, whatever `.limit()` says. */
  maxRows?: number;
  /** Fail the Nth read of `blocks` (1-based) with a RESOLVED error. */
  failRead?: number;
}

/** `n` inbound blocks on ME, ids shuffled out of insertion order so only `.order("id")` can make a walk correct. */
function inbound(n: number): Spec["rows"] {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `blk-${String(i).padStart(6, "0")}`, blocker_id: blockerId(i), blocked_id: ME }));
  for (let i = rows.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; }
  return rows;
}

function client(spec: Spec) {
  let reads = 0;
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let orderCol: string | null = null;
    let limitN: number | null = null;
    function run() {
      if (table !== "blocks") return Promise.resolve({ data: [], error: null });
      reads += 1;
      if (spec.failRead === reads) return Promise.resolve({ data: null, error: FAIL });
      let out = spec.rows.filter((r) => preds.every((p) => p(r))).map((r) => ({ ...r }));
      if (orderCol) { const c = orderCol; out.sort((a: any, b: any) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0)); }
      if (limitN != null) out = out.slice(0, limitN);
      out = out.slice(0, spec.maxRows ?? 1000); // the server's cap, which no .limit() lifts
      return Promise.resolve({ data: out, error: null });
    }
    const b: any = {
      select() { return b; },
      eq(c: string, v: unknown) { preds.push((r) => r[c] === v); return b; },
      gt(c: string, v: any) { preds.push((r) => r[c] > v); return b; },
      order(c: string) { orderCol = c; return b; },
      limit(n: number) { limitN = n; return b; },
      then(f: any, j: any) { return run().then(f, j); },
      // requireUser's own reads (account state) are not this suite's subject: no row, no error.
      in() { return b; },
      is() { return b; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      single() { return Promise.resolve({ data: null, error: null }); },
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    auth: {
      getUser: async (tok: string) => (tok === TOKEN
        ? { data: { user: { id: ME } }, error: null }
        : { data: { user: null }, error: { message: "bad token" } }),
    },
    reads: () => reads,
  };
}

let server: http.Server;
let base = "";

before(async () => {
  const app = express();
  app.use((req: any, _res, next) => { req.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
  app.use("/", blocksRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

function use(spec: Spec) {
  const c = client(spec);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}

async function blockerIds(): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}/me/blocker-ids`, { headers: { authorization: `Bearer ${TOKEN}`, connection: "close" } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function assertWhole(body: any, n: number, what: string) {
  assert.ok(Array.isArray(body?.ids), `${what}: ids is a list`);
  assert.equal(body.ids.length, n, `${what}: every blocker, not a prefix`);
  assert.equal(new Set(body.ids).size, n, `${what}: no blocker twice`);
  const want = new Set(Array.from({ length: n }, (_, i) => blockerId(i)));
  for (const id of body.ids) assert.ok(want.has(id), `${what}: ${id} is a real blocker`);
}

describe("§54 GET /me/blocker-ids is the whole list or a refusal", () => {
  it("CONTROL: nobody blocked me → an empty list; one blocker → that one", async () => {
    use({ rows: [] });
    let r = await blockerIds();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ids: [] });
    use({ rows: inbound(1) });
    r = await blockerIds();
    assert.equal(r.status, 200);
    assertWhole(r.body, 1, "one");
  });

  it("CONTROL: my OUTBOUND blocks and other people's blocks are never listed", async () => {
    use({ rows: [
      { id: "blk-a", blocker_id: ME, blocked_id: SOMEONE },
      { id: "blk-b", blocker_id: SOMEONE, blocked_id: blockerId(9) },
      { id: "blk-c", blocker_id: blockerId(0), blocked_id: ME },
    ] });
    const r = await blockerIds();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.ids, [blockerId(0)]);
  });

  it("501 blockers → all 501 (the read stopped at 500 and said nothing)", async () => {
    use({ rows: inbound(501) });
    const r = await blockerIds();
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assertWhole(r.body, 501, "501");
  });

  it("1,234 blockers behind a 1,000-row server cap → all 1,234, over pages", async () => {
    const c = use({ rows: inbound(1234), maxRows: 1000 });
    const r = await blockerIds();
    assert.equal(r.status, 200);
    assertWhole(r.body, 1234, "1,234 at cap 1,000");
    assert.ok(c.reads() >= 2, "more than one page was read");
  });

  it("2,500 blockers behind a 400-row server cap (below the walk's page size) → all 2,500: a short page is not the end", async () => {
    use({ rows: inbound(2500), maxRows: 400 });
    const r = await blockerIds();
    assert.equal(r.status, 200);
    assertWhole(r.body, 2500, "2,500 at cap 400");
  });

  it("exactly 10,000 blockers (the ceiling) → all 10,000", async () => {
    use({ rows: inbound(10_000) });
    const r = await blockerIds();
    assert.equal(r.status, 200);
    assertWhole(r.body, 10_000, "10,000");
  });

  it("10,001 blockers → a 503 refusal, never the first 10,000 presented as all of them", async () => {
    use({ rows: inbound(10_001) });
    const r = await blockerIds();
    assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.ids, undefined, "no list at all");
  });

  it("a page that fails MID-walk fails the whole answer: no prefix is served", async () => {
    use({ rows: inbound(1500), maxRows: 1000, failRead: 2 });
    const r = await blockerIds();
    assert.equal(r.status, 500, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.error, "db_error");
    assert.equal(r.body.ids, undefined, "the 1,000 rows of page one are not served");
  });

  it("a FIRST read that fails is db_error, as before (no empty list)", async () => {
    use({ rows: inbound(3), failRead: 1 });
    const r = await blockerIds();
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "db_error");
    assert.equal(r.body.ids, undefined);
  });
});
