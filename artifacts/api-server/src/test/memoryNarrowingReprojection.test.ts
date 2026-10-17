/**
 * §21 "Make private: revoke public derivatives and public indexing, retain the
 * Memory" — on the §18 registry (2730, applied). Census H189 and H114.
 *
 * Before: only DELETE reached memory_derivative_registry. A visibility PATCH
 * left every registered derivative carrying the Memory its audience had lost.
 * Now: PATCH /memories/:id re-derives every ACTIVE registration carrying the
 * Memory from the committed audience — the public derivative no longer carries
 * it, the owner's timeline still does — and revokes (empties) what cannot be
 * re-derived.
 *
 * Every assertion is on the STORE, after the real memories router ran.
 * Run: node --import tsx/esm --test src/test/memoryNarrowingReprojection.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import { rebuildProjection, DERIVATIVE_REGISTRY_TABLE } from "../services/memoryProjections/derivativeRegistry.js";
import { parseScopeKey, reprojectDerivativesAfterNarrowing } from "../services/memoryProjections/narrowingReprojection.js";
import { scopeKeyOf } from "../services/memoryProjections/projectionRegistry.js";
import { DELETION_REVOCATION_REASON, REGISTRY_PAGE } from "../services/memoryProjections/narrowingReprojection.js"; import { crewMemberTarget } from "../services/memory/memorySearchService.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-07T12:00:00.000Z");

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: `t-${id.slice(0, 4)}`, caption: null, visibility: "public", state: "published",
    trip_id: null, event_id: null, place_id: null, starts_at: "2026-03-02T19:00:00.000Z", ends_at: null,
    created_at: "2026-03-02T22:00:00.000Z", updated_at: "2026-03-02T22:00:00.000Z",
    location_city: "Lisbon", location_country: "Portugal", location_lat: null, location_lng: null,
    canonical_location_id: null, allowed_user_ids: [], hidden_user_ids: [], ...over,
  };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [], memories: [memory(M), memory(M2, { starts_at: "2026-03-01T10:00:00.000Z" })],
    memory_items: [], memory_tags: [], [DERIVATIVE_REGISTRY_TABLE]: [],
  };
}

interface FakeOpts { failWrites?: Set<string>; failReads?: Set<string> }
let gen = 0;

function makeClient(store: Record<string, any[]>, opts: FakeOpts = {}) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = []; let countExact = false;
    let mode: "select" | "upsert" | "update" | "insert" | "delete" = "select";
    let payload: any = null; let onConflict: string[] = []; let wantRows = false; let single = false;
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select(_columns?: string, options?: { count?: string }) { countExact = options?.count === "exact"; if (mode !== "select") wantRows = true; return obj; },
      upsert(d: any, o?: { onConflict?: string }) { mode = "upsert"; payload = d; onConflict = (o?.onConflict ?? "").split(",").filter(Boolean); return obj; },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f((r) => r[c] === v),
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      contains: (c: string, vs: any[]) => f((r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))),
      gte() { return obj; }, lte() { return obj; }, gt() { return obj; }, lt() { return obj; },
      not() { return obj; }, or() { return obj; }, order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      if (mode !== "select" && opts.failWrites?.has(`${table}:${mode}`)) return { data: null, error: { message: `${table} ${mode} failed`, code: "57014" } }; if (mode === "select" && opts.failReads?.has(table)) return { data: null, error: { message: `${table} read failed`, code: "57014" } };
      const all = (store[table] ??= []);
      if (mode === "upsert" || mode === "insert") {
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const idx = onConflict.length ? all.findIndex((x) => onConflict.every((k) => x[k] === r[k])) : -1;
          if (idx >= 0) { all[idx] = { ...all[idx], ...r }; written.push(all[idx]); }
          else { const row = { id: r.id ?? `reg-${++gen}`, ...r }; all.push(row); written.push(row); }
        }
        return { data: wantRows ? written.map((x) => ({ ...x })) : null, error: null };
      }
      const matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null }; }
      if (mode === "delete") { store[table] = all.filter((r) => !matched.includes(r)); return { data: wantRows ? matched : null, error: null }; }
      if (single) return { data: matched[0] ? { ...matched[0] } : null, error: null };
      return { data: matched.map((row, index) => table === "memory_items" ? { ...row, id: row.id ?? `fixture-item-${index}` } : { ...row }), error: null, count: countExact ? matched.length : null };
    }
    return obj;
  }
  return {
    from: (t: string) => chain(t),
    rpc: async () => ({ data: null, error: { message: "rpc not modelled", code: "PGRST202" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

const PUBLIC_SCOPE = { owner_id: OWNER, viewer_id: null, trip_id: null, place_id: null, person_id: null };
const OWNER_SCOPE = { owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: null, person_id: null };
const reg = (store: Record<string, any[]>, projection: "PublicMemoryProjection" | "MemoryTimelineProjection", scope: any) =>
  store[DERIVATIVE_REGISTRY_TABLE].find((r) => r.scope_key === scopeKeyOf(projection, scope));
const carries = (row: any, id: string) => (row.source_memory_ids ?? []).includes(id) || (row.payload_json ?? []).some((p: any) => p.memory_id === id);

async function registerBoth(store: Record<string, any[]>) {
  const client = makeClient(store) as any;
  assert.ok((await rebuildProjection(client, "PublicMemoryProjection", PUBLIC_SCOPE, NOW)).ok);
  assert.ok((await rebuildProjection(client, "MemoryTimelineProjection", OWNER_SCOPE, NOW)).ok);
  assert.ok(carries(reg(store, "PublicMemoryProjection", PUBLIC_SCOPE), M), "precondition: the public derivative carries M");
  assert.ok(carries(reg(store, "MemoryTimelineProjection", OWNER_SCOPE), M), "precondition: the owner's timeline carries M");
}

interface App { base: string; store: Record<string, any[]>; logs: Array<{ obj: any; msg: string }>; close: () => Promise<void> }
async function start(store: Record<string, any[]>, opts: FakeOpts = {}): Promise<App> {
  _setTestClient(makeClient(store, opts) as any, true);
  const logs: App["logs"] = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { const push = (obj: any, msg: string) => logs.push({ obj, msg }); req.log = { error: push, info: push, warn: push }; n(); });
  app.use("/api", memoriesRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, store, logs, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
let keyN = 0;
async function patch(app: App, id: string, body: unknown) {
  const res = await fetch(`${app.base}/api/memories/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json", "Idempotency-Key": `n-${++keyN}`, connection: "close" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

let app: App | null = null;
afterEach(async () => { if (app) { await app.close(); app = null; } });

describe("PATCH /memories/:id — make private re-derives the registry's derivatives (H189, H114)", () => {
  it("public → only_me: the public derivative no longer carries the Memory; the owner's timeline still does; the Memory is retained", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store);
    const r = await patch(app, M, { visibility: "only_me" });
    assert.equal(r.status, 200, r.body);

    const pub = reg(store, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.equal(pub.revocation_state, "ACTIVE", "re-derived, not killed: the owner's other public Memories stay searchable");
    assert.equal(carries(pub, M), false, "the public derivative no longer carries the now-private Memory");
    assert.equal(carries(pub, M2), true, "and still carries the Memory that is still public");
    const mine = reg(store, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.deepEqual([mine.revocation_state, carries(mine, M)], ["ACTIVE", true], "the owner keeps the Memory in their own timeline");
    const row = store.memories.find((x) => x.id === M);
    assert.deepEqual([row.state, row.visibility], ["published", "only_me"], "the Memory itself is retained");
  });

  it("a caption edit does not touch the registry", async () => {
    const store = seed();
    await registerBoth(store);
    const before = JSON.stringify(store[DERIVATIVE_REGISTRY_TABLE]);
    app = await start(store);
    assert.equal((await patch(app, M, { caption: "new words" })).status, 200);
    assert.equal(JSON.stringify(store[DERIVATIVE_REGISTRY_TABLE]), before);
  });

  it("FAIL CLOSED: a derivative that cannot be re-derived is revoked and emptied, and the failure is not hidden", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store, { failWrites: new Set([`${DERIVATIVE_REGISTRY_TABLE}:upsert`]) });
    assert.equal((await patch(app, M, { visibility: "only_me" })).status, 200, "the owner's privacy decision itself is not undone");
    const pub = reg(store, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.equal(pub.revocation_state, "REVOKED");
    assert.deepEqual([pub.payload_json, pub.row_count], [[], 0], "no row of the now-private Memory survives at rest");
    assert.ok(app.logs.some((l) => /could not all be re-derived/.test(l.msg)), "an operator is told");
  });

  it("widening (only_me → public): the registration that carries the Memory is re-derived in place; one that does not is left for its next read", async () => {
    const store = seed();
    store.memories[0].visibility = "only_me";
    const client = makeClient(store) as any;
    assert.ok((await rebuildProjection(client, "MemoryTimelineProjection", OWNER_SCOPE, NOW)).ok);
    assert.ok((await rebuildProjection(client, "PublicMemoryProjection", PUBLIC_SCOPE, NOW)).ok);
    assert.equal(carries(reg(store, "PublicMemoryProjection", PUBLIC_SCOPE), M), false);
    const publicBefore = JSON.stringify(reg(store, "PublicMemoryProjection", PUBLIC_SCOPE));
    const timelineGeneratedBefore = reg(store, "MemoryTimelineProjection", OWNER_SCOPE).generated_at;
    app = await start(store);
    assert.equal((await patch(app, M, { visibility: "public" })).status, 200);
    // The public registration did not carry M, so M's change does not reach it here: the
    // next search finds it STALE and rebuilds it with M. Widening never exposes early.
    assert.equal(JSON.stringify(reg(store, "PublicMemoryProjection", PUBLIC_SCOPE)), publicBefore);
    const mine = reg(store, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.deepEqual([mine.revocation_state, carries(mine, M)], ["ACTIVE", true]);
    assert.notEqual(mine.generated_at, timelineGeneratedBefore, "the registration carrying M was re-derived from the committed audience");
  });
});

describe("reprojectDerivativesAfterNarrowing — the parts the route does not show", () => {
  it("a scope key it cannot parse is revoked rather than left carrying the Memory", async () => {
    const store = seed();
    store[DERIVATIVE_REGISTRY_TABLE].push({ id: "odd", scope_key: "NoSuchProjection|owner:x", source_memory_ids: [M], revocation_state: "ACTIVE", payload_json: [{ memory_id: M }], row_count: 1 });
    const out = await reprojectDerivativesAfterNarrowing(makeClient(store) as any, { memoryId: M, now: NOW, reason: "memory_visibility_changed" });
    assert.deepEqual([out.carried, out.revokedInstead, out.ok], [1, 1, true]);
    const odd = store[DERIVATIVE_REGISTRY_TABLE].find((r) => r.id === "odd");
    assert.deepEqual([odd.revocation_state, odd.payload_json], ["REVOKED", []]);
  });

  it("an already REVOKED registration is left alone (it is terminal), and one neither re-derived nor revoked is reported", async () => {
    const store = seed();
    store[DERIVATIVE_REGISTRY_TABLE].push(
      { id: "dead", scope_key: "NoSuchProjection|owner:y", source_memory_ids: [M], revocation_state: "REVOKED", payload_json: [], row_count: 0 },
      { id: "stuck", scope_key: "NoSuchProjection|owner:z", source_memory_ids: [M], revocation_state: "ACTIVE", payload_json: [{ memory_id: M }], row_count: 1 },
    );
    const out = await reprojectDerivativesAfterNarrowing(makeClient(store, { failWrites: new Set([`${DERIVATIVE_REGISTRY_TABLE}:update`]) }) as any, { memoryId: M, now: NOW, reason: "r" });
    assert.equal(out.carried, 1, "the revoked one is not counted as carrying");
    assert.equal(out.ok, false);
    assert.deepEqual(out.unresolved, ["NoSuchProjection|owner:z"]);
  });

  it("parseScopeKey is scopeKeyOf's inverse", () => {
    const scope = { owner_id: OWNER, viewer_id: "v", trip_id: "t", place_id: "p", person_id: "q" };
    assert.deepEqual(parseScopeKey(scopeKeyOf("TripMemoryProjection", scope)), { projectionId: "TripMemoryProjection", scope });
    assert.deepEqual(parseScopeKey(scopeKeyOf("PublicMemoryProjection", PUBLIC_SCOPE)), { projectionId: "PublicMemoryProjection", scope: PUBLIC_SCOPE });
    assert.equal(parseScopeKey("PublicMemoryProjection|viewer:v"), null, "no owner");
    assert.equal(parseScopeKey("PublicMemoryProjection|owner:a|owner:b"), null, "a repeated part");
  });
});

// ── Lead ruling H-5 (2026-10-07) ─────────────────────────────────────────────
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function send(a: App, method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(`${a.base}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", "Idempotency-Key": `h5-${++keyN}`, connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}
const lastLifecycle = (a: App) => a.logs.filter((l) => l.msg === "memories: §21 deletion lifecycle").at(-1)?.obj.report;
const stepOf = (report: any, name: string) => report.steps.find((x: any) => x.step === name);

describe("lead ruling H-5 — a deletion REBUILDS the derivatives that carried the Memory", () => {
  it("DELETE: the public derivative and the owner's timeline are rebuilt without the Memory, ACTIVE, still carrying the rest", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store);
    assert.equal((await send(app, "DELETE", `/memories/${M}`, OWNER)).status, 204);
    for (const [projection, scope] of [["PublicMemoryProjection", PUBLIC_SCOPE], ["MemoryTimelineProjection", OWNER_SCOPE]] as const) {
      const row = reg(store, projection, scope);
      assert.equal(row.revocation_state, "ACTIVE", `${projection} is rebuilt, not killed`);
      assert.equal(carries(row, M), false, `${projection} no longer carries the deleted Memory`);
      assert.equal(carries(row, M2), true, `${projection} still carries the Memory that was not deleted`);
    }
    const s3 = stepOf(lastLifecycle(app), "DERIVATIVES_PURGED");
    assert.deepEqual([s3.outcome, s3.facts.carried, s3.facts.rebuiltWithout, s3.facts.revokedInstead], ["done", 2, 2, 0]);
  });

  it("the owner's search after a deletion is never 410 for good: a derivative the deletion had to REVOKE is rebuilt on the owner's next search, without the deleted Memory", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store, { failWrites: new Set([`${DERIVATIVE_REGISTRY_TABLE}:upsert`]) });
    assert.equal((await send(app, "DELETE", `/memories/${M}`, OWNER)).status, 204);
    const revoked = reg(store, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.equal(revoked.revocation_state, "REVOKED", "precondition: the fail-closed fallback revoked it");
    assert.ok(String(revoked.revocation_reason).startsWith(DELETION_REVOCATION_REASON));

    _setTestClient(makeClient(store) as any, true);
    const search = await send(app, "POST", "/memories/search", OWNER, { intent: { kind: "mine" } });
    assert.notEqual(search.status, 410, JSON.stringify(search.body));
    assert.equal(search.status, 200, JSON.stringify(search.body));
    const mine = reg(store, "MemoryTimelineProjection", OWNER_SCOPE);
    assert.deepEqual([mine.revocation_state, carries(mine, M), carries(mine, M2)], ["ACTIVE", false, true]);
    assert.ok(!(search.body.hits ?? []).some((h: any) => h.memory_id === M || h.memoryId === M), "the deleted Memory is not a hit");
  });

  it("someone else's request does NOT rebuild a deletion-revoked derivative: it stays REVOKED and they are told 410", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store, { failWrites: new Set([`${DERIVATIVE_REGISTRY_TABLE}:upsert`]) });
    assert.equal((await send(app, "DELETE", `/memories/${M}`, OWNER)).status, 204);
    _setTestClient(makeClient(store) as any, true);
    const theirs = await send(app, "POST", "/memories/search", VIEWER, { intent: { kind: "public", ownerId: OWNER } });
    assert.equal(theirs.status, 410, JSON.stringify(theirs.body));
    assert.equal(reg(store, "PublicMemoryProjection", PUBLIC_SCOPE).revocation_state, "REVOKED");
  });

  it("a derivative revoked for ANY other reason stays revoked, even on its owner's request", async () => {
    const store = seed();
    await registerBoth(store);
    const mine = reg(store, "MemoryTimelineProjection", OWNER_SCOPE);
    Object.assign(mine, { revocation_state: "REVOKED", revocation_reason: "memory_visibility_changed: re-derivation failed", payload_json: [], row_count: 0 });
    app = await start(store);
    const search = await send(app, "POST", "/memories/search", OWNER, { intent: { kind: "mine" } });
    assert.equal(search.status, 410, JSON.stringify(search.body));
    assert.equal(reg(store, "MemoryTimelineProjection", OWNER_SCOPE).revocation_state, "REVOKED");
  });

  it("mustExclude: a rebuild that still carries the Memory is revoked, never counted as retained", async () => {
    const store = seed();
    await registerBoth(store);
    // M is NOT deleted here, so a rebuild keeps it: the deletion rule must still not let it stand.
    const out = await reprojectDerivativesAfterNarrowing(makeClient(store) as any, { memoryId: M, now: NOW, reason: DELETION_REVOCATION_REASON, mustExclude: true });
    assert.deepEqual([out.carried, out.retained, out.revokedInstead], [2, 0, 2]);
    assert.equal(reg(store, "MemoryTimelineProjection", OWNER_SCOPE).revocation_state, "REVOKED");
  });
});

// ── VERIFY-H2 (2026-10-07): H2-2 crew derivative, H2-4 registry read error, the page bound ──
const TRIPX = "66666666-6666-4666-8666-666666666666";
function tripSeed(): Record<string, any[]> {
  const st = seed();
  for (const m of st.memories) m.trip_id = TRIPX;
  return st;
}
const CREW_SCOPE = crewMemberTarget(OWNER, TRIPX).scope;
const VIEWER_TRIP_SCOPE = { owner_id: OWNER, viewer_id: VIEWER, trip_id: TRIPX, place_id: null, person_id: null };
const narrowingLog = (a: App) => a.logs.filter((l) => /§18/.test(l.msg)).at(-1);

describe("VERIFY-H2 H2-2 — a derivative built for a non-owner audience excludes, at BUILD time, what that audience may not see", () => {
  it("the crew search's TripMemoryProjection (viewer null): make-private through the router leaves it ACTIVE and WITHOUT the Memory or its title", async () => {
    const store = tripSeed();
    const client = makeClient(store) as any;
    assert.ok((await rebuildProjection(client, "TripMemoryProjection", CREW_SCOPE, NOW)).ok);
    const crew = () => store[DERIVATIVE_REGISTRY_TABLE].find((r) => r.scope_key === scopeKeyOf("TripMemoryProjection", CREW_SCOPE));
    assert.ok(carries(crew(), M), "precondition: a public trip Memory is in the crew derivative");
    app = await start(store);
    assert.equal((await patch(app, M, { visibility: "only_me" })).status, 200);
    assert.equal(crew().revocation_state, "ACTIVE");
    assert.equal(carries(crew(), M), false, "the now-private Memory is gone from the crew derivative");
    assert.ok(!JSON.stringify(crew().payload_json).includes(`t-${M.slice(0, 4)}`), "and so is its title");
    assert.equal(carries(crew(), M2), true);
  });

  it("at build time the crew derivative carries only public / trip_crew Memories with nobody hidden", async () => {
    const store = tripSeed();
    store.memories.push(
      { ...store.memories[0], id: "77777777-7777-4777-8777-777777777771", visibility: "friends_only" },
      { ...store.memories[0], id: "77777777-7777-4777-8777-777777777772", visibility: "trip_crew" },
      { ...store.memories[0], id: "77777777-7777-4777-8777-777777777773", visibility: "trip_crew", hidden_user_ids: [VIEWER] },
      { ...store.memories[0], id: "77777777-7777-4777-8777-777777777774", visibility: "only_me" },
    );
    const built = await rebuildProjection(makeClient(store) as any, "TripMemoryProjection", CREW_SCOPE, NOW);
    assert.ok(built.ok);
    assert.deepEqual([...built.value.registration.source_memory_ids].sort(), [M, M2, "77777777-7777-4777-8777-777777777772"].sort());
    const own = await rebuildProjection(makeClient(store) as any, "TripMemoryProjection", { ...CREW_SCOPE, viewer_id: OWNER }, NOW);
    assert.ok(own.ok && own.value.registration.source_memory_ids.length === 6, "the owner's own view carries all six");
  });

  it("a viewer-specific derivative that still carries the Memory is counted retainedShared, and the route says so", async () => {
    const store = tripSeed();
    assert.ok((await rebuildProjection(makeClient(store) as any, "TripMemoryProjection", VIEWER_TRIP_SCOPE, NOW)).ok);
    app = await start(store);
    assert.equal((await patch(app, M, { visibility: "friends_only" })).status, 200);
    const line = narrowingLog(app);
    assert.ok(line && /viewer-specific derivative still carries/.test(line.msg), JSON.stringify(app.logs.map((l) => l.msg)));
    assert.deepEqual([line!.obj.narrowed.retainedShared, line!.obj.narrowed.retained], [1, 0]);
    // and narrowing that viewer out entirely removes it at build time
    assert.equal((await patch(app, M, { visibility: "only_me" })).status, 200);
    const reg = store[DERIVATIVE_REGISTRY_TABLE].find((r) => r.scope_key === scopeKeyOf("TripMemoryProjection", VIEWER_TRIP_SCOPE));
    assert.equal(carries(reg, M), false);
  });
});

describe("VERIFY-H2 H2-4 and the page bound", () => {
  it("H2-4: an unreadable registry is ok:false with the reason, and the make-private route logs it (the decision itself still commits)", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store, { failReads: new Set([DERIVATIVE_REGISTRY_TABLE]) });
    assert.equal((await patch(app, M, { visibility: "only_me" })).status, 200);
    const line = narrowingLog(app);
    assert.ok(line && /could not all be re-derived/.test(line.msg), JSON.stringify(app.logs.map((l) => l.msg)));
    assert.equal(line!.obj.narrowed.ok, false);
    assert.match(line!.obj.narrowed.unresolved[0], /registry unreadable/);
  });

  it("a FULL page (PostgREST's max-rows) is ok:false and says more may remain — every row it returned is still re-derived", async () => {
    const store = seed();
    await registerBoth(store);
    for (let i = 0; i < REGISTRY_PAGE; i += 1) {
      store[DERIVATIVE_REGISTRY_TABLE].push({ id: `bulk-${i}`, scope_key: `NoSuchProjection|owner:o${i}`, source_memory_ids: [M], revocation_state: "ACTIVE", payload_json: [{ memory_id: M }], row_count: 1 });
    }
    const out = await reprojectDerivativesAfterNarrowing(makeClient(store) as any, { memoryId: M, now: NOW, reason: "memory_visibility_changed" });
    assert.equal(out.ok, false);
    assert.match(out.unresolved[0], /registry page full/);
    assert.equal(out.carried, REGISTRY_PAGE + 2);
    assert.equal(reg(store, "PublicMemoryProjection", PUBLIC_SCOPE).revocation_state, "ACTIVE");
  });
});

describe("§AL — a shared (crew) build carries a venue id only at the exact / venue rung", () => {
  it("the crew derivative drops the place id (the registry reads no rung, so none is admitted); the owner's own view keeps it", async () => {
    const store = tripSeed();
    for (const m of store.memories) m.place_id = "place-venue-0001";
    const crew = await rebuildProjection(makeClient(store) as any, "TripMemoryProjection", CREW_SCOPE, NOW);
    assert.ok(crew.ok);
    assert.ok(crew.value.rows.length > 0);
    assert.ok(crew.value.rows.every((r: any) => r.place_id === null), JSON.stringify(crew.value.rows));
    const own = await rebuildProjection(makeClient(store) as any, "TripMemoryProjection", { ...CREW_SCOPE, viewer_id: OWNER }, NOW);
    assert.ok(own.ok && own.value.rows.every((r: any) => r.place_id === "place-venue-0001"));
  });
});

// ── check:write-path-columns (hotfix after #645, 2026-10-10). Appended. ─────
// narrowingReprojection.ts names the registry table as a LITERAL so the live
// column check can verify its select/update lists (a dynamic table name is an
// unresolvable site, and main's live-DB run refused two new ones). This pins
// that every table it touches IS the registry, by the constant's value.
describe("narrowingReprojection names the registry table as a literal equal to DERIVATIVE_REGISTRY_TABLE", () => {
  it("every .from() in the module is a string literal, and each is the registry table", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("../services/memoryProjections/narrowingReprojection.ts", import.meta.url)), "utf8");
    const calls = [...src.matchAll(/\.from\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    assert.equal(calls.length, 2, `expected the two registry sites, found ${JSON.stringify(calls)}`);
    for (const c of calls) assert.equal(c, JSON.stringify(DERIVATIVE_REGISTRY_TABLE), `a .from() that is not the registry literal: ${c}`);
  });
});

// ── §24 the PROJECTION log line (census H223). Appended. ─────────────────────
// Spec §24 (.txt:640): "Operational logs must include memoryId, commandId,
// eventId, source version, engine version, reason codes, projection name, and
// failure class. Do not log sensitive raw content unless strictly necessary."
// The command log (MemoryDomainService.auditCommand) carries seven of the eight
// and an explicit null `projectionName` — a command is not a projection. H223
// stayed W because "nothing writes a projection log line that carries it". These
// cases drive the real router (PATCH / DELETE) and the registry, and read the
// lines the application logger receives.
const SECTION_24_FIELDS = [
  "memoryId", "commandId", "eventId", "sourceVersion",
  "engineVersion", "reason", "projectionName", "failureClass",
] as const;

async function captureAppLog<T>(fn: () => Promise<T>): Promise<{ out: T; lines: Array<Record<string, any>> }> {
  const { logger } = await import("../lib/logger.js");
  const lines: Array<Record<string, any>> = [];
  const realInfo = logger.info.bind(logger);
  const realWarn = logger.warn.bind(logger);
  (logger as any).info = (obj: any, msg?: string) => { lines.push({ ...(obj ?? {}), __msg: msg }); };
  (logger as any).warn = (obj: any, msg?: string) => { lines.push({ ...(obj ?? {}), __msg: msg }); };
  try {
    return { out: await fn(), lines };
  } finally {
    (logger as any).info = realInfo;
    (logger as any).warn = realWarn;
  }
}
const projectionLines = (lines: Array<Record<string, any>>, projection: string) =>
  lines.filter((l) => l.projectionName === projection);
const commandLine = (lines: Array<Record<string, any>>, type: string) =>
  lines.find((l) => l.commandType === type && l.projectionName === null);

describe("§24 the PROJECTION log line — the eighth field has a home (H223)", () => {
  it("PATCH make-private: each re-derived registration logs all eight §24 fields, joined to the command by its ids, with no Memory content", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store);
    const { out: r, lines } = await captureAppLog(() => patch(app!, M, { visibility: "only_me" }));
    assert.equal(r.status, 200, r.body);

    const cmd = commandLine(lines, "CHANGE_VISIBILITY");
    assert.ok(cmd, `the command's own audit line is the join key: ${JSON.stringify(lines)}`);
    assert.equal(typeof cmd!.commandId, "string");

    for (const [projection, scope, engine] of [
      ["PublicMemoryProjection", PUBLIC_SCOPE, "public@1"],
      ["MemoryTimelineProjection", OWNER_SCOPE, "timeline@1"],
    ] as const) {
      const mine = projectionLines(lines, projection);
      assert.equal(mine.length, 1, `${projection}: exactly one projection line for one re-derivation: ${JSON.stringify(lines)}`);
      const line = mine[0]!;
      for (const f of SECTION_24_FIELDS) assert.ok(f in line, `${projection}: §24 field ${f} is missing from the projection log line`);
      assert.equal(line.projectionName, projection);
      assert.equal(line.memoryId, M, "the Memory whose change caused the re-derivation");
      assert.equal(line.commandId, cmd!.commandId, "the projection line names the command that caused it");
      assert.equal(line.eventId, cmd!.eventId, "and the command's event (null on the legacy path, present as a key)");
      assert.equal(line.sourceVersion, reg(store, projection, scope).source_version, "the version the registration now records");
      assert.equal(typeof line.sourceVersion, "string");
      assert.equal(line.engineVersion, engine, "the builder that produced the derivative");
      assert.equal(line.reason, "memory_visibility_changed");
      assert.equal(line.failureClass, null, "a re-derivation that succeeded has no failure class");
      assert.deepEqual([line.operation, line.outcome], ["rebuild", "rebuilt"]);
      assert.equal(line.scopeKey, scopeKeyOf(projection, scope));
    }
    const text = JSON.stringify(lines.filter((l) => l.projectionName));
    for (const raw of [`t-${M.slice(0, 4)}`, `t-${M2.slice(0, 4)}`, "Lisbon", "Portugal"]) {
      assert.ok(!text.includes(raw), `the projection log must not carry Memory content (${raw})`);
    }
  });

  it("a re-derivation that fails logs its failure class and reason code, then the fail-closed revocation logs its own line", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store, { failWrites: new Set([`${DERIVATIVE_REGISTRY_TABLE}:upsert`]) });
    const { out: r, lines } = await captureAppLog(() => patch(app!, M, { visibility: "only_me" }));
    assert.equal(r.status, 200, r.body);
    const cmd = commandLine(lines, "CHANGE_VISIBILITY");
    const pub = projectionLines(lines, "PublicMemoryProjection");
    const refused = pub.find((l) => l.operation === "rebuild");
    assert.ok(refused, JSON.stringify(lines));
    for (const f of SECTION_24_FIELDS) assert.ok(f in refused!, `§24 field ${f} is missing from a refused projection line`);
    assert.deepEqual([refused!.outcome, refused!.reason, refused!.failureClass], ["refused", "registry_unavailable", "infrastructure"]);
    assert.equal(refused!.sourceVersion, null, "nothing was registered, so no version is claimed");
    assert.equal(refused!.engineVersion, "public@1");
    assert.equal(refused!.commandId, cmd!.commandId);
    const revoked = pub.find((l) => l.operation === "revoke");
    assert.ok(revoked, `the fail-closed revocation is a projection operation and is logged: ${JSON.stringify(pub)}`);
    for (const f of SECTION_24_FIELDS) assert.ok(f in revoked!, `§24 field ${f} is missing from a revocation line`);
    assert.deepEqual([revoked!.outcome, revoked!.failureClass, revoked!.memoryId, revoked!.commandId], ["revoked", null, M, cmd!.commandId]);
    assert.equal(revoked!.reason, "memory_visibility_changed: re-derivation failed");
  });

  it("a revocation that could not be written is logged as a failure, never as a revocation", async () => {
    const store = seed();
    store[DERIVATIVE_REGISTRY_TABLE].push({ id: "stuck", scope_key: "NoSuchProjection|owner:z", source_memory_ids: [M], revocation_state: "ACTIVE", payload_json: [{ memory_id: M }], row_count: 1 });
    const { lines } = await captureAppLog(() => reprojectDerivativesAfterNarrowing(
      makeClient(store, { failWrites: new Set([`${DERIVATIVE_REGISTRY_TABLE}:update`]) }) as any,
      { memoryId: M, now: NOW, reason: "memory_visibility_changed" },
    ));
    const line = projectionLines(lines, "NoSuchProjection").find((l) => l.operation === "revoke");
    assert.ok(line, JSON.stringify(lines));
    assert.deepEqual([line!.outcome, line!.failureClass, line!.reason], ["refused", "infrastructure", "revocation_unconfirmed"]);
    assert.equal(line!.engineVersion, null, "no builder is known for a projection id the registry does not define");
  });

  it("DELETE: the deletion's re-derivations log with the DELETE_MEMORY command's id and the deletion reason", async () => {
    const store = seed();
    await registerBoth(store);
    app = await start(store);
    const { out: r, lines } = await captureAppLog(() => send(app!, "DELETE", `/memories/${M}`, OWNER));
    assert.equal(r.status, 204);
    const cmd = commandLine(lines, "DELETE_MEMORY");
    assert.ok(cmd, JSON.stringify(lines));
    for (const projection of ["PublicMemoryProjection", "MemoryTimelineProjection"]) {
      const line = projectionLines(lines, projection).find((l) => l.operation === "rebuild");
      assert.ok(line, `${projection}: ${JSON.stringify(lines)}`);
      assert.deepEqual([line!.memoryId, line!.commandId, line!.reason, line!.failureClass], [M, cmd!.commandId, DELETION_REVOCATION_REASON, null]);
    }
  });

  it("a scope-wide rebuild (the search's ensure-fresh) logs every key, with no Memory, command or event to name", async () => {
    const store = seed();
    const { out, lines } = await captureAppLog(() => rebuildProjection(makeClient(store) as any, "PublicMemoryProjection", PUBLIC_SCOPE, NOW));
    assert.ok(out.ok);
    const line = projectionLines(lines, "PublicMemoryProjection")[0];
    assert.ok(line, JSON.stringify(lines));
    for (const f of SECTION_24_FIELDS) assert.ok(f in line!, `§24 field ${f} is missing`);
    assert.deepEqual([line!.memoryId, line!.commandId, line!.eventId], [null, null, null], "null is a state, not a missing key");
    assert.equal(line!.sourceVersion, out.ok ? out.value.registration.source_version : undefined);
  });

  it("the line is an ALLOWLIST: content handed to the logger with the entry never reaches the line", async () => {
    const { logProjectionOperation } = await import("../services/memoryProjections/projectionLog.js");
    const { lines } = await captureAppLog(async () => logProjectionOperation({
      operation: "rebuild", outcome: "rebuilt", projectionName: "PublicMemoryProjection", scopeKey: "PublicMemoryProjection|owner:o",
      sourceVersion: "v1", engineVersion: "public@1", trace: { memoryId: M },
      ...({ rows: [{ memory_id: M, title: "Dinner at Ana's", caption: "secret words" }], payload_json: [{ city: "Lisbon" }] } as any),
    }));
    assert.equal(lines.length, 1);
    const text = JSON.stringify(lines[0]);
    for (const raw of ["Dinner at Ana's", "secret words", "Lisbon"]) assert.ok(!text.includes(raw), `content leaked into the projection log: ${raw}`);
    for (const f of SECTION_24_FIELDS) assert.ok(f in lines[0]!, `§24 field ${f} is missing`);
  });

  it("a rebuild that declines to overwrite a REVOKED registration logs kept_revoked, not a failure", async () => {
    const store = seed();
    await registerBoth(store);
    Object.assign(reg(store, "PublicMemoryProjection", PUBLIC_SCOPE), { revocation_state: "REVOKED", revocation_reason: "owner made it private", payload_json: [], row_count: 0 });
    const { out, lines } = await captureAppLog(() => rebuildProjection(makeClient(store) as any, "PublicMemoryProjection", PUBLIC_SCOPE, NOW, { trace: { memoryId: M, reason: "derivative_stale" } }));
    assert.ok(out.ok && out.value.was_revoked);
    const line = projectionLines(lines, "PublicMemoryProjection")[0];
    assert.ok(line, JSON.stringify(lines));
    assert.deepEqual([line!.outcome, line!.failureClass, line!.memoryId, line!.reason, line!.engineVersion], ["kept_revoked", null, M, "derivative_stale", "public@1"]);
  });

  it("a rebuild that THROWS is logged as refused (rebuild_threw) before the throw propagates", async () => {
    const throwing = { from: () => { throw new Error("client exploded"); } };
    const { lines } = await captureAppLog(async () => {
      await assert.rejects(rebuildProjection(throwing as any, "PublicMemoryProjection", PUBLIC_SCOPE, NOW, { trace: { memoryId: M } }), /client exploded/);
    });
    const line = projectionLines(lines, "PublicMemoryProjection")[0];
    assert.ok(line, JSON.stringify(lines));
    assert.deepEqual([line!.outcome, line!.reason, line!.failureClass, line!.memoryId], ["refused", "rebuild_threw", "infrastructure", M]);
  });

  it("an unknown projection is refused with a validation class and no engine version", async () => {
    const { out, lines } = await captureAppLog(() => rebuildProjection(makeClient(seed()) as any, "NoSuchProjection" as any, PUBLIC_SCOPE, NOW));
    assert.equal(out.ok, false);
    const line = projectionLines(lines, "NoSuchProjection")[0];
    assert.ok(line, JSON.stringify(lines));
    assert.deepEqual([line!.outcome, line!.reason, line!.failureClass, line!.engineVersion], ["refused", "unknown_projection", "validation", null]);
  });
});
