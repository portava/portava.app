/**
 * census-discovery §104 (DV-83, D-W11X2-57) — GET /hashtags/trending feeds the
 * Discover screen's trending chips. With city scope and no usage in the city, the
 * route falls back to global usage; that fallback read's error was ignored, so a
 * failed read answered `200 { trending: [] }`, which the screen draws as "nothing
 * trending". It now answers the route's own db_error, as its first read already did.
 *
 *   HT1  city scope empty, the global fallback read fails → db_error, never 200 []
 *   HTc  CONTROL city scope empty, the fallback reads and is empty → 200 { trending: [] }
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/hashtagsTrendingFallbackRead.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import hashtagsRouter from "../routes/hashtags.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "ab000000-0000-4000-a000-000000000001";
const TOKEN = "tok-hashtags-fallback";

function client(fallbackFails: boolean) {
  function builder(table: string) {
    const calls: Record<string, unknown[]> = {};
    const answer = (single: boolean) => {
      if (table === "profiles") return { data: single ? { id: VIEWER, account_status: "active" } : [], error: null };
      if (table === "hashtag_usage" && calls.eq === undefined && fallbackFails) return { data: null, error: { code: "57014", message: "statement timeout" } };
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer(true));
        return (...args: unknown[]) => { calls[prop] = args; return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => builder(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", hashtagsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());

async function get() {
  const r = await fetch(`${base}/hashtags/trending?scope=city&city_id=Rome`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: (await r.json()) as { error?: string; trending?: unknown[] } };
}

describe("§104 GET /hashtags/trending — the global fallback read", () => {
  it("HT1 city scope empty, the fallback read fails → db_error, never 200 []", async () => {
    _setTestClient(client(true), true);
    const { status, body } = await get();
    assert.notEqual(status, 200, JSON.stringify(body));
    assert.equal(body.error, "db_error");
  });

  it("HTc CONTROL city scope empty, the fallback reads and is empty → 200 { trending: [] }", async () => {
    _setTestClient(client(false), true);
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.deepEqual(body.trending, []);
  });
});
