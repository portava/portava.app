/**
 * POST /memories/from-layover/:sessionId — census-layover L275.
 *
 * Layover spec §25: "Passport / Memories — convert a COMPLETED session into an
 * optional stamp/postcard/memory." The census held L275 at W on one surviving
 * clause: "there is no postcard and no memory path from the layover surface".
 * This suite proves the memory path on the STORE, not the status code:
 *
 *   - a completed layover becomes ONE private, unpublished Memory carrying the
 *     city, country and window — and no coordinate (§3 L19: Memory "must not
 *     own temporary operational location data");
 *   - a retry answers the same Memory, never a second one (§19);
 *   - an abandoned, expired or still-active layover is refused by name;
 *   - another traveller's layover is indistinguishable from a missing one;
 *   - an unreadable table is 503, never "not found" and never a write (§28.11).
 *
 * Run: node --import tsx/esm --test src/test/memoryFromLayover.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import memoriesRouter from "../routes/memories.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SESSION = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const TRIP = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CITY_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const ARRIVAL = "2026-10-01T02:00:00.000Z";
const DEPARTURE = "2026-10-01T09:30:00.000Z";

function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION, user_id: OWNER, status: "completed", trip_id: TRIP, canonical_city_id: CITY_ID,
    arrival_time: ARRIVAL, departure_time: DEPARTURE,
    manual_city: null, manual_country: null, manual_airport_name: null, manual_iata: null,
    // The airport row carries a coordinate. The Memory must not.
    airport_profiles: { city: "Taipei", country: "Taiwan", name: "Taoyuan International", iata_code: "TPE", lat: 25.0797, lng: 121.2342 },
    // Operational inputs a Memory has no business carrying.
    checked_bags: true, immigration_required: true, return_reminder_at: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

function tables(sessions: Record<string, unknown>[]): Record<string, any[]> {
  return {
    layover_sessions: sessions,
    memories: [], memory_tags: [], memory_items: [], memory_likes: [], memory_saves: [],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null, expo_push_token: null },
      { id: STRANGER, account_status: "active", name: "Stranger", handle: "stranger", avatar_url: null, expo_push_token: null },
    ],
    blocks: [], user_follows: [], circle_memberships: [],
    feature_flags: [], notifications: [], hidden_gems: [],
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
      // Reads fail; writes are left alone, so a write that happens anyway is
      // visible in the store rather than masked by a write-side error.
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

interface App {
  baseUrl: string;
  store: Record<string, any[]>;
  audits: Array<{ obj: any; msg: string }>;
  close: () => Promise<void>;
}

async function startApp(sessions: Record<string, unknown>[] = [session()], failReads: Set<string> = new Set()): Promise<App> {
  const store = tables(sessions);
  _setTestClient(makeClient(store, failReads) as any, true);
  const audits: Array<{ obj: any; msg: string }> = [];
  const realInfo = logger.info.bind(logger);
  (logger as any).info = (obj: any, msg?: string) => { audits.push({ obj, msg: String(msg ?? "") }); };
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoriesRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, store, audits,
        close: () => new Promise<void>((r) => {
          (logger as any).info = realInfo;
          srv.closeAllConnections();
          srv.close(() => r());
        }),
      });
    });
    srv.on("error", reject);
  });
}

async function post(app: App, sessionId: string, actor: string, key = `layover-memory-${sessionId}`) {
  const res = await fetch(`${app.baseUrl}/api/memories/from-layover/${sessionId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", "Idempotency-Key": key, connection: "close" },
    body: "{}",
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("a completed layover becomes ONE private Memory with no coordinate", () => {
  it("writes the Memory the traveller asked for — city, country, window, trip — private and unpublished", async () => {
    app = await startApp();
    const r = await post(app, SESSION, OWNER);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body?.existing, false);
    assert.equal(app.store.memories.length, 1);
    const m = app.store.memories[0];
    assert.equal(m.owner_id, OWNER);
    assert.equal(m.title, "Layover in Taipei");
    assert.equal(m.visibility, "only_me", "a Memory the traveller did not compose is private");
    assert.equal(m.state, "draft", "and unpublished until they choose otherwise");
    assert.equal(m.location_city, "Taipei");
    assert.equal(m.location_country, "Taiwan");
    assert.equal(m.canonical_location_id, CITY_ID);
    assert.equal(m.trip_id, TRIP);
    assert.equal(m.starts_at, ARRIVAL);
    assert.equal(m.ends_at, DEPARTURE);
  });

  it("§3 L19: carries no coordinate, no place id and no operational input of the session", async () => {
    app = await startApp();
    const r = await post(app, SESSION, OWNER);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = app.store.memories[0];
    for (const k of ["location_lat", "location_lng", "place_id", "checked_bags", "immigration_required", "return_reminder_at", "airport_profiles"]) {
      assert.ok(!(k in m), `the Memory row must not carry ${k}: ${JSON.stringify(m)}`);
    }
  });

  it("crosses the §17 command boundary: one CREATE_MEMORY audit line, accepted, with the client's key", async () => {
    app = await startApp();
    const r = await post(app, SESSION, OWNER, "client-key-1");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const audit = app.audits.find((a) => a.obj?.commandType === "CREATE_MEMORY");
    assert.ok(audit, `no CREATE_MEMORY audit line; saw ${JSON.stringify(app.audits.map((a) => a.obj?.commandType))}`);
    assert.equal(audit!.obj.outcome, "accepted");
    assert.equal(audit!.obj.idempotencyKey, "client-key-1");
  });

  it("a retry answers the existing Memory and writes no second row", async () => {
    app = await startApp();
    const first = await post(app, SESSION, OWNER);
    assert.equal(first.status, 201);
    const again = await post(app, SESSION, OWNER, "a-different-key-after-a-lost-response");
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body?.existing, true);
    assert.equal(app.store.memories.length, 1, "one live Memory per layover");
  });

  it("a deleted earlier Memory does not block keeping the layover again", async () => {
    app = await startApp();
    assert.equal((await post(app, SESSION, OWNER)).status, 201);
    app.store.memories[0].state = "deleted";
    const again = await post(app, SESSION, OWNER, "after-delete");
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(app.store.memories.filter((m) => m.state !== "deleted").length, 1);
  });

  it("falls back to the traveller's own typed city when there is no airport row", async () => {
    app = await startApp([session({ airport_profiles: null, manual_city: "Lisbon", manual_country: "Portugal" })]);
    const r = await post(app, SESSION, OWNER);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(app.store.memories[0].title, "Layover in Lisbon");
    assert.equal(app.store.memories[0].location_city, "Lisbon");
    assert.equal(app.store.memories[0].location_country, "Portugal");
  });

  it("names the airport when no city is known at all", async () => {
    app = await startApp([session({ airport_profiles: null, manual_airport_name: "Gate 7 Airfield" })]);
    const r = await post(app, SESSION, OWNER);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(app.store.memories[0].title, "Layover at Gate 7 Airfield");
    assert.equal(app.store.memories[0].location_city, null);
  });
});

describe("only a layover that ended with the flight", () => {
  for (const status of ["active", "cancelled", "expired"]) {
    it(`refuses a layover whose status is ${status}, by name, and writes nothing`, async () => {
      app = await startApp([session({ status })]);
      const r = await post(app, SESSION, OWNER);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body?.error, "conflict");
      assert.equal(r.body?.reason, "layover_not_completed");
      assert.equal(app.store.memories.length, 0);
    });
  }
});

describe("another traveller's layover is indistinguishable from a missing one", () => {
  it("answers 404 to a stranger and writes nothing", async () => {
    app = await startApp();
    const r = await post(app, SESSION, STRANGER);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(app.store.memories.length, 0);
  });

  it("answers the same 404 for an id that does not exist", async () => {
    app = await startApp([]);
    const r = await post(app, SESSION, OWNER);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(app.store.memories.length, 0);
  });

  it("refuses a malformed id before reading anything", async () => {
    app = await startApp();
    const r = await post(app, "not-a-uuid", OWNER);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(app.store.memories.length, 0);
  });
});

describe("§28.11 — an unreadable table is a refusal, never an absence and never a write", () => {
  it("layover_sessions unreadable → 503, not 404, and no Memory", async () => {
    app = await startApp([session()], new Set(["layover_sessions"]));
    const r = await post(app, SESSION, OWNER);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(app.store.memories.length, 0);
  });

  it("the existing-Memory check unreadable → 503 BEFORE the write, so a retry cannot duplicate", async () => {
    app = await startApp([session()], new Set(["memories"]));
    const r = await post(app, SESSION, OWNER);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(app.store.memories.length, 0, "a Memory was written although the duplicate check could not run");
  });
});
