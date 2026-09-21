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

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VIEWER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const M_PUB = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const M_PRIV = "dddddddd-dddd-dddd-dddd-dddddddddd02";
const M_MINE = "dddddddd-dddd-dddd-dddd-dddddddddd03";

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
  };
}

function makeClient(store: Record<string, any[]>, failReads: Set<string>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
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
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
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

async function startApp(opts: { failReads?: Set<string>; store?: Record<string, any[]> } = {}): Promise<App> {
  const store = opts.store ?? tables();
  _setTestClient(makeClient(store, opts.failReads ?? new Set()) as any, true);
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

  it("says plainly which namespace this surface cannot reach, and why", async () => {
    // Census H113's ceiling, on the wire rather than only in a comment: a
    // crew-wide derivative is a product decision, not a wiring gap.
    const app = await startApp();
    try {
      const r = await search(app, VIEWER, { intent: { kind: "mine" } });
      assert.deepEqual(r.body.capabilities.namespaces, ["PRIVATE_PERSONAL", "PUBLIC"]);
      assert.ok("SHARED_CREW" in r.body.capabilities.unreachableNamespaces);
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
