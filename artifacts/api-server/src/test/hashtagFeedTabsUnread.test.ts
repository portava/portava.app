/**
 * census-discovery §105 (DV-83 round 9, register D-W11X2-61): GET /hashtags/:slug/feed —
 * the page every Discover trending chip opens — never serves a failed read as an empty tab.
 *
 * Before §105 the people, places, trips, circles and events tabs destructured `{ data }`
 * alone, so supabase-js's RESOLVED `{ data: null, error }` became `items: []`, and their
 * catches answered the same empty page; app/hashtag/[slug].tsx drew "No {tab} content yet".
 * The hashtag lookup ignored its error too, so a failed lookup was `404 Hashtag not found`.
 * Every read now answers `db_error` on failure, as the posts tab already did.
 *
 * HF0..HF3 are the independent round-8 verifier's probe (V8-HF0..3), copied in.
 * Harness shape copied from hashtagsTrendingFallbackRead.test.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import hashtagsRouter from "../routes/hashtags.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "ab000000-0000-4000-a000-000000000001";
const TOKEN = "tok-hashtag-feed";
const ID = "66666666-6666-4666-8666-666666666601";
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };

const ROWS: Record<string, unknown[]> = {
  events: [{ id: ID, title: "Jazz night", location_name: "Rome", starts_at: null, ends_at: null, host_id: "host-1" }],
  discovery_places: [{ id: ID, name: "Caffè", city: "rome", place_type: "cafe", image_url: null, submitted_by: "host-1" }],
  trips: [{ id: ID, title: "Rome jazz week", destination_city: "rome", status: "active", owner_id: "host-1", visibility: "public" }],
  circles: [{ id: ID, name: "Rome jazz", owner_id: "host-1", visibility: "public" }],
  trip_members: [], circle_memberships: [],
};

/** `failing`: tables whose read RESOLVES an error (`t:list`: only its list reads, so auth's profile read still works); `throwing`: tables whose read throws. */
function client(failing: string[], throwing: string[] = []) {
  function builder(table: string) {
    const answer = (single: boolean) => {
      if (throwing.includes(table)) throw new Error("socket hang up");
      if (failing.includes(table) || (!single && failing.includes(`${table}:list`))) return { data: null, error: DB_ERR };
      if (table === "hashtags" && failing.includes("hashtags:absent")) return { data: null, error: null };
      if (table === "profiles") return { data: single ? { id: VIEWER, account_status: "active" } : [{ id: ID, handle: "jazzfan", name: null, avatar_url: null }], error: null };
      if (table === "hashtags") return { data: single ? { id: "ht-1", is_blocked: false } : [], error: null };
      if (table === "hashtag_usage") return { data: [{ source_id: ID, created_at: "2026-09-28T10:00:00.000Z" }], error: null };
      if (ROWS[table]) return { data: ROWS[table], error: null };
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => { try { return Promise.resolve(answer(false)).then(f, r); } catch (e) { return Promise.reject(e).then(f, r); } };
        if (prop === "maybeSingle" || prop === "single") return () => { try { return Promise.resolve(answer(true)); } catch (e) { return Promise.reject(e); } };
        return () => b;
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

async function get(tab: string) {
  const r = await fetch(`${base}/hashtags/romejazz/feed?tab=${tab}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: (await r.json()) as any };
}
const servedEmpty = (status: number, body: any) => status === 200 && Array.isArray(body.items) && body.items.length === 0 && body.refusal == null;

describe("census-discovery §105 (DV-83, D-W11X2-61): GET /hashtags/:slug/feed with a read failing", () => {
  it("HF0 (V8-HF0) CONTROL: every tab, reads healthy → its row is served", async () => {
    _setTestClient(client([]) as any, true);
    for (const tab of ["events", "places", "trips", "circles", "people"]) {
      const { status, body } = await get(tab);
      assert.equal(status, 200, tab);
      assert.equal(body.items.length, 1, tab);
    }
  });

  it("HF1 (V8-HF1) events tab, the events read fails → a failed read, never an empty tab", async () => {
    _setTestClient(client(["events"]) as any, true);
    const { status, body } = await get("events");
    assert.ok(!servedEmpty(status, body), "a failed events read is served as an empty tab");
    assert.equal(status, 500); assert.equal(body.error, "db_error");
  });

  it("HF2 (V8-HF2) places tab, the discovery_places read fails → a failed read", async () => {
    _setTestClient(client(["discovery_places"]) as any, true);
    const { status, body } = await get("places");
    assert.ok(!servedEmpty(status, body), "a failed places read is served as an empty tab");
    assert.equal(status, 500); assert.equal(body.error, "db_error");
  });

  it("HF3 (V8-HF3) the hashtag lookup fails → a failed read, never 404 'Hashtag not found'", async () => {
    _setTestClient(client(["hashtags"]) as any, true);
    const { status, body } = await get("recent");
    assert.notEqual(status, 404, "a failed hashtag lookup is answered 'Hashtag not found'");
    assert.equal(status, 500); assert.equal(body.error, "db_error");
  });

  for (const [tab, table] of [["people", "profiles:list"], ["trips", "trips"], ["trips", "trip_members"], ["circles", "circles"], ["circles", "circle_memberships"]] as const) {
    it(`HF4 ${tab} tab, the ${table} read fails → a failed read, never an empty or short tab`, async () => {
      _setTestClient(client([table]) as any, true);
      const { status, body } = await get(tab);
      assert.ok(!servedEmpty(status, body));
      assert.equal(status, 500); assert.equal(body.error, "db_error");
    });
  }

  for (const [tab, table] of [["places", "discovery_places"], ["trips", "trips"], ["circles", "circles"], ["events", "events"]] as const) {
    it(`HF5 ${tab} tab, the ${table} read THROWS → the catch answers a failed read, never an empty page`, async () => {
      _setTestClient(client([], [table]) as any, true);
      const { status, body } = await get(tab);
      assert.ok(!servedEmpty(status, body), `${tab}: a thrown read is served as an empty tab`);
      assert.equal(status, 500); assert.equal(body.error, "db_error");
    });
  }

  it("HF6 CONTROL: a hashtag that was READ and is absent is still 404 not_found", async () => {
    _setTestClient(client(["hashtags:absent"]) as any, true);
    const { status, body } = await get("events");
    assert.equal(status, 404); assert.equal(body.error, "not_found");
  });
});

// ── §105 sweep (D-W11X2-61): GET /hashtags/trending's ranking reads ──
// The Discover chips are this route's top N. The post-engagement reads and the event-activity
// read ignored their errors (the round-8 verifier noted it, uncounted), so a failed read
// silently changed WHICH hashtags were served as "trending", presented as complete.
const HT = ["h1", "h2", "h3"];
function trendingClient(failing: string[], throwing: string[] = []) {
  function builder(table: string) {
    const eqs: Record<string, unknown> = {};
    const key = () => (table === "hashtag_usage" && eqs.source_type ? `hashtag_usage:${String(eqs.source_type)}` : table);
    const answer = (single: boolean) => {
      if (throwing.includes(key())) throw new Error("socket hang up");
      if (failing.includes(key())) return { data: null, error: DB_ERR };
      if (table === "profiles") return { data: single ? { id: VIEWER, account_status: "active" } : [], error: null };
      if (table === "hashtag_usage" && eqs.source_type === "post") return { data: [{ hashtag_id: "h1", source_id: "p1" }], error: null };
      if (table === "hashtag_usage" && eqs.source_type === "event") return { data: [{ hashtag_id: "h2" }], error: null };
      if (table === "hashtag_usage") return { data: HT.flatMap((h) => [1, 2, 3].map((a) => ({ hashtag_id: h, author_id: `a${a}`, city: null }))), error: null };
      if (table === "posts") return { data: [{ id: "p1", like_count: 50, comment_count: 5 }], error: null };
      if (table === "hashtags") return { data: HT.map((id) => ({ id, slug: id, name: id, usage_count: 3 })), error: null };
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => { try { return Promise.resolve(answer(false)).then(f, r); } catch (e) { return Promise.reject(e).then(f, r); } };
        if (prop === "maybeSingle" || prop === "single") return () => { try { return Promise.resolve(answer(true)); } catch (e) { return Promise.reject(e); } };
        if (prop === "eq") return (c: string, v: unknown) => { eqs[c] = v; return b; };
        return () => b;
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
async function trending() {
  const r = await fetch(`${base}/hashtags/trending?scope=global`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: (await r.json()) as any };
}

describe("census-discovery §105 sweep (DV-83, D-W11X2-61): GET /hashtags/trending's ranking reads", () => {
  it("HT0 CONTROL: every read healthy → the ranked chips", async () => {
    _setTestClient(trendingClient([]) as any, true);
    const { status, body } = await trending();
    assert.equal(status, 200);
    assert.equal(body.trending.length, 3);
    assert.equal(body.trending[0].slug, "h1", "engagement ranks h1 first");
  });

  for (const read of ["hashtag_usage:post", "posts", "hashtag_usage:event"]) {
    it(`HT1 the ${read} ranking read fails → a failed read, never a re-ranked list served as the trending chips`, async () => {
      _setTestClient(trendingClient([read]) as any, true);
      const { status, body } = await trending();
      assert.equal(status, 500, JSON.stringify(body));
      assert.equal(body.error, "db_error");
    });
  }

  it("HT2 the event-activity read THROWS → a failed read, never silently unranked", async () => {
    _setTestClient(trendingClient([], ["hashtag_usage:event"]) as any, true);
    const { status, body } = await trending();
    assert.equal(status, 500);
    assert.equal(body.error, "db_error");
  });
});
