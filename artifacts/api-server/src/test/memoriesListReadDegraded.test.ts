/**
 * The LIST reads of `routes/memories.ts`, under an outage — §M.6's defect,
 * found a second time on the three paths §M.6 did not read.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §28.11 "Never swallow projection/schema failures into plausible-looking
 *          empty history without structured error state."
 *
 * WHAT WAS WRONG, MEASURED BEFORE THIS SUITE
 * ------------------------------------------
 * §M.6 bound the `memory_items` error on `GET /memories/:id` and wrote the rule
 * it was binding it under: *"a wrong like count is not a claim about what
 * happened, an empty item list is"*. The SAME table is read by three other
 * handlers in the same file, and none of the three bound its error:
 *
 *     // enrichMemories — GET /memories and GET /users/:userId/memories
 *     const [likeRows, savedRows, coverRows, ownerRows, allowedNames] =
 *       await Promise.all([ ... ]);
 *     for (const r of (coverRows.data ?? []) as any[]) { ... }
 *     ...  cover: coverMap[m.id] ?? null,
 *
 *     // GET /trips/:tripId/memory
 *     const [coverRow, likeCount, likedByMe, ownerProfile] = await Promise.all([...]);
 *     cover: coverRow.data ? { ... } : null,
 *
 * supabase-js RESOLVES on a database error, so an unreadable `memory_items`
 * made `coverRows.data` / `coverRow.data` `null`, and the `?? null` beneath
 * turned that into a 200 saying **every Memory on the page has no
 * photograph** — byte-identical to the truth for a Memory that really has
 * none. That is the §M.6 defect, on the paths §M.6 did not reach, and the fix
 * here is the SAME rule rather than a second one: a failed `memory_items` read
 * never becomes "no photographs" anywhere in this file.
 *
 * THE ASYMMETRY IS CARRIED OVER UNCHANGED. `memory_likes`, `memory_saves`,
 * `collections` / `collection_items` (the viewer's `isSaved`) and the owner
 * profile degrade rather than refuse — a wrong like count, or a Memory that
 * reads as unsaved, is not a claim about the Memory's history. They bind and
 * log, so the outage is visible somewhere. §M.6's mutation E proved that
 * asserting "does not refuse" measures nothing, so every degrade case here
 * asserts the LOG SHAPE — `table` bound out of the log object — and not any
 * wording.
 *
 * Run: node --import tsx/esm --test src/test/memoriesListReadDegraded.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VIEWER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MEM = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const TRIP = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function tables(): Record<string, any[]> {
  return {
    memories: [{
      id: MEM, owner_id: OWNER, title: "Lisbon rooftop", caption: null,
      visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
      trip_id: TRIP, event_id: null, place_id: null,
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
    memory_tags: [],
    memory_likes: [], memory_saves: [],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null, expo_push_token: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null, expo_push_token: null },
    ],
    trips: [{ id: TRIP, user_id: OWNER, owner_id: OWNER, title: "Portugal", visibility: "public" }],
    trip_members: [],
    blocks: [], user_follows: [], circle_memberships: [],
    feature_flags: [], notifications: [], hidden_gems: [],
    collections: [{ id: "col-1", owner_id: VIEWER }],
    collection_items: [{ collection_id: "col-1", entity_type: "memory", entity_id: MEM }],
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

/** The three list paths, each named with the handler it exercises. */
const LIST_PATHS: ReadonlyArray<{ readonly name: string; readonly path: string; readonly cover: (b: any) => any }> = [
  { name: "GET /memories", path: "/api/memories", cover: (b) => b?.memories?.[0]?.cover },
  { name: "GET /users/:userId/memories", path: `/api/users/${OWNER}/memories`, cover: (b) => b?.memories?.[0]?.cover },
  { name: "GET /trips/:tripId/memory", path: `/api/trips/${TRIP}/memory`, cover: (b) => b?.memory?.cover },
];

