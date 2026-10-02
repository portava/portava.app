/**
 * lib/postgrestFilter.safeOrIlikeValue — a value spliced into an `.or()` ilike
 * pattern matches LITERALLY. census-discovery §80.14 (lane W10-S1).
 *
 * THE DEFECT. The helper LIKE-escaped first (`%` → `\%`, `_` → `\_`, `\` → `\\`)
 * and THEN stripped the `.or()` structural characters, which include `\`. So
 * the second pass removed every escape the first had just added, and `%` and
 * `_` reached the database as wildcards: "100%" matched "1000 Lakes", "a_b"
 * matched "axb", and a single "%" in a people search matched everyone.
 *
 * THE FIX is the order census-discovery §80.13 gave the duplicate scan: strip
 * the structure first (so no user backslash survives to re-open a wildcard),
 * then LIKE-escape (so the escapes the helper adds are the only backslashes in
 * the value). PostgREST passes an UNQUOTED `.or()` value through verbatim —
 * only a double-quoted value treats `\` as an escape — so `\%` arrives at SQL
 * ILIKE as a literal percent sign.
 *
 * Proven on the helper and on two real route callers, each driven over HTTP
 * with a fake client that records the `.or()` expression the route builds:
 * `GET /users/search` (routes/follows.ts) and `GET /tags/suggestions`
 * (routes/tags.ts).
 *
 * Run: node --import tsx/esm --test src/test/postgrestFilterLikeEscape.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { safeOrIlikeValue } from "../lib/postgrestFilter.js";
import followsRouter from "../routes/follows.js";
import tagsRouter from "../routes/tags.js";

// ── The helper ──────────────────────────────────────────────────────────────

describe("safeOrIlikeValue — strip the structure, then escape the wildcards", () => {
  it("a percent sign is escaped, not left as a wildcard", () => {
    assert.equal(safeOrIlikeValue("100%"), "100\\%");
  });

  it("an underscore is escaped, not left as a single-character wildcard", () => {
    assert.equal(safeOrIlikeValue("a_b"), "a\\_b");
  });

  it("a user backslash is stripped, so it cannot re-open a wildcard", () => {
    // "\%" typed by the user must not become "\\%" (a literal backslash then a
    // live wildcard) nor survive as "\%" of the user's making.
    assert.equal(safeOrIlikeValue("50\\%"), "50\\%");
    assert.equal(safeOrIlikeValue("kiosk\\"), "kiosk");
  });

  it("the .or() structural characters are still removed (the injection guard is unchanged)", () => {
    assert.equal(safeOrIlikeValue("zzz,name.ilike."), "zzznameilike");
    assert.equal(safeOrIlikeValue('a(b)"c'), "abc");
  });

  it("the only backslashes in the output are the ones escaping % and _", () => {
    for (const v of ["100%", "a_b", "\\\\%_", "x\\y", "%,_.(\\)"]) {
      const out = safeOrIlikeValue(v);
      assert.ok(!/\\(?![%_])/.test(out), `${JSON.stringify(v)} → ${JSON.stringify(out)} has a stray backslash`);
      assert.ok(!/(?<!\\)[%_]/.test(out), `${JSON.stringify(v)} → ${JSON.stringify(out)} has an unescaped wildcard`);
    }
  });
});

// ── The route callers ───────────────────────────────────────────────────────

const CALLER_ID = "aaaaaaaa-1111-0000-0000-000000000001";

/** A permissive fake: every read is empty, and every `.or()` is recorded. */
function recordingClient(orCalls: Array<{ table: string; expr: string }>) {
  const build = (table: string): any => {
    let single = false;
    const q: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") {
          return (res: any, rej: any) =>
            Promise.resolve(single ? { data: null, error: null, count: 0 } : { data: [], error: null, count: 0 }).then(res, rej);
        }
        if (prop === "or") return (expr: string) => { orCalls.push({ table, expr }); return q; };
        if (prop === "single" || prop === "maybeSingle") return () => { single = true; return q; };
        return () => q;
      },
    });
    return q;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: CALLER_ID, email: "t@example.com" } }, error: null }) },
    from: (table: string) => build(table),
    rpc: () => build("rpc"),
    storage: { from: () => ({ remove: async () => ({}) }) },
  };
}

let server: http.Server;
let base: string;

function get(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET", headers: { authorization: "Bearer fake.jwt.token" } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    r.on("error", reject);
    r.end();
  });
}

describe("route callers splice the escaped value into .or()", () => {
  before(() => {
    const app = express();
    app.use(express.json());
    app.use(followsRouter);
    app.use("/api", tagsRouter);
    server = http.createServer(app);
    return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)).then(() => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
  });
  after(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));

  function install() {
    const orCalls: Array<{ table: string; expr: string }> = [];
    const client = recordingClient(orCalls);
    _setTestClient(client as any, true);
    _setTestServiceClient(client as any);
    return orCalls;
  }

  it("GET /users/search?q=100% — the people search matches a literal percent sign", async () => {
    const orCalls = install();
    assert.equal(await get(`/users/search?q=${encodeURIComponent("100%")}`), 200);
    const expr = orCalls.find((c) => c.table === "profiles")?.expr;
    assert.ok(expr, "the route built no .or() on profiles");
    assert.equal(expr, "name.ilike.%100\\%%,handle.ilike.%100\\%%,username.ilike.%100\\%%");
  });

  it("GET /tags/suggestions?q=a_b — the mention picker matches a literal underscore", async () => {
    const orCalls = install();
    assert.equal(await get(`/api/tags/suggestions?q=${encodeURIComponent("a_b")}`), 200);
    const expr = orCalls.find((c) => c.table === "profiles")?.expr;
    assert.ok(expr, "the route built no .or() on profiles");
    assert.equal(expr, "handle.ilike.a\\_b%,name.ilike.%a\\_b%");
  });
});
