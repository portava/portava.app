/**
 * GET /users/:username/og-image.png — visibility enforcement tests
 *
 * The OG image route must re-check resolveProfileVisibility with a null
 * viewer (crawlers are always unauthenticated) and serve the SAME generic
 * branded card for private / unavailable / unknown accounts, so the image
 * bytes never leak account state. A public profile gets a personalized card.
 *
 * Run: node --import tsx/esm --test src/test/ogImageVisibility.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportRouter from "../routes/passport.js";

const ALICE = "bb000000-0000-4000-a000-000000000002"; // public
const BOB   = "cc000000-0000-4000-a000-000000000003"; // private
const CARL  = "dd000000-0000-4000-a000-000000000004"; // deactivated

// ── Binary-safe request helper ────────────────────────────────────────────────

function getRaw(
  server: ReturnType<typeof createServer>,
  path: string,
): Promise<{ status: number; contentType: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import("net").AddressInfo;
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// ── Fake Supabase service client ──────────────────────────────────────────────

type FakeState = Record<string, any[]>;

function makeClient(state: FakeState) {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: "no token" } }),
    },
    from: (table: string) => {
      const filters: Array<(r: any) => boolean> = [];
      let _head = false;
      let _count: string | null = null;

      function rows() {
        return (state[table] ?? []).filter((row) => filters.every((f) => f(row)));
      }

      const builder: any = {
        select(_col?: string, opts?: any) {
          if (opts?.count) _count = opts.count;
          if (opts?.head) _head = true;
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        or() { return builder; },
        limit() { return builder; },
        order() { return builder; },
        maybeSingle() {
          const r = rows();
          return Promise.resolve({ data: r[0] ?? null, error: null });
        },
        single() {
          const r = rows();
          return Promise.resolve(
            r.length
              ? { data: r[0], error: null }
              : { data: null, error: { message: "no rows", code: "PGRST116" } },
          );
        },
        then(resolve: any, reject?: any) {
          if (_head && _count) {
            return Promise.resolve({ data: null, count: rows().length, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

const baseState: FakeState = {
  profiles: [
    {
      id: ALICE, handle: "alice_public", username: "alice_public",
      display_name: "Alice Explorer", name: "Alice",
      avatar_url: null, // no avatar → deterministic initials card, no fetch
      is_private: false, passport_visibility: "public", account_status: "active",
    },
    {
      id: BOB, handle: "bob_private", username: "bob_private",
      display_name: "Bob Secret", name: "Bob",
      avatar_url: null,
      is_private: true, passport_visibility: "private", account_status: "active",
    },
    {
      id: CARL, handle: "carl_gone", username: "carl_gone",
      display_name: "Carl Gone", name: "Carl",
      avatar_url: null,
      is_private: false, passport_visibility: "public", account_status: "deactivated",
    },
  ],
  blocks: [],
  user_follows: [],
  user_account_states: [],
  profile_privacy_settings: [],
  user_friendships: [],
  trips: [
    { id: "t1", owner_id: ALICE },
    { id: "t2", owner_id: ALICE },
  ],
  stamps: [{ id: "s1", user_id: ALICE, locked: false }],
};

// ── Test server ───────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  // Minimal req.log shim (routes use req.log.warn/error on fallback paths).
  app.use((req: any, _res, next) => {
    req.log = { info() {}, warn() {}, error() {} };
    next();
  });
  const client = makeClient(JSON.parse(JSON.stringify(baseState)));
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  app.use("/", passportRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /users/:username/og-image.png visibility enforcement", () => {
  let genericPng: Buffer;

  it("unknown user → 200 generic PNG (no 404 that would leak existence)", async () => {
    const r = await getRaw(server, "/users/does_not_exist_xyz/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.ok(r.body.length > 0, "should have image bytes");
    genericPng = r.body;
  });

  it("private profile → byte-identical generic PNG (no name/avatar leak)", async () => {
    const r = await getRaw(server, "/users/bob_private/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.ok(
      r.body.equals(genericPng),
      "private profile image must be identical to the unknown-user generic card",
    );
  });

  it("unavailable (deactivated) account → byte-identical generic PNG", async () => {
    const r = await getRaw(server, "/users/carl_gone/og-image.png");
    assert.equal(r.status, 200);
    assert.ok(
      r.body.equals(genericPng),
      "unavailable account image must be identical to the generic card",
    );
  });

  it("@-prefixed private handle → still generic", async () => {
    const r = await getRaw(server, "/users/@bob_private/og-image.png");
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(genericPng));
  });

  it("public profile → personalized PNG that differs from the generic card", async () => {
    const r = await getRaw(server, "/users/alice_public/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.ok(
      !r.body.equals(genericPng),
      "public profile should get a personalized (different) image",
    );
  });
});
