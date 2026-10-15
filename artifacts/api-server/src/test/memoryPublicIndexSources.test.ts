/**
 * census-highlights-memories H203 (B58 cluster MEM-INDEX) — the PUBLIC index is
 * built from a privacy-filtered read, and the outbox worker keeps it from the
 * event payload.
 *
 * SPEC §23 "Search/index workers consume privacy-filtered event payloads where
 * possible rather than raw entire rows"; §28.6 "Never expose private canonical
 * Memory records to public search and rely on post-filtering."
 *
 * THE FAKE RECORDS EVERY QUERY: the table, the columns asked for, and every row
 * the database handed back. The assertions are on THAT log, not on the output:
 * the output of the public index was already right on main (its builder
 * filters); what was wrong is what was READ to build it.
 *
 * Two kinds of import. Everything the RED-ON-MAIN cases call exists on main
 * (rebuildProjection, projectionStaleness, drainMemoryOutbox), so on main this
 * file loads and those cases fail on their assertions. What this cluster adds
 * (publicIndexSources.ts, the consumer's new exports) is imported inside the
 * cases that need it.
 *
 * Offline: no database, no network, no listening socket.
 * Run: node --import tsx/esm --test src/test/memoryPublicIndexSources.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  rebuildProjection,
  projectionStaleness,
  deriveProjection,
  DERIVATIVE_REGISTRY_TABLE,
  isDeletionRevocation,
} from "../services/memoryProjections/derivativeRegistry.js";
import { drainMemoryOutbox, OUTBOX_CLAIM_FN, OUTBOX_ACK_FN, OUTBOX_FAIL_FN } from "../services/memoryProjections/outboxConsumer.js";
import { getProjectionDefinition, scopeKeyOf } from "../services/memoryProjections/projectionRegistry.js";
// The event store is addressed by its boundary's own name (lib/memoryOutbox.ts), never a second spelling of it.
import { MEMORY_EVENT_TABLE } from "../lib/memoryOutbox.js";

// ── the world ────────────────────────────────────────────────────────────────

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TRIP = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PLACE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const PUB_A = "11111111-1111-4111-8111-111111111111";
const PUB_B = "22222222-2222-4222-8222-222222222222";
const PRIV = "33333333-3333-4333-8333-333333333333";
const FRIENDS = "44444444-4444-4444-8444-444444444444";
const DRAFT = "55555555-5555-4555-8555-555555555555";
const GONE = "66666666-6666-4666-8666-666666666666";
const ARCH = "77777777-7777-4777-8777-777777777777";
const KEPT = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-10-14T12:00:00.000Z");

const PUBLIC_SCOPE = { owner_id: OWNER, viewer_id: null, trip_id: null, place_id: null, person_id: null };
const PUBLIC_KEY = scopeKeyOf("PublicMemoryProjection", PUBLIC_SCOPE);

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: `title-${id.slice(0, 4)}`, caption: `caption-${id.slice(0, 4)}`,
    visibility: "public", state: "published", trip_id: TRIP, event_id: null, place_id: PLACE,
    starts_at: "2026-03-02T19:00:00.000Z", ends_at: "2026-03-02T21:00:00.000Z",
    created_at: "2026-03-02T22:00:00.000Z", updated_at: "2026-03-03T08:00:00.000Z",
    location_city: "Lisbon", location_country: "Portugal", location_lat: 38.7071, location_lng: -9.1355,
    canonical_location_id: PLACE, allowed_user_ids: [FRIEND], hidden_user_ids: [STRANGER],
    ...over,
  };
}

/** Every kind of Memory an owner has, and one row that breaks 3671's rule (a public KEEP_PRIVATE_FOREVER). */
function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    memories: [
      memory(PUB_A),
      memory(PUB_B, { starts_at: null, created_at: "2026-02-01T10:00:00.000Z", location_city: "Porto", trip_id: null }),
      memory(PRIV, { visibility: "only_me", title: "PRIVATE-TITLE", caption: "PRIVATE-CAPTION" }),
      memory(FRIENDS, { visibility: "friends_only", title: "FRIENDS-TITLE" }),
      memory(DRAFT, { state: "draft", title: "DRAFT-TITLE" }),
      memory(GONE, { state: "deleted", title: "DELETED-TITLE" }),
      memory(ARCH, { state: "archived", title: "ARCHIVED-TITLE" }),
      memory(KEPT, { title: "KEPT-TITLE" }),
    ],
    memory_items: [
      { memory_id: PUB_A, media_url: "https://cdn.example/a0.jpg", media_type: "image", position: 0, visibility: null },
      { memory_id: PUB_A, media_url: "https://cdn.example/a1-hidden.jpg", media_type: "image", position: 1, visibility: "only_me" },
      { memory_id: PRIV, media_url: "https://cdn.example/private.jpg", media_type: "image", position: 0, visibility: null },
      { memory_id: KEPT, media_url: "https://cdn.example/kept.jpg", media_type: "image", position: 0, visibility: null },
    ],
    memory_tags: [
      { memory_id: PUB_A, tagged_user_id: FRIEND, status: "approved" },
      { memory_id: PRIV, tagged_user_id: FRIEND, status: "approved" },
    ],
    memory_resurfacing_preferences: [
      { owner_id: OWNER, memory_id: PRIV, control: "KEEP_PRIVATE_FOREVER" },
      { owner_id: OWNER, memory_id: KEPT, control: "KEEP_PRIVATE_FOREVER" },
      { owner_id: OWNER, memory_id: PUB_B, control: "DO_NOT_RESURFACE" },
    ],
    [MEMORY_EVENT_TABLE]: [],
    [DERIVATIVE_REGISTRY_TABLE]: [],
  };
}

