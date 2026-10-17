/**
 * §23 (census H203): "Search/index workers consume privacy-filtered event
 * payloads where possible rather than raw entire rows" — and §28.6, "never
 * expose private canonical Memory records to public search and rely on
 * post-filtering".
 *
 * Two halves, both asserted against a table-backed fake that RECORDS every
 * query (table, columns asked for, filters) and every row it handed back, and
 * that returns only the columns a query selected — as PostgREST does:
 *
 *   1. The public search index (PublicMemoryProjection) is built from a
 *      privacy-filtered read: public + published rows only, the published
 *      columns only, no tags, no media URLs, KEEP_PRIVATE_FOREVER dropped, and
 *      the owner's §3.6 PUBLIC location ceiling (3997, H33) applied. Its
 *      staleness check reads the same way.
 *   2. The outbox worker reads each Memory event's privacy-filtered PAYLOAD
 *      through lib/memoryOutbox.ts, refuses one that is not privacy-filtered,
 *      rebuilds the public index at the scope the public search serves, and,
 *      when the payload says the Memory may have left an audience, re-derives
 *      every registration still carrying it — from the payload and the
 *      registry, never from the Memory's row.
 *
 * Run: node --import tsx/esm --test src/test/memoryPublicIndexPayload.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveProjection, projectionStaleness, rebuildProjection } from "../services/memoryProjections/derivativeRegistry.js";
import { drainMemoryOutbox, publicIndexScope, OUTBOX_CLAIM_FN, OUTBOX_ACK_FN, OUTBOX_FAIL_FN } from "../services/memoryProjections/outboxConsumer.js";
import { scopeKeyOf } from "../services/memoryProjections/projectionRegistry.js";
import { MEMORY_EVENT_TABLE, payloadMayNarrowAudience, readEventPayload } from "../lib/memoryOutbox.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M_PUBLIC = "10000000-0000-4000-8000-000000000001";
const M_ONLY_ME = "10000000-0000-4000-8000-000000000002";
const M_FRIENDS = "10000000-0000-4000-8000-000000000003";
const M_DRAFT = "10000000-0000-4000-8000-000000000004";
const M_DELETED = "10000000-0000-4000-8000-000000000005";
const M_KEPT = "10000000-0000-4000-8000-000000000006";
const PRIVATE_WORD = "the-hotel-room-number-412";
const FORBIDDEN_COLUMNS = ["location_lat", "location_lng", "allowed_user_ids", "hidden_user_ids", "trip_id", "event_id", "place_id", "canonical_location_id", "media_url"];

interface Query { table: string; op: string; columns: string; filters: string[]; handedBack: any[] }

function memory(id: string, over: Record<string, unknown> = {}) {
  return {
    id, owner_id: OWNER, title: "Rooftop in Lisbon", caption: "the long walk up", visibility: "public", state: "published",
    trip_id: "trip-1", event_id: null, place_id: "fsq-rooftop", canonical_location_id: null,
    starts_at: "2026-01-02T10:00:00.000Z", ends_at: null, created_at: "2026-01-02T10:00:00.000Z", updated_at: "2026-01-02T10:00:00.000Z",
    location_city: "Lisbon", location_country: "PT", location_lat: 38.7, location_lng: -9.1,
    allowed_user_ids: [], hidden_user_ids: [], ...over,
  };
}

function world(): Record<string, any[]> {
  return {
    memories: [
      memory(M_PUBLIC),
      memory(M_ONLY_ME, { visibility: "only_me", title: PRIVATE_WORD, caption: PRIVATE_WORD }),
      memory(M_FRIENDS, { visibility: "friends_only", title: PRIVATE_WORD }),
      memory(M_DRAFT, { state: "draft", title: PRIVATE_WORD }),
      memory(M_DELETED, { state: "deleted", title: PRIVATE_WORD }),
      memory(M_KEPT, { title: "kept private forever" }),
    ],
    memory_items: [
      { id: "i1", memory_id: M_PUBLIC, media_url: `https://cdn/${PRIVATE_WORD}.jpg`, media_type: "image", position: 0 },
      { id: "i2", memory_id: M_ONLY_ME, media_url: `https://cdn/${PRIVATE_WORD}-2.jpg`, media_type: "image", position: 0 },
    ],
    memory_tags: [{ memory_id: M_PUBLIC, tagged_user_id: "someone", status: "approved" }],
    memory_resurfacing_preferences: [{ owner_id: OWNER, memory_id: M_KEPT, control: "KEEP_PRIVATE_FOREVER" }],
    memory_derivative_registry: [],
    feature_flags: [],
    memory_visibility_policies: [],
    [MEMORY_EVENT_TABLE]: [],
  };
}

interface Opts { fail?: Set<string>; absent?: Set<string>; registryUpdateFails?: boolean }

function makeClient(store: Record<string, any[]>, opts: Opts = {}) {
  const log: Query[] = [];
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  let claim: any[] = [];
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const described: string[] = [];
    let columns = "*";
    let mode: "read" | "upsert" | "update" = "read";
    let payload: any = null;
    let exact = false;
    let single = false;
    const project = (r: any) => {
      if (columns.trim() === "*") return { ...r };
      const out: any = {};
      for (const c of columns.split(",").map((x) => x.trim()).filter(Boolean)) out[c] = r[c];
      return out;
    };
    const b: any = {
      select(c?: string, o?: any) { if (mode === "read") columns = c ?? "*"; exact = o?.count === "exact"; return b; },
      eq(c: string, v: any) { described.push(`${c}=${v}`); filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { described.push(`${c}!=${v}`); filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { described.push(`${c} in [${vs.join(",")}]`); filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      contains(c: string, vs: any[]) { described.push(`${c} contains ${vs.join(",")}`); filters.push((r) => vs.every((v) => (r[c] ?? []).includes(v))); return b; },
      order() { return b; }, limit() { return b; },
      upsert(d: any) { mode = "upsert"; payload = d; return b; },
      update(d: any) { mode = "update"; payload = d; return b; },
      maybeSingle() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (opts.absent?.has(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` }, count: null };
      if (opts.fail?.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const all = (store[table] ??= []);
      if (mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]);
        const out: any[] = [];
        for (const r of rows) {
          const i = all.findIndex((e) => e.projection_id === r.projection_id && e.scope_key === r.scope_key);
          if (i >= 0) { all[i] = { ...r, id: all[i].id }; out.push(all[i]); } else { const s = { ...r, id: `reg-${all.length + 1}` }; all.push(s); out.push(s); }
        }
        return { data: out, error: null, count: out.length };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        if (opts.registryUpdateFails && table === "memory_derivative_registry") return { data: null, error: { message: "registry write failed" }, count: null };
        for (const r of matched) Object.assign(r, payload);
        return { data: matched.map((r) => ({ id: r.id })), error: null, count: matched.length };
      }
      const handedBack = matched.map(project);
      log.push({ table, op: "read", columns, filters: described, handedBack });
      if (single) return { data: handedBack[0] ?? null, error: null, count: handedBack.length };
      return { data: handedBack, error: null, count: exact ? handedBack.length : null };
    }
    return b;
  }
  return {
    log, rpcCalls,
    setClaim(rows: any[]) { claim = rows; },
    from: (t: string) => chain(t),
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (fn === OUTBOX_CLAIM_FN) { const out = claim; claim = []; return { data: out, error: null }; }
      if (fn === OUTBOX_ACK_FN) return { data: Array.isArray(args?.p_ids) ? args.p_ids.length : 0, error: null };
      if (fn === OUTBOX_FAIL_FN) return { data: 1, error: null };
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  };
}

const NOW = new Date("2026-03-01T00:00:00.000Z");
const PUBLIC_SCOPE = publicIndexScope(OWNER);
const memoryReads = (c: ReturnType<typeof makeClient>) => c.log.filter((q) => q.table === "memories");

function assertPrivacyFiltered(c: ReturnType<typeof makeClient>, reads: Query[], publicBuildOnly = true) {
  for (const q of reads) {
    for (const col of FORBIDDEN_COLUMNS) assert.ok(!q.columns.split(",").map((x) => x.trim()).includes(col) && q.columns.trim() !== "*", `${q.table} read asked for ${col}: ${q.columns}`);
    for (const r of q.handedBack) {
      if (q.table === "memories") {
        assert.equal(r.visibility, "public", `a ${r.visibility} row was handed to the public build`);
        assert.equal(r.state, "published");
      }
      assert.ok(!JSON.stringify(r).includes(PRIVATE_WORD), `a private word reached the process: ${JSON.stringify(r)}`);
    }
  }
  if (publicBuildOnly) assert.equal(c.log.filter((q) => q.table === "memory_tags").length, 0, "the public index reads no tags");
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The public index's source read is privacy-filtered in the database
 * ═════════════════════════════════════════════════════════════════════════ */

