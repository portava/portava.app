/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the sweep beside the round-23 verifier's B43 and B44): every
 * list a Discovery answer reads FOR ONE VIEWER is read whole, or the answer says it could not be.
 *
 * B43 and B44 were two instances of one shape: a read filtered to one person, with no bound, taken as that person's
 * whole list. PostgREST cuts a response at db-max-rows (1000 here) silently. The sweep found the same shape on every
 * surface below; each decided what a tab shows, or who is hidden from the viewer, from the first 1000 rows.
 *
 *   safety lists
 *     MU1  withMutedAuthors: 1200 mutes → the author past the cap is in the exclusion set (a muted author's place is withheld)
 *     MU2  the mute list is cut and its keyed re-read FAILS → null (fail-closed, as over any unreadable mute list)
 *     MU0  CONTROL: three mutes → those three, beside the blocked set
 *     CP1  getCompassProfile: 1200 blockers, 1200 blocked, 1200 muted → each list whole, the id past the cap in each
 *     CP2  a Compass safety list is cut and cannot be read whole → the profile is refused (fail-closed), never built short
 *   the events tab
 *     EF1  GET /events/following: 1200 follows, the host past the cap → the event is listed
 *     EC1  GET /events/circles: 1200 circle memberships, the circle past the cap → the event is listed
 *     EM1  GET /events/me: 1200 going RSVPs, this event's past the cap → the event is listed
 *     EJ1  GET /events/joined: the same → the event is listed
 *     EF2  the follow list is cut and its keyed re-read FAILS → 503, never a shorter list (EC2, EM2, EJ2 the same)
 *     E0   CONTROL on each: a short list → the event is listed
 *   Pulse
 *     PC1  GET /pulse?tab=crew: 1200 follows, the author past the cap → the post is served
 *     PC2  the follow list is cut and cannot be read whole → no posts, `user_follows` named
 *     PR1  GET /pulse/live: 1200 saved events, the upcoming one past the cap → on the rail
 *     PR2  the saved list is cut and cannot be read whole → `event_saves` named
 *   lists served whole
 *     HF1  GET /me/hashtag-follows: 1200 followed hashtags → all 1200, newest first
 *     WL1  GET /wishlist: 1200 saved places → all 1200, newest first; WL2 cut and unreadable → an error, never a shorter list
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { withMutedAuthors } from "../lib/discoveryCacheEligibility.js";
import { getCompassProfile, clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { world, eventsServer, EVENT, HOST, VIEWER } from "./helpers/eventsWorld.js";
import { cappedClient, seqId, type Row, type SeenRead } from "./helpers/cappedPostgrest.js";

const ME = "a1a1a1a1-aaaa-4aaa-8aaa-000000000001";
const TARGET = "b2b2b2b2-bbbb-4bbb-8bbb-000000000002";
type Fail = (r: SeenRead) => boolean | "throw";

/** `n` rows `{ [mine]: me, [other]: … }`; `target` at insertion index `at` (absent when `at` is -1). */
function list(n: number, mine: string, me: string, other: string, target: string, at: number, more: Row = {}): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push({ [mine]: me, [other]: i === at ? target : seqId("c0000000", i), ...more });
  return out;
}

describe("census-discovery §123: the viewer's mute list is applied whole", () => {
  const BLOCKED = new Set(["blocked-1"]);
  const read = (mutes: Row[], fail?: Fail) => withMutedAuthors(cappedClient({ user_mutes: mutes }, { fail }) as any, ME, BLOCKED);
  it("MU0 CONTROL: three mutes → those three beside the blocked set", async () => {
    const set = await read(list(3, "muter_id", ME, "muted_id", TARGET, 1));
    assert.deepEqual([...(set ?? [])].sort(), ["blocked-1", TARGET, seqId("c0000000", 0), seqId("c0000000", 2)].sort());
  });
  it("MU1 1200 mutes → the author past the cap is in the set", async () => {
    const set = await read(list(1200, "muter_id", ME, "muted_id", TARGET, 1100));
    assert.equal(set?.has(TARGET), true, `a muted author is missing from the exclusion set (${set?.size} entries)`);
    assert.equal(set?.size, 1201);
  });
  it("MU2 the mute list is cut and its keyed re-read FAILS → null", async () => {
    assert.equal(await read(list(1200, "muter_id", ME, "muted_id", TARGET, 1100), (r) => r.ordered), null);
  });
});

describe("census-discovery §123: the Compass profile's block and mute lists are whole", () => {
  const tables = () => ({
    blocks: [...list(1200, "blocked_id", ME, "blocker_id", TARGET, 1100), ...list(1200, "blocker_id", ME, "blocked_id", "b3b3b3b3-bbbb-4bbb-8bbb-000000000003", 1100).map((r) => ({ ...r, blocked_id: r.blocked_id === TARGET ? "x" : r.blocked_id }))],
    user_mutes: list(1200, "muter_id", ME, "muted_id", "b4b4b4b4-bbbb-4bbb-8bbb-000000000004", 1100),
  });
  it("CP1 1200 blockers, 1200 blocked and 1200 muted → each list whole", async () => {
    clearCompassProfileCache();
    const p = await getCompassProfile(cappedClient(tables()) as any, ME, true);
    assert.deepEqual(
      { blockers: p.blockerUserIds.length, hasBlocker: p.blockerUserIds.includes(TARGET), blocked: p.blockedUserIds.length, hasBlocked: p.blockedUserIds.includes("b3b3b3b3-bbbb-4bbb-8bbb-000000000003"), muted: p.mutedUserIds.length, hasMuted: p.mutedUserIds.includes("b4b4b4b4-bbbb-4bbb-8bbb-000000000004") },
      { blockers: 1200, hasBlocker: true, blocked: 1200, hasBlocked: true, muted: 1200, hasMuted: true },
    );
  });
  it("CP2 a safety list is cut and cannot be read whole → the profile is refused", async () => {
    clearCompassProfileCache();
    await assert.rejects(() => getCompassProfile(cappedClient(tables(), { fail: (r) => r.table === "user_mutes" && r.ordered }) as any, ME, true), /safety-list load failed/);
    clearCompassProfileCache();
    await assert.rejects(() => getCompassProfile(cappedClient(tables(), { fail: (r) => r.table === "blocks" && r.ordered }) as any, ME, true), /safety-list load failed/);
  });
});

// ── the events tab ────────────────────────────────────────────────────────────────────────────────────────────────
const CAPPED_EVENT_TABLES = ["user_follows", "circle_memberships", "event_rsvps"] as const;
async function events(path: string, over: Partial<Record<(typeof CAPPED_EVENT_TABLES)[number], Row[]>>, fail?: Fail) {
  const base: Record<string, Row[]> = {
    user_follows: [{ follower_id: VIEWER, following_id: HOST }],
    circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "active" }],
    event_rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }],
  };
  const w = world({ ev: { state: "open", circle_id: HOST, visibility: "public", starts_at: "2030-01-05T18:00:00.000Z" }, extra: { event_saves: [], collections: [], collection_items: [] }, rsvps: [] });
  const capped = cappedClient({ ...base, ...over }, { fail });
  const from = w.client.from.bind(w.client);
  w.client.from = (t: string) => ((CAPPED_EVENT_TABLES as readonly string[]).includes(t) ? capped.from(t) : from(t));
  const srv = await eventsServer();
  try {
    const r = await srv.req("t-viewer", "GET", path);
    return { status: r.status, listed: ((r.body?.events ?? []) as any[]).some((e) => e.id === EVENT), text: r.text.slice(0, 240) };
  } finally { srv.close(); }
}
const FOLLOWS = () => list(1200, "follower_id", VIEWER, "following_id", HOST, 1100);
const MEMBERSHIPS = () => list(1200, "other_id", VIEWER, "user_id", HOST, 1100, { status: "active" });
const RSVPS = () => list(1200, "user_id", VIEWER, "event_id", EVENT, 1100, { status: "going" });
const EVENT_LISTS: Array<[string, string, (typeof CAPPED_EVENT_TABLES)[number], () => Row[]]> = [
  ["EF /events/following", "/events/following", "user_follows", FOLLOWS],
  ["EC /events/circles", "/events/circles", "circle_memberships", MEMBERSHIPS],
  ["EM /events/me", "/events/me", "event_rsvps", RSVPS],
  ["EJ /events/joined", "/events/joined", "event_rsvps", RSVPS],
];

