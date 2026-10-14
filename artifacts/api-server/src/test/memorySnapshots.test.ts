/**
 * Census-highlights-memories H35 — §3 `memory_snapshots`, versioned fact
 * snapshots for replay (migration 3811). B58 cluster MEM-SNAPSHOTS.
 *
 * Over the REAL routers (POST / PATCH / DELETE /memories, GET
 * /memories/:id/history, and the whole API router from routes/index.ts) and a
 * table-backed fake. The fake carries 3811's trigger and guard as the §25
 * harness models them (services/memoryCertification/snapshotReplay.ts
 * recordSnapshotInWorld / the guard); the SQL itself is executed by
 * src/test/db/memorySnapshots.db.test.ts on the full chain (CI's local-db job)
 * and rehearsed in sql/rehearsals/3811_01_memory_snapshots.sql.
 *
 *   S1  PATCH the place twice ⇒ versions 1..3 carrying the place history; a
 *       title / caption edit writes no version
 *   S2  DELETE runs §21 and ZERO versions remain (RAW_EVIDENCE_PURGED); the
 *       history then answers 404
 *   S3  property, over EVERY column the chain gives public.memories: only the
 *       whitelist ever appears in a snapshot, and no other column's value does;
 *       the SQL whitelist, extractor and cap equal this code's
 *   S4  the cap: 55 changes keep the newest 50
 *   S5  a non-owner (even one who may read the Memory) gets the 404 a missing
 *       Memory gets; a malformed id is 400
 *   S6  absent is not empty: 3811 unapplied ⇒ `not_deployed`; unreadable ⇒ 503;
 *       a Memory not written since ⇒ `none_recorded`; a stored non-fact is never served
 *   S7  §21 step 4 reports the purge, fails and dead-letters a failed or
 *       unconfirmed purge, and names 3811 when it is not deployed
 *   S8  the §25 replay: every scenario certifies, and a foreign row diverges
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memorySnapshots.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import memoryHistoryRouter from "../routes/memoryHistory.js";
import apiRouter from "../routes/index.js";
import {
  MEMORY_SNAPSHOT_BASE_COLUMNS,
  MEMORY_SNAPSHOT_CAP,
  MEMORY_SNAPSHOT_EXTRACTOR_VERSION,
  MEMORY_SNAPSHOT_FACT_KEYS,
  MEMORY_SNAPSHOT_LATER_COLUMNS,
  snapshotFactsOf,
  whitelistFacts,
} from "../services/memory/memorySnapshots.js";
import {
  SNAPSHOT_REPLAY_SCENARIO_IDS,
  recordSnapshotInWorld,
  replayMemoryFromSnapshots,
  runSnapshotReplayCertification,
  type SnapshotWorld,
} from "../services/memoryCertification/snapshotReplay.js";
import { runMemoryDeletionLifecycle, MAX_STEP_ATTEMPTS } from "../services/memory/memoryDeletionLifecycle.js";
import { buildCanonicalSchema } from "../scripts/lib/canonicalSchema.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API = resolve(__dir, "../..");
const MIGRATION = resolve(API, "src/migrations/3811_memory_snapshots.sql");

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEM_PUBLIC = "10000000-0000-4000-8000-0000000003b1"; // the owner's PUBLIC Memory: FRIEND may read the Memory itself
const MEM_LEGACY = "10000000-0000-4000-8000-0000000003b2"; // written before 3811: no version
const MISSING = "10000000-0000-4000-8000-0000000003ff";

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Coffee", caption: "TOP-SECRET-CAPTION", visibility: "public", state: "published",
    allowed_user_ids: [], hidden_user_ids: [], trip_id: null, event_id: null, place_id: "fsq:origin", canonical_location_id: null,
    location_city: "Hanoi", location_country: "Vietnam", location_lat: 21.0333, location_lng: 105.8501,
    starts_at: "2026-03-03T11:00:00.000Z", ends_at: null, location_precision: "exact", source_mode: "USER_CREATED",
    created_at: "2026-03-03T12:00:00.000Z", updated_at: "2026-03-03T12:00:00.000Z", ...over,
  };
}

interface World {
  snapshotsAbsent?: boolean;
  failSnapshotReads?: boolean;
  failSnapshotDeletes?: boolean;
  /** A purge that answers without error and deletes nothing. */
  silentSnapshotDeletes?: boolean;
  /** The trigger is off: a Memory write records nothing (a control). */
  triggerOff?: boolean;
}

