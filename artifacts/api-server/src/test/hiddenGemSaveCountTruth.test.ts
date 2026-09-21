/**
 * saveGem — the save_count increment must never be lost SILENTLY.
 *
 * ── THE DEFECT (measured, not read) ──────────────────────────────────────────
 * `saveGem` bumps `hidden_gems.save_count` through the `increment_counter` RPC
 * and, when that RPC errors, falls back to a read-then-update. BOTH legs of the
 * fallback were swallowed with `logger.warn`, and the function returned the
 * identical `{ alreadySaved: false }` whether the counter moved or not. The
 * route answered `{ ok: true, alreadySaved: false }` either way, so a lost
 * increment left no trace anywhere a caller could see.
 *
 * It was unreachable in tests until the doubles were made faithful: an
 * unregistered `.rpc()` on `failClosedSupabase` now resolves PGRST202 (the real
 * client's own answer for a missing function) instead of `{ error: null }`, so
 * every save in this file takes the fallback unless a handler is registered.
 * That is exactly why nobody noticed — the old double made the RPC "succeed".
 *
 * ── WHY IT IS NOT COSMETIC ───────────────────────────────────────────────────
 * `save_count` is a threshold input to `deriveHiddenGemState`
 * (lib/hiddenGemState.ts):
 *
 *     saves >= NO_LONGER_HIDDEN_SAVE_THRESHOLD &&
 *     visits >= NO_LONGER_HIDDEN_VISIT_THRESHOLD  ->  "no_longer_hidden"
 *
 * and "no_longer_hidden" is the state that stops the system pushing a small
 * real place that has already been discovered out. An UNDER-count is the
 * harmful direction: the gem keeps reading as still hidden and keeps being
 * recommended into a place that is already overloaded. Nothing recomputes
 * save_count from `hidden_gem_saves`, so the loss is permanent.
 *
 * ── THE RESOLUTION UNDER TEST ────────────────────────────────────────────────
 * Throwing is the WRONG fix: the `hidden_gem_saves` row is already committed
 * when the counter is touched, so a throw would tell the caller "your save
 * failed" about a save that happened. Instead `saveGem` REPORTS
 * `saveCountIncremented`, the route puts it in the response, and the failure is
 * logged at ERROR with `code: "save_count_increment_lost"`.
 *
 * Every case pairs the failure with a CONTROL, and asserts the durable save row
 * is present in BOTH — a "fix" that refused to save at all would otherwise pass
 * every failure assertion here.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/hiddenGemSaveCountTruth.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { saveGem } from "../services/hiddenGems/HiddenGemService.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";

const USER = "10000000-0000-4000-a000-000000000001";
const GEM  = "20000000-0000-4000-a000-000000000003";
const TOKEN = "save-count-truth-token";

/** A registered `increment_counter` that behaves like the real stored proc. */
const rpcOk = { increment_counter: () => ({ data: null, error: null }) };
/** A registered `increment_counter` that fails the way a broken proc fails. */
const rpcDown = {
  increment_counter: () => ({ data: null, error: { code: "57P01", message: "increment_counter unavailable" } }),
};

const gemsUnreadable = (ctx: FakeReadContext) =>
  ctx.table === "hidden_gems" ? { message: "hidden_gems unreadable", code: "57P01" } : null;

function seed(extra: Record<string, any> = {}) {
  return {
    rows: {
      hidden_gem_saves: [] as any[],
      hidden_gems: [{ id: GEM, save_count: 7, status: "active" }],
      feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }],
    },
    users: { [TOKEN]: USER },
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Service level
// ─────────────────────────────────────────────────────────────────────────────

