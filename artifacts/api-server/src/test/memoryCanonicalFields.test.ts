/**
 * Census-highlights-memories H40 (§4 `MemoryType`, migration 3803) and H71
 * (§9 "Entity merges may repoint canonical identity while preserving
 * occurrence-time display text", migration 3804). B58 cluster MEM-CANON.
 *
 * Over the REAL routers (POST/PATCH/GET /memories, POST /memories/search,
 * POST /trips/:tripId/memory, GET /memories/:id/actions, GET /memory-types) and
 * a table-backed fake that is STRICT about the two new columns: while a
 * migration is "not applied" the column does not exist, and a statement naming
 * it fails the way PostgREST fails it (42703 on a read, PGRST204 on a write).
 * The fake carries 3803's DEFAULT and a TypeScript port of 3804's trigger; the
 * SQL itself is executed by src/test/db/memoryCanonicalFields.db.test.ts on the
 * full chain (CI's local-db job) and rehearsed in
 * sql/rehearsals/3803_01_memory_canonical_fields.sql.
 *
 *   H40  an owner's type is kept, refused when it cannot be (never dropped), a
 *        legacy row reads null (never guessed), TRIP / EPISODE are written by
 *        the server, the §15 filter answers from the derivative, and the kernel
 *        path (which names a fixed column list) still ends with the type meant.
 *   H71  the Memory keeps the name its place had; a catalog merge repoints the
 *        action menu's place while the Memory still shows the occurrence text;
 *        a non-owner never gets the name of a place the owner rejected, or one
 *        the precision rung withholds (H-16/H-17); the same place never
 *        rewrites its text; a legacy row is never backfilled.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCanonicalFields.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import memoryActionsRouter from "../routes/memoryActions.js";
import memoryTypesRouter from "../routes/memoryTypes.js";
import { _setMemoryActionDeps } from "../services/memory/memoryActionService.js";
import { deriveProjection } from "../services/memoryProjections/derivativeRegistry.js";
import { getProjectionDefinition, sourceVersionOf, type MemorySourceRow } from "../services/memoryProjections/projectionRegistry.js";
import {
  MEMORY_TYPES, columnWritable, fieldServed, isCatalogPlaceId, occurrenceNameFor, occurrenceNameForWrite,
  occurrenceNameKeptWithRef, ownerTypeChoiceRefusal, type CanonicalGate,
} from "../services/memory/memoryCanonicalFields.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const MEM_CAT = "10000000-0000-4000-8000-0000000000c1";    // recorded at catalog place P, which was later merged into Q and renamed
const MEM_PICK = "10000000-0000-4000-8000-0000000000c2";   // recorded at a provider pick
const MEM_LEGACY = "10000000-0000-4000-8000-0000000000c3"; // existed before 3803/3804: no type, no name
const TRIP = "40000000-0000-4000-8000-000000000001";

const PLACE_P = "20000000-0000-4000-8000-0000000000a1";   // "Cafe A" when the Memory was made; renamed since; merged into Q
const PLACE_Q = "20000000-0000-4000-8000-0000000000a2";   // "Cafe B", the merge survivor
const PLACE_R = "20000000-0000-4000-8000-0000000000a3";   // another catalog place, "Ramen R"

const NAME_COLS = ["place_display_name_at_occurrence"];
const TYPE_COLS = ["memory_type"];
const BASE_MEMORY_COLUMNS = new Set([
  "id", "owner_id", "title", "caption", "visibility", "allowed_user_ids", "hidden_user_ids", "trip_id", "event_id",
  "place_id", "starts_at", "ends_at", "state", "created_at", "updated_at", "location_city", "location_country",
  "location_lat", "location_lng", "canonical_location_id", "location_precision",
]);
// The columns 2711's CREATE_MEMORY names. The kernel never names the new ones.
const KERNEL_INSERT_COLUMNS = ["title", "caption", "visibility", "allowed_user_ids", "hidden_user_ids", "trip_id", "event_id",
  "place_id", "location_city", "location_country", "location_lat", "location_lng", "canonical_location_id", "starts_at", "ends_at", "state"];

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Coffee", caption: null, visibility: "public", state: "published",
    allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null,
    place_id: null, canonical_location_id: null, location_precision: "exact",
    location_city: "Hanoi", location_country: "Vietnam", location_lat: 21.03, location_lng: 105.85,
    starts_at: "2026-03-03T11:00:00.000Z", ends_at: null,
    created_at: "2026-03-03T12:00:00.000Z", updated_at: "2026-03-03T12:00:00.000Z", ...over,
  };
}
function place(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: "Somewhere", primary_category: "food", latitude: 21.03, longitude: 105.85, address: null, city: "Hanoi",
    country_code: "VN", status: "active", merged_into_place_id: null, canonical_location_id: null, ...over,
  };
}

interface World {
  /** Which migrations are "applied": the column exists AND its flag row exists. */
  migrated: { type: boolean; name: boolean };
  /** The flag rows' values (when migrated). */
  on: { type: boolean; name: boolean };
  kernel?: boolean;
  precision?: boolean;
  failFlags?: Set<string>;
  failCanonicalRead?: boolean;
  /** Seed rows: the canonical fields as they would stand on a migrated database. */
  canon?: Record<string, { memory_type?: string | null; place_display_name_at_occurrence?: string | null }>;
  mutate?: (s: Record<string, any[]>) => void;
}