interface Op { table: string; mode: string; payload?: any }
type Store = Record<string, any[]>;

/** 3811's trigger, as the §25 harness models it, over this fake's tables. */
function snapshotTrigger(store: Store, row: any, w: World): void {
  if (w.triggerOff || w.snapshotsAbsent) return;
  const world: SnapshotWorld = {
    memories: new Map((store.memories ?? []).map((m) => [m.id, m])),
    itemCounts: new Map([[row.id, (store.memory_items ?? []).filter((i) => i.memory_id === row.id).length]]),
    snapshots: store.memory_snapshots ?? [],
  };
  recordSnapshotInWorld(world, row, { at: `2026-10-14T00:00:${String((store.memory_snapshots ?? []).length % 60).padStart(2, "0")}.000Z` });
  store.memory_snapshots = world.snapshots;
}

function makeClient(store: Store, ops: Op[], w: World) {
  let idN = 0;
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    let payload: any = null; let wantRows = false; let single = false; let limitN: number | null = null; let selected: string[] | null = null;
    const orders: Array<[string, boolean]> = [];
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select(c?: string) { if (mode !== "select") wantRows = true; else if (typeof c === "string") selected = c.split(",").map((k) => k.trim()).filter((k) => k && !k.includes("(")); return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      upsert(d: any) { mode = "upsert"; payload = d; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f((r) => r[c] === v),
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      contains: (c: string, vs: any[]) => f((r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; }, not() { return obj; }, or() { return obj; }, range() { return obj; }, filter() { return obj; },
      order(c: string, o?: any) { orders.push([c, o?.ascending !== false]); return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      const clean = (r: any) => Object.fromEntries(Object.entries(r ?? {}).filter(([, v]) => v !== undefined));
      const body: any = Array.isArray(payload) ? payload.map(clean) : payload ? clean(payload) : null;
      ops.push({ table, mode, payload: body });
      if (table === "memory_snapshots") {
        if (w.snapshotsAbsent) return { data: null, error: { code: "42P01", message: 'relation "public.memory_snapshots" does not exist' } };
        if (mode === "select" && w.failSnapshotReads) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        if (mode === "delete" && w.failSnapshotDeletes) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        if (mode === "insert" || mode === "upsert" || mode === "update") return { data: null, error: { code: "42501", message: "permission denied for table memory_snapshots" } }; // service_role: SELECT, DELETE only
      }
      const all = (store[table] ??= []);
      if (mode === "upsert" || mode === "insert") {
        const written: any[] = [];
        for (const r of (Array.isArray(body) ? body : [body])) {
          const row: any = { id: r.id ?? `30000000-0000-4000-8000-${String(++idN).padStart(12, "0")}`, created_at: "2026-10-14T00:00:00.000Z", updated_at: "2026-10-14T00:00:00.000Z", ...r };
          if (table === "memories") Object.assign(row, { location_precision: row.location_precision ?? "exact", source_mode: row.source_mode ?? "USER_CREATED", state: row.state ?? "published", visibility: row.visibility ?? "friends_only", allowed_user_ids: row.allowed_user_ids ?? [], hidden_user_ids: row.hidden_user_ids ?? [] });
          all.push(row); written.push(row);
          if (table === "memories") snapshotTrigger(store, row, w);
        }
        if (single) return { data: written[0] ? { ...written[0] } : null, error: null };
        return { data: wantRows ? written.map((x) => ({ ...x })) : null, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") {
        for (const r of matched) { Object.assign(r, body); if (table === "memories") snapshotTrigger(store, r, w); }
        if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
        return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null };
      }
      if (mode === "delete") {
        if (table === "memory_snapshots") {
          if (w.silentSnapshotDeletes) return { data: [], error: null };
          // 3811's guard: a live Memory's version goes only by the cap; the statement fails whole.
          const live = matched.some((s) => { const m = (store.memories ?? []).find((x) => x.id === s.memory_id); return m && m.state !== "deleted"; });
          if (live) return { data: null, error: { code: "42501", message: "memory_snapshots: a version of a live Memory is deleted only by the cap, by the §21 erasure of the deleted Memory, or with its account (3811)" } };
        }
        store[table] = all.filter((r) => !matched.includes(r));
        return { data: wantRows ? matched.map((x) => ({ version: x.version, id: x.id })) : null, error: null };
      }
      if (orders.length > 0) matched = [...matched].sort((x, y) => { for (const [c, asc] of orders) { const d = String(x[c] ?? "").localeCompare(String(y[c] ?? "")); if (d !== 0) return asc ? d : -d; } return 0; });
      if (limitN != null) matched = matched.slice(0, limitN);
      const project = (x: any) => (selected && selected.length > 0 && !selected.includes("*") ? Object.fromEntries(selected.filter((k) => k in x).map((k) => [k, x[k]])) : { ...x });
      if (single) return { data: matched[0] ? project(matched[0]) : null, error: null };
      return { data: matched.map(project), error: null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async (fn: string) => ({ data: null, error: { code: "PGRST202", message: `${fn} not modelled` } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

function seed(): Store {
  return {
    feature_flags: [],
    memories: [memory(MEM_PUBLIC), memory(MEM_LEGACY, { visibility: "only_me" })],
    memory_items: [{ id: "item-1", memory_id: MEM_PUBLIC, media_url: "post-media/x.jpg", media_type: "image/jpeg", caption: "ITEM-CAPTION", position: 0, created_at: "2026-03-03T12:00:00.000Z" }],
    memory_snapshots: [],
    profiles: [{ id: OWNER, name: "Owner", handle: "owner", avatar_url: null }, { id: FRIEND, name: "Friend", handle: "friend", avatar_url: null }],
    user_follows: [{ follower_id: FRIEND, following_id: OWNER }], blocks: [], memory_tags: [], memory_likes: [], memory_saves: [], trips: [], trip_members: [],
    circle_memberships: [], memory_corrections: [], memory_derivative_registry: [], memory_deletion_dead_letters: [],
  };
}

interface App { base: string; store: Store; ops: Op[]; logs: Array<{ obj: any; msg: string }>; close: () => Promise<void> }
async function start(w: World = {}, opts: { full?: boolean; mutate?: (s: Store) => void } = {}): Promise<App> {
  const store = seed();
  opts.mutate?.(store);
  const ops: Op[] = [];
  const logs: Array<{ obj: any; msg: string }> = [];
  _setTestClient(makeClient(store, ops, w) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    const log = (obj: any, msg: string) => logs.push({ obj, msg });
    req.log = { error: log, info: log, warn: log, debug: () => {}, child: () => req.log };
    n();
  });
  if (opts.full) app.use("/api", apiRouter);
  else { app.use("/api", memoryHistoryRouter); app.use("/api", memoriesRouter); }
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, ops, logs, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
let keyN = 0;
async function call(a: App, method: string, p: string, actor = OWNER, body?: unknown) {
  const res = await fetch(`${a.base}/api${p}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", "Idempotency-Key": `snap-${++keyN}`, connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const snaps = (a: App, id: string) => a.store.memory_snapshots!.filter((s) => s.memory_id === id).sort((x, y) => x.version - y.version);

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

// ════════════════════════════════════════════════════════════════════════════
describe("H35 S1: a Memory's place, changed twice, is three versions of fact history", () => {
  it("POST, PATCH place, PATCH place ⇒ GET /memories/:id/history answers versions 1..3 with the place history", async () => {
    app = await start();
    const c = await call(app, "POST", "/memories", OWNER, { title: "Pho", caption: "TOP-SECRET-CAPTION", placeId: "fsq:pho-10", visibility: "only_me" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const id = c.body.memory.id as string;
    assert.equal((await call(app, "PATCH", `/memories/${id}`, OWNER, { placeId: "fsq:bun-cha-34" })).status, 200);
    assert.equal((await call(app, "PATCH", `/memories/${id}`, OWNER, { placeId: "fsq:cafe-giang" })).status, 200);
    const h = await call(app, "GET", `/memories/${id}/history`);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal(h.body.memoryId, id);
    assert.equal(h.body.history.state, "recorded");
    assert.deepEqual(h.body.history.versions.map((v: any) => v.version), [1, 2, 3]);
    assert.deepEqual(h.body.history.versions.map((v: any) => v.facts.place_id), ["fsq:pho-10", "fsq:bun-cha-34", "fsq:cafe-giang"]);
    assert.deepEqual(h.body.history.versions[1].changed, ["place_id"]);
    assert.deepEqual(h.body.history.versions[2].changed, ["place_id"]);
    assert.equal(h.body.history.versions[0].facts.visibility, "only_me");
    assert.deepEqual(h.body.history.versions[0].engineVersions, { snapshot: MEMORY_SNAPSHOT_EXTRACTOR_VERSION });
    assert.equal(h.body.history.cap, MEMORY_SNAPSHOT_CAP);
    assert.equal(h.body.history.prunedBefore, null);
  });

  it("a title or caption edit is not a fact: no version is written, and no version carries the text", async () => {
    app = await start();
    const c = await call(app, "POST", "/memories", OWNER, { title: "Pho", placeId: "fsq:pho-10" });
    const id = c.body.memory.id as string;
    assert.equal((await call(app, "PATCH", `/memories/${id}`, OWNER, { title: "TITLE-EDIT", caption: "CAPTION-EDIT" })).status, 200);
    const h = await call(app, "GET", `/memories/${id}/history`);
    assert.deepEqual(h.body.history.versions.map((v: any) => v.version), [1]);
    assert.doesNotMatch(JSON.stringify(h.body), /TITLE-EDIT|CAPTION-EDIT|Pho"/);
  });

  it("the route answers through the REAL API router (routes/index.ts's mount)", async () => {
    app = await start({}, { full: true, mutate: (s) => { s.memory_snapshots = [{ memory_id: MEM_PUBLIC, owner_id: OWNER, version: 1, facts: { state: "published", place_id: "fsq:origin", item_count: 1 }, engine_versions: { snapshot: MEMORY_SNAPSHOT_EXTRACTOR_VERSION }, cause: {}, created_at: "2026-10-14T00:00:00.000Z" }]; } });
    const h = await call(app, "GET", `/memories/${MEM_PUBLIC}/history`);
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.deepEqual(h.body.history.versions.map((v: any) => v.facts.place_id), ["fsq:origin"]);
  });
});

describe("H35 S2: §21 deletion leaves no version behind", () => {
  it("DELETE /memories/:id ⇒ RAW_EVIDENCE_PURGED purges every version, zero remain, and the history is a 404", async () => {
    app = await start();
    const c = await call(app, "POST", "/memories", OWNER, { title: "Pho", placeId: "fsq:a" });
    const id = c.body.memory.id as string;
    await call(app, "PATCH", `/memories/${id}`, OWNER, { placeId: "fsq:b" });
    await call(app, "PATCH", `/memories/${id}`, OWNER, { placeId: "fsq:c" });
    assert.equal(snaps(app, id).length, 3, "anti-vacuity: three versions before the delete");
    assert.equal((await call(app, "DELETE", `/memories/${id}`)).status, 204);
    assert.equal(snaps(app, id).length, 0, "a version outlived the §21 lifecycle");
    const report = app.logs.filter((l) => l.msg === "memories: §21 deletion lifecycle").at(-1)?.obj.report;
    const step4 = report.steps.find((s: any) => s.step === "RAW_EVIDENCE_PURGED");
    assert.equal(step4.outcome, "done", JSON.stringify(step4));
    assert.equal(step4.facts.snapshotsPurged, 3);
    assert.equal((await call(app, "GET", `/memories/${id}/history`)).status, 404);
  });

  it("the soft delete itself writes no version (a deleted Memory accrues no history)", async () => {
    app = await start({ failSnapshotDeletes: true });
    const c = await call(app, "POST", "/memories", OWNER, { title: "Pho", placeId: "fsq:a" });
    const id = c.body.memory.id as string;
    assert.equal((await call(app, "DELETE", `/memories/${id}`)).status, 204);
    assert.deepEqual(snaps(app, id).map((s) => s.facts.state), ["published"], "the purge failed here, and still no 'deleted' version was written");
  });
});

describe("H35 S3: facts only — a property over every column of public.memories", () => {
  const schema = buildCanonicalSchema(resolve(API, "baseline/20260819_baseline_structure.sql"), [resolve(API, "migrations"), resolve(API, "src/migrations")]);
  const columns = [...(schema.columns.get("memories") ?? [])];

  it("anti-vacuity: the chain's memories columns include every fact column and every forbidden one", () => {
    for (const c of [...MEMORY_SNAPSHOT_BASE_COLUMNS, ...MEMORY_SNAPSHOT_LATER_COLUMNS, "title", "caption", "location_lat", "location_lng", "location_city", "location_country", "allowed_user_ids", "hidden_user_ids"]) {
      assert.ok(columns.includes(c), `canonical memories lacks ${c}: ${columns.join(", ")}`);
    }
  });

  it("only whitelisted keys ever appear, and no non-fact column's value leaks into any of them", () => {
    const marker = (c: string) => `MARK-${c}-${c.length}`;
    const row = Object.fromEntries(columns.map((c) => [c, marker(c)]));
    const facts = snapshotFactsOf(row, 7);
    for (const k of Object.keys(facts)) assert.ok(MEMORY_SNAPSHOT_FACT_KEYS.includes(k), `non-whitelisted key ${k}`);
    const json = JSON.stringify(facts);
    for (const c of columns.filter((x) => !MEMORY_SNAPSHOT_FACT_KEYS.includes(x))) assert.ok(!json.includes(marker(c)), `${c}'s value leaked into a snapshot: ${json}`);
    for (const forbidden of ["title", "caption", "lat", "lng", "location_city", "location_country", "allowed_user_ids", "hidden_user_ids"]) {
      assert.doesNotMatch(Object.keys(facts).join(","), new RegExp(`(^|,)${forbidden}(,|$)`));
    }
    // and each column ALONE: a row carrying one column at a time puts nothing of it in a non-fact key
    for (const c of columns) {
      const f = snapshotFactsOf({ [c]: marker(c) }, 0);
      if (!MEMORY_SNAPSHOT_FACT_KEYS.includes(c)) assert.ok(!JSON.stringify(f).includes(marker(c)), `${c} alone leaked`);
    }
  });

  it("the SQL holds the same whitelist (CHECK and trigger), extractor and cap as this code, and names no free text or coordinate", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const check = /memory_snapshots_facts_whitelist CHECK \(\s*jsonb_typeof\(facts\) = 'object'\s*AND \(facts - ARRAY\[([^\]]+)\]\)/.exec(sql);
    assert.ok(check, "the whitelist CHECK is not found");
    const list = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    assert.deepEqual(list, [...MEMORY_SNAPSHOT_FACT_KEYS].sort());
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.memory_snapshot_record()"), sql.indexOf("REVOKE ALL ON FUNCTION public.memory_snapshot_record()"));
    const written = [...body.matchAll(/'([a-z_]+)', (?:NEW\.|\(SELECT|to_char|v_row)/g)].map((m) => m[1]!).sort();
    assert.deepEqual(written, [...MEMORY_SNAPSHOT_FACT_KEYS].sort(), "the trigger writes exactly the whitelisted keys");
    for (const c of MEMORY_SNAPSHOT_LATER_COLUMNS) assert.match(body, new RegExp(`IF v_row \\? '${c}' THEN`), `${c} is written only where it exists`);
    assert.match(body, new RegExp(`'snapshot', '${MEMORY_SNAPSHOT_EXTRACTOR_VERSION}'`));
    assert.match(body, new RegExp(`version <= v_version - ${MEMORY_SNAPSHOT_CAP};`));
    assert.doesNotMatch(body, /NEW\.(title|caption|location_lat|location_lng|location_city|location_country|allowed_user_ids|hidden_user_ids)/);
  });

  it("a stored non-fact is never SERVED (the API's own whitelist), even where the CHECK was dropped", async () => {
    app = await start({}, { mutate: (s) => { s.memory_snapshots = [{ memory_id: MEM_PUBLIC, owner_id: OWNER, version: 1, facts: { state: "published", caption: "TOP-SECRET-CAPTION", location_lat: 21.0333 }, engine_versions: { snapshot: MEMORY_SNAPSHOT_EXTRACTOR_VERSION }, cause: { command_id: "a0000000-0000-4000-8000-0000000000c1", note: "free text" }, created_at: "2026-10-14T00:00:00.000Z" }]; } });
    const h = await call(app, "GET", `/memories/${MEM_PUBLIC}/history`);
    assert.equal(h.status, 200);
    assert.deepEqual(h.body.history.versions[0].facts, { state: "published" });
    assert.deepEqual(h.body.history.versions[0].cause, { commandId: "a0000000-0000-4000-8000-0000000000c1" });
    assert.doesNotMatch(JSON.stringify(h.body), /TOP-SECRET|21\.0333|free text/);
    assert.deepEqual(whitelistFacts({ state: "x", title: "y", item_count: 2, place_id: { nested: true } }), { facts: { state: "x", item_count: 2 }, dropped: ["place_id", "title"] });
  });
});

describe("H35 S4: the cap keeps the newest 50", () => {
  it("55 place changes ⇒ versions 7..56, the newest is the Memory as it is", async () => {
    app = await start();
    const c = await call(app, "POST", "/memories", OWNER, { title: "busy", placeId: "fsq:p0" });
    const id = c.body.memory.id as string;
    for (let i = 1; i <= 55; i++) assert.equal((await call(app, "PATCH", `/memories/${id}`, OWNER, { placeId: `fsq:p${i}` })).status, 200);
    const h = await call(app, "GET", `/memories/${id}/history`);
    const vs = h.body.history.versions.map((v: any) => v.version);
    assert.equal(vs.length, 50);
    assert.equal(vs[0], 7);
    assert.equal(vs[49], 56);
    assert.equal(h.body.history.prunedBefore, 7);
    assert.equal(h.body.history.versions[49].facts.place_id, "fsq:p55");
  });
});

describe("H35 S5: owner only, with no existence oracle", () => {
  it("a non-owner — even one who may read the PUBLIC Memory itself — gets exactly the 404 a missing Memory gets", async () => {
    app = await start({}, { mutate: (s) => { s.memory_snapshots = [{ memory_id: MEM_PUBLIC, owner_id: OWNER, version: 1, facts: { state: "published", place_id: "fsq:origin", item_count: 1 }, engine_versions: { snapshot: MEMORY_SNAPSHOT_EXTRACTOR_VERSION }, cause: {}, created_at: "2026-10-14T00:00:00.000Z" }]; } });
    assert.equal((await call(app, "GET", `/memories/${MEM_PUBLIC}`, FRIEND)).status, 200, "anti-vacuity: the friend may read the Memory");
    const foreign = await call(app, "GET", `/memories/${MEM_PUBLIC}/history`, FRIEND);
    const missing = await call(app, "GET", `/memories/${MISSING}/history`, FRIEND);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error, "not_found");
    assert.deepEqual(foreign.body, missing.body, "the answer must not tell a foreign Memory from a missing one");
    const own = await call(app, "GET", `/memories/${MEM_PUBLIC}/history`, OWNER);
    assert.equal(own.status, 200);
  });

  it("a non-owner's request reads the Memory once and never reaches memory_snapshots", async () => {
    app = await start();
    await call(app, "GET", `/memories/${MEM_PUBLIC}/history`, FRIEND);
    assert.deepEqual(app.ops.filter((o) => o.table === "memory_snapshots"), []);
  });

  it("a malformed id is 400, as GET /memories/:id; the owner's DELETED Memory is a 404", async () => {
    app = await start({}, { mutate: (s) => { s.memories!.find((m) => m.id === MEM_LEGACY)!.state = "deleted"; } });
    assert.equal((await call(app, "GET", "/memories/not-a-uuid/history")).status, 400);
    assert.equal((await call(app, "GET", `/memories/${MEM_LEGACY}/history`)).status, 404);
  });
});

describe("H35 S6: absent is not empty", () => {
  it("3811 unapplied ⇒ 200 `not_deployed` with no versions — never `recorded`", async () => {
    app = await start({ snapshotsAbsent: true });
    const h = await call(app, "GET", `/memories/${MEM_PUBLIC}/history`);
    assert.equal(h.status, 200);
    assert.equal(h.body.history.state, "not_deployed");
    assert.deepEqual(h.body.history.versions, []);
  });
  it("an unreadable history is a 503, never an empty one", async () => {
    app = await start({ failSnapshotReads: true });
    const h = await call(app, "GET", `/memories/${MEM_PUBLIC}/history`);
    assert.equal(h.status, 503);
    assert.equal(h.body.error, "degraded_unavailable");
  });
  it("a Memory not written since 3811 (no backfill, Q-H35) is `none_recorded`", async () => {
    app = await start();
    const h = await call(app, "GET", `/memories/${MEM_LEGACY}/history`);
    assert.equal(h.status, 200);
    assert.equal(h.body.history.state, "none_recorded");
  });
  it("an unreadable Memory is a 503, never a 404", async () => {
    app = await start();
    _setTestClient({ ...makeClient(app.store, app.ops, {}), from: (t: string) => (t === "memories" ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "57014", message: "timeout" } }) }) }) } : makeClient(app.store, app.ops, {}).from(t)) } as any, true);
    assert.equal((await call(app, "GET", `/memories/${MEM_PUBLIC}/history`)).status, 503);
  });
});

