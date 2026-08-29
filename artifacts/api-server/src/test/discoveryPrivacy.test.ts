/**
 * Discovery search privacy exclusion tests
 *
 * Verifies that GET /api/discovery/search?type=travelers correctly excludes:
 *   1. Profiles with is_private=true (set by PATCH /me/privacy → profiles.is_private sync)
 *   2. Profiles with allow_profile_discovery=false in profile_privacy_settings
 *
 * Run: node --import tsx/esm --test src/test/discoveryPrivacy.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter from "../routes/discoverySearch.js";

let server: http.Server;
let base: string;

const VIEWER_TOKEN   = "disc-privacy-viewer";
const VIEWER_ID      = "11111111-1111-1111-1111-111111111111";
const PUBLIC_USER    = "22222222-2222-2222-2222-222222222222";
const PRIVATE_USER   = "33333333-3333-3333-3333-333333333333";
const OPTOUT_USER    = "44444444-4444-4444-4444-444444444444";
const BLOCKED_USER   = "55555555-5555-5555-5555-555555555555";
// Viewer is blocked by REVERSE_BLOCKER (not the other way around)
const REVERSE_BLOCKER = "66666666-6666-6666-6666-666666666666";

function buildFakeClient() {
  const profiles = [
    { id: PUBLIC_USER,     name: "Alice Public",    handle: "alicepub",   is_private: false, account_status: "active", home_city: null, home_country: null },
    { id: PRIVATE_USER,    name: "Bob Private",     handle: "bobpriv",    is_private: true,  account_status: "active", home_city: null, home_country: null },
    { id: OPTOUT_USER,     name: "Carol OptOut",    handle: "carolopt",   is_private: false, account_status: "active", home_city: null, home_country: null },
    { id: BLOCKED_USER,    name: "Dave Blocked",    handle: "daveblk",    is_private: false, account_status: "active", home_city: null, home_country: null },
    { id: REVERSE_BLOCKER, name: "Eve RevBlock",    handle: "everevblk",  is_private: false, account_status: "active", home_city: null, home_country: null },
    { id: VIEWER_ID,       name: "Viewer",          handle: "viewer",     is_private: false, account_status: "active", home_city: null, home_country: null },
  ];

  const privacySettings = [
    { user_id: OPTOUT_USER, allow_profile_discovery: false },
  ];

  const blocks = [
    // Viewer blocked Dave (viewer → target direction)
    { blocker_id: VIEWER_ID,      blocked_id: BLOCKED_USER   },
    // Eve blocked the viewer (target → viewer direction)
    { blocker_id: REVERSE_BLOCKER, blocked_id: VIEWER_ID     },
  ];

  function from(table: string) {
    const tableRows: Record<string, any[]> = {
      profiles,
      profile_privacy_settings: privacySettings,
      blocks,
      user_follows: [],
      user_privacy_settings: [],
    };
    let rows: any[] = tableRows[table] ?? [];
    const filters: Array<(r: any) => boolean> = [];
    let _offset = 0;
    let _limit: number | null = null;

    const b: any = {
      select() { return b; },
      insert() { return b; },
      update() { return b; },
      delete() { return b; },
      upsert() { return b; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      or(_expr: string)            { return b; },
      ilike(_col: string, _pat: string) { return b; },
      order()  { return b; },
      range(from: number, to: number) { _offset = from; _limit = to - from + 1; return b; },
      limit(n: number) { _limit = n; return b; },
      maybeSingle() { return resolveOne(); },
      single()      { return resolveOne(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function filtered() {
      return rows.filter((r: any) => filters.every((f) => f(r)));
    }

    async function resolveList() {
      let data = filtered();
      if (_limit !== null) data = data.slice(_offset, _offset + _limit);
      return { data, error: null, count: filtered().length };
    }

    async function resolveOne() {
      const data = filtered();
      return { data: data[0] ?? null, error: null };
    }

    return b;
  }

  return {
    auth: {
      getUser: async (token: string) => {
        if (token === VIEWER_TOKEN) return { data: { user: { id: VIEWER_ID } }, error: null };
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from,
  };
}

function req(
  path: string,
  token: string = VIEWER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request(
      { hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET",
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}` } },
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

describe("Discovery search — privacy exclusions", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", discoveryRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
    const fc = buildFakeClient();
    _setTestClient(fc as any, true);
    _setTestServiceClient(fc as any);
  });

  after(async () => {
    server.close();
    _setTestClient(null as any, false);
    _setTestServiceClient(null as any);
  });

  it("returns public profiles in traveler search", async () => {
    const r = await req("/api/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
    const ids = (r.body.results ?? []).map((x: any) => x.id);
    assert.ok(ids.includes(PUBLIC_USER), "public profile should appear in results");
  });

  it("returns profiles with is_private=true as a locked preview, not excluded", async () => {
    const r = await req("/api/discovery/search?q=bob&type=travelers");
    assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
    const results = (r.body.results ?? []) as any[];
    const bob = results.find((x) => x.id === PRIVATE_USER);
    assert.ok(bob, "private profile (is_private=true) should still be discoverable by handle");
    assert.equal(bob.privacyState?.isPrivate, true, "must be flagged private");
    assert.equal(bob.accessState?.canAccess, false, "locked preview must not grant access");
    assert.equal(bob.avatarUrl, null, "locked preview must not leak the avatar");
  });

  it("excludes profiles with allow_profile_discovery=false from traveler search", async () => {
    const r = await req("/api/discovery/search?q=carol&type=travelers");
    assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
    const ids = (r.body.results ?? []).map((x: any) => x.id);
    assert.ok(!ids.includes(OPTOUT_USER), "discovery-opted-out profile must be excluded from search");
  });

  it("requires authentication", async () => {
    const r = await req("/api/discovery/search?q=alice&type=travelers", "invalid-token");
    assert.equal(r.status, 401);
  });

  it("returns 400 for query shorter than 2 characters", async () => {
    const r = await req("/api/discovery/search?q=a&type=travelers");
    assert.ok(r.status === 400 || r.status === 422, `expected 400 or 422, got ${r.status}`);
  });

  it("excludes users blocked by the viewer from traveler search", async () => {
    const r = await req("/api/discovery/search?q=dave&type=travelers");
    assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
    const ids = (r.body.results ?? []).map((x: any) => x.id);
    assert.ok(!ids.includes(BLOCKED_USER), "user blocked by viewer must not appear in search results");
  });

  it("excludes users who blocked the viewer from traveler search", async () => {
    // REVERSE_BLOCKER has blocker_id=REVERSE_BLOCKER, blocked_id=VIEWER_ID.
    // fetchBlockedSet adds REVERSE_BLOCKER to the set (blocker_id !== VIEWER_ID branch),
    // so REVERSE_BLOCKER must not appear in results.
    const r = await req("/api/discovery/search?q=eve&type=travelers");
    assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
    const ids = (r.body.results ?? []).map((x: any) => x.id);
    assert.ok(!ids.includes(REVERSE_BLOCKER), "user who blocked viewer must not appear in search results");
  });

  it("non-blocked users still appear after block exclusions", async () => {
    const r = await req("/api/discovery/search?q=alice&type=travelers");
    assert.equal(r.status, 200, `unexpected status: ${JSON.stringify(r.body)}`);
    const ids = (r.body.results ?? []).map((x: any) => x.id);
    assert.ok(ids.includes(PUBLIC_USER), "non-blocked public user must appear in results");
    assert.ok(!ids.includes(BLOCKED_USER), "viewer-blocked user must not appear");
    assert.ok(!ids.includes(REVERSE_BLOCKER), "reverse-blocker must not appear");
  });
});