function seed(w: World): Record<string, any[]> {
  const flags: any[] = [];
  if (w.migrated.type) flags.push({ flag: "memory_type_enabled", enabled: w.on.type });
  if (w.migrated.name) flags.push({ flag: "memory_place_occurrence_name_enabled", enabled: w.on.name });
  if (w.kernel) flags.push({ flag: "memory_kernel_enabled", enabled: true });
  if (w.precision) flags.push({ flag: "memory_location_precision_enabled", enabled: true });
  const rows = [
    memory(MEM_CAT, { place_id: PLACE_P }),
    memory(MEM_PICK, { place_id: "fsq:cafe-a" }),
    memory(MEM_LEGACY, { place_id: PLACE_R, visibility: "public" }),
  ];
  for (const r of rows as any[]) {
    if (w.migrated.type) r.memory_type = w.canon?.[r.id]?.memory_type ?? null;
    if (w.migrated.name) r.place_display_name_at_occurrence = w.canon?.[r.id]?.place_display_name_at_occurrence ?? null;
  }
  return {
    feature_flags: flags,
    memories: rows,
    places: [
      place(PLACE_P, { name: "Cafe A (renamed since)", status: "duplicate", merged_into_place_id: PLACE_Q }),
      place(PLACE_Q, { name: "Cafe B" }),
      place(PLACE_R, { name: "Ramen R" }),
    ],
    profiles: [{ id: OWNER, name: "Owner", handle: "owner", avatar_url: null }, { id: FRIEND, name: "Friend", handle: "friend", avatar_url: null }],
    trips: [{ id: TRIP, owner_id: OWNER, title: "Hanoi week", destination_city: "Hanoi", destination_country: "Vietnam", start_date: "2026-03-01", end_date: "2026-03-07", status: "completed" }],
    trip_members: [], hidden_gems: [], trip_saved_places: [], memory_saves: [], memory_likes: [], blocks: [], user_follows: [],
    circle_memberships: [], memory_items: [], memory_tags: [], memory_corrections: [], memory_derivative_registry: [],
    memory_command_receipts: [],
  };
}

/** 3804's trigger, ported. The SQL is executed by the db test and the PGlite rehearsal. */
function occurrenceTrigger(op: "INSERT" | "UPDATE", oldRow: any, next: any, store: Record<string, any[]>): void {
  const blank = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const place = blank(next.place_id);
  let given = blank(next.place_display_name_at_occurrence)?.slice(0, 300) ?? null;
  if (op === "UPDATE" && (next.place_id ?? null) === (oldRow.place_id ?? null)) {
    next.place_display_name_at_occurrence = oldRow.place_display_name_at_occurrence != null ? oldRow.place_display_name_at_occurrence : place === null ? null : given;
    return;
  }
  if (place === null) { next.place_display_name_at_occurrence = null; return; }
  if (op === "UPDATE" && (next.place_display_name_at_occurrence ?? null) === (oldRow.place_display_name_at_occurrence ?? null)) given = null;
  if (given === null && isCatalogPlaceId(place)) given = blank((store.places ?? []).find((p) => p.id === place)?.name)?.slice(0, 300) ?? null;
  next.place_display_name_at_occurrence = given;
}

