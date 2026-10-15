/**
 * memoryMineSearchPeopleBlocks — the owner's own "mine" search names a person
 * exactly when GET /memories/:id does: never a person blocked in either
 * direction (census-highlights-memories §BU; lane MEM-PRIV-FIX's §BQ.7 finding).
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * POST /memories/search with `intent: mine` reads the owner's
 * `MemoryTimelineProjection`. Each row carries `people`: the approved
 * participants' ids (`approvedTagsFor`). Nothing on that read consulted
 * `blocks`, so the owner was handed, by id, the people they had blocked and the
 * people who had blocked them; a `people` filter naming one of them matched;
 * and `deterministicMatchCount` and the `person_relevance` dimension betrayed
 * them with no id on the wire. GET /memories/:id, for the SAME owner and the
 * SAME Memory, hides them: §10 rule 1 (memoryParticipantVisibility.ts
 * `participantRungFor`) is BLOCK → HIDDEN, ahead of everything, the viewer's
 * ownership of the Memory included.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * runMemorySearch passes the same per-read `withholdPeople` hook the crew
 * search uses (PR #739's mechanism, `viewerPeopleWithholder`), so the people
 * filter, the ranking and the counts are computed over the rows as this viewer
 * may see them. Unreadable (an error, or a thrown read) ⇒ every person but the
 * viewer is withheld, and the answer says so (`peopleComplete: false`); a REAL
 * block is silent.
 *
 * Run: node --import tsx/esm --test src/test/memoryMineSearchPeopleBlocks.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
/** The owner blocked this person. */
const BLOCKED = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb10";
/** This person blocked the owner. */
const BLOCKER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb11";
/** Tagged, and blocked by nobody. */
const FRIEND = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb12";
/** Exists, and is tagged on nothing. */
const STRANGER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const M_BOTH = "dddddddd-dddd-dddd-dddd-dddddddddd20";
const M_BLOCKER_ONLY = "dddddddd-dddd-dddd-dddd-dddddddddd21";
const M_UNTAGGED = "dddddddd-dddd-dddd-dddd-dddddddddd22";
const M_FRIEND_ONLY = "dddddddd-dddd-dddd-dddd-dddddddddd23";
const REG = "memory_derivative_registry";

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Porto", caption: null,
    visibility: "private", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null,
    location_city: "Porto", location_country: "PT",
    location_lat: null, location_lng: null, canonical_location_id: null,
    starts_at: "2026-01-02T10:00:00.000Z", ends_at: null,
    state: "published", created_at: "2026-01-02T10:00:00.000Z",
    updated_at: "2026-01-02T10:00:00.000Z",
    ...over,
  };
}

const tag = (memory_id: string, tagged_user_id: string, status = "approved") => ({ memory_id, tagged_user_id, status });

function mineTables(opts: { withBlocks?: boolean } = {}): Record<string, any[]> {
  return {
    memories: [
      memory(M_BOTH, { title: "Porto dinner" }),
      // Same day, same place: the only person on it blocked the owner.
      memory(M_BLOCKER_ONLY, { title: "Porto last night" }),
      // Same day, same place, NO participants: what a withheld person must be indistinguishable from.
      memory(M_UNTAGGED, { title: "Porto last night" }),
      memory(M_FRIEND_ONLY, { title: "Porto bridge", starts_at: "2026-01-03T10:00:00.000Z" }),
    ],
    memory_items: [],
    memory_tags: [
      tag(M_BOTH, BLOCKED), tag(M_BOTH, FRIEND),
      tag(M_BLOCKER_ONLY, BLOCKER),
      tag(M_FRIEND_ONLY, FRIEND),
    ],
    memory_derivative_registry: [],
    profiles: [OWNER, BLOCKED, BLOCKER, FRIEND, STRANGER].map((id) => ({
      id, account_status: "active", name: id.slice(-2), handle: id.slice(-2), avatar_url: null,
    })),
    blocks: opts.withBlocks === false ? [] : [
      { blocker_id: OWNER, blocked_id: BLOCKED },
      { blocker_id: BLOCKER, blocked_id: OWNER },
    ],
    feature_flags: [],
  };
}

/**
 * The table-backed double memorySearchRoute.test.ts drives the search with
 * (writes are applied, so a registered derivative can be read back), plus two
 * ways for ONE table's reads to fail: RESOLVED with `{ error }` the way
 * supabase-js fails (`failReads`), and REJECTED the way a torn-down client or a
 * fetch that never reached PostgREST fails (`throwReads`). `blockReads` counts
 * the reads of `blocks`, so a search whose rows name nobody can be shown to
 * make none.
 */
