/**
 * Stamp share-link preview visibility tests
 *
 * Covers GET /users/:username/stamps/:stampId/preview and the ?stamp=<id>
 * variant of GET /users/:username/og-image.png. Share links
 * (/u/<username>?stamp=<id>) are rendered for anonymous crawlers, so a stamp
 * preview must only be served when the owner's profile is publicly visible
 * AND the stamp is public, non-revoked, and owned by that user. Everything
 * else must 404 (JSON endpoint) or fall back to the passport/generic card
 * (og-image) so link previews never leak private or revoked stamps.
 *
 * Run: node --import tsx/esm --test src/test/stampPreviewVisibility.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportRouter from "../routes/passport.js";

const ALICE = "bb000000-0000-4000-a000-000000000002"; // public profile
const BOB   = "cc000000-0000-4000-a000-000000000003"; // private profile
const CARL  = "dd000000-0000-4000-a000-000000000004"; // deactivated account
const DANA  = "ee000000-0000-4000-a000-000000000005"; // second public profile

// Stamp IDs (all valid UUIDs)
const STAMP_PUBLIC       = "11111111-1111-4111-a111-111111111111"; // Alice, public, active
const STAMP_FRIENDS_ONLY = "22222222-2222-4222-a222-222222222222"; // Alice, friends_only
const STAMP_PRIVATE      = "33333333-3333-4333-a333-333333333333"; // Alice, private
const STAMP_REVOKED      = "44444444-4444-4444-a444-444444444444"; // Alice, public but revoked
const STAMP_OF_DANA      = "55555555-5555-4555-a555-555555555555"; // Dana's public stamp
const STAMP_OF_BOB       = "66666666-6666-4666-a666-666666666666"; // Bob's public stamp (private profile)
const STAMP_MISSING      = "77777777-7777-4777-a777-777777777777"; // does not exist

// ── Request helpers ───────────────────────────────────────────────────────────

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

async function getJson(server: ReturnType<typeof createServer>, path: string) {
  const r = await getRaw(server, path);
  let json: any = null;
  try { json = JSON.parse(r.body.toString("utf-8")); } catch { /* non-JSON */ }
  return { status: r.status, json };
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

const stampDef = { name: "Tokyo Wanderer", stamp_type: "city", universal_artwork_url: null };

