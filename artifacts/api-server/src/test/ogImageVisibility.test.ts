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
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import passportRouter from "../routes/passport.js";

const ALICE = "bb000000-0000-4000-a000-000000000002"; // public
const BOB   = "cc000000-0000-4000-a000-000000000003"; // private
const CARL  = "dd000000-0000-4000-a000-000000000004"; // deactivated
const FRED  = "ee000000-0000-4000-a000-000000000005"; // public, show_profile_picture_publicly=false
const GINA  = "ff000000-0000-4000-a000-000000000006"; // public, show_profile_picture_publicly=true

const TRUSTED_SUPABASE_URL = "https://sb.example.test";
const TRUSTED_AVATAR_URL = `${TRUSTED_SUPABASE_URL}/storage/v1/object/public/profile-media/avatars/x.jpg`;
// A valid, minimal 1x1 transparent PNG — stands in for a real avatar fetch.
const STUB_AVATAR_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// ── Binary-safe request helper ────────────────────────────────────────────────

function getRaw(
  server: ReturnType<typeof createServer>,
  path: string,
): Promise<{ status: number; contentType: string; cacheControl: string; body: Buffer }> {
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
            cacheControl: String(res.headers["cache-control"] ?? ""),
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
      // Column projection for "profiles" only: without this, a mutation that
      // strips a column from the og-image route's SELECT string would go
      // unnoticed — the mock would keep returning the full fixture row
      // regardless of what was actually requested.
      let profileCols: string[] | null = null;

      function rows() {
        let r = (state[table] ?? []).filter((row) => filters.every((f) => f(row)));
        if (table === "profiles" && profileCols) {
          r = r.map((row) => Object.fromEntries(profileCols!.filter((c) => c in row).map((c) => [c, row[c]])));
        }
        return r;
      }

      const builder: any = {
        select(cols?: string, opts?: any) {
          if (table === "profiles" && typeof cols === "string" && cols !== "*") {
            profileCols = cols.split(",").map((c) => c.trim());
          }
          if (opts?.count) _count = opts.count;
          if (opts?.head) _head = true;
          return builder;
        },
        eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
        neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
        in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
        not() { return builder; },
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
    {
      id: FRED, handle: "fred_hidden", username: "fred_hidden",
      display_name: "Fred Hidden", name: "Fred",
      avatar_url: TRUSTED_AVATAR_URL,
      is_private: false, passport_visibility: "public", account_status: "active",
      show_profile_picture_publicly: false,
    },
    {
      id: GINA, handle: "gina_shown", username: "gina_shown",
      display_name: "Gina Shown", name: "Gina",
      avatar_url: TRUSTED_AVATAR_URL,
      is_private: false, passport_visibility: "public", account_status: "active",
      show_profile_picture_publicly: true,
    },
  ],
  blocks: [],
  user_follows: [],
  // og-image.png's own profiles SELECT does not include account_status (only
  // "id, username, display_name, name, avatar_url, passport_visibility,
  // is_private, show_profile_picture_publicly") — resolveProfileVisibility
  // falls through to this table for account-state checks on that route.
  // (Previously this test passed only because the mock ignored SELECT
  // strings entirely and always returned the full fixture row, including a
  // carl_gone.account_status the route never actually fetches — fixed by
  // making CARL's deactivation reachable through the real fallback path.)
  user_account_states: [{ user_id: CARL, state: "deactivated" }],
  profile_privacy_settings: [],
  user_friendships: [],
  trips: [
    { id: "t1", owner_id: ALICE },
    { id: "t2", owner_id: ALICE },
  ],
  stamps: [{ id: "s1", user_id: ALICE, locked: false }],
  user_stamps: [
    {
      id: "aa000000-0000-4000-a000-000000001001",
      user_id: ALICE,
      city: "Lisbon", country: "Portugal",
      earned_at: "2026-05-01T00:00:00Z",
      title_override: "Lisbon Explorer",
      visibility: "public", is_revoked: false,
      stamp_definitions: { name: "Lisbon", stamp_type: "city", universal_artwork_url: null },
    },
    {
      id: "aa000000-0000-4000-a000-000000002002",
      user_id: ALICE,
      city: "Hidden City", country: "Nowhere",
      earned_at: "2026-05-02T00:00:00Z",
      title_override: "Secret Stamp",
      visibility: "private", is_revoked: false,
      stamp_definitions: { name: "Hidden", stamp_type: "city", universal_artwork_url: null },
    },
  ],
};

const PUBLIC_STAMP_ID = baseState.user_stamps[0].id;
const PRIVATE_STAMP_ID = baseState.user_stamps[1].id;

// ── Test server ───────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;

const OLD_SUPABASE_URL = process.env.SUPABASE_URL;
const OLD_FETCH = globalThis.fetch;
let fetchCallUrls: string[] = [];

beforeEach(() => { fetchCallUrls = []; });