// ── the recording fake ───────────────────────────────────────────────────────

interface Query { table: string; mode: string; columns: string[]; rows: any[] }
interface FakeOpts {
  /** A READ of this table resolves with this error (supabase-js resolves; it does not throw). */
  failRead?: Record<string, { code?: string; message: string }>;
  /** A WRITE for which this answers true resolves with an error. */
  failWrite?: (table: string, mode: string, payload: any) => boolean;
  /** A READ this answers with an error for (by table, columns and `.eq` filters) resolves with it — finer than `failRead`. */
  failQuery?: (q: { table: string; columns: string[]; eqs: Record<string, unknown> }) => { code?: string; message: string } | null;
  /** A READ of this table resolves with this body and no error (a shape PostgREST should never send). */
  weird?: Record<string, unknown>;
  claim?: any[];
}

let gen = 0;
function makeDb(store: Record<string, any[]>, opts: FakeOpts = {}) {
  const log: Query[] = [];
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let mode = "select"; let columns: string[] = []; let payload: any = null; let onConflict: string[] = []; let wantRows = false; let single = false;
    const eqs: Record<string, unknown> = {};
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select(cols?: string) { if (mode !== "select") wantRows = true; else columns = String(cols ?? "*").split(",").map((c) => c.trim()); return obj; },
      upsert(d: any, o?: { onConflict?: string }) { mode = "upsert"; payload = d; onConflict = (o?.onConflict ?? "").split(",").filter(Boolean); return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      eq: (c: string, v: any) => { eqs[c] = v; return f((r) => r[c] === v); },
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      contains: (c: string, vs: any[]) => f((r) => Array.isArray(r[c]) && vs.every((v) => r[c].includes(v))),
      order() { return obj; }, limit() { return obj; },
      maybeSingle() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      if (mode === "select" && opts.failRead?.[table]) { log.push({ table, mode, columns, rows: [] }); return { data: null, error: opts.failRead[table] }; }
      const queryError = mode === "select" ? opts.failQuery?.({ table, columns, eqs }) ?? null : null;
      if (queryError) { log.push({ table, mode, columns, rows: [] }); return { data: null, error: queryError }; }
      if (mode === "select" && opts.weird && table in opts.weird) { log.push({ table, mode, columns, rows: [] }); return { data: opts.weird[table], error: null }; }
      if (mode !== "select" && opts.failWrite?.(table, mode, payload)) return { data: null, error: { message: `${table} ${mode} failed`, code: "57014" } };
      const all = (store[table] ??= []);
      if (mode === "upsert") {
        const written: any[] = [];
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const idx = all.findIndex((x) => onConflict.every((k) => x[k] === r[k]));
          if (idx >= 0) { all[idx] = { ...all[idx], ...r }; written.push(all[idx]); } else { const row = { id: `reg-${++gen}`, ...r }; all.push(row); written.push(row); }
        }
        return { data: wantRows ? written.map((x) => ({ ...x })) : null, error: null };
      }
      const matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") { for (const r of matched) Object.assign(r, payload); return { data: wantRows ? matched.map((x) => ({ ...x })) : null, error: null }; }
      // A real SELECT returns the columns asked for, and only those.
      const shaped = matched.map((r) => (columns.includes("*") ? { ...r } : Object.fromEntries(columns.filter((c) => c in r).map((c) => [c, r[c]]))));
      log.push({ table, mode, columns, rows: shaped });
      if (single) return { data: shaped[0] ?? null, error: null };
      return { data: shaped, error: null };
    }
    return obj;
  }
  const client: any = {
    log,
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: any) => {
      if (fn === OUTBOX_CLAIM_FN) return { data: opts.claim ?? [], error: null };
      if (fn === OUTBOX_ACK_FN) return { data: (args?.p_ids ?? []).length, error: null };
      if (fn === OUTBOX_FAIL_FN) return { data: 1, error: null };
      return { data: null, error: { message: `rpc ${fn} not modelled` } };
    },
  };
  return client;
}

