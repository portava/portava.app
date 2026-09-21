/**
 * profileTabs applyVisibilityGuard — the HTTP consequence of an unreadable
 * `profile_privacy_settings` table.
 *
 * ── WHAT CHANGED ────────────────────────────────────────────────────────────
 * The guard's owner branch used to return early with its OWN
 * `profile_privacy_settings` read — a second IMPLEMENTATION of the read
 * `resolveProfileVisibility` already does on its self-view path (reached
 * instead of it, so the request count was one either way), binding only `data`
 * and therefore blind to a resolved PostgREST error. Two implementations of the
 * same privacy read cannot help but drift, and this pair had. The owner branch
 * now delegates to the shared resolver: one implementation, one failure policy,
 * and an owner-path read failure is logged instead of silent.
 *
 * What that buys at the HTTP surface is on the NON-owner path: with the shared
 * resolver honest about a failed read, a stranger asking for the tabs of a
 * public-looking profile during a `profile_privacy_settings` outage now gets an
 * EMPTY tab rather than the person's posts and stamps.
 *
 * ── TRAPS AVOIDED DELIBERATELY ──────────────────────────────────────────────
 *  • Never `assert.notEqual(status, 200)`. Withholding here is a 200 with an
 *    empty `items` array, so the status alone proves nothing — every assertion
 *    names the exact body.
 *  • The `req.log` shim the real server installs is present. Without it these
 *    handlers throw on `req.log.error(...)` and a 500-from-crash would look
 *    like a deliberate refusal.
 *  • Every failure case is paired with the readable twin that must still serve
 *    the content, so a guard that simply withheld from everyone fails here.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/profileTabsVisibilityGuard.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog } from "./helpers/failClosedSupabase.js";
import profileTabsRouter from "../routes/profileTabs.js";

const OWNER  = "aaaaaaaa-0000-4000-a000-000000000001";
const VIEWER = "bbbbbbbb-0000-4000-a000-000000000002";
const OWNER_TOKEN  = "tok-owner";
const VIEWER_TOKEN = "tok-viewer";
const HANDLE = "wanderer";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The shim the real server installs. Without it `req.log.error(...)` throws
  // and the resulting 500 would be mistaken for a deliberate refusal.
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", profileTabsRouter);
  server = http.createServer(app);
  // 127.0.0.1 explicitly: a host-less listen(0) binds the IPv6 wildcard and the
  // kernel may hand back a port a foreign process already holds on loopback.
  // The address makes the bind DEFERRED, so the callback — not the next line —
  // is when address() is readable.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function get(path: string, token?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method: "GET",
        headers: token ? { authorization: `Bearer ${token}` } : {},
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

const PUBLIC_PROFILE = {
  id: OWNER, handle: HANDLE, username: HANDLE,
  is_private: false, passport_visibility: "public", account_status: "active",
};

const POSTS = [
  { id: "post-1", author_id: OWNER, post_status: "published", content: "hello", created_at: "2026-01-01T00:00:00Z" },
];

/** Count of privacy-settings reads issued — measured, not assumed. */
let privacyReads = 0;

function install(opts: { settings?: Record<string, any>[]; failSettings?: boolean }) {
  privacyReads = 0;
  const c = makeFailClosedClient({
    rows: {
      profiles: [PUBLIC_PROFILE],
      profile_privacy_settings: opts.settings ?? [],
      blocks: [],
      user_account_states: [],
      user_friendships: [],
      user_follows: [],
      posts: POSTS,
      post_media: [],
    },
    users: { [OWNER_TOKEN]: OWNER, [VIEWER_TOKEN]: VIEWER },
    failOn: (ctx) => {
      if (ctx.table !== "profile_privacy_settings") return null;
      privacyReads++;
      return opts.failSettings ? READ_FAIL : null;
    },
  });
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
}

let scenarios = 0;

describe("GET /users/:username/posts — stranger", () => {
  it("HEALTHY TWIN: a public profile with no privacy row serves its posts", async () => {
    scenarios++;
    install({});
    const r = await get(`/api/users/${HANDLE}/posts`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, "fixture guard: the healthy path must actually serve content");
    assert.equal(r.body.items[0].id, "post-1");
  });

  it("HEALTHY TWIN: an explicit show_posts=false is honoured — empty", async () => {
    scenarios++;
    install({ settings: [{ user_id: OWNER, profile_visibility: "public", show_posts: false }] });
    const r = await get(`/api/users/${HANDLE}/posts`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { items: [], nextCursor: null });
  });

  it("FAILURE: an unreadable privacy table withholds the posts", async () => {
    scenarios++;
    install({ failSettings: true });
    const r = await get(`/api/users/${HANDLE}/posts`, VIEWER_TOKEN);
    // Before the fix this served post-1: the settings read failed, the tier fell
    // back to the public `profiles` row, and show_posts was never consulted.
    assert.equal(r.status, 200, "withholding is a 200 with no items, not a 500");
    assert.deepEqual(r.body, { items: [], nextCursor: null });
  });

  it("FAILURE: an UNAUTHENTICATED stranger is withheld from too", async () => {
    scenarios++;
    install({ failSettings: true });
    const r = await get(`/api/users/${HANDLE}/posts`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { items: [], nextCursor: null });
  });
});

describe("GET /users/:username/posts — the owner", () => {
  it("HEALTHY: the owner sees their own posts", async () => {
    scenarios++;
    install({ settings: [{ user_id: OWNER, profile_visibility: "private", show_posts: false }] });
    const r = await get(`/api/users/${HANDLE}/posts`, OWNER_TOKEN);
    assert.equal(r.status, 200);
    // The owner's own opt-outs never filter their own tab.
    assert.equal(r.body.items.length, 1);
  });

  it("FAILURE: an unreadable privacy table does not lock the owner out", async () => {
    scenarios++;
    install({ failSettings: true });
    const r = await get(`/api/users/${HANDLE}/posts`, OWNER_TOKEN);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1, "the owner's own tab must not be collateral damage");
  });

  it("delegating did not DOUBLE the owner's privacy read", async () => {
    scenarios++;
    install({ settings: [{ user_id: OWNER, profile_visibility: "public" }] });
    const r = await get(`/api/users/${HANDLE}/posts`, OWNER_TOKEN);
    assert.equal(r.status, 200);
    // The old owner branch returned early with its own read, so the request
    // count was one; the obvious way to get this refactor wrong is to keep that
    // read AND call the resolver. Counted at runtime, not inferred from source.
    assert.equal(privacyReads, 1, `expected 1 privacy read, saw ${privacyReads}`);
  });
});

describe("GET /users/:username/stamps — the same guard, a second tab", () => {
  it("HEALTHY TWIN: a stranger gets the tab (empty seed, but not withheld)", async () => {
    scenarios++;
    install({});
    const r = await get(`/api/users/${HANDLE}/stamps`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    assert.equal(r.body.blocked, undefined);
  });

  it("FAILURE: an unreadable privacy table withholds the stamps tab too", async () => {
    scenarios++;
    install({ failSettings: true });
    const r = await get(`/api/users/${HANDLE}/stamps`, VIEWER_TOKEN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { items: [], nextCursor: null });
  });
});

describe("vacuity", () => {
  it("exercised a non-zero number of scenarios", () => {
    assert.ok(scenarios >= 9, `expected >= 9 scenarios, ran ${scenarios}`);
  });
});