describe("§28.11 — an unreadable `memory_items` is never served as 'no photographs'", () => {
  for (const p of LIST_PATHS) {
    it(`${p.name} refuses with degraded_unavailable rather than a null cover`, async () => {
      app = await startApp(new Set(["memory_items"]));
      const r = await get(app, p.path, VIEWER);
      assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "degraded_unavailable");
      assert.equal(r.body?.memories, undefined, "a refusal must not also ship a list body");
      assert.equal(r.body?.memory, undefined, "a refusal must not also ship a Memory body");
    });

    it(`${p.name} still serves the cover when every table reads`, async () => {
      // THE POSITIVE CONTROL. It asserts the cover is PRESENT on purpose: a
      // refusal that also broke the happy path would pass the case above and
      // be worthless. The fixture carries exactly one position-0 item.
      app = await startApp();
      const r = await get(app, p.path, VIEWER);
      assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(p.cover(r.body)?.mediaUrl, "https://example.test/a.jpg", "the one photograph must survive");
    });
  }
});

describe("§28.11 — the engagement reads degrade, and the degradation is observable", () => {
  it("GET /memories serves the page with a zero like count when `memory_likes` is unreadable", async () => {
    app = await startApp(new Set(["memory_likes"]));
    const r = await get(app, "/api/memories", VIEWER);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.memories?.length, 1);
    assert.equal(r.body?.memories?.[0]?.likeCount, 0);
    // ASSERTED ON SHAPE, NOT ON WORDING — §M.6's mutation E. "Does not refuse"
    // is satisfied just as well by a handler that never looked at the error,
    // so what is asserted is that the handler SAW `memory_likes` fail and said
    // which table.
    assert.ok(
      app.logged.some((o: any) => o?.table === "memory_likes" && o?.err),
      `no observation of the failed memory_likes read; saw ${JSON.stringify(app.logged.map((o: any) => o?.table))}`,
    );
  });

  it("GET /memories reads `isSaved` as false when the saved-collection lookup fails, and says so", async () => {
    // The `collections` read was inside a bare `try { } catch { }` with the
    // error discarded, so a viewer's entire saved set read as empty and
    // NOTHING anywhere recorded it. The response is unchanged — an unsaved
    // Memory is not a claim about what happened — but the outage is now bound.
    app = await startApp(new Set(["collections"]));
    const r = await get(app, "/api/memories", VIEWER);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.memories?.[0]?.isSaved, false);
    assert.ok(
      app.logged.some((o: any) => o?.table === "collections" && o?.err),
      `no observation of the failed collections read; saw ${JSON.stringify(app.logged.map((o: any) => o?.table))}`,
    );
  });

  it("GET /memories reports `isSaved` true when the lookup succeeds", async () => {
    // The positive control for the case above: without it, "isSaved false" is
    // satisfied by a handler that never performs the lookup at all.
    app = await startApp();
    const r = await get(app, "/api/memories", VIEWER);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.memories?.[0]?.isSaved, true, "the fixture has this Memory in the viewer's collection");
  });

  it("GET /users/:userId/memories serves the page with `savedByMe` false when `memory_saves` is unreadable, and says so", async () => {
    // `profiles` is NOT the table used for this case, deliberately: an
    // unreadable `profiles` is refused much earlier, by `requireUser`'s
    // account-status check, so it could never reach the enrichment reads and a
    // test written on it would be measuring the wrong guard. `memory_saves` is
    // read only inside `enrichMemories`.
    app = await startApp(new Set(["memory_saves"]));
    const r = await get(app, `/api/users/${OWNER}/memories`, VIEWER);
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.memories?.[0]?.savedByMe, false);
    assert.ok(
      app.logged.some((o: any) => o?.table === "memory_saves" && o?.err),
      `no observation of the failed memory_saves read; saw ${JSON.stringify(app.logged.map((o: any) => o?.table))}`,
    );
  });
});
