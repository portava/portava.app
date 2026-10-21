/**
 * census-telegraph T220c — GET /users/:userId/block-status reads each direction
 * as a `.limit(1)` EXISTENCE read, never `.maybeSingle()`, and every failure is
 * the route's one refusal.
 *
 * node:test + node:assert. In-process fake; listens on 127.0.0.1 (run with
 * loopback allowed).
 *
 * The schema allows one row per direction — UNIQUE(blocker_id, blocked_id),
 * `blocks_pair_unique`, in the baseline (20260819_baseline_structure.sql) and in
 * 0015_blocks.sql — so today neither directional read can match two rows. But
 * `.maybeSingle()` RAISES on a second row (PGRST116), so the answer leaned on
 * that constraint: a duplicate turned a REAL block into "temporarily
 * unavailable". "Is there a row" is `.limit(1)` and a length. The same change
 * makes the failure handling whole: a returned error (as before), a THROWN read
 * (it escaped the handler as a bare 500) and an answer that is not a row list
 * (a string read as `true`) all answer the route's db_error refusal ("Block
 * status is temporarily unavailable", kept server-side by sendError) — never a
 * confident false/false.
 *
 * Each case says whether it was RED or GREEN on the code before T220c
 * (a85d2eb78). The fake answers `.maybeSingle()` the way PostgREST does
 * (PGRST116 on more than one row), so the old code is measured, not assumed.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import blocksRouter from "../routes/blocks.js";

const VIEWER = "a5555555-5555-4555-8555-5555555220c0";
const TARGET = "a6666666-6666-4666-8666-6666666220c1";
const ERR = { message: "simulated blocks failure", code: "57014" };

type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: number | null };
type BlockRow = { blocker_id: string; blocked_id: string };

interface World {
  rows: BlockRow[];
  /** Override a `blocks` read: the direction is "mine" (viewer → target) or "theirs" (target → viewer). */
  blocks?: (direction: "mine" | "theirs", calls: Call[]) => Answer | "throw" | undefined;
  reads: Call[][];
}

function client(w: World) {
  function builder(table: string) {
    const calls: Call[] = [];
    const answer = (single: boolean): Answer => {
      if (table === "profiles") return single ? { data: { id: VIEWER, account_status: "active" }, error: null } : { data: [], error: null };
      if (table !== "blocks") return { data: single ? null : [], error: null };
      w.reads.push(calls);
      const eq = (c: string) => calls.find(([m, a]) => m === "eq" && a[0] === c)?.[1][1];
      const direction = eq("blocker_id") === VIEWER ? "mine" : "theirs";
      const over = w.blocks?.(direction, calls);
      if (over === "throw") throw new Error("simulated thrown blocks read");
      if (over) return over;
      let rows = w.rows.filter((r) => r.blocker_id === eq("blocker_id") && r.blocked_id === eq("blocked_id"));
      const lim = calls.find(([m]) => m === "limit");
      if (lim) rows = rows.slice(0, lim[1][0] as number);
      if (single) {
        if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows.map((r) => ({ blocked_id: r.blocked_id })), error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve().then(() => answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => { calls.push([prop, []]); return Promise.resolve().then(() => answer(true)); };
        return (...args: unknown[]) => { calls.push([prop, args]); return b; };
      },
    });
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: VIEWER } }, error: null }) },
  } as any;
}

