/**
 * §15 Memory Retrieval and Search — REACHABLE.
 *
 * Highlights/Memories Development Architecture Spec v1 §15, §18, §28.6.
 * Census H110–H114, whose single shared blocker reads: "No route imports the
 * module." `services/memoryRetrieval/searchMemories.ts` implements the §15
 * signature, deterministic filters ahead of any reranking, the seven ranking
 * dimensions, namespace isolation checked on the way IN, and refusal-by-name
 * for a revoked derivative — and until `POST /memories/search` existed its only
 * callers were the certification harness's in-memory world.
 *
 * WHAT THIS SUITE ASSERTS, AND WHY EACH IS NOT THE ENGINE'S OWN TEST
 * -----------------------------------------------------------------
 * `memoryRetrievalSearch.test.ts` already proves the engine. What could not be
 * proved before is that a REQUEST reaches it without widening what it may read,
 * and that the derivative it reads is registered rather than absent:
 *
 *   - a search over a scope with no registration BUILDS and REGISTERS one, so
 *     the cleanup graph §18 depends on has a row to walk. Before this, census
 *     H34 recorded that "the READ paths still build per request and register
 *     nothing", and a derivative that was never registered cannot be revoked
 *     when the Memory behind it is deleted.
 *
 *   - a REVOKED registration is NOT rebuilt. This is the assertion that makes
 *     H114 mean anything: an "ensure it is fresh" helper written the obvious
 *     way sees REVOKED, decides the payload needs refreshing, and resurrects
 *     the exact derivative a privacy decision destroyed.
 *
 *   - the caller cannot name a namespace, an owner for a private namespace, or
 *     a projection. The engine would refuse a cross-namespace request anyway;
 *     what is asserted here is that the request never gets to be one.
 *
 * Run: node --import tsx/esm --test src/test/memorySearchRoute.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import { scopeKeyOf } from "../services/memoryProjections/projectionRegistry.js";
import { CREW_UNION_MEMBER_LIMIT } from "../services/memory/memorySearchService.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VIEWER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const M_PUB = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const M_PRIV = "dddddddd-dddd-dddd-dddd-dddddddddd02";
const M_MINE = "dddddddd-dddd-dddd-dddd-dddddddddd03";
/** SHARED_CREW fixture. OWNER owns the trip; VIEWER and DEPARTING are crew. */
const TRIP = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1";
const DEPARTING = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb02";
const NONMEMBER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb03";
const M_CREW_OWNER = "dddddddd-dddd-dddd-dddd-dddddddddd10";
const M_CREW_VIEWER = "dddddddd-dddd-dddd-dddd-dddddddddd11";
const M_CREW_ONLY_ME = "dddddddd-dddd-dddd-dddd-dddddddddd12";
const M_CREW_DEPARTING = "dddddddd-dddd-dddd-dddd-dddddddddd13";

function memory(id: string, owner: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: owner, title: "Lisbon rooftop sunset", caption: "the long walk up",
    visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: "place-lisboa",
    location_city: "Lisbon", location_country: "PT",
    location_lat: 38.7, location_lng: -9.1, canonical_location_id: null,
    starts_at: "2026-01-02T10:00:00.000Z", ends_at: null,
    state: "published", created_at: "2026-01-02T10:00:00.000Z",
    updated_at: "2026-01-02T10:00:00.000Z",
    ...over,
  };
}

function tables(): Record<string, any[]> {
  return {
    memories: [
      memory(M_PUB, OWNER),
      memory(M_PRIV, OWNER, { id: M_PRIV, visibility: "private", title: "the hotel room" }),
      memory(M_MINE, VIEWER, { id: M_MINE, title: "Hanoi noodle stall", location_city: "Hanoi", location_country: "VN" }),
    ],
    memory_items: [],
    memory_tags: [],
    memory_derivative_registry: [],
    profiles: [
      { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null },
      { id: VIEWER, account_status: "active", name: "Viewer", handle: "viewer", avatar_url: null },
      { id: STRANGER, account_status: "active", name: "S", handle: "s", avatar_url: null },
    ],
    blocks: [],
    feature_flags: [],
    trips: [],
    trip_members: [],
  };
}

/**
 * The SHARED_CREW fixture, as a separate builder so the existing single-target
 * cases keep the store they were written against.
 *
 * Note what is deliberately in it: one `only_me` Memory of the trip owner's
 * (`M_CREW_ONLY_ME`). `TripMemoryProjection.build` filters to the scope owner's
 * UNDELETED Memories on the trip and runs no audience ladder at all — it does not
 * look at `visibility`, and `TRIP_FIELDS` does not even carry the column — so
 * that row IS in the registered derivative the union reads. If the §23 ladder is
 * not run over the union, the crew gets handed it.
 */