before(async () => {
  process.env.SUPABASE_URL = TRUSTED_SUPABASE_URL;
  // Stub the avatar fetch so the flag-gating tests below never touch the
  // network — a spy that both records calls (to prove the gate ran BEFORE
  // any fetch attempt, not just that the resulting image looks right) and
  // returns a valid image so the "flag on" path still gets a real data URI.
  globalThis.fetch = (async (url: any, init?: any) => {
    fetchCallUrls.push(String(url));
    if (String(url) === TRUSTED_AVATAR_URL) {
      return new Response(STUB_AVATAR_PNG, {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
    return OLD_FETCH(url, init);
  }) as typeof fetch;

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
  process.env.SUPABASE_URL = OLD_SUPABASE_URL;
  globalThis.fetch = OLD_FETCH;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

const NO_STORE = "no-store, no-cache, must-revalidate";
const GENERIC_CACHE = "public, max-age=600";

describe("GET /users/:username/og-image.png visibility enforcement", () => {
  let genericPng: Buffer;

  it("unknown user → 200 generic PNG (no 404 that would leak existence)", async () => {
    const r = await getRaw(server, "/users/does_not_exist_xyz/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.ok(r.body.length > 0, "should have image bytes");
    assert.equal(r.cacheControl, GENERIC_CACHE, "generic image must stay publicly cacheable");
    genericPng = r.body;
  });

  it("private profile → byte-identical generic PNG (no name/avatar leak)", async () => {
    const r = await getRaw(server, "/users/bob_private/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.equal(r.cacheControl, GENERIC_CACHE, "generic image must stay publicly cacheable");
    assert.ok(
      r.body.equals(genericPng),
      "private profile image must be identical to the unknown-user generic card",
    );
  });

  it("unavailable (deactivated) account → byte-identical generic PNG", async () => {
    const r = await getRaw(server, "/users/carl_gone/og-image.png");
    assert.equal(r.status, 200);
    assert.equal(r.cacheControl, GENERIC_CACHE);
    assert.ok(
      r.body.equals(genericPng),
      "unavailable account image must be identical to the generic card",
    );
  });

  it("@-prefixed private handle → still generic", async () => {
    const r = await getRaw(server, "/users/@bob_private/og-image.png");
    assert.equal(r.status, 200);
    assert.equal(r.cacheControl, GENERIC_CACHE);
    assert.ok(r.body.equals(genericPng));
  });

  it("public profile → personalized PNG that differs from the generic card", async () => {
    const r = await getRaw(server, "/users/alice_public/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.equal(r.cacheControl, NO_STORE, "personalized image must send no-store cache headers");
    assert.ok(
      !r.body.equals(genericPng),
      "public profile should get a personalized (different) image",
    );
  });

  it("?stamp=<public id> → personalized stamp PNG with no-store cache headers", async () => {
    const r = await getRaw(server, `/users/alice_public/og-image.png?stamp=${PUBLIC_STAMP_ID}`);
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.equal(
      r.cacheControl,
      NO_STORE,
      "personalized stamp preview must send no-store cache headers",
    );
    assert.ok(!r.body.equals(genericPng), "stamp preview should differ from the generic card");
  });

  it("?stamp=<private id> → falls back to passport card, still no-store", async () => {
    const r = await getRaw(server, `/users/alice_public/og-image.png?stamp=${PRIVATE_STAMP_ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.cacheControl, NO_STORE, "fallback passport card is still personalized");
    assert.ok(!r.body.equals(genericPng));
  });

  it("?stamp on a private profile → generic PNG stays publicly cacheable", async () => {
    const r = await getRaw(server, `/users/bob_private/og-image.png?stamp=${PUBLIC_STAMP_ID}`);
    assert.equal(r.status, 200);
    assert.equal(r.cacheControl, GENERIC_CACHE);
    assert.ok(r.body.equals(genericPng));
  });

  // ── show_profile_picture_publicly enforcement ───────────────────────────────
  // OG image requests come from crawlers — always unauthenticated (see the
  // route's own comment) — so this is the surface that serves a switched-off
  // user's avatar to literally anything that fetches a link preview: chat
  // apps, Slack unfurls, social-share bots. No auth wall to hide behind.

  it("flag off → the avatar is never even fetched (gate runs before the network call)", async () => {
    const r = await getRaw(server, "/users/fred_hidden/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.equal(r.cacheControl, NO_STORE, "still a personalized card (name/stats), just no photo");
    assert.deepEqual(
      fetchCallUrls, [],
      "the avatar URL must never be fetched when show_profile_picture_publicly=false",
    );
    // Falls back to the initials card, but the name/stats still personalize
    // it — must not collapse to the fully-generic unknown-user card.
    assert.ok(!r.body.equals(genericPng), "Fred's card must still be personalized (name/stats), not generic");
  });

  it("flag on → the avatar IS fetched and embedded", async () => {
    const r = await getRaw(server, "/users/gina_shown/og-image.png");
    assert.equal(r.status, 200);
    assert.match(r.contentType, /^image\/png/);
    assert.deepEqual(
      fetchCallUrls, [TRUSTED_AVATAR_URL],
      "the avatar URL must be fetched exactly once when show_profile_picture_publicly=true",
    );
  });

});