describe("census-discovery §123: the events tab's lists read the viewer's own lists whole", () => {
  after(() => { _setTestClient(null as any, false); _setTestServiceClient(null); });
  for (const [name, path, table, rows] of EVENT_LISTS) {
    it(`E0 CONTROL ${name}: a short list → the event is listed`, async () => {
      const r = await events(path, {});
      assert.deepEqual({ status: r.status, listed: r.listed }, { status: 200, listed: true }, r.text);
    });
    it(`${name} 1: 1200 rows, this event's past the cap → the event is listed`, async () => {
      const r = await events(path, { [table]: rows() });
      assert.deepEqual({ status: r.status, listed: r.listed }, { status: 200, listed: true }, `the list was served short: ${r.text}`);
    });
    it(`${name} 2: the list is cut and its keyed re-read FAILS → 503, never a shorter list`, async () => {
      const r = await events(path, { [table]: rows() }, (x) => x.table === table && x.ordered && x.eqs[table === "circle_memberships" ? "other_id" : table === "user_follows" ? "follower_id" : "user_id"] === VIEWER && !("event_id" in x.eqs) && Object.keys(x.ins).length === 0);
      assert.equal(r.status, 503, r.text);
    });
  }
});

// ── Pulse ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const ALICE = "a1a1a1a1-aaaa-4aaa-8aaa-0000000000a1";
const BOB = "b2b2b2b2-bbbb-4bbb-8bbb-0000000000b2";
const auth = { getUser: async (t: string) => (t === "valid-token" ? { data: { user: { id: ALICE } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };
async function mount(routerPath: string, tables: Record<string, Row[]>, path: string, fail?: Fail) {
  const client = cappedClient(tables, { fail, auth });
  _setTestClient(client as any, true); _setTestServiceClient(client as any); invalidateFlagsCache?.();
  const { default: router } = await import(routerPath);
  const app = express(); app.use(express.json());
  app.use((req: any, _r: unknown, n: () => void) => { req.log = { info() {}, warn() {}, error() {}, debug() {}, child() { return req.log; } }; n(); });
  app.use("/api", router);
  const server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, { headers: { Authorization: "Bearer valid-token" } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const POST = "p9999999-0000-4000-8000-000000009999";
const post = { id: POST, author_id: BOB, content: "Sunset from the fort", status: "active", visibility: "public", post_status: "published", created_at: "2026-09-30T18:00:00.000Z", post_media: [], pulse_geo_tags: null, profiles: { id: BOB, username: "bob" } };
const in2h = new Date(Date.now() + 2 * 3_600_000).toISOString();
const in3days = new Date(Date.now() + 3 * 86_400_000).toISOString();
const SAVED_EV = "ec000000-0000-4000-8000-000000000077";
const railTables = (saves: Row[]): Record<string, Row[]> => ({
  feature_flags: [{ flag: "safe_return_enabled", enabled: false }, { flag: "hidden_gems_enabled", enabled: false }, { flag: "find_your_circle_enabled", enabled: false }],
  events: [{ id: SAVED_EV, host_id: BOB, title: "Night market", starts_at: in2h, ends_at: in3days, city: "Manila", state: "open", visibility: "public", going_count: 1, max_attendees: 10 }],
  event_rsvps: [], event_saves: saves, trip_members: [], trips: [], trip_join_requests: [], safe_return_sessions: [], blocks: [],
});

describe("census-discovery §123: Pulse reads the viewer's follows and saves whole", () => {
  after(() => { _setTestClient(null as any, false); _setTestServiceClient(null); });
  const crew = (follows: Row[], fail?: Fail) => mount("../routes/pulse.js", { posts: [post], user_follows: follows }, "/api/pulse?tab=crew", fail);
  it("PC0 CONTROL: the viewer follows the author (one row) → the post is served on the crew tab", async () => {
    const r = await crew([{ follower_id: ALICE, following_id: BOB }]);
    assert.equal(((r.body.posts ?? []) as any[]).some((p) => p.id === POST), true, JSON.stringify(r.body).slice(0, 240));
  });
  it("PC1 1200 follows, the author past the cap → the post is served", async () => {
    const r = await crew(list(1200, "follower_id", ALICE, "following_id", BOB, 1100));
    assert.equal(((r.body.posts ?? []) as any[]).some((p) => p.id === POST), true, `a followed author's post is missing from the crew tab: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.equal(r.body.failedSources, undefined);
  });
  it("PC2 the follow list is cut and cannot be read whole → no posts, `user_follows` named", async () => {
    const r = await crew(list(1200, "follower_id", ALICE, "following_id", BOB, 1100), (x) => x.table === "user_follows" && x.ordered);
    assert.deepEqual({ posts: r.body.posts, failedSources: r.body.failedSources }, { posts: [], failedSources: ["user_follows"] });
  });
  const rail = (saves: Row[], fail?: Fail) => mount("../routes/pulse.js", railTables(saves), "/api/pulse/live", fail);
  const onRail = (b: any) => ((b.items ?? []) as any[]).some((i) => i.item_id === SAVED_EV);
  it("PR0 CONTROL: one saved upcoming event → on the rail", async () => {
    const r = await rail([{ user_id: ALICE, event_id: SAVED_EV }]);
    assert.equal(onRail(r.body), true, JSON.stringify(r.body).slice(0, 300));
  });
  it("PR1 1200 saved events, the upcoming one past the cap → on the rail", async () => {
    const r = await rail(list(1200, "user_id", ALICE, "event_id", SAVED_EV, 1100));
    assert.equal(onRail(r.body), true, `a saved upcoming event is missing from the rail: ${JSON.stringify({ items: (r.body.items ?? []).length, failedSources: r.body.failedSources })}`);
  });
  it("PR2 the saved list is cut and cannot be read whole → `event_saves` named", async () => {
    const r = await rail(list(1200, "user_id", ALICE, "event_id", SAVED_EV, 1100), (x) => x.table === "event_saves" && x.ordered);
    assert.equal(((r.body.failedSources ?? []) as string[]).includes("event_saves"), true, JSON.stringify(r.body).slice(0, 300));
  });
});

// ── lists served whole ───────────────────────────────────────────────────────────────────────────────────────────
describe("census-discovery §123: a list served to its owner is served whole", () => {
  after(() => { _setTestClient(null as any, false); _setTestServiceClient(null); });
  const follows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ user_id: ALICE, hashtag_id: seqId("4a540000", i), created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), hashtags: { id: seqId("4a540000", i), slug: `tag-${i}`, name: `tag ${i}`, usage_count: 1 } }));
  it("HF0 CONTROL: three followed hashtags → three, newest first", async () => {
    const r = await mount("../routes/hashtags.js", { user_hashtag_follows: follows(3) }, "/api/me/hashtag-follows");
    assert.deepEqual((r.body.follows ?? []).map((f: any) => f.hashtag?.slug), ["tag-2", "tag-1", "tag-0"], JSON.stringify(r.body).slice(0, 200));
  });
  it("HF1 1200 followed hashtags → all 1200, newest first", async () => {
    const r = await mount("../routes/hashtags.js", { user_hashtag_follows: follows(1200) }, "/api/me/hashtag-follows");
    assert.equal((r.body.follows ?? []).length, 1200, `the list holds ${(r.body.follows ?? []).length} of 1200 followed hashtags`);
    assert.deepEqual((r.body.follows ?? []).slice(0, 2).map((f: any) => f.hashtag?.slug), ["tag-1199", "tag-1198"]);
  });
  const places = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ user_id: ALICE, place_id: seqId("91ace000", i), list_id: null, place_data: { id: seqId("91ace000", i), name: `place ${i}` }, saved_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() }));
  it("WL0 CONTROL: three saved places → three, newest first", async () => {
    const r = await mount("../routes/wishlist.js", { wishlist_places: places(3) }, "/api/wishlist");
    assert.deepEqual((r.body.places ?? []).map((p: any) => p.name), ["place 2", "place 1", "place 0"], JSON.stringify(r.body).slice(0, 200));
  });
  it("WL1 1200 saved places → all 1200, newest first", async () => {
    const r = await mount("../routes/wishlist.js", { wishlist_places: places(1200) }, "/api/wishlist");
    assert.equal((r.body.places ?? []).length, 1200, `the list holds ${(r.body.places ?? []).length} of 1200 saved places`);
    assert.deepEqual((r.body.places ?? []).slice(0, 2).map((p: any) => p.name), ["place 1199", "place 1198"]);
  });
  it("WL2 the list is cut and cannot be read whole → an error, never a shorter list", async () => {
    let n = 0;
    const r = await mount("../routes/wishlist.js", { wishlist_places: places(1200) }, "/api/wishlist", (x) => x.table === "wishlist_places" && ++n > 1);
    assert.equal(r.status >= 500, true, JSON.stringify({ status: r.status, n: (r.body.places ?? []).length }));
    assert.equal(r.body.places, undefined);
  });
});