describe("H35 S7: §21 RAW_EVIDENCE_PURGED carries the snapshot purge", () => {
  const deletedState = () => { const s = seed(); s.memories![0]!.state = "deleted"; s.memory_snapshots = [1, 2].map((v) => ({ memory_id: MEM_PUBLIC, owner_id: OWNER, version: v, facts: { state: "published" }, engine_versions: { snapshot: MEMORY_SNAPSHOT_EXTRACTOR_VERSION }, cause: {}, created_at: "2026-10-14T00:00:00.000Z" })); return s; };
  const run = (sc: any) => runMemoryDeletionLifecycle(sc, { memoryId: MEM_PUBLIC, ownerId: OWNER, actorUserId: OWNER, previous: { visibility: "public", state: "published" } as any, now: new Date("2026-10-14T00:00:00.000Z") });

  it("done: the versions are purged and counted", async () => {
    const s = deletedState();
    const report = await run(makeClient(s, [], {}));
    const step = report.steps.find((x) => x.step === "RAW_EVIDENCE_PURGED")!;
    assert.equal(step.outcome, "done");
    assert.equal(step.facts.snapshotsPurged, 2);
    assert.equal(s.memory_snapshots!.length, 0);
  });
  it("a failing purge is retried to the cap, fails the step and is named in the dead letter", async () => {
    const s = deletedState();
    const report = await run(makeClient(s, [], { failSnapshotDeletes: true }));
    const step = report.steps.find((x) => x.step === "RAW_EVIDENCE_PURGED")!;
    assert.equal(step.outcome, "failed");
    assert.equal(step.attempts, MAX_STEP_ATTEMPTS);
    assert.match(step.detail, /memory_snapshots purge/);
    assert.equal(step.facts.snapshotsFailed, true);
    assert.equal(report.completed, false);
  });
  it("a purge that answers cleanly and leaves a version is a failure, not a success", async () => {
    const s = deletedState();
    const report = await run(makeClient(s, [], { silentSnapshotDeletes: true }));
    const step = report.steps.find((x) => x.step === "RAW_EVIDENCE_PURGED")!;
    assert.equal(step.outcome, "failed");
    assert.match(step.detail, /memory_snapshots purge unconfirmed/);
  });
  it("3811 not deployed: named in notDeployed, and never `done` with a purge that did not happen", async () => {
    const s = deletedState();
    const report = await run(makeClient(s, [], { snapshotsAbsent: true }));
    const step = report.steps.find((x) => x.step === "RAW_EVIDENCE_PURGED")!;
    assert.ok((step.facts.notDeployed as string[]).includes("memory_snapshots"), JSON.stringify(step.facts));
    assert.equal(step.facts.snapshotsPurged, 0);
  });
});

