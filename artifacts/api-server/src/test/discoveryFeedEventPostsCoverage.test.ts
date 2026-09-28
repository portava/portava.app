/**
 * census-discovery §94 (lane W11-X2), DV-83 / W11A-B8 — hunk §80.7: a failed
 * event-post read on GET /discovery/feed is carried on the feed's refusal
 * envelope instead of being served as a quiet city.
 *
 * Before: `lib/eventPostsDiscovery.ts` computed `readFailed` and dropped it
 * (it only skipped the cache write), and the route turned a thrown fetch into
 * `[]`. So a feed whose event-post read failed answered 200 with `posts: []`
 * and NO refusal — the "Live from events" rail could not branch on a failure
 * it was never sent (§80.1 DV-83, §29.2 ground 1's shape on another route).
 *
 * Now: `readEventPostsForDiscovery` returns `{ posts, readFailed }`, the route
 * pushes `"event_posts"` onto the feed's `failedSources`, and the envelope's
 * existing coverage rule decides `nothing` (the body is empty BECAUSE of the
 * failure) or `partial` (real posts or places were served beside the gap).
 *
 *   E1  both event-post paths fail, posts only → coverage "nothing", failedSources ["event_posts"], no exposure
 *   E2  one path fails, the other serves a post → "partial", ["event_posts"], the post is kept AND logged
 *   E3  places served, event posts failed → "partial", ["event_posts"], places kept
 *   E4  a place category AND the event posts failed → both named, the places code
 *   E5  a thrown event-post fetch (the route's catch arm) → coverage "nothing", ["event_posts"]
 *   C1  CONTROL: a healthy event-post read carries no refusal
 *   C2  CONTROL: an anonymous feed reads no event posts and carries no refusal
 *   C3  CONTROL: a failed read is not cached — the next healthy request serves the post
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryFeedEventPostsCoverage.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import discoveryRouter, { _setTestDbPlacesOverride } from "../routes/discovery.js";
import { invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { _clearEventPostsCache } from "../lib/eventPostsDiscovery.js";

const _originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const s = String(typeof url === "string" ? url : (url as URL).href ?? "");
  if (s.includes("overpass-api.de")) return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { "content-type": "application/json" } }); if (s.includes("overpass-api.de") || s.includes("nominatim.openstreetmap.org")) throw new Error("Network blocked in test environment");
  return _originalFetch(url, init);
}) as typeof globalThis.fetch;

const TOKEN = "w11x2-viewer";
const VIEWER = "b11b2000-0000-4000-8000-000000000001";
const AUTHOR = "b11b2000-0000-4000-8000-0000000000a1";

let inserts: Array<{ table: string; rows: any }> = [];

function venuePost(id: string) {
  return {
    id, author_id: AUTHOR, content: `live from ${id}`, media_urls: [], location_city: "Miami",
    location_place_id: "node/1", public_lat: 25.77, public_lng: -80.19, created_at: new Date().toISOString(),
    like_count: 1, comment_count: 0, visibility: "public", status: "active", post_status: "published",
    deleted_at: null, publish_eligible_at: null, location_privacy_mode: "none",
    discovery_places: { name: "The Venue", primary_category: "events", city: "Miami", lat: 25.77, lng: -80.19 },
  };
}

type AuthMode = "ok" | "throws" | "retryable" | "server_error" | "invalid_token" | "rate_limited";
function fakeClient(opts: { errorTables?: string[]; rows?: Record<string, any[]>; auth?: AuthMode } = {}) {
  const errorTables = new Set(opts.errorTables ?? []);
  const rowsFor: Record<string, any[]> = {
    feature_flags: [{ flag: "discovery_serve_log_enabled", enabled: true }],
    ...(opts.rows ?? {}),
  };
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    const b: any = {
      select() { return b; },
      insert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      upsert(payload: unknown) { inserts.push({ table, rows: payload }); return b; },
      update() { return b; }, delete() { return b; },
      eq(col: string, val: any) { preds.push((r) => r[col] === val); return b; },
      neq() { return b; }, is() { return b; }, not() { return b; },
      gt() { return b; }, gte() { return b; }, lt() { return b; }, lte() { return b; },
      in() { return b; }, or() { return b; }, ilike() { return b; }, contains() { return b; }, overlaps() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle: async () => errorTables.has(table) ? { data: null, error: { message: `${table} unavailable` } } : { data: rows()[0] ?? null, error: null },
      single: async () => errorTables.has(table) ? { data: null, error: { message: `${table} unavailable` } } : { data: rows()[0] ?? null, error: null },
      then(onF: any, onR: any) {
        const out = errorTables.has(table) ? { data: null, error: { message: `${table} unavailable` }, count: null } : { data: rows(), error: null, count: rows().length };
        return Promise.resolve(out).then(onF, onR);
      },
    };
    const rows = () => (rowsFor[table] ?? []).filter((r) => preds.every((p) => p(r)));
    return b;
  }
  return {
    auth: {
      getUser: async (t: string) => {
        const mode = opts.auth ?? "ok";
        if (mode === "throws") throw new Error("fetch failed");
        // supabase-js's two failure shapes: a retryable transport failure (status 0 or 5xx), and a definitive 4xx.
        if (mode === "retryable") return { data: { user: null }, error: { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 } };
        if (mode === "server_error") return { data: { user: null }, error: { name: "AuthApiError", message: "upstream", status: 503 } };
        if (mode === "rate_limited") return { data: { user: null }, error: { name: "AuthApiError", message: "over_request_rate_limit", status: 429 } };
        if (mode === "invalid_token") return { data: { user: null }, error: { name: "AuthApiError", message: "invalid JWT", status: 401, code: "bad_jwt" } };  // §98 (D-W11X2-21): Auth names its verdict; a code-less 4xx is V9's case
        return t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { name: "AuthApiError", message: "bad token", status: 401, code: "bad_jwt" } };
      },
    },
    from,
    rpc: async () => ({ data: null, error: null }),
  };
}

function setClient(opts: Parameters<typeof fakeClient>[0] = {}) {
  const c = fakeClient(opts);
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
}

let server: http.Server;
let base = "";

function get(path: string, auth = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method: "GET",
      headers: auth ? { authorization: `Bearer ${TOKEN}` } : {},
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolve({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject);
    r.end();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const rankRows = () => inserts.filter((i) => i.table === "rank_events").flatMap((i) => (Array.isArray(i.rows) ? i.rows : [i.rows]));

const FEED_POSTS_ONLY = "/api/discovery/feed?city=Miami&lat=25.77&lng=-80.19&includePlaces=0&radiusKm=25";
const FEED_WITH_PLACES = "/api/discovery/feed?city=Miami&lat=25.77&lng=-80.19&radiusKm=25";
const DB_PLACE = { id: "db/aaaaaaaa-0000-4000-8000-000000000001", name: "Gem", lat: 25.77, lng: -80.19, category: "for_you", source: "traveler" };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", discoveryRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  globalThis.fetch = _originalFetch;
  _setTestClient(null as any, false);
  _setTestServiceClient(null as any);
  _setTestDbPlacesOverride(null);
});

beforeEach(() => { inserts = []; invalidateServeLogFlagCache(); _clearEventPostsCache(); });
afterEach(() => { _setTestDbPlacesOverride(null); });

describe("GET /discovery/feed — a failed event-post read is on the envelope (DV-83, §80.7)", () => {
  it("E1 both event-post paths fail, posts only: coverage 'nothing', failedSources ['event_posts'], no exposure", async () => {
    setClient({ errorTables: ["post_event_links", "posts"] });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.ok(r.body.refusal, `a failed event-post read must not read as a quiet city: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.refusal.class, "transient_db");
    assert.equal(r.body.refusal.code, "feed_event_posts_read_failed");
    assert.equal(r.body.refusal.coverage, "nothing");
    assert.deepEqual(r.body.refusal.failedSources, ["event_posts"]);
    await settle();
    assert.equal(rankRows().length, 0, "a refused feed enters no exposure denominator");
  });

  it("E2 one path fails and the other serves a post: 'partial', the post kept and logged", async () => {
    setClient({ errorTables: ["post_event_links"], rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts.map((p: any) => p.id), ["p-1"]);
    assert.ok(r.body.refusal, "the surviving path's posts are real, but the list is incomplete and must say so");
    assert.equal(r.body.refusal.code, "feed_event_posts_read_failed");
    assert.equal(r.body.refusal.coverage, "partial");
    assert.deepEqual(r.body.refusal.failedSources, ["event_posts"]);
    await settle();
    assert.deepEqual(rankRows().map((row: any) => row.item_id), ["p-1"], "a partial serve's items really were served and are logged");
  });

  it("E3 places served and the event posts failed: 'partial', places kept", async () => {
    setClient({ errorTables: ["post_event_links", "posts"] });
    _setTestDbPlacesOverride(async () => [DB_PLACE as any]);
    const r = await get(FEED_WITH_PLACES);
    assert.equal(r.status, 200);
    assert.ok(r.body.places.length >= 1, `the places are real and kept: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.refusal?.coverage, "partial");
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
    assert.equal(r.body.refusal?.code, "feed_event_posts_read_failed");
  });

  it("E4 a place category AND the event posts failed: both named, under the places code", async () => {
    setClient({ errorTables: ["post_event_links", "posts", "discovery_places"] });
    const r = await get(FEED_WITH_PLACES);
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal?.code, "feed_places_read_failed");
    assert.deepEqual(r.body.refusal?.failedSources, ["for_you", "event_posts"]);
    assert.equal(r.body.refusal?.coverage, "nothing");
  });

  it("E5 a THROWN event-post fetch is a failed read, not an empty one (the route's catch arm)", async () => {
    // Both paths catch their own read errors; what reaches the route's catch is
    // anything the pipeline throws AFTER the reads. A like count that cannot be
    // added (a Symbol) throws inside the page-wide engagement fold.
    setClient({ rows: { posts: [{ ...venuePost("p-x"), like_count: Symbol("not a number") }] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.equal(r.body.refusal?.code, "feed_event_posts_read_failed", JSON.stringify(r.body));
    assert.equal(r.body.refusal?.coverage, "nothing");
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("C1 CONTROL: a healthy event-post read carries no refusal", async () => {
    setClient({ rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts.map((p: any) => p.id), ["p-1"]);
    assert.equal(r.body.refusal, undefined);
  });

  it("C2 CONTROL: an anonymous feed reads no event posts and carries no refusal", async () => {
    setClient({ errorTables: ["post_event_links", "posts"] });
    const r = await get(FEED_POSTS_ONLY, false);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.equal(r.body.refusal, undefined, "no read was owed, so none failed");
  });

  it("C3 CONTROL: a failed read is not cached — the next healthy request serves the post", async () => {
    setClient({ errorTables: ["post_event_links", "posts"] });
    const bad = await get(FEED_POSTS_ONLY);
    assert.equal(bad.body.refusal?.coverage, "nothing");
    setClient({ rows: { posts: [venuePost("p-2")] } });
    const good = await get(FEED_POSTS_ONLY);
    assert.deepEqual(good.body.posts.map((p: any) => p.id), ["p-2"]);
    assert.equal(good.body.refusal, undefined);
  });

  // ── Round 2 (§94.10): the viewer's identity is part of the event-post read ──
  // With a Bearer token present the read is OWED. If the identity lookup fails
  // (a throw, or supabase-js's retryable/5xx error), the read was not performed:
  // that is a failed source, never a quiet city. A definitive 4xx (an invalid or
  // expired token) means there is no viewer, as with no header (C2).

  it("V1 a Bearer token whose identity lookup THROWS: the event-post read failed, not empty", async () => {
    setClient({ auth: "throws", rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved", JSON.stringify(r.body));
    assert.equal(r.body.refusal?.coverage, "nothing");
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("V2 AuthRetryableFetchError (status 0) and a 5xx: failed, with places kept as partial", async () => {
    for (const auth of ["retryable", "server_error"] as const) {
      setClient({ auth });
      _setTestDbPlacesOverride(async () => [DB_PLACE as any]);
      const r = await get(FEED_WITH_PLACES);
      assert.equal(r.status, 200);
      assert.ok(r.body.places.length >= 1, auth);
      assert.equal(r.body.refusal?.coverage, "partial", `${auth}: ${JSON.stringify(r.body.refusal)}`);
      assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"], auth);
    }
  });

  it("V4 the auth server rate-limiting the lookup (429) is a failure, not an anonymous viewer", async () => {
    setClient({ auth: "rate_limited", rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved", JSON.stringify(r.body));
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("V3 CONTROL: an invalid or expired token (a definitive 401) is no viewer, as with no header — no refusal", async () => {
    setClient({ auth: "invalid_token", rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.equal(r.body.refusal, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// census-discovery §98 (DV-83, §94.10): an UNRESOLVED viewer is a failed read.
// Appended at the tail so the anchored cases above (E1 :152, E5 :199) keep
// their lines.
//
// §94.10's verifier found one path §94 did not cover: a signed-in request
// whose identity could not be resolved had its event-post read replaced by
// `[]` with no `readFailed`, answering 200 with no posts and no refusal, the
// same screen as "nothing live". A token the auth service REJECTED (4xx) is
// still an anonymous request, which owes no event-post read (C2's posture).
//
//   V1  getUser THROWS → refused: upstream_unavailable / feed_viewer_unresolved, "nothing", ["event_posts"], no exposure, no serve row
//   V2  getUser answers AuthRetryableFetchError (status 0) → the same refusal
//   V3  getUser answers a 5xx → the same refusal
//   V6  getUser answers AuthUnknownError (no status) → the same refusal
//   V7  getUser answers 429 (rate limited) → the same refusal: a declined look is not a verdict on the token
//   V8  getUser answers 408 (timed out) → the same refusal
//   V4  places served beside it → "partial", places kept, the same code
//   V5  a place category failed too → both named, under the places code and class
//   C4  CONTROL: a rejected token (401 bad_jwt) is an anonymous request: no refusal
//   C5  CONTROL: AuthInvalidJwtError (400) is a rejection too: no refusal
//   C6  CONTROL: the refusal is not cached — a resolved viewer's next request serves the post
//   C7  CONTROL: 403 bad_jwt (expired) and 404 user_not_found are Auth's verdicts: no refusal
//   C8  CONTROL: AuthSessionMissingError (revoked session; 400, no code) is a rejection: no refusal
//   V9  a 4xx with no Auth error code (the gateway refusing the server's key) → the same refusal
// ═════════════════════════════════════════════════════════════════════════════

let rpcCalls: string[] = [];
function setClientWithGetUser(getUser: (token: string) => Promise<unknown>, opts: Parameters<typeof fakeClient>[0] = {}) {
  rpcCalls = [];
  const c = { ...fakeClient(opts), auth: { getUser }, rpc: async (name: string) => { rpcCalls.push(name); return { data: null, error: null }; } };
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
}
const noUser = (error: unknown) => async () => ({ data: { user: null }, error });

describe("GET /discovery/feed — an unresolved viewer's event-post read is a failed read (DV-83, §94.10)", () => {
  it("V1 getUser THROWS: refused upstream_unavailable / feed_viewer_unresolved, coverage 'nothing', no exposure", async () => {
    setClientWithGetUser(async () => { throw new Error("socket hang up"); }, { rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.ok(r.body.refusal, `an unresolved viewer must not read as a quiet city: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.refusal.class, "upstream_unavailable");
    assert.equal(r.body.refusal.code, "feed_viewer_unresolved");
    assert.equal(r.body.refusal.coverage, "nothing");
    assert.deepEqual(r.body.refusal.failedSources, ["event_posts"]);
    await settle();
    assert.equal(rankRows().length, 0, "a refused feed enters no exposure denominator");
    assert.deepEqual(rpcCalls.filter((n) => n === SERVE_REQUEST_RPC), [], "nor a per-request serve row (3376)");
  });

  it("V2 getUser answers AuthRetryableFetchError (network, status 0): the same refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" }), { rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal?.class, "upstream_unavailable", JSON.stringify(r.body));
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved");
    assert.equal(r.body.refusal?.coverage, "nothing");
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("V3 getUser answers a 5xx: the same refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthApiError", status: 500, message: "internal error" }), { rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved", JSON.stringify(r.body));
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("V6 getUser answers AuthUnknownError (a response it could not read; no status): the same refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthUnknownError", message: "Unexpected token < in JSON" }), { rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved", JSON.stringify(r.body));
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("V7 getUser answers 429 (rate limited): the service declined to look, so the same refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" }), { rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal?.class, "upstream_unavailable", JSON.stringify(r.body));
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved");
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("V8 getUser answers 408 request_timeout (Auth timed out, with its code): the same refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthApiError", status: 408, code: "request_timeout", message: "Processing this request timed out" }), { rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved", JSON.stringify(r.body));
  });

  it("V4 places served beside an unresolved viewer: 'partial', the places kept, the viewer code", async () => {
    setClientWithGetUser(async () => { throw new Error("socket hang up"); });
    _setTestDbPlacesOverride(async () => [DB_PLACE as never]);
    const r = await get(FEED_WITH_PLACES);
    assert.equal(r.status, 200);
    assert.ok(r.body.places.length >= 1, `the places are real and kept: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.refusal?.coverage, "partial");
    assert.equal(r.body.refusal?.code, "feed_viewer_unresolved");
    assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
  });

  it("V5 a place category failed as well: both named, under the places code and class", async () => {
    setClientWithGetUser(async () => { throw new Error("socket hang up"); }, { errorTables: ["discovery_places"] });
    const r = await get(FEED_WITH_PLACES);
    assert.equal(r.body.refusal?.class, "transient_db", JSON.stringify(r.body));
    assert.equal(r.body.refusal?.code, "feed_places_read_failed");
    assert.deepEqual(r.body.refusal?.failedSources, ["for_you", "event_posts"]);
  });

  it("C4 CONTROL: a token the auth service REJECTED (401 bad_jwt) is an anonymous request, and carries no refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthApiError", status: 401, code: "bad_jwt", message: "invalid JWT" }), { rows: { posts: [venuePost("p-1")] } });
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.posts, []);
    assert.equal(r.body.refusal, undefined, "a rejection is an answer: no read was owed");
  });

  it("C5 CONTROL: AuthInvalidJwtError (400) is a rejection too, and carries no refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthInvalidJwtError", status: 400, message: "invalid JWT" }));
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal, undefined);
  });

  it("C7 CONTROL: a 403 bad_jwt (an expired token) and a 404 user_not_found are Auth's verdicts, and carry no refusal", async () => {
    for (const err of [
      { name: "AuthApiError", status: 403, code: "bad_jwt", message: "invalid JWT: token is expired" },
      { name: "AuthApiError", status: 404, code: "user_not_found", message: "User from sub claim in JWT does not exist" },
    ]) {
      setClientWithGetUser(noUser(err), { rows: { posts: [venuePost("p-1")] } });
      const r = await get(FEED_POSTS_ONLY);
      assert.equal(r.body.refusal, undefined, `${err.status} ${err.code} is a rejection: ${JSON.stringify(r.body)}`);
    }
  });

  it("C8 CONTROL: AuthSessionMissingError (auth-js's name for a revoked session; 400, no code) is a rejection, and carries no refusal", async () => {
    setClientWithGetUser(noUser({ name: "AuthSessionMissingError", status: 400, message: "Auth session missing!" }));
    const r = await get(FEED_POSTS_ONLY);
    assert.equal(r.body.refusal, undefined);
  });

  it("V9 a 4xx with no Auth error code (the gateway refusing the server's own key) never evaluated the token: the same refusal", async () => {
    for (const status of [401, 400]) {
      setClientWithGetUser(noUser({ name: "AuthApiError", status, message: "Invalid API key" }), { rows: { posts: [venuePost("p-1")] } });
      const r = await get(FEED_POSTS_ONLY);
      assert.equal(r.body.refusal?.class, "upstream_unavailable", `${status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.refusal?.code, "feed_viewer_unresolved");
      assert.deepEqual(r.body.refusal?.failedSources, ["event_posts"]);
    }
  });

  it("C6 CONTROL: the refusal is not cached — once the viewer resolves, the next request serves the post", async () => {
    setClientWithGetUser(async () => { throw new Error("socket hang up"); }, { rows: { posts: [venuePost("p-3")] } });
    const bad = await get(FEED_POSTS_ONLY);
    assert.equal(bad.body.refusal?.code, "feed_viewer_unresolved");
    setClient({ rows: { posts: [venuePost("p-3")] } });
    const good = await get(FEED_POSTS_ONLY);
    assert.deepEqual(good.body.posts.map((p: { id: string }) => p.id), ["p-3"]);
    assert.equal(good.body.refusal, undefined);
  });
});

// §98: the per-request serve row's RPC name, imported at the foot so no line above moves.
import { SERVE_REQUEST_RPC } from "../lib/discoveryServeLog.js";