describe("saveGem — save_count truth", () => {
  it("CONTROL: the atomic RPC path counts, reports true, and writes no fallback update", async () => {
    const inserted: Record<string, any[]> = {};
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({ ...seed(), rpc: rpcOk, inserted, updated });

    const r = await saveGem(db, GEM, USER);
    assert.deepEqual(r, { alreadySaved: false, saveCountIncremented: true });
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 1, "the save row is durable");
    assert.equal((updated["hidden_gems"] ?? []).length, 0, "the RPC path must not also read-modify-write");
  });

  it("CONTROL: the fallback path counts, reports true, and writes save_count + 1", async () => {
    const inserted: Record<string, any[]> = {};
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({ ...seed(), rpc: rpcDown, inserted, updated });

    const r = await saveGem(db, GEM, USER);
    assert.deepEqual(r, { alreadySaved: false, saveCountIncremented: true });
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 1, "the save row is durable");
    const writes = updated["hidden_gems"] ?? [];
    assert.equal(writes.length, 1, "vacuity guard: the fallback must actually write");
    assert.deepEqual(writes[0], { save_count: 8 }, "seeded 7, so the fallback writes 8");
  });

  it("fallback READ fails: the save is durable, the increment is LOST, and saveGem says so", async () => {
    const inserted: Record<string, any[]> = {};
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      ...seed(), rpc: rpcDown, failOn: gemsUnreadable, inserted, updated,
    });

    const r = await saveGem(db, GEM, USER);
    assert.equal(r.alreadySaved, false);
    assert.equal(r.saveCountIncremented, false, "an unreadable hidden_gems must not read as 'counted'");
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 1, "the save itself still happened");
    assert.equal((updated["hidden_gems"] ?? []).length, 0, "nothing was written to the counter");
  });

  it("fallback UPDATE fails: the save is durable, the increment is LOST, and saveGem says so", async () => {
    const inserted: Record<string, any[]> = {};
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      ...seed(),
      rpc: rpcDown,
      failWritesOn: (t: string) => (t === "hidden_gems" ? { code: "57P01", message: "counter write refused" } : null),
      inserted, updated,
    });

    const r = await saveGem(db, GEM, USER);
    assert.equal(r.alreadySaved, false);
    assert.equal(r.saveCountIncremented, false, "a refused counter write must not read as 'counted'");
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 1, "the save itself still happened");
  });

  it("an unregistered increment_counter is a FAILURE, not silence (the double's PGRST202)", async () => {
    // No `rpc` key at all: this is the shape that used to resolve
    // `{ data: null, error: null }` and hide the whole fallback from every test.
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({ ...seed(), updated });

    const r = await saveGem(db, GEM, USER);
    assert.equal(r.saveCountIncremented, true, "the fallback rescued it");
    assert.equal((updated["hidden_gems"] ?? []).length, 1, "so the fallback must have run");
  });

  it("an already-saved gem counts nothing and claims to count nothing", async () => {
    const inserted: Record<string, any[]> = {};
    const updated: Record<string, any[]> = {};
    const db = makeFailClosedClient({
      rows: {
        hidden_gem_saves: [{ gem_id: GEM, user_id: USER }],
        hidden_gems: [{ id: GEM, save_count: 7 }],
      },
      rpc: rpcOk, inserted, updated,
    });

    assert.deepEqual(await saveGem(db, GEM, USER), { alreadySaved: true, saveCountIncremented: false });
    assert.equal((inserted["hidden_gem_saves"] ?? []).length, 0);
    assert.equal((updated["hidden_gems"] ?? []).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Route level — the response must carry the same truth
// ─────────────────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

function post(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname,
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  // The `req.log` shim the real server installs. Without it a route that logs
  // CRASHES and the 500-from-crash masquerades as a deliberate failure.
  app.use((req: any, _res, next) => {
    const noop = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => noop };
    req.log = noop;
    next();
  });
  app.use("/api", hiddenGemsRouter);
  // `resolve` is NOT passed straight to listen(): its parameter is
  // `void | PromiseLike<void>` while the listen callback's is `Error | undefined`,
  // so handing it over both fails the test typecheck and would resolve the
  // promise WITH a listen error rather than surfacing it. Await the listening
  // callback, then read the assigned port.
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === "object", "server must be listening on a TCP port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
  _setTestClient(null, false);
  _setTestServiceClient(null);
});

describe("POST /api/hidden-gems/:id/save — the response tells the truth about the counter", () => {
  it("CONTROL: a healthy save reports saveCountIncremented: true", async () => {
    const db = makeFailClosedClient({ ...seed(), rpc: rpcOk });
    _setTestClient(db, true);
    _setTestServiceClient(db);

    const r = await post(`/api/hidden-gems/${GEM}/save`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.alreadySaved, false);
    assert.equal(r.body.saveCountIncremented, true);
  });

  it("a lost increment is still a 200 (the save happened) but the body says the counter did not move", async () => {
    const db = makeFailClosedClient({ ...seed(), rpc: rpcDown, failOn: gemsUnreadable });
    _setTestClient(db, true);
    _setTestServiceClient(db);

    const r = await post(`/api/hidden-gems/${GEM}/save`);
    // Not `status !== 200`: the save IS durable, so 200 is the honest code.
    assert.equal(r.status, 200, "the save row committed; a 5xx here would be the opposite lie");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.alreadySaved, false, "the save is new");
    assert.equal(
      r.body.saveCountIncremented, false,
      "the response must not imply save_count moved when it did not",
    );
  });
});