describe("T220c — GET /users/:userId/block-status: limit-1 existence reads, one refusal for every failure", () => {
  let server: http.Server;
  let base = "";
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    app.use(blocksRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => server.close());

  async function status(o: Partial<World>): Promise<{ status: number; body: any; reads: Call[][] }> {
    const w: World = { rows: o.rows ?? [], blocks: o.blocks, reads: [] };
    const c = client(w);
    _setTestClient(c, true);
    _setTestServiceClient(c);
    const r = await fetch(`${base}/users/${TARGET}/block-status`, { headers: { authorization: "Bearer fake.jwt.token" } });
    const text = await r.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, reads: w.reads };
  }

  const MINE = { blocker_id: VIEWER, blocked_id: TARGET };
  const THEIRS = { blocker_id: TARGET, blocked_id: VIEWER };

  it("GREEN before (CONTROL): nobody blocked → 200 false / false", async () => {
    const r = await status({});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { userId: TARGET, iBlocked: false, theyBlockedMe: false });
  });

  for (const [name, rows, want] of [
    ["the viewer blocked the target", [MINE], [true, false]],
    ["the target blocked the viewer", [THEIRS], [false, true]],
    ["a MUTUAL block (two rows, one per direction)", [MINE, THEIRS], [true, true]],
  ] as Array<[string, BlockRow[], [boolean, boolean]]>) {
    it(`GREEN before: ${name} → iBlocked ${want[0]}, theyBlockedMe ${want[1]}`, async () => {
      const r = await status({ rows });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.iBlocked, r.body.theyBlockedMe], want);
    });
  }

  it("RED before: each direction is ONE `.select(\"blocked_id\").eq(blocker).eq(blocked).limit(1)` read — no `.maybeSingle()`", async () => {
    const r = await status({});
    assert.equal(r.reads.length, 2);
    assert.deepEqual(r.reads.map((c) => c.map(([m]) => m)), [["select", "eq", "eq", "limit"], ["select", "eq", "eq", "limit"]]);
    for (const c of r.reads) assert.deepEqual(c.find(([m]) => m === "limit"), ["limit", [1]]);
  });

  for (const direction of ["mine", "theirs"] as const) {
    it(`RED before: a direction holding TWO rows (a duplicate the UNIQUE constraint forbids today) still answers BLOCKED (${direction}) — maybeSingle refused a real block as "unavailable"`, async () => {
      const row = direction === "mine" ? MINE : THEIRS;
      const r = await status({ rows: [row, { ...row }] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(direction === "mine" ? r.body.iBlocked : r.body.theyBlockedMe, true);
    });

    it(`GREEN before: a returned error (${direction}) → the route's db_error refusal`, async () => {
      const r = await status({ rows: [MINE], blocks: (d) => (d === direction ? { data: null, error: ERR } : undefined) });
      assert.equal(r.body?.error, "db_error", JSON.stringify(r.body)); // the route's JSON refusal (sendError keeps the detail server-side)
      assert.equal(r.body?.iBlocked, undefined);
    });

    it(`RED before: a THROWN read (${direction}) → the same db_error refusal — it escaped the handler as a bare 500`, async () => {
      const r = await status({ blocks: (d) => (d === direction ? "throw" : undefined) });
      assert.equal(r.body?.error, "db_error", JSON.stringify(r.body)); // the route's JSON refusal (sendError keeps the detail server-side)
      assert.equal(r.body?.iBlocked, undefined);
    });

    it(`RED before: an answer that is not a row list — a string, no error (${direction}) → db_error, never a status (it read as \`true\`)`, async () => {
      const r = await status({ blocks: (d) => (d === direction ? { data: "not rows", error: null } : undefined) });
      assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
      assert.equal(r.body?.iBlocked, undefined);
    });

    it(`NEW CONTRACT (RED before, by design): \`data: null\` with no error (${direction}) is not a row list → db_error. (Under maybeSingle a null WAS its no-row answer; under limit(1) "no row" is [].)`, async () => {
      const r = await status({ rows: [MINE], blocks: (d) => (d === direction ? { data: null, error: null } : undefined) });
      assert.equal(r.body?.error, "db_error", JSON.stringify(r.body));
    });
  }

  it("GREEN before: an invalid id is still invalid_payload, and no blocks read is made", async () => {
    const w: World = { rows: [], reads: [] };
    const c = client(w);
    _setTestClient(c, true);
    _setTestServiceClient(c);
    const r = await fetch(`${base}/users/not-a-uuid/block-status`, { headers: { authorization: "Bearer fake.jwt.token" } });
    assert.equal(r.status, 400);
    assert.equal(w.reads.length, 0);
  });
});
