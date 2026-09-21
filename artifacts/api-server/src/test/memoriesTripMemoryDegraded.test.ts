/**
 * POST/GET /trips/:tripId/memory — the create-from-trip path, under an outage.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §17   command bus: every canonical Memory mutation crosses one boundary and
 *         carries a commandId, an idempotency key and an audit row.
 *   §19   "client-generated operation IDs and server-side idempotency".
 *   §22   "never fabricate trip IDs, place IDs, participant links or visited
 *         outcomes".
 *   §28.11 "Never swallow projection/schema failures into plausible-looking
 *         empty history without structured error state."
 *
 * WHAT WAS WRONG, MEASURED AT src/routes/memories.ts BEFORE THIS SUITE
 * --------------------------------------------------------------------
 *   1674  `const { data: trip } = await sc.from("trips")...`  — `.error` is not
 *         bound. supabase-js RESOLVES on a database error, so an unreadable
 *         `trips` table produced `trip === null` and the handler answered
 *         404 "Trip not found" for a trip that exists.
 *   1688  `const { data: members } = await sc.from("trip_members")...` — same
 *         shape, and this one is worse than a wrong status code: `members`
 *         became null, `crewIds` became `[]`, and the handler WENT ON TO WRITE
 *         a canonical Memory with `visibility: 'trip_crew'` and no participant
 *         at all. A durable row produced from a participant set the server
 *         never actually read.
 *   1698  that insert did not cross the §17 command boundary — the only
 *         Memory-creating route in the file that did not — so there was no
 *         commandId, no audit line, no idempotency key, and a client retrying
 *         after the outage got a SECOND Memory for the same trip.
 *
 * Run: node --import tsx/esm --test src/test/memoriesTripMemoryDegraded.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import memoriesRouter from "../routes/memories.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TRIP = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function tables(): Record<string, any[]> {
  return {
    trips: [{
      id: TRIP, owner_id: OWNER, title: "Lisbon", destination_city: "Lisbon",
      destination_country: "PT", start_date: "2026-01-01", end_date: "2026-01-08",
      status: "completed",
    }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: CREW, role: "member", status: "accepted" },
    ],
    memories: [],
    memory_tags: [],
    memory_items: [],
    memory_likes: [],
    memory_saves: [],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null, expo_push_token: null },
      { id: CREW, account_status: "active", name: "Crew", handle: "crew", avatar_url: null, expo_push_token: null },
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

async function startApp(failReads: Set<string> = new Set()): Promise<App> {
  const store = tables();
  _setTestClient(makeClient(store, failReads) as any, true);
  const audits: Array<{ obj: any; msg: string }> = [];
  const realInfo = logger.info.bind(logger);
  (logger as any).info = (obj: any, msg?: string) => { audits.push({ obj, msg: String(msg ?? "") }); };
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    n();
  });
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

async function call(
  app: App,
  method: string,
  path: string,
  actor: string,
  headers: Record<string, string> = {},
) {
  const res = await fetch(app.baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close", ...headers },
    body: method === "POST" ? "{}" : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

// ── 1. An unreadable `trips` table is not "Trip not found" ───────────────────

describe("POST /trips/:tripId/memory — §28.11 structured error state", () => {
  it("answers 503 degraded_unavailable when `trips` cannot be read, and writes nothing", async () => {
    app = await startApp(new Set(["trips"]));
    const r = await call(app, "POST", `/api/trips/${TRIP}/memory`, OWNER);
    assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(app.store.memories.length, 0, "no Memory may be written when the trip could not be read");
  });

  it("answers 503 and writes NOTHING when `trip_members` cannot be read", async () => {
    // THE STORE IS THE ASSERTION. A 503 with a row already in `memories` would
    // be the same defect wearing a better status code: the participant set was
    // unreadable, so the Memory must not exist at all.
    app = await startApp(new Set(["trip_members"]));
    const r = await call(app, "POST", `/api/trips/${TRIP}/memory`, OWNER);
    assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
    assert.equal(app.store.memories.length, 0,
      "a canonical Memory was written from a participant set the server could not read");
    assert.equal(app.store.memory_tags.length, 0, "no tag may be written either");
  });
});

// ── 2. The happy path still works, and now crosses the §17 boundary ──────────

describe("POST /trips/:tripId/memory — §17 command boundary", () => {
  it("creates the Memory, tags the crew, and emits a CREATE_MEMORY audit line", async () => {
    app = await startApp();
    const r = await call(app, "POST", `/api/trips/${TRIP}/memory`, OWNER);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(app.store.memories.length, 1);
    assert.equal(r.body?.taggedCount, 1);
    const audit = app.audits.find((a) => a.obj?.commandType === "CREATE_MEMORY");
    assert.ok(audit, `no §17 audit line for CREATE_MEMORY; saw ${JSON.stringify(app.audits.map((a) => a.obj?.commandType))}`);
    assert.equal(audit.obj.outcome, "accepted");
    assert.equal(typeof audit.obj.commandId, "string");
    assert.equal(typeof audit.obj.idempotencyKey, "string");
  });

  it("refuses a malformed §19 Idempotency-Key instead of silently ignoring it", async () => {
    app = await startApp();
    const r = await call(app, "POST", `/api/trips/${TRIP}/memory`, OWNER, { "Idempotency-Key": "x".repeat(201) });
    assert.equal(r.status, 400, `expected invalid_payload, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "invalid_payload");
    assert.equal(app.store.memories.length, 0, "a refused command must not have written");
  });
});

// ── 3. The read twin ─────────────────────────────────────────────────────────

describe("GET /trips/:tripId/memory — §28.11", () => {
  it("answers 503 degraded_unavailable when `trips` cannot be read", async () => {
    app = await startApp(new Set(["trips"]));
    const r = await call(app, "GET", `/api/trips/${TRIP}/memory`, OWNER);
    assert.equal(r.status, 503, `expected degraded_unavailable, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error, "degraded_unavailable");
  });
});