describe("H35 S8: the §25 replay from snapshots", () => {
  it("every certification scenario certifies, the four controls included", async () => {
    const out = await runSnapshotReplayCertification();
    assert.deepEqual(out.map((o) => o.id), [...SNAPSHOT_REPLAY_SCENARIO_IDS]);
    assert.deepEqual(out.filter((o) => o.status !== "CERTIFIED").map((o) => `${o.id}: ${o.divergences.join(" | ")}`), []);
    assert.deepEqual(out.filter((o) => o.id.startsWith("CONTROL_")).map((o) => o.replay.status), ["DIVERGED", "DIVERGED", "DIVERGED", "DIVERGED"]);
  });
  it("replays what the routes wrote, and a version of another owner diverges", async () => {
    app = await start();
    const c = await call(app, "POST", "/memories", OWNER, { title: "Pho", placeId: "fsq:a" });
    const id = c.body.memory.id as string;
    await call(app, "PATCH", `/memories/${id}`, OWNER, { placeId: "fsq:b" });
    const sc = makeClient(app.store, [], {});
    const row = app.store.memories!.find((m) => m.id === id);
    const ok = await replayMemoryFromSnapshots(sc, { memoryId: id, ownerId: OWNER, canonical: { row, itemCount: 0 } });
    assert.equal(ok.status, "REPLAYED", ok.detail);
    assert.deepEqual(ok.timeline.map((t) => t.changed), [[...Object.keys(snapshotFactsOf(row, 0))].sort(), ["place_id"]]);
    app.store.memory_snapshots!.push({ ...snaps(app, id).at(-1), version: 3, owner_id: FRIEND, facts: { ...snaps(app, id).at(-1).facts, visibility: "public" } });
    const bad = await replayMemoryFromSnapshots(sc, { memoryId: id, ownerId: OWNER });
    assert.equal(bad.status, "DIVERGED");
    assert.match(bad.detail, /version 3 belongs to/);
  });
});