/** The ids of rows that are about a Memory, in every table a query read. */
const memoryIdsIn = (q: Query) => q.rows.map((r) => (q.table === "memories" ? r.id : r.memory_id)).filter((id) => typeof id === "string");
const PUBLIC_ADMITTED = new Set([PUB_A, PUB_B]);
const PUBLIC_PUBLISHED = new Set([PUB_A, PUB_B, KEPT]);
const FORBIDDEN_MEMORY_COLUMNS = ["location_lat", "location_lng", "allowed_user_ids", "hidden_user_ids", "*"];

/**
 * THE PROPERTY. Every query the public index made: no `memories` row that is
 * not public AND published, none of the four columns the plan names (nor `*`),
 * no tag, no photo URL, and no row in ANY table about a Memory the index does
 * not admit.
 */
function assertPublicReadOnly(log: Query[], label: string) {
  assert.ok(log.some((q: Query) => q.table === "memories"), `${label}: precondition — memories was read`);
  for (const q of log) {
    if (q.table === "memories") {
      for (const c of FORBIDDEN_MEMORY_COLUMNS) assert.ok(!q.columns.includes(c), `${label}: memories read selected ${c} (${q.columns.join(", ")})`);
      for (const r of q.rows) {
        assert.equal(r.visibility, "public", `${label}: a ${r.visibility} Memory (${r.id}) was fetched`);
        assert.equal(r.state, "published", `${label}: a ${r.state} Memory (${r.id}) was fetched`);
      }
    }
    assert.notEqual(q.table, "memory_tags", `${label}: the public index read tags (it names nobody)`);
    if (q.table === "memory_items") assert.ok(!q.columns.includes("media_url"), `${label}: the public index read photo URLs`);
    for (const id of memoryIdsIn(q)) {
      assert.ok(PUBLIC_PUBLISHED.has(id), `${label}: ${q.table} returned a row about ${id}, which is not a public, published Memory`);
    }
  }
}

const reg = (store: Record<string, any[]>, key: string) => store[DERIVATIVE_REGISTRY_TABLE].find((r) => r.scope_key === key);
const carries = (row: any, id: string) => (row?.source_memory_ids ?? []).includes(id) || (row?.payload_json ?? []).some((p: any) => p.memory_id === id);

// ═════════════════════════════════════════════════════════════════════════════

