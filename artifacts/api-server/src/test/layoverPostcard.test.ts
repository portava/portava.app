/**
 * POST /postcards with `layoverSessionId` — census-layover L275, the postcard half.
 *
 * Layover spec §25: "Passport / Memories — convert a COMPLETED session into an
 * optional stamp/postcard/memory." The stamp half rides on the close and the
 * memory half is POST /memories/from-layover/:sessionId (memoryFromLayover.test.ts).
 * The postcard half is NOT a new route: it is the existing postcard shell with
 * one more optional field, so the upload flow, the lazy passport postcard and
 * its presence rules are the ones every postcard gets. This suite proves, on the
 * STORE:
 *
 *   - a completed layover of the caller yields one postcard shell whose place is
 *     the layover's city and country — never a coordinate, place id, canonical
 *     id or location name;
 *   - an active, cancelled or expired layover is refused by name (409) and
 *     nothing is written;
 *   - another traveller's layover answers exactly like a missing one (404);
 *   - a client place sent alongside a layover id is refused, not merged;
 *   - an unreadable layover table is 503 and nothing is written;
 *   - the passport postcard the first ready file creates claims no presence
 *     (location_verified false, stamp_eligible false), and no stamp is awarded;
 *   - a postcard WITHOUT a layover id is untouched (the client's place still lands).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 node --import tsx/esm --test src/test/layoverPostcard.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import postcardsRouter, { syncPostcardAfterMediaChange } from "../routes/postcards.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SESSION = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MISSING = "99999999-9999-9999-9999-999999999999";
const CITY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION, user_id: OWNER, status: "completed", canonical_city_id: CITY_ID,
    arrival_time: "2026-10-01T02:00:00.000Z", departure_time: "2026-10-01T09:30:00.000Z",
    manual_city: null, manual_country: null, manual_airport_name: null, manual_iata: null,
    // The airport row carries a coordinate. The postcard must not.
    airport_profiles: { city: "Taipei", country: "Taiwan", name: "Taoyuan International", iata_code: "TPE", lat: 25.0797, lng: 121.2342 },
    ...over,
  };
}

function tables(sessions: Record<string, unknown>[]): Record<string, any[]> {
  return {
    layover_sessions: sessions,
    posts: [], post_media: [], passport_postcards: [], post_event_links: [],
    user_stamps: [], passport_stamps: [], feature_flags: [],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner" },
      { id: STRANGER, account_status: "active", name: "Stranger", handle: "stranger" },
    ],
  };
}

function makeClient(store: Record<string, any[]>, failReads: Set<string>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, head = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "update" | "delete" | null = null;
    let payload: any = null;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt() { return obj; }, lt() { return obj; }, gte() { return obj; }, lte() { return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (!isWrite && failReads.has(table)) {
        return { data: null, error: { message: `${table} unavailable` }, count: null };
      }
      const all = (store[table] ??= []);
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r, id: r.id ?? `new-${all.length}-${table}` }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null, count: rows.length };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        return selectedAfterWrite ? { data: single ? (matched[0] ?? null) : matched, error: null } : { data: null, error: null };
      }
      if (mode === "delete") {
        const gone = new Set(matched);
        store[table] = all.filter((r) => !gone.has(r));
        return { data: null, error: null };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched, error: null, count: head ? matched.length : null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: async () => ({ data: null, error: { message: "no rpc" } }),
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { baseUrl: string; store: Record<string, any[]>; close: () => Promise<void> }

async function startApp(sessions: Record<string, unknown>[] = [session()], failReads: Set<string> = new Set()): Promise<App> {
  const store = tables(sessions);
  _setTestClient(makeClient(store, failReads) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", postcardsRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, store,
        close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
      });
    });
    srv.on("error", reject);
  });
}

async function createPostcard(app: App, actor: string, body: Record<string, unknown>) {
  const res = await fetch(`${app.baseUrl}/api/postcards`, {
    method: "POST",
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("a completed layover of the caller becomes a postcard through the existing route", () => {
  it("writes ONE shell whose place is the layover's city and country", async () => {
    app = await startApp();
    const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION, caption: "Night market between flights", visibility: "private" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(app.store.posts.length, 1);
    const p = app.store.posts[0];
    assert.equal(r.body.id, p.id);
    assert.equal(p.author_id, OWNER);
    assert.equal(p.location_city, "Taipei");
    assert.equal(p.location_country, "Taiwan");
    assert.equal(p.visibility, "private", "the composer's visibility is the traveller's, not the layover's");
    assert.equal(p.content, "Night market between flights");
    assert.equal(p.media_count, 0, "a shell, exactly like every other postcard — the passport postcard waits for a ready file");
  });

  it("carries no coordinate, place id, canonical id or location name — the airport's lat/lng never reach it", async () => {
    app = await startApp();
    const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = app.store.posts[0];
    assert.equal(p.location_lat, null);
    assert.equal(p.location_lng, null);
    assert.equal(p.location_place_id, null);
    assert.equal(p.location_name, null);
    assert.ok(!("canonical_location_id" in p), `no canonical id: ${JSON.stringify(p)}`);
    assert.ok(!("layover_session_id" in p), "no new storage: the layover id is not persisted on the post");
  });

  it("falls back to the traveller's own typed city/country when the airport row has none", async () => {
    app = await startApp([session({ airport_profiles: null, manual_city: "Doha", manual_country: "Qatar" })]);
    const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(app.store.posts[0].location_city, "Doha");
    assert.equal(app.store.posts[0].location_country, "Qatar");
  });

  it("awards no stamp", async () => {
    app = await startApp();
    const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(app.store.user_stamps.length, 0);
    assert.equal(app.store.passport_stamps.length, 0);
  });
});

describe("only a COMPLETED layover, and only the caller's", () => {
  for (const status of ["active", "cancelled", "expired"]) {
    it(`a ${status} layover is refused by name and nothing is written`, async () => {
      app = await startApp([session({ status })]);
      const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body?.reason, "layover_not_completed");
      assert.equal(app.store.posts.length, 0);
    });
  }

  it("another traveller's completed layover answers exactly like a missing one", async () => {
    app = await startApp();
    const theirs = await createPostcard(app, STRANGER, { layoverSessionId: SESSION });
    const missing = await createPostcard(app, STRANGER, { layoverSessionId: MISSING });
    assert.equal(theirs.status, 404, JSON.stringify(theirs.body));
    assert.equal(missing.status, 404);
    assert.deepEqual(theirs.body, missing.body, "the refusal must not reveal that the layover exists");
    assert.equal(app.store.posts.length, 0);
  });

  it("an unreadable layover table is 503 — never 'not found' and never a postcard", async () => {
    app = await startApp([session()], new Set(["layover_sessions"]));
    const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(app.store.posts.length, 0);
  });

  it("a malformed layover id is a payload error", async () => {
    app = await startApp();
    const r = await createPostcard(app, OWNER, { layoverSessionId: "not-a-uuid" });
    assert.equal(r.status, 400);
    assert.equal(app.store.posts.length, 0);
  });
});

describe("the layover decides the place; the client may not add one", () => {
  const CLIENT_PLACES: Array<[string, unknown]> = [
    ["locationLat", 25.03], ["locationLng", 121.56], ["placeId", "nominatim:42"],
    ["canonicalLocationId", CITY_ID], ["locationName", "Taipei 101"],
    ["locationCity", "Tokyo"], ["locationCountry", "Japan"],
  ];
  for (const [key, value] of CLIENT_PLACES) {
    it(`${key} alongside a layover id is refused, not merged`, async () => {
      app = await startApp();
      const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION, [key]: value });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(app.store.posts.length, 0);
    });
  }

  it("a postcard WITHOUT a layover id keeps the client's place (the existing route is unchanged)", async () => {
    app = await startApp();
    const r = await createPostcard(app, OWNER, { locationCity: "Tokyo", locationCountry: "Japan", locationLat: 35.68, locationLng: 139.76 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const p = app.store.posts[0];
    assert.equal(p.location_city, "Tokyo");
    assert.equal(p.location_country, "Japan");
    assert.equal(p.location_lat, 35.68);
  });
});

describe("the passport postcard of a layover postcard claims no presence", () => {
  it("the first ready file writes the passport postcard unverified and not stamp-eligible, with the layover's city", async () => {
    app = await startApp();
    const r = await createPostcard(app, OWNER, { layoverSessionId: SESSION });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const postId = r.body.id as string;
    app.store.post_media.push({
      id: "m-1", post_id: postId, media_type: "image", processing_status: "ready",
      public_url: "https://cdn.test/p.jpg", sort_order: 0, moderation_status: "approved",
    });
    await syncPostcardAfterMediaChange(
      // the same client the router uses
      (await import("../lib/supabase.js")).getServiceClient(),
      postId, { id: OWNER }, { log: { warn: () => {} } },
    );
    assert.equal(app.store.passport_postcards.length, 1, JSON.stringify(app.store.passport_postcards));
    const pc = app.store.passport_postcards[0];
    assert.equal(pc.location_city, "Taipei");
    assert.equal(pc.location_country, "Taiwan");
    assert.equal(pc.location_verified, false);
    assert.equal(pc.stamp_eligible, false);
    assert.equal(pc.verification_method, "unavailable");
    assert.equal(app.store.user_stamps.length, 0);
    assert.equal(app.store.passport_stamps.length, 0);
  });
});