describe("H203 the public search index reads only what it publishes", () => {
  it("a PublicMemoryProjection build fetches only public + published rows and only the published columns", async () => {
    const c = makeClient(world());
    const d = await deriveProjection(c, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(d.ok, JSON.stringify(d));
    assert.deepEqual(d.value.rows.map((r) => r.memory_id), [M_PUBLIC], "KEEP_PRIVATE_FOREVER, private, draft and deleted Memories are not in it");
    assert.equal(d.value.rows[0]!.media_count, 1);
    assert.ok(memoryReads(c).length > 0);
    assert.ok(memoryReads(c).every((q) => q.filters.includes("visibility=public") && q.filters.includes("state=published")), "filtered IN the read, not after it");
    assertPrivacyFiltered(c, c.log.filter((q) => q.table === "memories" || (q.table === "memory_items" && !q.filters.includes("visibility=hidden"))));
    const itemReads = c.log.filter((q) => q.table === "memory_items");
    assert.ok(itemReads.every((q) => !q.filters.some((f) => f.includes(M_ONLY_ME))), "no row of a Memory the index does not admit is asked about");
  });

  it("the staleness check reads the same way, and a private Memory's change does not make the index stale", async () => {
    const store = world();
    const c = makeClient(store);
    const built = await rebuildProjection(c, "PublicMemoryProjection", PUBLIC_SCOPE, NOW);
    assert.ok(built.ok);
    c.log.length = 0;
    const fresh = await projectionStaleness(c, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(fresh.ok);
    assert.equal(fresh.value.state, "FRESH");
    assertPrivacyFiltered(c, memoryReads(c));
    store.memories.find((m) => m.id === M_ONLY_ME)!.updated_at = "2026-02-01T00:00:00.000Z";
    const still = await projectionStaleness(c, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(still.ok);
    assert.equal(still.value.state, "FRESH", "the index is not a function of rows it never publishes");
    store.memories.find((m) => m.id === M_PUBLIC)!.updated_at = "2026-02-01T00:00:00.000Z";
    const stale = await projectionStaleness(c, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(stale.ok);
    assert.equal(stale.value.state, "STALE");
  });

  it("a Memory that becomes public enters it, and one that leaves it leaves it", async () => {
    const store = world();
    const c = makeClient(store);
    store.memories.find((m) => m.id === M_ONLY_ME)!.visibility = "public";
    store.memories.find((m) => m.id === M_PUBLIC)!.visibility = "only_me";
    const d = await deriveProjection(c, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(d.ok);
    assert.deepEqual(d.value.rows.map((r) => r.memory_id), [M_ONLY_ME]);
  });

  it("unreadable §11 controls refuse the build; an absent controls table is 'none set'", async () => {
    const refused = await deriveProjection(makeClient(world(), { fail: new Set(["memory_resurfacing_preferences"]) }), "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.reason, "source_unavailable");
    const absent = await deriveProjection(makeClient(world(), { absent: new Set(["memory_resurfacing_preferences"]) }), "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(absent.ok);
    assert.deepEqual(absent.value.rows.map((r) => r.memory_id).sort(), [M_PUBLIC, M_KEPT].sort());
  });

  it("an owner-private projection still reads the owner's whole record (it is theirs) — only the public index is narrowed", async () => {
    const c = makeClient(world());
    const d = await deriveProjection(c, "MemoryTimelineProjection", { owner_id: OWNER, viewer_id: OWNER, trip_id: null, place_id: null });
    assert.ok(d.ok);
    assert.ok(d.value.rows.some((r) => r.memory_id === M_ONLY_ME));
  });
});

describe("H33 in the public index: the owner's PUBLIC location ceiling", () => {
  function withPolicy(rung: string) {
    const s = world();
    s.feature_flags = [{ flag: "memory_visibility_policies_enabled", enabled: true }];
    s.memory_visibility_policies = [{ owner_id: OWNER, audience: "public", location_precision: rung }];
    return s;
  }
  it("'country' drops the city from every public index row; 'hidden' drops both", async () => {
    const country = await deriveProjection(makeClient(withPolicy("country")), "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(country.ok);
    assert.equal(country.value.rows[0]!.location_city, null);
    assert.equal(country.value.rows[0]!.location_country, "PT");
    const hidden = await deriveProjection(makeClient(withPolicy("hidden")), "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(hidden.ok);
    assert.equal(hidden.value.rows[0]!.location_city, null);
    assert.equal(hidden.value.rows[0]!.location_country, null);
    const city = await deriveProjection(makeClient(withPolicy("city")), "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(city.ok);
    assert.equal(city.value.rows[0]!.location_city, "Lisbon");
  });

  it("changing the ceiling makes the registered index STALE, so the next build applies it", async () => {
    const store = withPolicy("city");
    const c = makeClient(store);
    assert.ok((await rebuildProjection(c, "PublicMemoryProjection", PUBLIC_SCOPE, NOW)).ok);
    store.memory_visibility_policies[0].location_precision = "country";
    const v = await projectionStaleness(c, "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(v.ok);
    assert.equal(v.value.state, "STALE");
  });

  it("an unreadable policy clamps the public index to no location at all", async () => {
    const store = withPolicy("city");
    const d = await deriveProjection(makeClient(store, { fail: new Set(["memory_visibility_policies"]) }), "PublicMemoryProjection", PUBLIC_SCOPE);
    assert.ok(d.ok);
    assert.equal(d.value.rows[0]!.location_city, null);
    assert.equal(d.value.rows[0]!.location_country, null);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. The worker consumes the event's privacy-filtered payload
 * ═════════════════════════════════════════════════════════════════════════ */

function event(id: string, memoryId: string, payload: Record<string, unknown>) {
  return { event_id: id, memory_id: memoryId, payload_json: payload };
}
function claimed(id: number, eventId: string, memoryId: string, type: string) {
  return { id, event_id: eventId, memory_id: memoryId, type, created_at: "2026-02-28T23:59:00.000Z", attempts: 1, locked_until: null };
}
const neutral = (memoryId: string) => ({ command_type: "UPDATE_MEMORY", from_state: "ACTIVE", to_state: "ACTIVE", visibility: null, refs: { memory_id: memoryId } });

describe("H203 the outbox worker reads the event payload, never the Memory's row, to decide the index's work", () => {
  it("reads the payload through the event store boundary, and rebuilds the index the public search SERVES", async () => {
    const store = world();
    store[MEMORY_EVENT_TABLE] = [event("e1", M_PUBLIC, neutral(M_PUBLIC))];
    const c = makeClient(store);
    c.setClaim([claimed(1, "e1", M_PUBLIC, "memory.corrected")]);
    const drained = await drainMemoryOutbox(c, { now: NOW });
    assert.equal(drained.ok, true, JSON.stringify(drained));
    assert.equal(drained.acked, 1);
    const payloadReads = c.log.filter((q) => q.table === MEMORY_EVENT_TABLE);
    assert.equal(payloadReads.length, 1);
    assert.equal(payloadReads[0]!.columns, "event_id, payload_json");
    const served = scopeKeyOf("PublicMemoryProjection", PUBLIC_SCOPE);
    const publicRegs = store.memory_derivative_registry.filter((r) => r.projection_id === "PublicMemoryProjection");
    assert.deepEqual(publicRegs.map((r) => r.scope_key), [served], "one public registration, at the key the public search reads");
    assert.deepEqual(publicRegs[0].source_memory_ids, [M_PUBLIC]);
    assertPrivacyFiltered(c, memoryReads(c).filter((q) => q.filters.includes("visibility=public")), false); // the owner's own projections in the same drain read their own record, tags included
  });

  it("a payload that is not privacy-filtered is refused, and nothing is rebuilt from it", async () => {
    const store = world();
    store[MEMORY_EVENT_TABLE] = [event("e1", M_PUBLIC, { ...neutral(M_PUBLIC), title: "leaked" })];
    const c = makeClient(store);
    c.setClaim([claimed(1, "e1", M_PUBLIC, "memory.corrected")]);
    const drained = await drainMemoryOutbox(c, { now: NOW });
    assert.equal(drained.acked, 0);
    assert.equal(drained.outcomes[0]?.failureClass, "payload_not_privacy_filtered");
    assert.equal(store.memory_derivative_registry.length, 0);
    assert.deepEqual(c.rpcCalls.filter((r) => r.fn === OUTBOX_FAIL_FN).map((r) => r.args.p_class), ["payload_not_privacy_filtered"]);
  });

  it("an unreadable payload fails the event (retried); a missing one fails it too", async () => {
    const unreadable = makeClient(world(), { fail: new Set([MEMORY_EVENT_TABLE]) });
    unreadable.setClaim([claimed(1, "e1", M_PUBLIC, "memory.corrected")]);
    assert.equal((await drainMemoryOutbox(unreadable, { now: NOW })).outcomes[0]?.failureClass, "payload_unavailable");
    const missing = makeClient(world());
    missing.setClaim([claimed(1, "e1", M_PUBLIC, "memory.corrected")]);
    const r = await drainMemoryOutbox(missing, { now: NOW });
    assert.equal(r.outcomes[0]?.failureClass, "payload_absent");
    assert.equal(r.acked, 0);
  });

  it("a NARROWING payload removes the Memory from the served index, without fetching the narrowed row for it", async () => {
    const store = world();
    const c = makeClient(store);
    assert.ok((await rebuildProjection(c, "PublicMemoryProjection", PUBLIC_SCOPE, NOW)).ok);
    const served = scopeKeyOf("PublicMemoryProjection", PUBLIC_SCOPE);
    assert.deepEqual(store.memory_derivative_registry.find((r) => r.scope_key === served).source_memory_ids, [M_PUBLIC]);
    // The owner makes it private. The canonical write committed; the event says so.
    store.memories.find((m) => m.id === M_PUBLIC)!.visibility = "only_me";
    store.memories.find((m) => m.id === M_PUBLIC)!.updated_at = "2026-02-15T00:00:00.000Z";
    store[MEMORY_EVENT_TABLE] = [event("e2", M_PUBLIC, { ...neutral(M_PUBLIC), command_type: "CHANGE_VISIBILITY", visibility: "only_me" })];
    c.log.length = 0;
    c.setClaim([claimed(2, "e2", M_PUBLIC, "memory.visibility_changed")]);
    const drained = await drainMemoryOutbox(c, { now: NOW });
    assert.equal(drained.ok, true, JSON.stringify(drained));
    const reg = store.memory_derivative_registry.find((r) => r.scope_key === served);
    assert.equal(reg.revocation_state, "ACTIVE", "rebuilt, not revoked: one Memory narrowing must not end the owner's public search");
    assert.deepEqual(reg.source_memory_ids, [], "the served index no longer carries it");
    assert.ok(!JSON.stringify(reg.payload_json).includes(M_PUBLIC));
    const publicReads = memoryReads(c).filter((q) => q.filters.includes("visibility=public"));
    assert.ok(publicReads.length > 0);
    assert.ok(publicReads.every((q) => q.handedBack.every((r) => r.id !== M_PUBLIC)), "the narrowed row never reached the public build");
    assert.ok(c.log.some((q) => q.table === "memory_derivative_registry" && q.filters.some((f) => f.startsWith("source_memory_ids contains"))), "the payload sent the worker to the registry for what still carries it");
  });

  it("a narrowing whose re-derivation cannot be confirmed fails the event so it is retried", async () => {
    const store = world();
    // A registration that still carries the Memory and can be neither re-derived
    // (its key names no projection) nor revoked (the registry refuses the write).
    store.memory_derivative_registry.push({ id: "reg-stuck", projection_id: "PublicMemoryProjection", scope_key: "NotAProjection|owner:x", source_memory_ids: [M_PUBLIC], revocation_state: "ACTIVE" });
    store[MEMORY_EVENT_TABLE] = [event("e3", M_PUBLIC, { ...neutral(M_PUBLIC), command_type: "CHANGE_VISIBILITY", visibility: "only_me" })];
    store.memories.find((m) => m.id === M_PUBLIC)!.visibility = "only_me";
    const c = makeClient(store, { registryUpdateFails: true });
    c.setClaim([claimed(3, "e3", M_PUBLIC, "memory.visibility_changed")]);
    const drained = await drainMemoryOutbox(c, { now: NOW });
    assert.equal(drained.acked, 0, "not acked: the payload's narrowing is not finished");
    assert.equal(drained.outcomes[0]?.failureClass, "narrowing_unresolved");
    assert.deepEqual(c.rpcCalls.filter((r) => r.fn === OUTBOX_FAIL_FN).map((r) => r.args.p_class), ["narrowing_unresolved"]);
  });

  it("a payload that narrows nothing does not send the worker hunting through the registry", async () => {
    const store = world();
    store[MEMORY_EVENT_TABLE] = [event("e1", M_PUBLIC, neutral(M_PUBLIC))];
    const c = makeClient(store);
    c.setClaim([claimed(1, "e1", M_PUBLIC, "memory.corrected")]);
    await drainMemoryOutbox(c, { now: NOW });
    assert.ok(!c.log.some((q) => q.filters.some((f) => f.startsWith("source_memory_ids contains"))));
  });
});

describe("H203 the payload boundary", () => {
  it("readEventPayload answers ok / unavailable / absent / not privacy-filtered, never a guess", async () => {
    const store = world();
    store[MEMORY_EVENT_TABLE] = [event("e1", M_PUBLIC, neutral(M_PUBLIC)), event("e2", M_PUBLIC, { ...neutral(M_PUBLIC), refs: { memory_id: M_PUBLIC, caption: "x" } }), event("e3", M_PUBLIC, null as any)];
    const c = makeClient(store);
    assert.equal((await readEventPayload(c, "e1")).ok, true);
    const nested = await readEventPayload(c, "e2");
    assert.equal(nested.ok, false);
    if (!nested.ok) assert.equal(nested.reason, "payload_not_privacy_filtered", "a leak one level down is still a leak");
    const notObject = await readEventPayload(c, "e3");
    assert.equal(notObject.ok, false);
    const absent = await readEventPayload(c, "nope");
    assert.equal(absent.ok, false);
    if (!absent.ok) assert.equal(absent.reason, "payload_absent");
    const down = await readEventPayload(makeClient(world(), { fail: new Set([MEMORY_EVENT_TABLE]) }), "e1");
    assert.equal(down.ok, false);
    if (!down.ok) assert.equal(down.reason, "payload_unavailable");
  });

  it("payloadMayNarrowAudience reads only what the payload STATES", () => {
    assert.equal(payloadMayNarrowAudience({ command_type: "X", from_state: "ACTIVE", to_state: "ACTIVE", visibility: null, refs: {} }), false);
    assert.equal(payloadMayNarrowAudience({ command_type: "X", from_state: "ACTIVE", to_state: "ACTIVE", visibility: "public", refs: {} }), false);
    assert.equal(payloadMayNarrowAudience({ command_type: "X", from_state: "ACTIVE", to_state: "ACTIVE", visibility: "only_me", refs: {} }), true);
    assert.equal(payloadMayNarrowAudience({ command_type: "X", from_state: "ACTIVE", to_state: "DELETED", visibility: null, refs: {} }), true);
    assert.equal(payloadMayNarrowAudience({ command_type: "X", from_state: "ACTIVE", to_state: null, visibility: null, refs: {} }), false);
  });
});