interface Op { table: string; mode: string; cols?: string; payload?: any }
function makeClient(store: Record<string, any[]>, ops: Op[], w: World) {
  let idN = 0;
  const memCols = new Set([...BASE_MEMORY_COLUMNS, ...(w.migrated.type ? TYPE_COLS : []), ...(w.migrated.name ? NAME_COLS : [])]);
  const unknownCol = (cols: string[]) => cols.find((c) => !memCols.has(c));
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const flagFilter: string[] = [];
    let mode: "select" | "upsert" | "update" | "insert" | "delete" = "select";
    let payload: any = null; let wantRows = false; let single = false; let limitN: number | null = null; let selected: string[] | null = null; let selectText = ""; let conflict: string[] = []; const orders: Array<[string, boolean]> = [];
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select(c?: string) { if (mode !== "select") wantRows = true; if (typeof c === "string") { selectText = c; if (mode === "select") selected = c.split(",").map((k) => k.trim()).filter((k) => k && !k.includes("(")); } return obj; },
      upsert(d: any, o?: any) { mode = "upsert"; payload = d; conflict = String(o?.onConflict ?? "").split(",").map((k) => k.trim()).filter(Boolean); return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => { if (table === "feature_flags" && c === "flag") flagFilter.push(String(v)); return f((r) => r[c] === v); },
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      contains: (c: string, vs: any[]) => f((r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; }, not() { return obj; }, or() { return obj; }, range() { return obj; },
      order(c: string, o?: any) { orders.push([c, o?.ascending !== false]); return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      const clean = (r: any) => Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => v !== undefined)); // supabase-js drops undefined keys
      const body = Array.isArray(payload) ? payload.map(clean) : payload ? clean(payload) : null;
      ops.push({ table, mode, cols: selectText, payload: body });
      if (table === "feature_flags" && flagFilter.some((fl) => w.failFlags?.has(fl))) return { data: null, error: { code: "57014", message: "feature_flags read failed" } };
      if (table === "memories") {
        const named = mode === "select" ? (selected ?? []) : [...(Array.isArray(body) ? body.flatMap((r: any) => Object.keys(r)) : Object.keys(body ?? {}))];
        const bad = unknownCol(named);
        if (bad) return { data: null, error: mode === "select" ? { code: "42703", message: `column memories.${bad} does not exist` } : { code: "PGRST204", message: `Could not find the '${bad}' column of 'memories' in the schema cache` } };
        if (w.failCanonicalRead && mode === "select" && named.some((c) => c === "memory_type" || c === "place_display_name_at_occurrence")) return { data: null, error: { code: "57014", message: "canonical read failed" } };
      }
      const all = (store[table] ??= []);
      if (mode === "upsert" || mode === "insert") {
        const written: any[] = [];
        for (const r of (Array.isArray(body) ? body : [body])) {
          const row: any = { id: `ins-${++idN}`, created_at: "2026-10-14T00:00:00.000Z", updated_at: "2026-10-14T00:00:00.000Z", ...r };
          if (table === "memories") {
            row.id = r.id ?? `30000000-0000-4000-8000-${String(++idN).padStart(12, "0")}`;
            if (w.migrated.type && !("memory_type" in r)) row.memory_type = "MOMENT"; // 3803's DEFAULT
            if (w.migrated.name) occurrenceTrigger("INSERT", null, row, store);
          }
          const had = conflict.length > 0 ? all.find((x) => conflict.every((k) => x[k] === row[k])) : undefined;
          if (had) { Object.assign(had, r); written.push(had); continue; }
          all.push(row); written.push(row);
        }
        const proj = (x: any) => (wantRows && selectText && table === "memories" ? Object.fromEntries(selectText.split(",").map((k) => k.trim()).filter((k) => k in x).map((k) => [k, x[k]])) : { ...x });
        if (single) return { data: written[0] ? proj(written[0]) : null, error: null };
        return { data: wantRows ? written.map(proj) : null, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") {
        for (const r of matched) {
          const next = { ...r, ...body };
          if (table === "memories" && w.migrated.name && ("place_id" in body || "place_display_name_at_occurrence" in body)) occurrenceTrigger("UPDATE", r, next, store);
          Object.assign(r, next);
        }
        return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null };
      }
      if (mode === "delete") { store[table] = all.filter((r) => !matched.includes(r)); return { data: wantRows ? matched : null, error: null }; }
      if (orders.length > 0) matched = [...matched].sort((x, y) => { for (const [c, asc] of orders) { const d = String(x[c] ?? "").localeCompare(String(y[c] ?? "")); if (d !== 0) return asc ? d : -d; } return 0; });
      if (limitN != null) matched = matched.slice(0, limitN);
      const project = (x: any) => (selected && selected.length > 0 && !selected.includes("*") ? Object.fromEntries(selected.filter((k) => k in x).map((k) => [k, x[k]])) : { ...x });
      if (single) return { data: matched[0] ? project(matched[0]) : null, error: null };
      return { data: matched.map(project), error: null };
    }
    return obj;
  }
  /** 2711's memory_kernel_execute, as far as these fields go: a FIXED column list, defaults, the trigger, an idempotent receipt. */
  async function rpc(fn: string, args: any) {
    ops.push({ table: `rpc:${fn}`, mode: "rpc", payload: args });
    if (fn !== "memory_kernel_execute") return { data: null, error: { code: "PGRST202", message: `${fn} not modelled` } };
    const c = args.p_command;
    const receipts = (store.memory_command_receipts ??= []);
    const had = receipts.find((r) => r.key === `${c.actor_user_id}:${c.idempotency_key}`);
    if (had) return { data: { ...had.data, duplicate: true }, error: null };
    let row: any;
    if (c.type === "CREATE_MEMORY") {
      row = { id: `30000000-0000-4000-8000-${String(++idN).padStart(12, "0")}`, owner_id: c.actor_user_id, created_at: "2026-10-14T00:00:00.000Z", updated_at: "2026-10-14T00:00:00.000Z" };
      for (const k of KERNEL_INSERT_COLUMNS) row[k] = c.payload.write?.[k] ?? null;
      row.visibility ??= "friends_only"; row.state ??= "published"; row.allowed_user_ids ??= []; row.hidden_user_ids ??= [];
      if (w.migrated.type) row.memory_type = "MOMENT";
      if (w.migrated.name) { row.place_display_name_at_occurrence = null; occurrenceTrigger("INSERT", null, row, store); }
      store.memories.push(row);
    } else {
      row = store.memories.find((m) => m.id === c.memory_id);
      if (!row) return { data: { ok: false, reason: "MEMORY_NOT_FOUND" }, error: null };
      const next = { ...row };
      for (const k of KERNEL_INSERT_COLUMNS) if (c.payload.patch && k in c.payload.patch) next[k] = c.payload.patch[k];
      if (w.migrated.name && c.payload.patch && "place_id" in c.payload.patch) occurrenceTrigger("UPDATE", row, next, store);
      Object.assign(row, next);
    }
    const data = { ok: true, duplicate: false, memory_id: row.id, event_id: `ev-${++idN}`, event_type: c.type === "CREATE_MEMORY" ? "memory.created" : "memory.corrected", result: { ...row }, contract_version: 1 };
    receipts.push({ key: `${c.actor_user_id}:${c.idempotency_key}`, data });
    return { data, error: null };
  }
  return {
    from: (t: string) => chain(t),
    rpc,
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; ops: Op[]; close: () => Promise<void> }
async function start(w: World): Promise<App> {
  const store = seed(w);
  w.mutate?.(store);
  const ops: Op[] = [];
  _setTestClient(makeClient(store, ops, w) as any, true);
  _setMemoryActionDeps({
    liveStatus: async () => null,
    tripWindows: async () => ({ ok: false } as any),
    restrictiveGemCeiling: async () => ({ determined: true, ceiling: null }),
  });
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", memoryActionsRouter);
  app.use("/api", memoryTypesRouter);
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, ops, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
let keyN = 0;
async function call(a: App, method: string, p: string, actor = OWNER, body?: unknown, key?: string) {
  const res = await fetch(`${a.base}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", "Idempotency-Key": key ?? `mcf-${++keyN}`, connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const mem = (a: App, id: string) => a.store.memories.find((m) => m.id === id);
const named = (a: App, col: string) => a.ops.filter((o) => o.table === "memories" && ((o.cols ?? "").includes(col) || (o.payload && JSON.stringify(o.payload).includes(`"${col}"`))));

const APPLIED_ON: World = { migrated: { type: true, name: true }, on: { type: true, name: true } };
const APPLIED_OFF: World = { migrated: { type: true, name: true }, on: { type: false, name: false } };
const NOT_APPLIED: World = { migrated: { type: false, name: false }, on: { type: false, name: false } };
const CANON = {
  [MEM_CAT]: { memory_type: "PLACE", place_display_name_at_occurrence: "Cafe A" },
  [MEM_PICK]: { memory_type: "REUNION", place_display_name_at_occurrence: "Cafe A Pick" },
  [MEM_LEGACY]: { memory_type: null, place_display_name_at_occurrence: null },
};

let app: App | null = null;
afterEach(async () => { _setMemoryActionDeps(null); if (app) { await app.close(); app = null; } });

// ════════════════════════════════════════════════════════════════════════════
describe("H40/H71: before 3803/3804 are applied nothing names either column (production today)", () => {
  it("create, read, edit and the trip create answer exactly as before; no statement names a new column", async () => {
    app = await start(NOT_APPLIED);
    const c = await call(app, "POST", "/memories", OWNER, { title: "x", placeId: "fsq:new", placeDisplayNameAtOccurrence: "New Pick" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal("memoryType" in c.body.memory, false);
    assert.equal("placeDisplayNameAtOccurrence" in c.body.memory, false);
    const g = await call(app, "GET", `/memories/${MEM_CAT}`, FRIEND);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal("memoryType" in g.body.memory, false);
    assert.equal("placeDisplayNameAtOccurrence" in g.body.memory, false);
    const p = await call(app, "PATCH", `/memories/${MEM_PICK}`, OWNER, { placeId: "fsq:other", placeDisplayNameAtOccurrence: "Other" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const t = await call(app, "POST", `/trips/${TRIP}/memory`, OWNER);
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.deepEqual(named(app, "memory_type").map((o) => o.mode), []);
    assert.deepEqual(named(app, "place_display_name_at_occurrence").map((o) => o.mode), []);
  });

  it("an owner's type is REFUSED, never dropped (404 feature_disabled), and nothing is written", async () => {
    app = await start(NOT_APPLIED);
    const before = app.store.memories.length;
    const c = await call(app, "POST", "/memories", OWNER, { title: "x", memoryType: "REUNION" });
    assert.equal(c.status, 404);
    assert.equal(c.body.error, "feature_disabled");
    assert.equal(app.store.memories.length, before);
    const p = await call(app, "PATCH", `/memories/${MEM_CAT}`, OWNER, { memoryType: "FIRST" });
    assert.equal(p.status, 404);
  });

  it("GET /memory-types says not enabled; the §15 type filter is refused, not answered empty", async () => {
    app = await start(NOT_APPLIED);
    const caps = await call(app, "GET", "/memory-types");
    assert.equal(caps.status, 200);
    assert.equal(caps.body.enabled, false);
    assert.deepEqual(caps.body.types, [...MEMORY_TYPES]);
    const s = await call(app, "POST", "/memories/search", OWNER, { intent: { kind: "mine" }, memoryType: "EPISODE" });
    assert.equal(s.status, 400, JSON.stringify(s.body));
    assert.match(s.body.message, /Memory type/);
  });
});

describe("H40: an unreadable flag refuses the owner's choice retryably (503), never drops it", () => {
  it("POST and PATCH answer 503 and write nothing; /memory-types is 503, not 'disabled'", async () => {
    app = await start({ ...APPLIED_ON, failFlags: new Set(["memory_type_enabled"]) });
    const before = JSON.stringify(app.store.memories);
    assert.equal((await call(app, "POST", "/memories", OWNER, { title: "x", memoryType: "REUNION" })).status, 503);
    assert.equal((await call(app, "PATCH", `/memories/${MEM_CAT}`, OWNER, { memoryType: "FIRST" })).status, 503);
    assert.equal(JSON.stringify(app.store.memories), before);
    assert.equal((await call(app, "GET", "/memory-types")).status, 503);
    assert.equal((await call(app, "POST", "/memories/search", OWNER, { intent: { kind: "mine" }, memoryType: "EPISODE" })).status, 503);
  });
});

describe("H40: applied, flag ON — the owner's type is stored and served", () => {
  it("a chosen type is stored and returned; none chosen is the 3803 DEFAULT (MOMENT, Q-H40)", async () => {
    app = await start(APPLIED_ON);
    const c = await call(app, "POST", "/memories", OWNER, { title: "Met Anh again", memoryType: "REUNION" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.body.memory.memoryType, "REUNION");
    assert.equal(mem(app, c.body.memory.id).memory_type, "REUNION");
    assert.equal(app.ops.some((o) => o.table === "memories" && o.mode === "update"), false, "the legacy create needed a follow-up write: the INSERT did not carry the type");
    const d = await call(app, "POST", "/memories", OWNER, { title: "No type" });
    assert.equal(d.body.memory.memoryType, "MOMENT");
    assert.equal(mem(app, d.body.memory.id).memory_type, "MOMENT");
  });

  it("an unknown type is a 400; the type is served to a viewer who may read the Memory", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    assert.equal((await call(app, "POST", "/memories", OWNER, { title: "x", memoryType: "VACATION" })).status, 400);
    const g = await call(app, "GET", `/memories/${MEM_PICK}`, FRIEND);
    assert.equal(g.body.memory.memoryType, "REUNION");
  });

  it("a LEGACY row reads null — unknown, never a guessed type", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    const g = await call(app, "GET", `/memories/${MEM_LEGACY}`, OWNER);
    assert.equal(g.status, 200);
    assert.equal(g.body.memory.memoryType, null);
    assert.equal(mem(app, MEM_LEGACY).memory_type, null);
  });

  it("PATCH sets and clears the type; GET /memory-types says enabled", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    const p = await call(app, "PATCH", `/memories/${MEM_CAT}`, OWNER, { memoryType: "MILESTONE" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.memory.memoryType, "MILESTONE");
    assert.equal(mem(app, MEM_CAT).memory_type, "MILESTONE");
    assert.equal(app.ops.filter((o) => o.table === "memories" && o.mode === "update").length, 1, "the legacy PATCH needed a follow-up write: its UPDATE did not carry the type");
    const q = await call(app, "PATCH", `/memories/${MEM_CAT}`, OWNER, { memoryType: null });
    assert.equal(q.body.memory.memoryType, null);
    assert.equal(mem(app, MEM_CAT).memory_type, null);
    assert.equal((await call(app, "GET", "/memory-types")).body.enabled, true);
  });

  it("a canonical-field read that fails refuses the Memory (503), never serves it without them", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON, failCanonicalRead: true });
    const g = await call(app, "GET", `/memories/${MEM_PICK}`, FRIEND);
    assert.equal(g.status, 503);
  });
});

describe("H40: applied, flag OFF — what the server knows is still written, nothing is served", () => {
  it("POST /trips/:tripId/memory writes TRIP; the response does not serve it; an owner's type is refused", async () => {
    app = await start({ ...APPLIED_OFF, canon: CANON });
    const t = await call(app, "POST", `/trips/${TRIP}/memory`, OWNER);
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.equal(mem(app, t.body.memory.id).memory_type, "TRIP");
    assert.equal(app.ops.find((o) => o.table === "memories" && o.mode === "insert")?.payload?.memory_type, "TRIP", "TRIP was not written by the create itself (one statement on the legacy path)");
    assert.equal(app.ops.some((o) => o.table === "memories" && o.mode === "update"), false, "the legacy path needed a follow-up write");
    assert.equal("memoryType" in t.body.memory, false);
    assert.equal((await call(app, "POST", "/memories", OWNER, { title: "x", memoryType: "CREW" })).status, 404);
    const g = await call(app, "GET", `/memories/${MEM_PICK}`, OWNER);
    assert.equal("memoryType" in g.body.memory, false);
    assert.equal("placeDisplayNameAtOccurrence" in g.body.memory, false);
  });
});

describe("H40/H71: the kernel path names a fixed column list (2711); the route still ends with what it meant", () => {
  it("CREATE through the kernel: the DEFAULT lands first, then the owner's type and the pick's name are written", async () => {
    app = await start({ ...APPLIED_ON, kernel: true });
    const c = await call(app, "POST", "/memories", OWNER, { title: "k", memoryType: "FIRST", placeId: "fsq:kernel", placeDisplayNameAtOccurrence: "Kernel Pick" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.ok(app.ops.some((o) => o.table === "rpc:memory_kernel_execute"), "the kernel was not used");
    const row = mem(app, c.body.memory.id);
    assert.equal(row.memory_type, "FIRST");
    assert.equal(row.place_display_name_at_occurrence, "Kernel Pick");
    assert.equal(c.body.memory.memoryType, "FIRST");
    assert.equal(c.body.memory.placeDisplayNameAtOccurrence, "Kernel Pick");
  });

  it("create-from-trip through the kernel ends TRIP; a PATCH through the kernel ends with the chosen type", async () => {
    app = await start({ ...APPLIED_ON, kernel: true, canon: CANON });
    const t = await call(app, "POST", `/trips/${TRIP}/memory`, OWNER);
    assert.equal(t.status, 201, JSON.stringify(t.body));
    assert.equal(mem(app, t.body.memory.id).memory_type, "TRIP");
    const p = await call(app, "PATCH", `/memories/${MEM_CAT}`, OWNER, { memoryType: "DISCOVERY" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(mem(app, MEM_CAT).memory_type, "DISCOVERY");
  });

  it("flags OFF, kernel ON: the kernel returns the WHOLE row, and still neither field is serialized; the pick's text is still recorded", async () => {
    app = await start({ ...APPLIED_OFF, kernel: true });
    const c = await call(app, "POST", "/memories", OWNER, { title: "k-off", placeId: "fsq:kernel-off", placeDisplayNameAtOccurrence: "Kernel Off Pick" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal("memoryType" in c.body.memory, false, "a raw memory_type column on the kernel's row reached the wire with the flag OFF");
    assert.equal("placeDisplayNameAtOccurrence" in c.body.memory, false);
    const row = mem(app, c.body.memory.id);
    assert.equal(row.memory_type, "MOMENT");
    assert.equal(row.place_display_name_at_occurrence, "Kernel Off Pick");
  });

  it("a replay of the same create is a duplicate of the same command: one Memory, the type still holds", async () => {
    app = await start({ ...APPLIED_ON, kernel: true });
    const a = await call(app, "POST", "/memories", OWNER, { title: "r", memoryType: "CREW" }, "same-key");
    const b = await call(app, "POST", "/memories", OWNER, { title: "r", memoryType: "CREW" }, "same-key");
    assert.equal(a.body.memory.id, b.body.memory.id);
    assert.equal(app.store.memories.filter((m) => m.title === "r").length, 1);
    assert.equal(mem(app, a.body.memory.id).memory_type, "CREW");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("H71: a merge repoints canonical identity while the Memory keeps its occurrence-time text", () => {
  it("P 'Cafe A' merged into Q 'Cafe B' and renamed: the menu acts on Q; the Memory still says 'Cafe A'", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    const menu = await call(app, "GET", `/memories/${MEM_CAT}/actions`, OWNER);
    assert.equal(menu.status, 200, JSON.stringify(menu.body));
    assert.equal(menu.body.menu.place?.id, PLACE_Q, "the merge was not followed: canonical identity is not repointed");
    assert.equal(menu.body.menu.place?.name, "Cafe B");
    for (const viewer of [OWNER, FRIEND]) {
      const g = await call(app, "GET", `/memories/${MEM_CAT}`, viewer);
      assert.equal(g.status, 200, JSON.stringify(g.body));
      assert.equal(g.body.memory.placeId, PLACE_P);
      assert.equal(g.body.memory.placeDisplayNameAtOccurrence, "Cafe A", `${viewer === OWNER ? "owner" : "viewer"}: the occurrence text was rewritten`);
    }
  });

  it("a legacy row reads null — never backfilled from today's catalog name", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    const g = await call(app, "GET", `/memories/${MEM_LEGACY}`, FRIEND);
    assert.equal(g.body.memory.placeId, PLACE_R);
    assert.equal(g.body.memory.placeDisplayNameAtOccurrence, null);
  });

  it("flag OFF: the field is not served (absent, not null), to anyone", async () => {
    app = await start({ ...APPLIED_OFF, canon: CANON });
    for (const viewer of [OWNER, FRIEND]) {
      const g = await call(app, "GET", `/memories/${MEM_CAT}`, viewer);
      assert.equal("placeDisplayNameAtOccurrence" in g.body.memory, false);
    }
  });
});

describe("H71 × H-16/H-17: a non-owner never gets the name of a place the owner rejected", () => {
  const reject = (placeId: string, memoryId: string) => (s: Record<string, any[]>) => {
    s.memory_corrections.push({ id: "c-1", memory_id: memoryId, owner_id: OWNER, field: "place", kind: "reject", place_id: placeId, canonical_location_id: null, source: "correction_route", created_at: "2026-04-01T00:00:01.000Z" });
  };
  const assertPlace = (placeId: string, memoryId: string) => (s: Record<string, any[]>) => {
    s.memory_corrections.push({ id: "c-2", memory_id: memoryId, owner_id: OWNER, field: "place", kind: "assert", place_id: placeId, canonical_location_id: null, source: "correction_route", created_at: "2026-04-01T00:00:02.000Z" });
  };

  it("the owner rejects P: the viewer gets neither P's id nor 'Cafe A'; the owner's own detail keeps the stored row", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON, mutate: reject(PLACE_P, MEM_CAT) });
    const friend = await call(app, "GET", `/memories/${MEM_CAT}`, FRIEND);
    assert.equal(friend.status, 200, JSON.stringify(friend.body));
    assert.equal(friend.body.memory.placeId, null);
    assert.equal(friend.body.memory.placeDisplayNameAtOccurrence, null);
    assert.equal(JSON.stringify(friend.body).includes("Cafe A"), false, "the rejected place's name reached a non-owner");
    const owner = await call(app, "GET", `/memories/${MEM_CAT}`, OWNER);
    assert.equal(owner.body.memory.placeDisplayNameAtOccurrence, "Cafe A");
  });

  it("the owner rejects the merge SUCCESSOR Q: the reference reaching it is dropped whole (H-17), and the name with it", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON, mutate: reject(PLACE_Q, MEM_CAT) });
    const friend = await call(app, "GET", `/memories/${MEM_CAT}`, FRIEND);
    assert.equal(friend.body.memory.placeId, null);
    assert.equal(friend.body.memory.placeDisplayNameAtOccurrence, null);
  });

  it("the owner asserts another place: the viewer sees that place's id and NOT the old place's text", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON, mutate: assertPlace(PLACE_R, MEM_PICK) });
    const friend = await call(app, "GET", `/memories/${MEM_PICK}`, FRIEND);
    assert.equal(friend.body.memory.placeId, PLACE_R);
    assert.equal(friend.body.memory.placeDisplayNameAtOccurrence, null);
  });

  it("a precision rung below venue withholds the place id from a viewer, and the name with it", async () => {
    app = await start({ ...APPLIED_ON, precision: true, canon: CANON, mutate: (s) => { mem({ store: s } as any, MEM_PICK).location_precision = "city"; } });
    const friend = await call(app, "GET", `/memories/${MEM_PICK}`, FRIEND);
    assert.equal(friend.status, 200, JSON.stringify(friend.body));
    assert.equal(friend.body.memory.placeId, null);
    assert.equal(friend.body.memory.placeDisplayNameAtOccurrence, null);
    const owner = await call(app, "GET", `/memories/${MEM_PICK}`, OWNER);
    assert.equal(owner.body.memory.placeDisplayNameAtOccurrence, "Cafe A Pick");
  });

  it("control: with no correction and the exact rung the viewer gets the occurrence name", async () => {
    app = await start({ ...APPLIED_ON, precision: true, canon: CANON });
    const friend = await call(app, "GET", `/memories/${MEM_PICK}`, FRIEND);
    assert.equal(friend.body.memory.placeDisplayNameAtOccurrence, "Cafe A Pick");
  });
});

describe("H71: what a write records", () => {
  it("POST: a provider pick records the client's text; a catalog place records the catalog's name, never the client's", async () => {
    app = await start(APPLIED_ON);
    const pick = await call(app, "POST", "/memories", OWNER, { title: "a", placeId: "fsq:pho", placeDisplayNameAtOccurrence: "  Pho 10  " });
    assert.equal(mem(app, pick.body.memory.id).place_display_name_at_occurrence, "Pho 10");
    assert.equal(app.ops.find((o) => o.table === "memories" && o.mode === "insert")?.payload?.place_display_name_at_occurrence, "Pho 10", "the pick's text was not written by the create itself");
    assert.equal(pick.body.memory.placeDisplayNameAtOccurrence, "Pho 10");
    const cat = await call(app, "POST", "/memories", OWNER, { title: "b", placeId: PLACE_R, placeDisplayNameAtOccurrence: "Anything The Client Says" });
    const insert = app.ops.find((o) => o.table === "memories" && o.mode === "insert" && o.payload?.place_id === PLACE_R);
    assert.equal("place_display_name_at_occurrence" in (insert?.payload ?? {}), false, "the route named the client's text for a catalog place");
    assert.equal(mem(app, cat.body.memory.id).place_display_name_at_occurrence, "Ramen R");
  });

  it("PATCH keeping the same place never rewrites the recorded text (the edit screen re-sends the place)", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    const p = await call(app, "PATCH", `/memories/${MEM_PICK}`, OWNER, { title: "t2", placeId: "fsq:cafe-a", placeDisplayNameAtOccurrence: "Rewritten" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    const update = app.ops.find((o) => o.table === "memories" && o.mode === "update");
    assert.equal("place_display_name_at_occurrence" in (update?.payload ?? {}), false);
    assert.equal(mem(app, MEM_PICK).place_display_name_at_occurrence, "Cafe A Pick");
  });

  it("PATCH to a new provider pick records the new text; to a catalog place, the catalog's; clearing the place clears it", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    await call(app, "PATCH", `/memories/${MEM_PICK}`, OWNER, { placeId: "fsq:banh-mi", placeDisplayNameAtOccurrence: "Banh Mi 25" });
    assert.equal(mem(app, MEM_PICK).place_display_name_at_occurrence, "Banh Mi 25");
    await call(app, "PATCH", `/memories/${MEM_PICK}`, OWNER, { placeId: PLACE_R, placeDisplayNameAtOccurrence: "ignored" });
    assert.equal(mem(app, MEM_PICK).place_display_name_at_occurrence, "Ramen R");
    await call(app, "PATCH", `/memories/${MEM_PICK}`, OWNER, { placeId: null });
    assert.equal(mem(app, MEM_PICK).place_display_name_at_occurrence, null);
  });

  it("a legacy row's unrelated edit does not backfill its name", async () => {
    app = await start({ ...APPLIED_ON, canon: CANON });
    await call(app, "PATCH", `/memories/${MEM_LEGACY}`, OWNER, { caption: "later", placeId: PLACE_R, placeDisplayNameAtOccurrence: "Ramen R" });
    assert.equal(mem(app, MEM_LEGACY).place_display_name_at_occurrence, null);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("H40 §15: the type filter answers from the owner's derivative", () => {
  it("search mine with memoryType EPISODE returns only EPISODE Memories (a legacy null never matches)", async () => {
    app = await start({ ...APPLIED_ON, canon: { ...CANON, [MEM_CAT]: { memory_type: "EPISODE", place_display_name_at_occurrence: "Cafe A" } } });
    const s = await call(app, "POST", "/memories/search", OWNER, { intent: { kind: "mine" }, memoryType: "EPISODE" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.hits.map((h: any) => h.memoryId), [MEM_CAT]);
    assert.equal(s.body.hits[0].row.memory_type, "EPISODE");
    const none = await call(app, "POST", "/memories/search", OWNER, { intent: { kind: "mine" }, memoryType: "TRIP" });
    assert.deepEqual(none.body.hits, []);
  });
});

describe("H40/H71 in the registry (§18)", () => {
  const scope = { owner_id: OWNER, viewer_id: OWNER, place_id: null as string | null };
  it("flag OFF: the source read names neither column and the digest is byte-identical to the pre-3803 one", async () => {
    const w = { ...APPLIED_OFF, canon: CANON };
    const store = seed(w); const ops: Op[] = [];
    const d = await deriveProjection(makeClient(store, ops, w) as any, "MemoryTimelineProjection", scope);
    assert.ok(d.ok, JSON.stringify(d));
    assert.equal(ops.some((o) => o.table === "memories" && /memory_type|place_display_name/.test(o.cols ?? "")), false);
    const plain = store.memories.map(({ memory_type: _t, place_display_name_at_occurrence: _n, ...r }) => r) as MemorySourceRow[];
    assert.equal(d.value.source_version, sourceVersionOf(plain).digest);
  });

  it("flag ON: the timeline carries the type; turning the flag on makes a registration STALE by content", async () => {
    const w = { ...APPLIED_ON, canon: CANON };
    const store = seed(w);
    const flag = (name: string, enabled: boolean) => { store.feature_flags.find((f) => f.flag === name).enabled = enabled; };
    const on = await deriveProjection(makeClient(store, [], w) as any, "MemoryTimelineProjection", scope);
    flag("memory_type_enabled", false); // ONLY the type turns off: the registration built while it was ON is now STALE
    const typeOff = await deriveProjection(makeClient(store, [], w) as any, "MemoryTimelineProjection", scope);
    flag("memory_type_enabled", true); flag("memory_place_occurrence_name_enabled", false); // ONLY the name turns off
    const nameOff = await deriveProjection(makeClient(store, [], w) as any, "MemoryTimelineProjection", scope);
    assert.ok(on.ok && typeOff.ok && nameOff.ok);
    assert.equal(on.value.rows.find((r) => r.memory_id === MEM_PICK)?.memory_type, "REUNION");
    assert.equal(on.value.rows.find((r) => r.memory_id === MEM_LEGACY)?.memory_type, null);
    assert.notEqual(on.value.source_version, typeOff.value.source_version, "the type is not in the digest");
    assert.notEqual(on.value.source_version, nameOff.value.source_version, "the occurrence name is not in the digest");
  });

  it("the owner's Place derivative carries the occurrence name, and drops it when the owner's correction changed the reference", async () => {
    const w = { ...APPLIED_ON, canon: CANON };
    const store = seed(w);
    const atP = await deriveProjection(makeClient(store, [], w) as any, "PlaceMemoryProjection", { ...scope, place_id: PLACE_P });
    assert.ok(atP.ok, JSON.stringify(atP));
    assert.equal(atP.value.rows[0]?.place_display_name_at_occurrence, "Cafe A");
    store.memory_corrections.push({ id: "c-9", memory_id: MEM_PICK, owner_id: OWNER, field: "place", kind: "assert", place_id: PLACE_R, canonical_location_id: null, source: "correction_route", created_at: "2026-04-01T00:00:02.000Z" });
    const atR = await deriveProjection(makeClient(store, [], w) as any, "PlaceMemoryProjection", { ...scope, place_id: PLACE_R });
    assert.ok(atR.ok, JSON.stringify(atR));
    const moved = atR.value.rows.find((r) => r.memory_id === MEM_PICK);
    assert.ok(moved, "the asserted place does not list the Memory");
    assert.equal(moved!.place_display_name_at_occurrence, null, "the old pick's text travelled to the asserted place");
    assert.ok(getProjectionDefinition("PublicMemoryProjection")!.field_whitelist.every((f) => f !== "place_display_name_at_occurrence" && f !== "memory_type"), "a public derivative carries a new field");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("the rules, as functions (each branch pinned)", () => {
  const gates: CanonicalGate[] = ["on", "off", "absent", "unreadable"];
  it("columnWritable / fieldServed", () => {
    assert.deepEqual(gates.map(columnWritable), [true, true, false, false]);
    assert.deepEqual(gates.map(fieldServed), [true, false, false, false]);
  });
  it("ownerTypeChoiceRefusal: nothing chosen is never refused; on accepts; unreadable is retryable; off/absent are feature_disabled", () => {
    assert.deepEqual(gates.map((g) => ownerTypeChoiceRefusal(g, undefined)), [null, null, null, null]);
    assert.deepEqual(gates.map((g) => ownerTypeChoiceRefusal(g, "PLACE")?.code ?? null), [null, "feature_disabled", "feature_disabled", "degraded_unavailable"]);
  });
  it("occurrenceNameForWrite: only a provider pick, only where the column exists, trimmed and bounded", () => {
    assert.equal(occurrenceNameForWrite("on", "fsq:1", " A "), "A");
    assert.equal(occurrenceNameForWrite("off", "fsq:1", "A"), "A");
    assert.equal(occurrenceNameForWrite("absent", "fsq:1", "A"), undefined);
    assert.equal(occurrenceNameForWrite("unreadable", "fsq:1", "A"), undefined);
    assert.equal(occurrenceNameForWrite("on", PLACE_P, "A"), undefined);
    assert.equal(occurrenceNameForWrite("on", null, "A"), undefined);
    assert.equal(occurrenceNameForWrite("on", "fsq:1", "   "), undefined);
    assert.equal(occurrenceNameForWrite("on", "fsq:1", "x".repeat(250))!.length, 200);
  });
  it("occurrenceNameFor: owner always; a viewer only with the same non-empty stored reference and a matching read", () => {
    const stored = { owner_id: OWNER, place_id: "fsq:1", canonical_location_id: "c1" };
    const fields = { id: "m", place_id: "fsq:1", place_display_name_at_occurrence: "N" };
    assert.equal(occurrenceNameFor(OWNER, stored, { place_id: null, canonical_location_id: null }, fields), "N");
    assert.equal(occurrenceNameFor(FRIEND, stored, { place_id: "fsq:1", canonical_location_id: "c1" }, fields), "N");
    assert.equal(occurrenceNameFor(FRIEND, stored, { place_id: null, canonical_location_id: "c1" }, fields), null);
    assert.equal(occurrenceNameFor(FRIEND, stored, { place_id: "fsq:2", canonical_location_id: "c1" }, fields), null);
    assert.equal(occurrenceNameFor(FRIEND, stored, { place_id: "fsq:1", canonical_location_id: null }, fields), null);
    assert.equal(occurrenceNameFor(FRIEND, stored, { place_id: "fsq:1", canonical_location_id: "c1" }, { ...fields, place_id: "fsq:9" }), null);
    assert.equal(occurrenceNameFor(OWNER, stored, stored, { ...fields, place_id: "fsq:9" }), null);
    assert.equal(occurrenceNameFor(FRIEND, { ...stored, place_id: "" }, { place_id: "", canonical_location_id: "c1" }, { ...fields, place_id: "" }), null);
    assert.equal(occurrenceNameFor(FRIEND, stored, stored, undefined), null);
  });
  it("occurrenceNameKeptWithRef: unchanged reference keeps the name; any change drops it; rows without the key are untouched", () => {
    const s = { place_id: "p", canonical_location_id: "c", place_display_name_at_occurrence: "N" };
    assert.equal(occurrenceNameKeptWithRef(s, { ...s }).place_display_name_at_occurrence, "N");
    assert.equal(occurrenceNameKeptWithRef(s, { ...s, place_id: null }).place_display_name_at_occurrence, null);
    assert.equal(occurrenceNameKeptWithRef(s, { ...s, canonical_location_id: null }).place_display_name_at_occurrence, null);
    const bare = { place_id: "p", canonical_location_id: "c" };
    assert.equal("place_display_name_at_occurrence" in occurrenceNameKeptWithRef(bare, { ...bare, place_id: null }), false);
  });
});