const baseState: FakeState = {
  profiles: [
    {
      id: ALICE, handle: "alice_public", username: "alice_public",
      display_name: "Alice Explorer", name: "Alice",
      avatar_url: null,
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
    {
      id: DANA, handle: "dana_public", username: "dana_public",
      display_name: "Dana Roamer", name: "Dana",
      avatar_url: null,
      is_private: false, passport_visibility: "public", account_status: "active",
    },
  ],
  blocks: [],
  user_follows: [],
  user_account_states: [],
  profile_privacy_settings: [],
  user_friendships: [],
  trips: [{ id: "t1", owner_id: ALICE }],
  stamps: [{ id: "s1", user_id: ALICE, locked: false }],
  user_stamps: [
    {
      id: STAMP_PUBLIC, user_id: ALICE, city: "Tokyo", country: "Japan",
      earned_at: "2026-05-01T00:00:00Z", title_override: null,
      visibility: "public", is_revoked: false, stamp_definitions: stampDef,
    },
    {
      id: STAMP_FRIENDS_ONLY, user_id: ALICE, city: "Paris", country: "France",
      earned_at: "2026-05-02T00:00:00Z", title_override: null,
      visibility: "friends_only", is_revoked: false, stamp_definitions: stampDef,
    },
    {
      id: STAMP_PRIVATE, user_id: ALICE, city: "Lima", country: "Peru",
      earned_at: "2026-05-03T00:00:00Z", title_override: null,
      visibility: "private", is_revoked: false, stamp_definitions: stampDef,
    },
    {
      id: STAMP_REVOKED, user_id: ALICE, city: "Rome", country: "Italy",
      earned_at: "2026-05-04T00:00:00Z", title_override: null,
      visibility: "public", is_revoked: true, stamp_definitions: stampDef,
    },
    {
      id: STAMP_OF_DANA, user_id: DANA, city: "Oslo", country: "Norway",
      earned_at: "2026-05-05T00:00:00Z", title_override: null,
      visibility: "public", is_revoked: false, stamp_definitions: stampDef,
    },
    {
      id: STAMP_OF_BOB, user_id: BOB, city: "Cairo", country: "Egypt",
      earned_at: "2026-05-06T00:00:00Z", title_override: null,
      visibility: "public", is_revoked: false, stamp_definitions: stampDef,
    },
  ],
};

// ── Test server ───────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
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

// ── JSON preview endpoint ─────────────────────────────────────────────────────

describe("GET /users/:username/stamps/:stampId/preview", () => {
  it("public profile + public stamp → 200 stamp card", async () => {
    const r = await getJson(server, `/users/alice_public/stamps/${STAMP_PUBLIC}/preview`);
    assert.equal(r.status, 200);
    assert.equal(r.json.label, "Tokyo Wanderer");
    assert.equal(r.json.city, "Tokyo");
    assert.equal(r.json.country, "Japan");
    assert.equal(r.json.ownerUsername, "alice_public");
  });

  it("friends_only stamp → 404", async () => {
    const r = await getJson(server, `/users/alice_public/stamps/${STAMP_FRIENDS_ONLY}/preview`);
    assert.equal(r.status, 404);
  });

  it("private stamp → 404", async () => {
    const r = await getJson(server, `/users/alice_public/stamps/${STAMP_PRIVATE}/preview`);
    assert.equal(r.status, 404);
  });

  it("revoked stamp → 404", async () => {
    const r = await getJson(server, `/users/alice_public/stamps/${STAMP_REVOKED}/preview`);
    assert.equal(r.status, 404);
  });

  it("stamp owned by a different user → 404 (no cross-user probing)", async () => {
    const r = await getJson(server, `/users/alice_public/stamps/${STAMP_OF_DANA}/preview`);
    assert.equal(r.status, 404);
  });

  it("public stamp on a PRIVATE profile → 404 (profile visibility wins)", async () => {
    const r = await getJson(server, `/users/bob_private/stamps/${STAMP_OF_BOB}/preview`);
    assert.equal(r.status, 404);
  });

  it("unavailable (deactivated) account → 404", async () => {
    const r = await getJson(server, `/users/carl_gone/stamps/${STAMP_PUBLIC}/preview`);
    assert.equal(r.status, 404);
  });

  it("unknown user → 404", async () => {
    const r = await getJson(server, `/users/nobody_here/stamps/${STAMP_PUBLIC}/preview`);
    assert.equal(r.status, 404);
  });

  it("missing stamp id → 404", async () => {
    const r = await getJson(server, `/users/alice_public/stamps/${STAMP_MISSING}/preview`);
    assert.equal(r.status, 404);
  });

  it("malformed (non-UUID) stamp id → 404", async () => {
    const r = await getJson(server, "/users/alice_public/stamps/not-a-uuid/preview");
    assert.equal(r.status, 404);
  });
});

// ── og-image ?stamp= variant ──────────────────────────────────────────────────

describe("GET /users/:username/og-image.png?stamp=<id>", () => {
  let passportPng: Buffer; // Alice's plain passport card (no stamp param)
  let genericPng: Buffer;  // generic branded card (unknown user)
  let stampPng: Buffer;    // Alice's public stamp card

  before(async () => {
    passportPng = (await getRaw(server, "/users/alice_public/og-image.png")).body;
    genericPng = (await getRaw(server, "/users/does_not_exist_xyz/og-image.png")).body;
  });

  it("public stamp → 200 PNG distinct from the passport card", async () => {
    const r = await getRaw(server, `/users/alice_public/og-image.png?stamp=${STAMP_PUBLIC}`);
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.ok(!r.body.equals(passportPng), "stamp variant should render a stamp card, not the passport card");
    assert.ok(!r.body.equals(genericPng), "stamp variant should not be the generic card");
    stampPng = r.body;
  });

  it("friends_only stamp → falls back to the passport card (no stamp leak)", async () => {
    const r = await getRaw(server, `/users/alice_public/og-image.png?stamp=${STAMP_FRIENDS_ONLY}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(passportPng), "must be byte-identical to the passport card");
  });

  it("private stamp → falls back to the passport card", async () => {
    const r = await getRaw(server, `/users/alice_public/og-image.png?stamp=${STAMP_PRIVATE}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(passportPng));
  });

  it("revoked stamp → falls back to the passport card", async () => {
    const r = await getRaw(server, `/users/alice_public/og-image.png?stamp=${STAMP_REVOKED}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(passportPng));
  });

  it("stamp owned by another user → falls back to the passport card", async () => {
    const r = await getRaw(server, `/users/alice_public/og-image.png?stamp=${STAMP_OF_DANA}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(passportPng));
  });

  it("valid public stamp but PRIVATE profile → generic card (no stamp, no profile leak)", async () => {
    const r = await getRaw(server, `/users/bob_private/og-image.png?stamp=${STAMP_OF_BOB}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(genericPng), "private profile must yield the generic card even with a valid stamp id");
    assert.ok(!r.body.equals(stampPng));
  });

  it("unavailable (deactivated) account + stamp param → generic card", async () => {
    const r = await getRaw(server, `/users/carl_gone/og-image.png?stamp=${STAMP_PUBLIC}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(genericPng));
  });

  it("unknown user + stamp param → generic card", async () => {
    const r = await getRaw(server, `/users/ghost_user/og-image.png?stamp=${STAMP_PUBLIC}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(genericPng));
  });

  it("malformed stamp id → falls back to the passport card (never 500)", async () => {
    const r = await getRaw(server, "/users/alice_public/og-image.png?stamp=<script>");
    assert.equal(r.status, 200);
    assert.ok(r.body.equals(passportPng));
  });

  it("personalized stamp render must not be cached forever (no immutable cache leak window)", async () => {
    // The stamp card is public data, but assert cache-control is bounded.
    const addr = server.address() as import("net").AddressInfo;
    const resp = await fetch(`http://127.0.0.1:${addr.port}/users/alice_public/og-image.png?stamp=${STAMP_PUBLIC}`);
    const cc = resp.headers.get("cache-control") ?? "";
    assert.ok(!/immutable/.test(cc), "stamp preview must not be immutable-cached");
  });
});
