/**
 * GET /memories/:id — the single canonical read, under an outage.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §28.11 "Never swallow projection/schema failures into plausible-looking
 *          empty history without structured error state."
 *
 * WHAT WAS WRONG, MEASURED AT src/routes/memories.ts BEFORE THIS SUITE
 * --------------------------------------------------------------------
 * The handler read six tables in one `Promise.all` and bound NONE of their
 * errors:
 *
 *     const [items, tags, likeCount, likedByMe, saveCount, savedByMe] =
 *       await Promise.all([ ...six reads... ]);
 *     ...
 *     items: (items.data ?? []).map(mapItem),
 *     tags:  participants.participants,      // built from (tags.data ?? [])
 *
 * supabase-js RESOLVES on a database error, so `items.data` and `tags.data`
 * were `null` for an unreadable table and `?? []` turned that into the
 * confident statement that the Memory has NO photographs and NOBODY was there.
 * A 200 with an empty list is indistinguishable from the truth, and it is the
 * one shape §28.11 names.
 *
 * THE SIBLING PATH IN THE SAME FILE ALREADY REFUSED. The trip recap
 * (`GET /trips/:tripId/recap`) binds both errors and answers 503 with
 * "refusing rather than reporting a trip with no photographs" /
 * "refusing rather than reporting a trip nobody shared". The single read is the
 * same two tables, the same question, and it answered with a lie. This suite
 * holds the two paths to the same contract.
 *
 * THE ENGAGEMENT READS ARE DELIBERATELY NOT A REFUSAL. `likeCount`,
 * `likedByMe`, `saveCount`, `savedByMe` and the owner profile degrade to
 * 0 / false / null, which is wrong but not a claim about the Memory's history.
 * They now bind their errors and log, so an outage is visible in the server log
 * instead of being invisible everywhere. Refusing the whole Memory because a
 * like count could not be read would be a worse answer than a wrong count, and
 * this file records that choice rather than leaving it to be inferred.
 *
 * Run: node --import tsx/esm --test src/test/memoriesSingleReadDegraded.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MEM = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function tables(): Record<string, any[]> {
  return {
    memories: [{
      id: MEM, owner_id: OWNER, title: "Lisbon rooftop", caption: null,
      visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
      trip_id: null, event_id: null, place_id: null,
      location_city: "Lisbon", location_country: "PT",
      location_lat: null, location_lng: null, canonical_location_id: null,
      starts_at: "2026-01-02T10:00:00.000Z", ends_at: null,
      state: "published", created_at: "2026-01-02T10:00:00.000Z",
      updated_at: "2026-01-02T10:00:00.000Z",
    }],
    memory_items: [{
      id: "item-1", memory_id: MEM, media_url: "https://example.test/a.jpg",
      media_type: "image", caption: null, position: 0,
      created_at: "2026-01-02T10:00:00.000Z",
    }],
    memory_tags: [{ memory_id: MEM, tagged_user_id: CREW, status: "approved", created_at: "2026-01-02T10:00:00.000Z" }],
    memory_likes: [], memory_saves: [],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null, expo_push_token: null },
      { id: CREW, account_status: "active", name: "Crew", handle: "crew", avatar_url: null, expo_push_token: null },
    ],
    trips: [], trip_members: [],
    blocks: [], user_follows: [], circle_memberships: [],
    feature_flags: [], notifications: [], hidden_gems: [],
    collections: [], collection_items: [],
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
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
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
        const rows = (Array.isArray(payload) ? payload : [payload])
          .map((r: any) => ({ ...r, id: r.id ?? `new-${all.length}-${table}`, created_at: "2026-02-01T00:00:00.000Z" }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null, count: rows.length };
      }
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        const gone = new Set(matched);
        store[table] = all.filter((r) => !gone.has(r));
        return selectedAfterWrite
          ? { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length }
          : { data: null, error: null, count: null };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        return selectedAfterWrite
          ? { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length }
          : { data: null, error: null, count: null };
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

interface App { baseUrl: string; store: Record<string, any[]>; logged: any[]; close: () => Promise<void> }

async function startApp(failReads: Set<string> = new Set()): Promise<App> {
  const store = tables();
  _setTestClient(makeClient(store, failReads) as any, true);
  const logged: any[] = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (o: any) => { logged.push(o); }, info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", memoriesRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, store, logged,
        close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(app: App, path: string, actor: string) {
  const res = await fetch(app.baseUrl + path, {
    headers: { Authorization: `Bearer ${actor}`, connection: "close" },
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("GET /memories/:id — §28.11 structured error state", () => {
  it("answers 503 degraded_unavailable when `memory_items` cannot be read, rather than a Memory with no photographs", async () => {
    app = await startApp(new Set(["memory_items"]));
    const r = await get(app, `/api/memories/${MEM}`, OWNER);
    assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(r.body?.memory, undefined, "a refusal must not also ship a Memory body");
  });

  it("answers 503 degraded_unavailable when `memory_tags` cannot be read, rather than a Memory nobody shared", async () => {
    app = await startApp(new Set(["memory_tags"]));
    const r = await get(app, `/api/memories/${MEM}`, OWNER);
    assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
  });

  it("still serves the Memory, its photographs and its participants when every table reads", async () => {
    // THE POSITIVE CONTROL, and it asserts the two lists are NON-EMPTY on
    // purpose: a refusal that also broke the happy path would pass the two
    // tests above and be worthless. The fixture carries exactly one item and
    // one approved tag so "empty" cannot be mistaken for "correct".
    app = await startApp();
    const r = await get(app, `/api/memories/${MEM}`, OWNER);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.memory?.items?.length, 1, "the one photograph must survive");
    assert.equal(r.body?.memory?.tags?.length, 1, "the one approved participant must survive");
  });

  it("an unreadable `memory_likes` degrades the count and does NOT refuse the Memory", async () => {
    // The deliberate asymmetry, asserted so it cannot drift into a refusal by
    // somebody copying the branch above. A wrong like count is not a claim
    // about what happened; an empty item list is.
    app = await startApp(new Set(["memory_likes"]));
    const r = await get(app, `/api/memories/${MEM}`, OWNER);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.memory?.items?.length, 1);
    assert.equal(r.body?.memory?.likeCount, 0);
    // ASSERTED ON SHAPE, NOT ON WORDING. A mutation test proved this assertion
    // was needed: deleting the whole observation loop left all the other cases
    // green, because "does not refuse" is satisfied by a handler that never
    // looked at the error at all. What must be true is that the failure is
    // BINDABLE — that the handler saw `memory_likes` fail and said which table
    // — so the assertion binds the table name out of the log object rather
    // than matching any part of the message text.
    assert.ok(
      app.logged.some((o: any) => o?.table === "memory_likes" && o?.err),
      `no observation of the failed memory_likes read; saw ${JSON.stringify(app.logged.map((o: any) => o?.table))}`,
    );
  });
});