function makeClient(store: Record<string, any[]>, failReads: Set<string>, throwReads: Set<string>, counter: { blockReads: number }) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "upsert" | "update" | "delete" | null = null;
    let payload: any = null;
    let conflict: string[] = [];
    const obj: any = {
      select(_c?: string, _o?: any) { if (isWrite) selectedAfterWrite = true; return obj; },
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
      if (!isWrite && table === "blocks") counter.blockReads += 1;
      if (!isWrite && throwReads.has(table)) throw new Error(`fetch failed (${table})`);
      if (!isWrite && failReads.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
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
      const matched = all.filter((r) => filters.every((f) => f(r)));
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
      return { data: matched, error: null, count: null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: async () => ({ data: null, error: { message: "no rpc" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App { baseUrl: string; store: Record<string, any[]>; counter: { blockReads: number }; close: () => Promise<void> }

async function startApp(opts: { store?: Record<string, any[]>; failReads?: Set<string>; throwReads?: Set<string> } = {}): Promise<App> {
  const store = opts.store ?? mineTables();
  const counter = { blockReads: 0 };
  _setTestClient(makeClient(store, opts.failReads ?? new Set(), opts.throwReads ?? new Set(), counter) as any, true);
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
        baseUrl: `http://127.0.0.1:${port}`, store, counter,
        close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
      });
    });
    srv.on("error", reject);
  });
}

