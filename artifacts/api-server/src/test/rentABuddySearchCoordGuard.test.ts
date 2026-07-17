/**
 * rentABuddySearchCoordGuard.test.ts
 *
 * Confirms the shared isNonNumericCoord guard fires on the Buddy search
 * endpoint (POST /api/rent-a-buddy/search) for coord values that are not
 * finite numbers — NaN, Infinity, and strings — all returning
 * 400 { error: "invalid_payload" }.
 *
 * NaN and Infinity cannot travel through JSON, so a body-injecting
 * middleware assigns req.body directly. This exercises the exact same
 * route handler while letting non-JSON-representable values reach it —
 * matching what would happen if a custom parser or an upstream layer
 * ever produced such values.
 *
 * Run: node --import tsx/esm --test src/test/rentABuddySearchCoordGuard.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import rentABuddyRouter from "../routes/rentABuddy.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

// The body each request should carry — set per test, injected by middleware
// so non-JSON values (NaN, Infinity) can reach the handler.
let injectedBody: Record<string, unknown> = {};

function search(body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  injectedBody = body;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: new URL(base).hostname,
        port: Number(new URL(base).port),
        path: "/api/rent-a-buddy/search",
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// ── Minimal fake builder ───────────────────────────────────────────────────────
// The coord guard fires before any DB query beyond the feature-flag check,
// so only feature_flags needs a meaningful result.
function makeBuilder(result: any): any {
  const b: any = {
    select: () => b,
    insert: () => b,
    upsert: () => b,
    update: () => b,
    delete: () => b,
    eq: () => b,
    neq: () => b,
    in: () => b,
    is: () => b,
    gte: () => b,
    lte: () => b,
    gt: () => b,
    lt: () => b,
    like: () => b,
    ilike: () => b,
    contains: () => b,
    overlaps: () => b,
    order: () => b,
    limit: () => b,
    range: () => b,
    single:      () => Promise.resolve({ data: result, error: null }),
    maybeSingle: () => Promise.resolve({ data: result, error: null }),
    then: (resolve: (r: any) => any) =>
      Promise.resolve({ data: result ? [result] : [], error: null }).then(resolve),
  };
  return b;
}

function makeServiceClient() {
  return {
    auth: { getUser: () => Promise.resolve({ data: { user: null }, error: null }) },
    from: (table: string) => {
      if (table === "feature_flags") {
        return makeBuilder({ flag: "rent_buddy_enabled", enabled: true });
      }
      return makeBuilder(null);
    },
  };
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  // Body injector instead of express.json(): lets NaN/Infinity reach the route.
  app.use((req, _res, next) => {
    req.body = injectedBody;
    next();
  });
  app.use(rentABuddyRouter);

  _setTestClient(makeServiceClient() as any, true);
  _setTestServiceClient(makeServiceClient() as any);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => new Promise<void>((resolve, reject) =>
  server.close((err) => (err ? reject(err) : resolve()))
));

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("POST /api/rent-a-buddy/search — isNonNumericCoord guard", () => {
  it("rejects NaN lat with 400 invalid_payload", async () => {
    const res = await search({ city: "Bangkok", lat: NaN, lng: 100.5018 });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects Infinity lat with 400 invalid_payload", async () => {
    const res = await search({ city: "Bangkok", lat: Infinity, lng: 100.5018 });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects -Infinity lat with 400 invalid_payload", async () => {
    const res = await search({ city: "Bangkok", lat: -Infinity, lng: 100.5018 });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects string lat with 400 invalid_payload", async () => {
    const res = await search({ city: "Bangkok", lat: "13.7563", lng: 100.5018 });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("rejects NaN lng with 400 invalid_payload", async () => {
    const res = await search({ city: "Bangkok", lat: 13.7563, lng: NaN });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "invalid_payload");
  });

  it("accepts a valid finite pair (never 400 invalid_payload)", async () => {
    const res = await search({ city: "Bangkok", lat: 13.7563, lng: 100.5018 });
    assert.notEqual(res.status, 400, `unexpected invalid_payload: ${JSON.stringify(res.body)}`);
  });
});