describe("H203 — the public index reads only what it may publish (red on main)", () => {
  it("a PublicMemoryProjection REBUILD fetches no private, unpublished or hidden-from-public row, and no coordinate or allow/hide list", async () => {
    const store = seed();
    const db = makeDb(store);
    const built = await rebuildProjection(db, "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.ok(built.ok, `the rebuild succeeds: ${!built.ok ? built.detail : ""}`);
    assertPublicReadOnly(db.log, "rebuild");
    // The private Memory's words were never in the process, so they cannot be at rest either.
    const atRest = JSON.stringify(reg(store, PUBLIC_KEY));
    for (const leaked of ["PRIVATE-TITLE", "FRIENDS-TITLE", "DRAFT-TITLE", "DELETED-TITLE", "ARCHIVED-TITLE", PRIV, FRIENDS, DRAFT, GONE, ARCH]) {
      assert.ok(!atRest.includes(leaked), `the public registration holds ${leaked}`);
    }
  });

  it("the STALENESS check a public search runs reads the same way — and finds the index FRESH", async () => {
    const store = seed();
    assert.ok((await rebuildProjection(makeDb(store), "PublicMemoryProjection", PUBLIC_SCOPE, NOW)).ok);
    const db = makeDb(store);
    const s = await projectionStaleness(db, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(s.ok);
    assert.equal(s.ok && s.value.state, "FRESH", "the build and the check read the same rows, so a fresh index is FRESH");
    assertPublicReadOnly(db.log, "staleness");
  });

  it("KEEP_PRIVATE_FOREVER stays out: a public, published Memory carrying it is never in the index (a row some path wrote around 3671's only_me rule)", async () => {
    const store = seed();
    const built = await rebuildProjection(makeDb(store), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.ok(built.ok);
    assert.deepEqual(built.ok && built.value.rows.map((r) => r.memory_id), [PUB_A, PUB_B]);
    assert.ok(!carries(reg(store, PUBLIC_KEY), KEPT));
    // …and clearing it makes the index STALE, so the Memory comes back on the next build.
    store.memory_resurfacing_preferences = store.memory_resurfacing_preferences.filter((r) => r.memory_id !== KEPT);
    const s = await projectionStaleness(makeDb(store), "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.equal(s.ok && s.value.state, "STALE");
  });

  it("hidden photos (3672) stay out of the count; a control that does not suppress public_projection (DO_NOT_RESURFACE) does not remove a Memory", async () => {
    const built = await rebuildProjection(makeDb(seed()), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.ok(built.ok);
    const a = built.ok && built.value.rows.find((r) => r.memory_id === PUB_A);
    assert.equal(a && a.media_count, 1, "two photos, one kept only_me: the public index counts 1");
    assert.ok(built.ok && built.value.rows.some((r) => r.memory_id === PUB_B), "DO_NOT_RESURFACE is not an unpublish");
  });

  it("FAIL CLOSED: unreadable controls REFUSE the public build — a KEEP_PRIVATE_FOREVER that could not be read is never published", async () => {
    const store = seed();
    const r = await rebuildProjection(makeDb(store, { failRead: { memory_resurfacing_preferences: { code: "57014", message: "statement timeout" } } }), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "source_unavailable");
    assert.equal(!r.ok && r.table, "memory_resurfacing_preferences");
    assert.equal(reg(store, PUBLIC_KEY), undefined, "nothing was registered");
  });

  it("3671 not applied (the table is absent): no control can exist, and the index builds", async () => {
    const r = await rebuildProjection(makeDb(seed(), { failRead: { memory_resurfacing_preferences: { code: "42P01", message: 'relation "public.memory_resurfacing_preferences" does not exist' } } }), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.value.rows.map((x) => x.memory_id), [PUB_A, KEPT, PUB_B], "with no controls table, nothing is KEEP_PRIVATE_FOREVER");
  });

  it("FAIL CLOSED (unchanged): an unreadable photo audience refuses the public build", async () => {
    const r = await rebuildProjection(makeDb(seed(), { failRead: { memory_items: { code: "57014", message: "timeout" } } }), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.equal(r.ok, false);
  });

  it("a failed memories read is a refusal, never an empty index (§28.11)", async () => {
    const store = seed();
    const r = await rebuildProjection(makeDb(store, { failRead: { memories: { code: "57014", message: "timeout" } } }), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.table, "memories");
    assert.equal(!r.ok && r.retryable, true, "an outage is retryable");
    assert.equal(reg(store, PUBLIC_KEY), undefined);
    const absent = await rebuildProjection(makeDb(seed(), { failRead: { memories: { code: "42P01", message: 'relation "public.memories" does not exist' } } }), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.equal(!absent.ok && absent.retryable, false, "a missing table is not");
    const shapeless = await rebuildProjection(makeDb(seed(), { weird: { memories: { rows: [] } } }), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.equal(shapeless.ok, false, "a body that is not a row array is a refusal, never an empty index");
    assert.equal(!shapeless.ok && shapeless.table, "memories");
  });

  it("the ITEMS read and the hidden-photo read fail closed each on its own (a count over items nobody could read is never published)", async () => {
    const itemsOnly = (q: { table: string; eqs: Record<string, unknown> }) => (q.table === "memory_items" && !("visibility" in q.eqs) ? { code: "57014", message: "items timeout" } : null);
    const hiddenOnly = (q: { table: string; eqs: Record<string, unknown> }) => (q.table === "memory_items" && "visibility" in q.eqs ? { code: "57014", message: "hidden timeout" } : null);
    for (const [label, failQuery] of [["items", itemsOnly], ["hidden photos", hiddenOnly]] as const) {
      const store = seed();
      const r = await rebuildProjection(makeDb(store, { failQuery }), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
      assert.equal(r.ok, false, `${label} unreadable must refuse`);
      assert.equal(!r.ok && r.table, "memory_items", label);
      assert.equal(reg(store, PUBLIC_KEY), undefined, label);
    }
  });
});

describe("H203 — no regression: for an owner whose every Memory is public, the index is byte-identical to main's", () => {
  // Captured on origin/main 665a5d102 by running this world through main's
  // rebuildProjection. Both trees must produce exactly this.
  function allPublic(): Record<string, any[]> {
    const s = seed();
    s.memories = s.memories.filter((m) => m.id === PUB_A || m.id === PUB_B);
    s.memory_items = s.memory_items.filter((i) => i.memory_id === PUB_A);
    s.memory_tags = s.memory_tags.filter((t) => t.memory_id === PUB_A);
    s.memory_resurfacing_preferences = s.memory_resurfacing_preferences.filter((c) => c.memory_id === PUB_B);
    return s;
  }
  const MAIN_ROWS = [
    { memory_id: PUB_A, owner_id: OWNER, occurred_at: "2026-03-02T19:00:00.000Z", title: "title-1111", caption: "caption-1111", location_city: "Lisbon", location_country: "Portugal", media_count: 1 },
    { memory_id: PUB_B, owner_id: OWNER, occurred_at: "2026-02-01T10:00:00.000Z", title: "title-2222", caption: "caption-2222", location_city: "Porto", location_country: "Portugal", media_count: 0 },
  ];
  const MAIN_VERSION = "v1:2:b3f1a297e776f42c";
  const MAIN_VERSION_JSON = {
    "hidden-items": `${PUB_A}#1`,
    [`control:${PUB_B}`]: "DO_NOT_RESURFACE",
    [PUB_A]: "2026-03-03T08:00:00.000Z",
    [PUB_B]: "2026-03-03T08:00:00.000Z",
  };

  it("rows, contributors and source version equal main's", async () => {
    const store = allPublic();
    const built = await rebuildProjection(makeDb(store), "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.ok(built.ok);
    const r = reg(store, PUBLIC_KEY);
    assert.equal(JSON.stringify(r.payload_json), JSON.stringify(MAIN_ROWS), "the payload, byte for byte");
    assert.deepEqual(r.source_memory_ids, [PUB_A, PUB_B]);
    assert.equal(r.source_version, MAIN_VERSION);
    assert.equal(JSON.stringify(r.source_version_json), JSON.stringify(MAIN_VERSION_JSON));
    assert.deepEqual([r.audience, r.destination, r.builder_version, r.row_count, r.revocation_state], ["PUBLIC", "public.social_search", "public@1", 2, "ACTIVE"]);
  });
});

describe("H203 — the outbox worker keeps the PUBLIC index from the event payload (red on main)", () => {
  function claimed(over: Record<string, unknown> = {}) {
    return { id: 1, event_id: "e-1", memory_id: PUB_A, highlight_id: null, type: "memory.visibility_changed", created_at: "2026-10-14T11:59:00.000Z", attempts: 1, locked_until: null, ...over };
  }
  function event(eventId: string, payload: unknown) {
    return { event_id: eventId, memory_id: PUB_A, sequence: 1, type: "memory.visibility_changed", payload_json: payload, occurred_at: "2026-10-14T11:59:00.000Z" };
  }
  const NARROWED = { command_type: "CHANGE_VISIBILITY", from_state: "ACTIVE", to_state: "ACTIVE", visibility: "only_me", refs: { memory_id: PUB_A } };
  const WIDENED = { ...NARROWED, visibility: "public" };

  /** PUB_A was public and the public index carries it; then its owner narrowed it to only_me. */
  async function narrowedWorld() {
    const store = seed();
    assert.ok((await rebuildProjection(makeDb(store), "PublicMemoryProjection", PUBLIC_SCOPE, NOW)).ok);
    assert.ok(carries(reg(store, PUBLIC_KEY), PUB_A), "precondition: the public index carries PUB_A");
    store.memories.find((m) => m.id === PUB_A)!.visibility = "only_me";
    store.memories.find((m) => m.id === PUB_A)!.updated_at = "2026-10-14T11:59:00.000Z";
    return store;
  }

  it("a drained narrowing rebuilds the index the public search SERVES (`PublicMemoryProjection|owner:<id>`) — it no longer carries the Memory", async () => {
    const store = await narrowedWorld();
    store[MEMORY_EVENT_TABLE]!.push(event("e-1", NARROWED));
    const d = await drainMemoryOutbox(makeDb(store, { claim: [claimed()] }), { now: NOW });
    assert.ok(d.ok, d.detail ?? "");
    const pub = reg(store, PUBLIC_KEY);
    assert.equal(pub.revocation_state, "ACTIVE", "rebuilt, not revoked: H-4");
    assert.ok(!carries(pub, PUB_A), "the served public index still carries the narrowed Memory");
    assert.deepEqual(pub.payload_json.map((r: any) => r.memory_id), [PUB_B]);
  });

  it("the worker writes NO 'public' registration keyed to the owner as viewer — the artifact nobody serves, which counted hidden photos", async () => {
    const store = seed();
    const d = await drainMemoryOutbox(makeDb(store, { claim: [claimed({ type: "memory.created" })] }), { now: NOW });
    assert.ok(d.ok, d.detail ?? "");
    const publics = store[DERIVATIVE_REGISTRY_TABLE].filter((r) => r.projection_id === "PublicMemoryProjection");
    assert.deepEqual(publics.map((r) => r.scope_key), [PUBLIC_KEY]);
    assert.equal(publics[0].payload_json.find((r: any) => r.memory_id === PUB_A)?.media_count, 1, "the hidden photo is not counted");
    // The owner's own surfaces are untouched: still at the event's scope, still counting both photos.
    const timeline = store[DERIVATIVE_REGISTRY_TABLE].find((r) => r.projection_id === "MemoryTimelineProjection");
    assert.ok(timeline && timeline.scope_key.includes(`viewer:${OWNER}`));
    assert.equal(timeline.payload_json.find((r: any) => r.memory_id === PUB_A)?.media_count, 2);
  });

  it("the narrowing's PUBLIC rebuild never reads the narrowed Memory — no body, no coordinate, no list", async () => {
    const { rebuildSubscribedProjection } = await import("../services/memoryProjections/outboxConsumer.js");
    const store = await narrowedWorld();
    store[MEMORY_EVENT_TABLE]!.push(event("e-1", NARROWED));
    const db = makeDb(store);
    const r = await rebuildSubscribedProjection(db, claimed() as any, "PublicMemoryProjection", { owner_id: OWNER, viewer_id: OWNER, trip_id: TRIP, place_id: PLACE }, NOW);
    assert.ok(r.ok);
    PUBLIC_PUBLISHED.delete(PUB_A);
    try { assertPublicReadOnly(db.log, "narrowing rebuild"); } finally { PUBLIC_PUBLISHED.add(PUB_A); }
    assert.ok(!db.log.some((q: Query) => q.table === "memories" && memoryIdsIn(q).includes(PUB_A)), "the narrowed Memory's row was fetched");
  });

  describe("H-4's fallback: a FAILED public rebuild after the payload says the Memory left the index REVOKES it — from the payload and the registry, never the row", () => {
    const failPublicUpsert = (table: string, mode: string, payload: any) =>
      table === DERIVATIVE_REGISTRY_TABLE && mode === "upsert" && payload?.projection_id === "PublicMemoryProjection";

    async function attempt(payloadRow: unknown | "absent", over: Record<string, unknown> = {}, failRead?: FakeOpts["failRead"]) {
      const { rebuildSubscribedProjection } = await import("../services/memoryProjections/outboxConsumer.js");
      const store = await narrowedWorld();
      if (payloadRow !== "absent") store[MEMORY_EVENT_TABLE]!.push(event("e-1", payloadRow));
      const db = makeDb(store, { failWrite: failPublicUpsert, failRead });
      const r = await rebuildSubscribedProjection(db, claimed(over) as any, "PublicMemoryProjection", { owner_id: OWNER, viewer_id: OWNER, trip_id: TRIP, place_id: null }, NOW);
      return { r, store, db, pub: reg(store, PUBLIC_KEY) };
    }

    it("narrowed to only_me ⇒ REVOKED and emptied, and the event is complete", async () => {
      const { r, pub, db } = await attempt(NARROWED);
      assert.ok(r.ok && r.value.was_revoked, "revoked instead");
      assert.equal(pub.revocation_state, "REVOKED");
      assert.deepEqual(pub.payload_json, []);
      assert.equal(pub.row_count, 0);
      assert.equal(pub.revocation_reason, "memory_visibility_changed: re-derivation failed");
      assert.ok(db.log.some((q: Query) => q.table === MEMORY_EVENT_TABLE && q.columns.join() === "payload_json"), "the decision read the payload");
      assert.ok(!db.log.some((q: Query) => q.table === "memories" && memoryIdsIn(q).includes(PUB_A)), "the decision read the Memory");
    });

    it("WIDENED (the payload says public) ⇒ NOT revoked: the failure stands and the outbox retries it", async () => {
      const { r, pub } = await attempt(WIDENED);
      assert.equal(r.ok, false);
      assert.equal(pub.revocation_state, "ACTIVE");
    });

    it("a hide-list-only CHANGE_VISIBILITY (no audience stated) ⇒ NOT revoked", async () => {
      const { r, pub } = await attempt({ ...NARROWED, visibility: null });
      assert.equal(r.ok, false);
      assert.equal(pub.revocation_state, "ACTIVE");
    });

    it("ARCHIVED (to_state) ⇒ revoked; DELETED ⇒ revoked with H-5's revivable reason", async () => {
      const arch = await attempt({ ...NARROWED, command_type: "ARCHIVE_MEMORY", to_state: "ARCHIVED", visibility: null }, { type: "memory.archived" });
      assert.equal(arch.pub.revocation_state, "REVOKED");
      assert.equal(arch.pub.revocation_reason, "memory_archived: re-derivation failed");
      const del = await attempt({ ...NARROWED, command_type: "DELETE_MEMORY", to_state: "DELETED", visibility: null }, { type: "memory.deleted" });
      assert.equal(del.pub.revocation_state, "REVOKED");
      assert.ok(isDeletionRevocation(del.pub.revocation_reason), "a deletion's revocation is the one its owner may revive (H-5)");
    });

    it("FAIL CLOSED: the payload unreadable, or absent, is treated as a narrowing", async () => {
      const unreadable = await attempt(NARROWED, {}, { [MEMORY_EVENT_TABLE]: { code: "57014", message: "timeout" } });
      assert.equal(unreadable.pub.revocation_state, "REVOKED");
      const absent = await attempt("absent");
      assert.equal(absent.pub.revocation_state, "REVOKED");
      const malformed = await attempt("not an object");
      assert.equal(malformed.pub.revocation_state, "REVOKED");
    });

    it("a registration that never carried the Memory is not revoked (the narrowing does not reach it); an unreadable registry revokes nothing — the failure stands", async () => {
      const { rebuildSubscribedProjection } = await import("../services/memoryProjections/outboxConsumer.js");
      const store = await narrowedWorld();
      store[MEMORY_EVENT_TABLE]!.push(event("e-1", NARROWED));
      const r1 = await rebuildSubscribedProjection(makeDb(store, { failWrite: failPublicUpsert }), claimed({ memory_id: PRIV }) as any, "PublicMemoryProjection", { owner_id: OWNER }, NOW);
      assert.equal(r1.ok, false);
      assert.equal(reg(store, PUBLIC_KEY).revocation_state, "ACTIVE");
      const r2 = await rebuildSubscribedProjection(makeDb(store, { failWrite: failPublicUpsert, failRead: { [DERIVATIVE_REGISTRY_TABLE]: { code: "57014", message: "timeout" } } }), claimed() as any, "PublicMemoryProjection", { owner_id: OWNER }, NOW);
      assert.equal(r2.ok, false);
      assert.equal(reg(store, PUBLIC_KEY).revocation_state, "ACTIVE");
    });

    it("a revoke whose write is not confirmed leaves the failure standing", async () => {
      const failBoth = (t: string, m: string, p: any) => failPublicUpsert(t, m, p) || (t === DERIVATIVE_REGISTRY_TABLE && m === "update");
      const { rebuildSubscribedProjection } = await import("../services/memoryProjections/outboxConsumer.js");
      const store = await narrowedWorld();
      store[MEMORY_EVENT_TABLE]!.push(event("e-1", NARROWED));
      const r = await rebuildSubscribedProjection(makeDb(store, { failWrite: failBoth }), claimed() as any, "PublicMemoryProjection", { owner_id: OWNER }, NOW);
      assert.equal(r.ok, false);
      assert.equal(reg(store, PUBLIC_KEY).revocation_state, "ACTIVE");
    });

    it("the rebuild failing at its SOURCE read (memories unreadable) takes the same fallback; an already-revoked registration is reported revoked, not rewritten", async () => {
      const { rebuildSubscribedProjection } = await import("../services/memoryProjections/outboxConsumer.js");
      const sourceDown = { memories: { code: "57014", message: "statement timeout" } };
      const store = await narrowedWorld();
      store[MEMORY_EVENT_TABLE]!.push(event("e-1", NARROWED));
      const r1 = await rebuildSubscribedProjection(makeDb(store, { failRead: sourceDown }), claimed() as any, "PublicMemoryProjection", { owner_id: OWNER }, NOW);
      assert.ok(r1.ok && r1.value.was_revoked);
      assert.equal(reg(store, PUBLIC_KEY).revocation_state, "REVOKED");
      Object.assign(reg(store, PUBLIC_KEY), { revocation_reason: "earlier" });
      const r2 = await rebuildSubscribedProjection(makeDb(store, { failRead: sourceDown }), claimed() as any, "PublicMemoryProjection", { owner_id: OWNER }, NOW);
      assert.ok(r2.ok && r2.value.was_revoked);
      assert.equal(reg(store, PUBLIC_KEY).revocation_reason, "earlier", "a revoked registration is not rewritten");
    });

    it("every OTHER projection's failure is untouched by the payload: it fails, it is never revoked here", async () => {
      const { rebuildSubscribedProjection } = await import("../services/memoryProjections/outboxConsumer.js");
      const store = seed();
      store[MEMORY_EVENT_TABLE]!.push(event("e-1", NARROWED));
      const db = makeDb(store, { failWrite: (t, m) => t === DERIVATIVE_REGISTRY_TABLE && m === "upsert" });
      const r = await rebuildSubscribedProjection(db, claimed() as any, "MemoryTimelineProjection", { owner_id: OWNER, viewer_id: OWNER }, NOW);
      assert.equal(r.ok, false);
      assert.ok(!db.log.some((q: Query) => q.table === MEMORY_EVENT_TABLE), "a non-public failure reads no payload");
    });
  });

  it("payloadLeftPublicIndex: states it only from what the payload STATES", async () => {
    const { payloadLeftPublicIndex } = await import("../services/memoryProjections/outboxConsumer.js");
    const cases: Array<[unknown, boolean]> = [
      [{ visibility: "only_me", to_state: "ACTIVE" }, true],
      [{ visibility: "friends_only", to_state: "ACTIVE" }, true],
      [{ visibility: "public", to_state: "ACTIVE" }, false],
      [{ visibility: null, to_state: "ACTIVE" }, false],
      [{ to_state: "ACTIVE" }, false],
      [{ visibility: null, to_state: "ARCHIVED" }, true],
      [{ visibility: null, to_state: "DELETED" }, true],
      [{ visibility: "public", to_state: "CANDIDATE" }, true],
      [{ visibility: null, to_state: null }, false],
      [{ visibility: 7 }, true],
      [null, true], ["x", true], [[], true],
    ];
    for (const [payload, left] of cases) assert.equal(payloadLeftPublicIndex(payload), left, JSON.stringify(payload));
  });
});

describe("H203 — the definition, never the caller, decides the read", () => {
  it("the column list is exactly what PUBLIC_FIELDS is made of, plus the admission test and the version", async () => {
    const { PUBLIC_SOURCE_MEMORY_COLUMNS } = await import("../services/memoryProjections/publicIndexSources.js");
    const cols = PUBLIC_SOURCE_MEMORY_COLUMNS.split(",").map((c: string) => c.trim()).sort();
    assert.deepEqual(cols, ["caption", "created_at", "id", "location_city", "location_country", "owner_id", "starts_at", "state", "title", "updated_at", "visibility"]);
    assert.deepEqual([...getProjectionDefinition("PublicMemoryProjection")!.field_whitelist].sort(),
      ["caption", "location_city", "location_country", "media_count", "memory_id", "occurred_at", "owner_id", "title"],
      "PUBLIC_FIELDS changed: re-derive PUBLIC_SOURCE_MEMORY_COLUMNS from it");
  });

  it("KEEP_PRIVATE_FOREVER is the control that suppresses public_projection — derived from CONTROL_EFFECTS", async () => {
    const { PUBLIC_INDEX_EXCLUDING_CONTROLS } = await import("../services/memoryProjections/publicIndexSources.js");
    assert.deepEqual([...PUBLIC_INDEX_EXCLUDING_CONTROLS], ["KEEP_PRIVATE_FOREVER"]);
  });

  it("a caller cannot widen a PUBLIC read, nor narrow an owner's: the stamp is the definition's", async () => {
    const pubDb = makeDb(seed());
    const pub = await deriveProjection(pubDb, "PublicMemoryProjection", { ...PUBLIC_SCOPE, audience: "OWNER_PRIVATE" } as any);
    assert.ok(pub.ok);
    assertPublicReadOnly(pubDb.log, "a PUBLIC build a caller labelled OWNER_PRIVATE");
    const ownDb = makeDb(seed());
    const own = await deriveProjection(ownDb, "MemoryTimelineProjection", { owner_id: OWNER, viewer_id: OWNER, audience: "PUBLIC" } as any);
    assert.ok(own.ok);
    assert.ok(own.ok && own.value.rows.some((r) => r.memory_id === PRIV), "the owner's timeline still holds their private Memory");
  });

  it("a PUBLIC read asked for a source it cannot honour refuses, never builds without it", async () => {
    const { readPublicProjectionSources, sourceScopeOf } = await import("../services/memoryProjections/publicIndexSources.js");
    const db = makeDb(seed());
    for (const opt of ["includeHighlights", "placeCorrections", "personCeilings"]) {
      const r = await readPublicProjectionSources(db, OWNER, { [opt]: true });
      assert.equal(r.ok, false, opt);
      assert.equal(!r.ok && r.reason, "projection_not_configured");
    }
    assert.equal(db.log.length, 0, "refused before any read");
    assert.ok((await readPublicProjectionSources(db, OWNER, { includeHighlights: false, placeCorrections: false })).ok);
    assert.deepEqual(sourceScopeOf(null, { owner_id: OWNER, audience: "PUBLIC" }), { owner_id: OWNER }, "an unknown projection reads with no audience");
  });

  it("every other projection reads exactly as before (the owner's timeline still reads the owner's whole record)", async () => {
    const db = makeDb(seed());
    const t = await deriveProjection(db, "MemoryTimelineProjection", { owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: null, person_id: null });
    assert.ok(t.ok);
    const memReads = db.log.filter((q: Query) => q.table === "memories");
    assert.equal(memReads.length, 1);
    assert.ok(memReads[0]!.columns.includes("location_lat"), "the owner-private read is unchanged");
    assert.ok(db.log.some((q: Query) => q.table === "memory_tags"));
  });
});
