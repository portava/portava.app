/**
 * §24 `place_correction_rate` and `participant_correction_rate` are counted on
 * the LIVE command paths — census-highlights-memories H215 / H216 (lane R,
 * 2026-10-06).
 *
 * The census rows read NB: "No counter is incremented anywhere" (H215) and
 * "ADD_PERSON / REMOVE_PERSON are dispatched and counted by nothing" (H216).
 * Both sentences went stale when `services/memory/memoryKernelMetrics.ts`
 * landed: `countAcceptedCommand` is called from the one audit point every §17
 * command outcome passes through (`MemoryDomainService.ts`), on the legacy path
 * as well as the kernel path. `memoryKernelMetrics.test.ts` proves the counter
 * ARITHMETIC by calling it directly; nothing proved that a real request
 * reaches it. These cases drive the two real routes with
 * `memory_kernel_enabled` OFF (no flag row — the production posture) and read
 * the counters back:
 *
 *   PATCH /memories/:id with a place field   -> CHANGE_PLACE   -> placeCorrections
 *   PATCH /memories/:id with a caption only  -> UPDATE_MEMORY  -> denominator only
 *   PATCH /memories/:id/tags/:userId approve -> ADD_PERSON     -> participantCorrections
 *   PATCH /memories/:id/tags/:userId remove  -> REMOVE_PERSON  -> participantCorrections
 *
 * and the refusals that must count NOTHING: a stranger's tag decision
 * (forbidden), a tag write that matched zero rows (not applied), and a
 * place edit on someone else's Memory.
 *
 * Emitted, not aggregated: the counters are per-process (that module's header),
 * which is census §K.2's `W`, not `C`.
 *
 * Harness: the fake client of memoryPatchConcurrency.test.ts, copied with a
 * `memory_tags` table and two more tokens.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";
import { _resetMemoryKernelMetrics, readMemoryKernelMetrics } from "../services/memory/memoryKernelMetrics.js";

const TAGGED = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const M = "11111111-1111-1111-1111-111111111111";

interface Row { [k: string]: any }

function memory(over: Row = {}): Row {
  return {
    id: M, owner_id: OWNER, title: "before", caption: "before",
    visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null,
    location_city: null, location_country: null,
    location_lat: null, location_lng: null, canonical_location_id: null,
    starts_at: null, ends_at: null, state: "draft",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

interface State {
  memories: Row[];
  memory_tags: Row[];
  blocks: Row[];
  feature_flags: Row[];
  profiles: Row[];
  /**
   * Applied to the stored `memories` row immediately AFTER the handler's first
   * SELECT resolves — the interleaving write, made deterministic. Nothing else
   * about the fake is special; this is the whole mechanism.
   */
  interleave?: Row | null;
  selectCount: number;
  errorTables: Set<string>;
}

function baseState(over: Partial<State> = {}): State {
  return {
    memories: [memory()],
    memory_tags: [{ memory_id: M, tagged_user_id: TAGGED, status: "pending" }],
    blocks: [],
    feature_flags: [],
    profiles: [{ id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null }],
    interleave: null,
    selectCount: 0,
    errorTables: new Set<string>(),
    ...over,
  };
}

function makeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let pendingUpdate: any = null;
    let isSelectAfterWrite = false;
    let limitN: number | null = null;

    const builder: any = {
      select() { if (pendingUpdate) isSelectAfterWrite = true; return builder; },
      update(p: any) { pendingUpdate = p; return builder; },
      insert() { return builder; },
      upsert() { return builder; },
      delete() { return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return builder; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return builder; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return builder; },
      not(c: string, op: string, v: any) {
        if (op === "is" && v === null) filters.push((r) => r[c] != null);
        else filters.push((r) => r[c] !== v);
        return builder;
      },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return resolve("maybeSingle"); },
      single() { return resolve("single"); },
      then(onF: any, onR: any) { return resolve("many").then(onF, onR); },
    };

    async function resolve(mode: "single" | "maybeSingle" | "many") {
      if (state.errorTables.has(table)) {
        return { data: null, error: { message: `${table} lookup failed` }, count: null };
      }
      if (pendingUpdate) {
        const rows = (state as any)[table].filter((r: Row) => filters.every((f) => f(r)));
        rows.forEach((r: Row) => Object.assign(r, pendingUpdate));
        // supabase-js: `.single()` over zero rows is PGRST116, an ERROR, not null.
        if (mode === "single" && rows.length === 0) {
          return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, count: 0 };
        }
        const copies = rows.map((r: Row) => ({ ...r }));
        return { data: mode === "many" ? copies : (copies[0] ?? null), error: null, count: copies.length };
      }
      let rows = ((state as any)[table] ?? []).filter((r: Row) => filters.every((f) => f(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      // A read hands back a SNAPSHOT, as a real round trip does. The handler
      // then holds a value the database is free to move underneath it.
      const copies = rows.map((r: Row) => ({ ...r }));
      const out = mode === "many"
        ? { data: copies, error: null, count: copies.length }
        : { data: copies[0] ?? null, error: null, count: copies.length };
      if (table === "memories") {
        state.selectCount += 1;
        if (state.selectCount === 1 && state.interleave) {
          for (const r of state.memories) if (r.id === M) Object.assign(r, state.interleave);
        }
      }
      return out;
    }

    void isSelectAfterWrite;
    return builder;
  }

  return {
    from,
    async rpc(fn: string) { return { data: null, error: { message: `unknown rpc ${fn}` } }; },
    auth: {
      getUser: async (tok: string) =>
        tok === "owner-tok"
          ? { data: { user: { id: OWNER } }, error: null }
          : tok === "tagged-tok"
            ? { data: { user: { id: TAGGED } }, error: null }
            : tok === "stranger-tok"
              ? { data: { user: { id: STRANGER } }, error: null }
              : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

async function startApp(state: State) {
  _setTestClient(makeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

/**
 * What a JSON response body is, before anything has been asserted about it.
 *
 * Typed as a record of UNKNOWN values on purpose. `res.json()` returns nothing
 * the compiler can vouch for, and the two shapes these cases actually receive
 * are different — an error envelope (`{ error, message }`) and a memory object —
 * so naming either one here would be a fixture describing a shape production
 * does not always emit, which is the thing the test-typecheck ratchet exists to
 * stop. `unknown` values still compare fine: node's `assert.equal` takes
 * `unknown` on both sides.
 */
type JsonBody = Record<string, unknown> | null;

async function patchReq(
  base: string,
  path: string,
  body: unknown,
  token = "owner-tok",
): Promise<{ status: number; body: JsonBody }> {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", connection: "close", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as JsonBody };
}


const counts = () => readMemoryKernelMetrics().counts;

describe("§24 correction rates are counted by the live routes (kernel flag OFF)", () => {
  beforeEach(() => _resetMemoryKernelMetrics());

  it("a place edit is CHANGE_PLACE: one correction over one accepted command", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { locationCity: "Lisbon" });
      assert.equal(status, 200);
      assert.equal(state.memories[0]!.location_city, "Lisbon", "control: the edit was applied");
      assert.equal(counts().commandsAccepted, 1);
      assert.equal(counts().placeCorrections, 1);
      assert.equal(readMemoryKernelMetrics().place_correction_rate, 1);
    } finally { await app.close(); }
  });

  it("a caption edit moves the DENOMINATOR only, so the rate is 0 — measured, not absent", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { caption: "after" });
      assert.equal(status, 200);
      assert.equal(counts().commandsAccepted, 1);
      assert.equal(counts().placeCorrections, 0);
      assert.equal(readMemoryKernelMetrics().place_correction_rate, 0);
    } finally { await app.close(); }
  });

  it("a place edit on SOMEONE ELSE's Memory is refused and counts nothing", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { locationCity: "Lisbon" }, "stranger-tok");
      assert.equal(status, 403);
      assert.equal(counts().commandsAccepted, 0);
      assert.equal(readMemoryKernelMetrics().place_correction_rate, null, "nothing happened: null, never 0");
    } finally { await app.close(); }
  });

  it("the tagged person's approval is ADD_PERSON: one participant correction", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}/tags/${TAGGED}`, { action: "approve" }, "tagged-tok");
      assert.equal(status, 200);
      assert.equal(state.memory_tags[0]!.status, "approved", "control: the decision was applied");
      assert.equal(counts().participantCorrections, 1);
      assert.equal(readMemoryKernelMetrics().participant_correction_rate, 1);
    } finally { await app.close(); }
  });

  it("the owner's removal is REMOVE_PERSON: one participant correction", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}/tags/${TAGGED}`, { action: "remove" });
      assert.equal(status, 200);
      assert.equal(state.memory_tags[0]!.status, "removed");
      assert.equal(counts().participantCorrections, 1);
    } finally { await app.close(); }
  });

  it("a stranger's tag decision is refused and counts nothing", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}/tags/${TAGGED}`, { action: "remove" }, "stranger-tok");
      assert.equal(status, 403);
      assert.equal(state.memory_tags[0]!.status, "pending");
      assert.equal(counts().commandsAccepted, 0);
      assert.equal(counts().participantCorrections, 0);
    } finally { await app.close(); }
  });

  it("a tag write that matched zero rows was not applied, so it is not counted", async () => {
    const state = baseState();
    const app = await startApp(state);
    // The tag is read (it exists) and then vanishes before the UPDATE — the
    // legacy writer reports db_error rather than an applied decision.
    const original = state.memory_tags;
    let reads = 0;
    Object.defineProperty(state, "memory_tags", {
      get() { reads += 1; return reads === 1 ? original : []; },
      configurable: true,
    });
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}/tags/${TAGGED}`, { action: "approve" }, "tagged-tok");
      assert.notEqual(status, 200);
      assert.equal(counts().participantCorrections, 0);
      assert.equal(counts().commandsAccepted, 0);
    } finally { await app.close(); }
  });
});