function crewTables(): Record<string, any[]> {
  const t = tables();
  t.memories.push(
    memory(M_CREW_OWNER, OWNER, { id: M_CREW_OWNER, trip_id: TRIP, visibility: "trip_crew", title: "Porto crew dinner" }),
    memory(M_CREW_VIEWER, VIEWER, { id: M_CREW_VIEWER, trip_id: TRIP, visibility: "trip_crew", title: "Porto morning run" }),
    memory(M_CREW_ONLY_ME, OWNER, { id: M_CREW_ONLY_ME, trip_id: TRIP, visibility: "only_me", title: "the argument on the bridge" }),
    memory(M_CREW_DEPARTING, DEPARTING, { id: M_CREW_DEPARTING, trip_id: TRIP, visibility: "trip_crew", title: "Porto last night" }),
  );
  t.trips = [{ id: TRIP, owner_id: OWNER }];
  t.trip_members = [
    { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
    { trip_id: TRIP, user_id: VIEWER, role: "member", status: "accepted" },
    { trip_id: TRIP, user_id: DEPARTING, role: "member", status: "accepted" },
  ];
  t.profiles.push(
    { id: DEPARTING, account_status: "active", name: "D", handle: "d", avatar_url: null },
    { id: NONMEMBER, account_status: "active", name: "N", handle: "n", avatar_url: null },
  );
  return t;
}

/**
 * `failScopeKeys` makes ONE member's derivative read fail while the rest of the
 * crew's succeed, which `failReads` (whole-table) cannot express. It is the only
 * way to exercise the case the honesty requirement is about: a union in which one
 * member's derivative could not be read must name that member as withheld, not
 * drop them and not report them as having no memories.
 */
function makeClient(store: Record<string, any[]>, failReads: Set<string>, failScopeKeys: Set<string> = new Set()) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const eqValues: any[] = [];
    let single = false, head = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "upsert" | "update" | "delete" | null = null;
    let payload: any = null;
    let conflict: string[] = [];
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any, o?: any) {
        isWrite = true; mode = "upsert"; payload = d;
        conflict = String(o?.onConflict ?? "id").split(",").map((c) => c.trim()).filter(Boolean);
        return obj;
      },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { eqValues.push(v); filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      contains(c: string, vs: any[]) { filters.push((r) => (vs as any[]).every((v) => (r[c] ?? []).includes(v))); return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      // supabase-js RESOLVES on a database error; it does not throw. A fake
      // that threw would exercise a `catch` the production path does not have.
      if (failReads.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      if (!isWrite && eqValues.some((v) => typeof v === "string" && failScopeKeys.has(v))) {
        return { data: null, error: { message: `${table} unavailable for ${eqValues.join("|")}` }, count: null };
      }
      const all = (store[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r }));
        const out: any[] = [];
        for (const r of rows) {
          const existing = mode === "upsert" && conflict.length
            ? all.find((e: any) => conflict.every((c) => e[c] === r[c]))
            : undefined;
          if (existing) { Object.assign(existing, r); out.push(existing); }
          else { const stored = { ...r, id: r.id ?? `new-${all.length}-${table}` }; all.push(stored); out.push(stored); }
        }
        return { data: single ? out[0] : out, error: null, count: out.length };
      }
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        const gone = new Set(matched);
        store[table] = all.filter((r) => !gone.has(r));
        return selectedAfterWrite ? { data: matched, error: null, count: matched.length } : { data: null, error: null, count: null };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        return selectedAfterWrite ? { data: matched, error: null, count: matched.length } : { data: null, error: null, count: null };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched, error: null, count: head ? matched.length : null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: async () => ({ data: null, error: { message: "no rpc" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { baseUrl: string; store: Record<string, any[]>; logged: any[]; close: () => Promise<void> }

async function startApp(opts: { failReads?: Set<string>; store?: Record<string, any[]>; failScopeKeys?: Set<string> } = {}): Promise<App> {
  const store = opts.store ?? tables();
  _setTestClient(makeClient(store, opts.failReads ?? new Set(), opts.failScopeKeys ?? new Set()) as any, true);
  const logged: any[] = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (o: any, m: string) => { logged.push({ o, m }); }, info: () => {}, warn: () => {} };
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

async function search(app: App, actor: string, body: unknown) {
  const res = await fetch(app.baseUrl + "/api/memories/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${actor}`, "Content-Type": "application/json", connection: "close" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const ids = (b: any) => new Set(((b?.hits ?? []) as any[]).map((h) => h.memoryId));
const REG = "memory_derivative_registry";

/* ══════════════════════════════════════════════════════════════════════════
 * The route reaches the engine at all — H110's blocker
 * ════════════════════════════════════════════════════════════════════════*/

describe("§15 POST /memories/search reaches the retrieval engine", () => {
  it("returns the viewer's own Memories with §15's ranking dimensions on every hit", async () => {
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(r.status, 200);
      assert.ok(ids(r.body).has(M_MINE));
      assert.equal(r.body.namespace, "PRIVATE_PERSONAL");
      assert.equal(r.body.projectionId, "MemoryTimelineProjection");
      assert.equal(r.body.engineVersion, "memory-retrieval@1");
      // A rank with no derivation is not a rank (§15).
      const hit = (r.body.hits as any[])[0];
      for (const d of r.body.capabilities.rankingDimensions) {
        assert.ok(d in hit.dimensions, `ranking dimension ${d} must be reported on the hit`);
      }
    } finally { await app.close(); }
  });

  it("REGISTERS the derivative it read, so §18's cleanup graph has a row to walk", async () => {
    const app = await startApp();
    try {
      assert.equal(app.store[REG].length, 0, "positive control: nothing is registered to begin with");
      const r = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(r.status, 200);
      // Census H34: "the READ paths still build per request and register
      // nothing". A derivative that was never registered cannot be revoked
      // when the Memory behind it is deleted.
      assert.equal(app.store[REG].length, 1);
      const reg = app.store[REG][0];
      assert.equal(reg.projection_id, "MemoryTimelineProjection");
      assert.equal(reg.owner_id, VIEWER);
      assert.equal(reg.revocation_state, "ACTIVE");
      assert.ok(reg.source_memory_ids.includes(M_MINE), "the cleanup graph must name the memory that contributed");
    } finally { await app.close(); }
  });

  it("a second search REUSES the registration rather than appending a second one", async () => {
    const app = await startApp();
    try {
      await search(app, VIEWER, { intent: { kind: "mine" } });
      await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(app.store[REG].length, 1);
    } finally { await app.close(); }
  });

  it("a deterministic filter selects, and the count of what it selected is reported", async () => {
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" }, query: "noodle" });
      assert.equal(r.status, 200);
      // §15 / H111: the filters decide membership and the query may only
      // REORDER what they selected. `deterministicMatchCount` is what makes
      // that visible — a semantic pass that added a row would exceed it.
      assert.ok(r.body.hits.length <= r.body.deterministicMatchCount);
      assert.equal(r.body.semanticRerankApplied, true);
    } finally { await app.close(); }
  });

  it("the count is what the FILTERS selected, not what the page returned", async () => {
    // ADDED after a mutation found the case above green when
    // `deterministicMatchCount` was replaced by `hits.length`. With one
    // matching Memory in the fixture the two numbers are equal, so `<=` held
    // and the field was not pinned to anything — and this is the field that
    // makes H111's claim ("the filters decide membership; a semantic pass may
    // only reorder what they selected") checkable at all. A count that silently
    // became the page size would report a truncated answer as a complete one.
    const store = tables();
    store.memories.push(
      memory("dddddddd-dddd-dddd-dddd-dddddddddd04", VIEWER, { id: "dddddddd-dddd-dddd-dddd-dddddddddd04", title: "Hanoi noodle soup" }),
      memory("dddddddd-dddd-dddd-dddd-dddddddddd05", VIEWER, { id: "dddddddd-dddd-dddd-dddd-dddddddddd05", title: "Hanoi noodle morning" }),
    );
    const app = await startApp({ store });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" }, limit: 1 });
      assert.equal(r.status, 200);
      assert.equal(r.body.hits.length, 1, "the page is what was asked for");
      assert.equal(r.body.deterministicMatchCount, 3, "the count is what the filters selected, before the limit");
      assert.ok(r.body.deterministicMatchCount > r.body.hits.length, "strictly greater — the two are not the same number");
    } finally { await app.close(); }
  });

  it("names the engine's ceiling on the wire: there is no semantic index", async () => {
    // H111. The default scorer is token overlap and no model is called on this
    // path. A search box that implied otherwise would promise an understanding
    // the engine does not have.
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(r.body.capabilities.semanticIndex, "none");
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * H113 — the caller cannot choose the namespace
 * ════════════════════════════════════════════════════════════════════════*/

describe("§15 namespace isolation: the request never gets to be a cross-namespace one", () => {
  it("a client-supplied namespace, ownerId and projection on a `mine` search are IGNORED", async () => {
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, {
        intent: { kind: "mine", ownerId: OWNER },
        namespace: "PRIVATE_PERSONAL",
        authorizedProjection: "MemoryTimelineProjection",
        ownerId: OWNER,
      });
      assert.equal(r.status, 200);
      // The whole point: the owner is the AUTHENTICATED viewer, so the
      // stranger's private timeline was never addressable.
      assert.ok(!ids(r.body).has(M_PUB));
      assert.ok(!ids(r.body).has(M_PRIV));
      assert.ok(ids(r.body).has(M_MINE));
      assert.equal(app.store[REG][0].owner_id, VIEWER);
    } finally { await app.close(); }
  });

  it("a PUBLIC search over another person serves only their published PUBLIC Memories", async () => {
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "public", ownerId: OWNER } });
      assert.equal(r.status, 200);
      assert.equal(r.body.namespace, "PUBLIC");
      assert.equal(r.body.projectionId, "PublicMemoryProjection");
      assert.ok(ids(r.body).has(M_PUB));
      assert.ok(!ids(r.body).has(M_PRIV), "a private Memory must not reach the public derivative");
    } finally { await app.close(); }
  });

  it("the PUBLIC derivative carries city and country and NEVER a coordinate", async () => {
    // §10 / §28.7, enforced by the projection's field whitelist rather than by
    // the reader remembering to strip it.
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "public", ownerId: OWNER } });
      const row = (r.body.hits as any[])[0].row;
      assert.equal(row.location_city, "Lisbon");
      assert.equal(row.location_country, "PT");
      assert.ok(!("location_lat" in row), "a public derivative must not carry a coordinate");
      assert.ok(!("location_lng" in row));
    } finally { await app.close(); }
  });

  it("the PUBLIC derivative is built ONCE FOR ITS AUDIENCE, not once per reader", async () => {
    // §28.6: "public search queries a public derivative, never canonical rows
    // plus post-filtering". A derivative keyed by VIEWER is exactly canonical
    // rows filtered per reader wearing a derivative's name — and it is
    // invisible from the outside, because both readers get the right answer.
    // What gives it away is the registration: `scopeKeyOf` puts `viewer:` in
    // the key, so a viewer-keyed public projection registers one row per
    // reader, and the cleanup graph then has to find N rows to revoke instead
    // of one.
    const app = await startApp();
    try {
      const a = await search(app, VIEWER, { intent: { kind: "public", ownerId: OWNER } });
      const b = await search(app, STRANGER, { intent: { kind: "public", ownerId: OWNER } });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.deepEqual([...ids(a.body)], [...ids(b.body)], "both readers see the same public derivative");
      assert.equal(app.store[REG].length, 1, "one audience, one registration");
      assert.ok(
        !String(app.store[REG][0].scope_key).includes("viewer:"),
        `a public derivative must not be keyed by reader; scope_key was ${app.store[REG][0].scope_key}`,
      );
    } finally { await app.close(); }
  });

  it("a blocked viewer gets an empty result, not a 403 that reveals the block exists", async () => {
    const t = tables();
    t.blocks = [{ blocker_id: OWNER, blocked_id: VIEWER }];
    const app = await startApp({ store: t });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "public", ownerId: OWNER } });
      assert.equal(r.status, 200);
      assert.equal(r.body.hits.length, 0);
      assert.equal(app.store[REG].length, 0, "a blocked search must not even build a derivative");
    } finally { await app.close(); }
  });

  it("refuses an intent that is not one of the three", async () => {
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "everyones" } });
      assert.equal(r.status, 400);
    } finally { await app.close(); }
  });

  it("reports all three namespaces reachable and NO unreachable ones", async () => {
    // This assertion used to be the opposite — `namespaces` was
    // ["PRIVATE_PERSONAL", "PUBLIC"] and SHARED_CREW was listed with a reason in
    // `unreachableNamespaces`. It is inverted rather than deleted because
    // `searchCapabilities()` puts both fields ON THE WIRE: a surface that kept
    // advertising a reason SHARED_CREW cannot be reached would be telling clients
    // they cannot do something they now can, which is a worse lie than the
    // original gap.
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.deepEqual(r.body.capabilities.namespaces, ["PRIVATE_PERSONAL", "SHARED_CREW", "PUBLIC"]);
      assert.deepEqual(r.body.capabilities.unreachableNamespaces, {});
      assert.ok(r.body.capabilities.intents.includes("crew_trip"));
      // The union's own ceilings travel beside `semanticIndex`, for the same
      // reason: a client must be able to render what this answer does not cover.
      assert.equal(r.body.capabilities.crewUnion.partialPolicy, "serve_readable_and_name_withheld");
      assert.equal(typeof r.body.capabilities.crewUnion.memberBound, "number");
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * H114 — a revoked derivative stays revoked
 * ════════════════════════════════════════════════════════════════════════*/

describe("§18 / §15 a REVOKED derivative is refused by name and is never rebuilt", () => {
  it("refuses with `gone` rather than an empty page, and does NOT resurrect the payload", async () => {
    const app = await startApp();
    try {
      // Register it the way a real search would, then revoke it the way a
      // privacy decision would.
      const first = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(first.status, 200);
      const reg = app.store[REG][0];
      reg.revocation_state = "REVOKED";
      reg.revoked_at = "2026-03-01T00:00:00.000Z";
      reg.revocation_reason = "owner deleted the memory";
      const payloadBefore = JSON.stringify(reg.payload_json);

      const after = await search(app, VIEWER, { intent: { kind: "mine" } });
      // "This index was revoked" and "nothing matched" are different answers to
      // a person, and only one of them is true.
      assert.equal(after.status, 410);
      assert.equal(after.body.error, "gone");
      // THE ASSERTION THAT MATTERS. An "ensure it is fresh" helper written the
      // obvious way sees REVOKED, decides the payload needs refreshing, and
      // resurrects the exact derivative a privacy decision destroyed.
      assert.equal(app.store[REG][0].revocation_state, "REVOKED");
      assert.equal(JSON.stringify(app.store[REG][0].payload_json), payloadBefore);
      assert.ok(app.logged.some((l) => /REVOKED/.test(l.m)));
    } finally { await app.close(); }
  });

  it("a PURGED registration is refused the same way", async () => {
    const app = await startApp();
    try {
      await search(app, VIEWER, { intent: { kind: "mine" } });
      app.store[REG][0].revocation_state = "PURGED";
      const after = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(after.status, 410);
      assert.equal(app.store[REG][0].revocation_state, "PURGED");
    } finally { await app.close(); }
  });

  it("a STALE registration IS rebuilt — revocation is the exception, not staleness", async () => {
    const app = await startApp();
    try {
      await search(app, VIEWER, { intent: { kind: "mine" } });
      const before = app.store[REG][0].source_version;
      // The canonical row moves. §18: the derivative is now stale and must be
      // rebuilt rather than served.
      app.store.memories.find((m: any) => m.id === M_MINE)!.updated_at = "2026-05-05T00:00:00.000Z";
      const after = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(after.status, 200);
      assert.notEqual(app.store[REG][0].source_version, before);
      assert.equal(app.store[REG].length, 1);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * §28.11 — a failure is never served as a plausible empty result
 * ════════════════════════════════════════════════════════════════════════*/

describe("§28.11 an unreadable source or registry refuses rather than answering 'nothing matched'", () => {
  it("an unreadable `memories` refuses with degraded_unavailable", async () => {
    const app = await startApp({ failReads: new Set(["memories"]) });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.ok(app.logged.length > 0, "the refusal must be logged, not only returned");
    } finally { await app.close(); }
  });

  it("an unreadable registry refuses rather than searching an unregistered derivative", async () => {
    const app = await startApp({ failReads: new Set([REG]) });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.notEqual(r.status, 200);
    } finally { await app.close(); }
  });

  it("a filter the derivative cannot answer is REFUSED, not silently dropped", async () => {
    // Dropping a predicate answers a different question than the one asked and
    // looks like a complete result. The public derivative's whitelist has no
    // trip_id.
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "public", ownerId: OWNER }, trip: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" });
      assert.equal(r.status, 400);
      assert.match(String(r.body.message), /cannot answer/i);
    } finally { await app.close(); }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * SHARED_CREW — the crew's memory of one trip, and the honesty of a UNION
 *
 * The namespace existed in the engine (`NAMESPACE_PROJECTIONS.SHARED_CREW`) and
 * was reachable only by calling `searchMemories` directly; the service listed it
 * in `UNREACHABLE_NAMESPACES` with a reason. The reason's two factual halves were
 * already settled in the schema — a departed member is simply not crew, because
 * REMOVE_PARTICIPANT and DECLINE_INVITE DELETE the `trip_members` row — and the
 * third half, what to do when one member's derivative is revoked, is the decision
 * these cases pin down.
 *
 * WHAT MAKES THESE CASES WORTH WRITING. A union is the one shape where "it
 * worked" and "it worked for four of the six people on this trip" are the same
 * 200. Every case below is about the difference.
 * ════════════════════════════════════════════════════════════════════════*/

const memberLine = (b: any, id: string) => ((b?.members ?? []) as any[]).find((m) => m.memberId === id);

describe("§15 SHARED_CREW: a crew search unions the crew's per-owner derivatives", () => {
  it("serves every accepted member's Memories of the trip, and REGISTERS one derivative per member", async () => {
    const app = await startApp({ store: crewTables() });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 200);
      assert.equal(r.body.namespace, "SHARED_CREW");
      assert.equal(r.body.projectionId, "TripMemoryProjection");
      // The union: the viewer's own Memory AND two other members'.
      assert.ok(ids(r.body).has(M_CREW_VIEWER), "the viewer's own trip Memory");
      assert.ok(ids(r.body).has(M_CREW_OWNER), "another member's trip Memory — this is the union");
      assert.ok(ids(r.body).has(M_CREW_DEPARTING));
      // STATE, not the return value: §18's cleanup graph must have one row per
      // member's derivative to walk, or a member's privacy decision has nothing
      // to revoke.
      const crewRegs = app.store[REG].filter((g: any) => g.projection_id === "TripMemoryProjection");
      assert.equal(crewRegs.length, 3, "one registration per crew member, not one for the union");
      assert.deepEqual(crewRegs.map((g: any) => g.owner_id).sort(), [OWNER, VIEWER, DEPARTING].sort());
      for (const g of crewRegs) assert.equal(g.revocation_state, "ACTIVE");
      // NO member was withheld — and the union still does not claim to be
      // complete, because the §23 ladder withheld the trip owner's only_me row
      // (the case below). Both facts are reported, separately, because they are
      // different failures: a member we could not read, and a row this reader may
      // not have.
      assert.deepEqual(r.body.withheldMembers, []);
      assert.equal(r.body.audienceWithheldCount, 1);
      assert.equal(r.body.unionComplete, false);
      assert.equal(r.body.crewSize, 3);
      for (const id of [OWNER, VIEWER, DEPARTING]) {
        assert.equal(memberLine(r.body, id).state, "served", `${id} must be named as served`);
      }
    } finally { await app.close(); }
  });

  it("does NOT serve another member's only_me Memory — the projection is not the permission", async () => {
    // `TripMemoryProjection.build` puts every undeleted Memory of the scope owner
    // on the trip into the payload, with no audience ladder and no `visibility`
    // field in TRIP_FIELDS to filter on afterwards. GET
    // /trips/:tripId/memories/recap handles that by running canReadMemory BEFORE
    // the builder; the search path reads a REGISTERED derivative that is keyed by
    // audience rather than by reader, so it cannot. The ladder therefore runs as
    // an intersection over the union, and this is the case that proves it does.
    const app = await startApp({ store: crewTables() });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 200);
      assert.ok(!ids(r.body).has(M_CREW_ONLY_ME), "a crew member's only_me Memory must not reach the crew");
      // STATE: the row IS in the registered derivative. The ladder is the only
      // thing keeping it out of the answer, so if that is ever removed this
      // assertion is what fails rather than nothing.
      const ownerReg = app.store[REG].find((g: any) => g.projection_id === "TripMemoryProjection" && g.owner_id === OWNER);
      assert.ok(
        (ownerReg.payload_json as any[]).some((row) => row.memory_id === M_CREW_ONLY_ME),
        "positive control: the derivative itself does contain it",
      );
      // A narrowed union is not a complete one, and it says so.
      assert.ok(r.body.audienceWithheldCount >= 1);
      assert.equal(r.body.unionComplete, false);
    } finally { await app.close(); }
  });

  it("the owner still sees their OWN only_me Memory of the trip", async () => {
    // The ladder's first line: the owner always reads their own row. Without this
    // the case above would also pass if the union simply dropped only_me rows for
    // everyone, which is a different (and wrong) rule.
    const app = await startApp({ store: crewTables() });
    try {
      const r = await search(app, OWNER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 200);
      assert.ok(ids(r.body).has(M_CREW_ONLY_ME));
      // And for THIS reader nothing was withheld at all, so the union reports
      // itself complete. This is the positive control for `unionComplete`: the
      // field has to be capable of being true, or it is decoration.
      assert.equal(r.body.audienceWithheldCount, 0);
      assert.equal(r.body.unionComplete, true);
    } finally { await app.close(); }
  });

  it("refuses a viewer who is not accepted crew, with the answer that does not confirm the trip", async () => {
    const app = await startApp({ store: crewTables() });
    try {
      const r = await search(app, NONMEMBER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 404);
      // STATE: a refused search must not have built anything. A derivative
      // registered on a stranger's request is a derivative their request caused
      // the system to compute over other people's Memories.
      assert.equal(app.store[REG].filter((g: any) => g.projection_id === "TripMemoryProjection").length, 0);
    } finally { await app.close(); }
  });

  it("refuses a member whose row says status != accepted", async () => {
    // `acceptedCrewOfTrip` is the single rule, and this is the half of it the
    // older, looser copies of the trip_crew predicate got wrong: role='invited'
    // and status='removed' both used to be admitted.
    const store = crewTables();
    store.trip_members.push({ trip_id: TRIP, user_id: NONMEMBER, role: "member", status: "invited" });
    const app = await startApp({ store });
    try {
      const r = await search(app, NONMEMBER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 404);
    } finally { await app.close(); }
  });

  it("a DEPARTED member's Memories leave the union, through the real read path", async () => {
    // Membership is a HARD delete: REMOVE_PARTICIPANT and DECLINE_INVITE both
    // `DELETE FROM public.trip_members`, and nothing in the repository ever
    // writes status='removed' or 'left'. So there is no "formerly crew" state to
    // handle — the union is over `acceptedCrewOfTrip` and inherits the answer.
    const store = crewTables();
    const app = await startApp({ store });
    try {
      const before = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.ok(ids(before.body).has(M_CREW_DEPARTING), "positive control: they were crew a moment ago");

      // The departure, as the route performs it.
      store.trip_members = store.trip_members.filter((m: any) => m.user_id !== DEPARTING);

      const after = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(after.status, 200);
      assert.ok(!ids(after.body).has(M_CREW_DEPARTING), "a departed member's Memories must not be in the crew's union");
      assert.equal(after.body.crewSize, 2);
      // And they are NOT reported as withheld either: they are not crew, which is
      // a different fact from "crew, and we could not serve them".
      assert.equal(memberLine(after.body, DEPARTING), undefined);
      assert.equal(after.body.withheldMembers.length, 0);
      // The Memory itself is untouched — a departure is not a deletion.
      assert.ok(store.memories.some((m: any) => m.id === M_CREW_DEPARTING && m.state === "published"));
    } finally { await app.close(); }
  });
});

describe("§18 / §15 SHARED_CREW partial unions are SERVED and NAMED, never refused whole", () => {
  it("one member's REVOKED derivative withholds that member and serves the rest", async () => {
    const app = await startApp({ store: crewTables() });
    try {
      await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      const ownerReg = app.store[REG].find((g: any) => g.projection_id === "TripMemoryProjection" && g.owner_id === OWNER);
      ownerReg.revocation_state = "REVOKED";
      ownerReg.revoked_at = "2026-03-01T00:00:00.000Z";
      const payloadBefore = JSON.stringify(ownerReg.payload_json);

      const r = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      // NOT a 410. One member's privacy decision must not blank the crew's
      // shared memory for the other two (a denial-of-service shape), and the
      // refusal itself would announce that somebody revoked something (a privacy
      // leak by inference).
      assert.equal(r.status, 200);
      assert.ok(ids(r.body).has(M_CREW_VIEWER), "the other members are still served");
      assert.ok(ids(r.body).has(M_CREW_DEPARTING));
      assert.ok(!ids(r.body).has(M_CREW_OWNER), "the revoked member contributes nothing");
      // NAMED. This is the requirement: a partial union must never present as
      // complete, and the withheld member must be identifiable.
      const line = memberLine(r.body, OWNER);
      assert.equal(line.state, "withheld");
      assert.equal(line.reason, "derivative_revoked");
      // Never 0 — "we did not look" is not "this member has no memories".
      assert.equal(line.matchCount, null);
      assert.deepEqual(r.body.withheldMembers.map((m: any) => m.memberId), [OWNER]);
      assert.equal(r.body.unionComplete, false);
      // STATE: and it was NOT resurrected on the way past.
      assert.equal(ownerReg.revocation_state, "REVOKED");
      assert.equal(JSON.stringify(ownerReg.payload_json), payloadBefore);
    } finally { await app.close(); }
  });

  it("one member's UNREADABLE derivative is named as withheld, not dropped and not reported as empty", async () => {
    // §28.11, which is the whole reason this field exists: a failed read served
    // as an empty one is the defect this repository keeps finding. The member is
    // still in `members`, still has a reason, and still has `matchCount: null`.
    const store = crewTables();
    const failing = scopeKeyOf("TripMemoryProjection", {
      owner_id: DEPARTING, viewer_id: null, trip_id: TRIP, place_id: null, person_id: null,
    });
    const app = await startApp({ store, failScopeKeys: new Set([failing]) });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 200);
      const line = memberLine(r.body, DEPARTING);
      assert.ok(line, "an unreadable member must still appear in `members` — dropping them is the silent omission");
      assert.equal(line.state, "withheld");
      assert.equal(line.reason, "derivative_unavailable");
      assert.equal(line.matchCount, null, "0 would claim this member has no memories of the trip");
      assert.ok(typeof line.detail === "string" && line.detail.length > 0);
      assert.ok(!ids(r.body).has(M_CREW_DEPARTING));
      assert.equal(r.body.unionComplete, false);
      // The readable members are still served — the failure is contained.
      assert.ok(ids(r.body).has(M_CREW_VIEWER));
      assert.equal(memberLine(r.body, VIEWER).state, "served");
    } finally { await app.close(); }
  });

  it("an unreadable trip_members REFUSES rather than searching an empty crew", async () => {
    // An empty crew would be served as "nobody on this trip has any memories",
    // which is a claim about the world made out of a failed read.
    const app = await startApp({ store: crewTables(), failReads: new Set(["trip_members"]) });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 503);
      assert.ok(app.logged.length > 0, "the refusal must be logged, not only returned");
    } finally { await app.close(); }
  });

  it("a `trip` filter that contradicts the crew scope is refused rather than reconciled", async () => {
    const app = await startApp({ store: crewTables() });
    try {
      const r = await search(app, VIEWER, {
        intent: { kind: "crew_trip", tripId: TRIP },
        trip: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee9",
      });
      assert.equal(r.status, 400);
    } finally { await app.close(); }
  });
});