async function call(app: App, method: string, path: string, body?: unknown) {
  const res = await fetch(app.baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const mine = (app: App, extra: Record<string, unknown> = {}) => call(app, "POST", "/api/memories/search", { intent: { kind: "mine" }, ...extra });
const hitIds = (b: any) => ((b?.hits ?? []) as any[]).map((h) => h.memoryId).sort();
const peopleOf = (b: any, memoryId: string): string[] =>
  [...((((b?.hits ?? []) as any[]).find((h) => h.memoryId === memoryId)?.row?.people ?? []) as string[])].sort();
const everyoneNamed = (b: any) => new Set(((b?.hits ?? []) as any[]).flatMap((h) => (h.row?.people ?? []) as string[]));
/** Everything on a search answer except the hits' rows: what a filter selected, and how it was counted. */
const shape = (b: any) => ({
  hits: hitIds(b),
  deterministicMatchCount: b.deterministicMatchCount,
  peopleComplete: b.peopleComplete,
  audienceWithheldCount: b.audienceWithheldCount,
});
const ALL = [M_BLOCKER_ONLY, M_BOTH, M_FRIEND_ONLY, M_UNTAGGED].sort();

describe("§BU the owner's own 'mine' search honours blocks between the owner and a participant", () => {
  it("CONTROL: with no block, the timeline names every participant and a people filter matches them", async () => {
    const app = await startApp({ store: mineTables({ withBlocks: false }) });
    try {
      const r = await mine(app);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(hitIds(r.body), ALL);
      assert.deepEqual(peopleOf(r.body, M_BOTH), [BLOCKED, FRIEND].sort());
      assert.deepEqual(peopleOf(r.body, M_BLOCKER_ONLY), [BLOCKER]);
      const f = await mine(app, { people: [BLOCKER] });
      assert.deepEqual(hitIds(f.body), [M_BLOCKER_ONLY], "a people filter CAN match this person");
      assert.equal(r.body.peopleComplete, true);
    } finally { await app.close(); }
  });

  it("a person the owner blocked, and a person who blocked the owner, are named on NO row; every Memory is still served", async () => {
    const app = await startApp();
    try {
      const r = await mine(app);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const named = everyoneNamed(r.body);
      assert.ok(!named.has(BLOCKED), "the person the owner blocked was named");
      assert.ok(!named.has(BLOCKER), "the person who blocked the owner was named");
      assert.deepEqual(peopleOf(r.body, M_BOTH), [FRIEND]);
      assert.deepEqual(peopleOf(r.body, M_BLOCKER_ONLY), []);
      assert.deepEqual(peopleOf(r.body, M_FRIEND_ONLY), [FRIEND]);
      assert.deepEqual(hitIds(r.body), ALL, "a block withholds a PERSON, never the owner's own Memory");
    } finally { await app.close(); }
  });

  it("the search names exactly the people GET /memories/:id shows the same owner, Memory by Memory", async () => {
    for (const withBlocks of [false, true]) {
      const app = await startApp({ store: mineTables({ withBlocks }) });
      try {
        const r = await mine(app);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        for (const id of ALL) {
          const d = await call(app, "GET", `/api/memories/${id}`);
          assert.equal(d.status, 200, JSON.stringify(d.body));
          const detailPeople = ((d.body.memory.tags ?? []) as any[]).map((t) => t.userId).sort();
          assert.deepEqual(peopleOf(r.body, id), detailPeople, `${withBlocks ? "with" : "without"} blocks, Memory ${id}: search and detail disagree`);
        }
      } finally { await app.close(); }
    }
  });

  it("a REAL block is silent: completeness and counts are exactly those of the no-block answer", async () => {
    const free = await startApp({ store: mineTables({ withBlocks: false }) });
    const blocked = await startApp();
    try {
      const a = await mine(free);
      const b = await mine(blocked);
      assert.deepEqual(shape(b.body), shape(a.body));
      assert.equal(b.body.peopleComplete, true, "a block is never announced");
    } finally { await free.close(); await blocked.close(); }
  });

  it("a people filter naming a blocked person matches NOTHING, and its counts are a never-tagged stranger's", async () => {
    const app = await startApp();
    try {
      for (const p of [BLOCKER, BLOCKED]) {
        const r = await mine(app, { people: [p] });
        const s = await mine(app, { people: [STRANGER] });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(hitIds(r.body), [], `a filter on ${p} matched`);
        assert.equal(r.body.deterministicMatchCount, 0);
        assert.deepEqual(shape(r.body), shape(s.body), "indistinguishable from a person who was never there");
      }
      const pair = await mine(app, { people: [FRIEND, BLOCKED] });
      const pairStranger = await mine(app, { people: [FRIEND, STRANGER] });
      assert.deepEqual(shape(pair.body), shape(pairStranger.body));
      // CONTROL inside the case: the unblocked participant IS matchable.
      assert.deepEqual(hitIds((await mine(app, { people: [FRIEND] })).body), [M_BOTH, M_FRIEND_ONLY].sort());
    } finally { await app.close(); }
  });

  it("the ranking does not betray a withheld participant: a row whose only person blocked the owner ranks as an untagged row", async () => {
    const app = await startApp();
    try {
      const r = await mine(app);
      const hit = (id: string) => (r.body.hits as any[]).find((h) => h.memoryId === id);
      assert.equal(hit(M_BLOCKER_ONLY).dimensions.person_relevance, hit(M_UNTAGGED).dimensions.person_relevance);
      assert.deepEqual(hit(M_BLOCKER_ONLY).dimensions, hit(M_UNTAGGED).dimensions);
      assert.equal(hit(M_BLOCKER_ONLY).score, hit(M_UNTAGGED).score);
    } finally { await app.close(); }
  });

  it("the narrowing is per READ: the registered timeline derivative still names the person, so lifting the block needs no rebuild", async () => {
    const app = await startApp();
    try {
      await mine(app);
      const reg = app.store[REG].find((g: any) => g.projection_id === "MemoryTimelineProjection" && g.owner_id === OWNER);
      assert.ok(reg, "the owner's timeline derivative was registered");
      const row = (reg.payload_json as any[]).find((x) => x.memory_id === M_BOTH);
      assert.deepEqual([...row.people].sort(), [BLOCKED, FRIEND].sort());
      app.store.blocks = [];
      assert.deepEqual(peopleOf((await mine(app)).body, M_BOTH), [BLOCKED, FRIEND].sort(), "unblocked: named again on the next read");
    } finally { await app.close(); }
  });
});

describe("§BU an unreadable block state withholds every participant, and says so", () => {
  for (const [label, opts] of [
    ["RESOLVED with an error", { failReads: new Set(["blocks"]) }],
    ["THROWN (the read rejected)", { throwReads: new Set(["blocks"]) }],
  ] as const) {
    it(`the blocks read ${label}: every Memory is served, nobody is named, and peopleComplete is false`, async () => {
      const app = await startApp({ store: mineTables({ withBlocks: false }), ...opts });
      try {
        const r = await mine(app);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(hitIds(r.body), ALL, "a person's block state is not the Memory's");
        assert.deepEqual([...everyoneNamed(r.body)], [], "nobody may be named while blocks are unknown");
        assert.equal(r.body.peopleComplete, false);
        const f = await mine(app, { people: [FRIEND] });
        assert.deepEqual(hitIds(f.body), [], "a people filter cannot match a person whose block state is unknown");
        assert.equal(f.body.peopleComplete, false, "and the empty answer says why it may be empty");
      } finally { await app.close(); }
    });
  }

  it("CONTROL: a timeline that names nobody makes no block read at all, and stays complete when blocks is unreadable", async () => {
    const store = mineTables({ withBlocks: false });
    store.memory_tags = [];
    const app = await startApp({ store, failReads: new Set(["blocks"]) });
    try {
      const r = await mine(app);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.peopleComplete, true);
      assert.equal(app.counter.blockReads, 0, "a read with no named person is not a block question");
    } finally { await app.close(); }
  });

  it("CONTROL: a pending or withdrawn tag never reaches the timeline, so it needs no block read either", async () => {
    const store = mineTables({ withBlocks: false });
    store.memory_tags = [tag(M_BOTH, FRIEND, "pending"), tag(M_BLOCKER_ONLY, BLOCKER, "removed")];
    const app = await startApp({ store, failReads: new Set(["blocks"]) });
    try {
      const r = await mine(app);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([...everyoneNamed(r.body)], []);
      assert.equal(r.body.peopleComplete, true);
    } finally { await app.close(); }
  });
});