describe("§15 SHARED_CREW bounds its fan-out and says what the bound is", () => {
  it("unions at most CREW_UNION_MEMBER_LIMIT members and NAMES the rest as withheld", async () => {
    // N members is N derivative reads. The bound is the smallest safe one rather
    // than a capacity decision anybody has made, and it is on the wire so a crew
    // of 27 is never handed 25 members' memories as though that were all of them.
    const store = crewTables();
    const extra: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = `f0000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`;
      extra.push(id);
      store.trip_members.push({ trip_id: TRIP, user_id: id, role: "member", status: "accepted" });
    }
    const app = await startApp({ store });
    try {
      const r = await search(app, VIEWER, { intent: { kind: "crew_trip", tripId: TRIP } });
      assert.equal(r.status, 200);
      const bound = r.body.memberBound;
      assert.equal(bound, CREW_UNION_MEMBER_LIMIT);
      assert.equal(r.body.crewSize, 33, "the crew is reported in full, however many are served");
      const served = (r.body.members as any[]).filter((m) => m.state === "served");
      const over = (r.body.members as any[]).filter((m) => m.reason === "over_member_bound");
      assert.ok(served.length <= bound, `served ${served.length} must not exceed the bound ${bound}`);
      assert.equal(served.length + (r.body.members as any[]).filter((m) => m.state === "withheld").length, 33);
      assert.equal(over.length, 33 - bound);
      assert.equal(r.body.unionComplete, false);
      // STATE, and this is the assertion the bound exists for: exactly `bound`
      // derivatives were read and registered, not one per crew member.
      assert.equal(
        app.store[REG].filter((g: any) => g.projection_id === "TripMemoryProjection").length,
        bound,
        "the fan-out itself must be bounded, not just the reported member list",
      );
      // The cut is deterministic, so a member is never served to one reader and
      // withheld from another.
      const sorted = [...served.map((m) => m.memberId)].sort();
      assert.deepEqual(served.map((m) => m.memberId), sorted);
      assert.ok(extra.length === 30);
    } finally { await app.close(); }
  });
});
