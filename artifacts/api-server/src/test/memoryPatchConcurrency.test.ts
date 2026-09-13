/**
 * PATCH /memories/:id under a concurrent write — the §5 guard, re-asserted at
 * the moment it is acted on.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §5   the Memory lifecycle machine.
 *   §17  "All canonical writes should cross an explicit command boundary for
 *        authorization, invariants, idempotency, audit …"
 *   §19  "Concurrent edits should resolve at command/field level, not blind row
 *        last-write-wins."
 *
 * WHAT WAS WRONG, AND IT IS LIVE
 * ------------------------------
 * The handler does this, in this order:
 *
 *     loadMemoryForCommand(sc, id)             <- reads `state`
 *     guardLifecycle(existing.state, d.state)  <- decides on the value it read
 *     …
 *     .update(patch).eq("id", id).eq("owner_id", user.id)   <- asserts NEITHER
 *
 * The write never says "and only if the row is still in the state I judged".
 * `assertLifecycleTransition` treats `deleted` and `removed` as TERMINAL and its
 * own comment says why that matters: "a plain PATCH {"state":"published"} put
 * moderator-removed content back into the discovery feed". The guard stops that
 * when the row is already terminal WHEN IT IS READ. It does nothing at all when
 * the row becomes terminal in the microseconds between the read and the write —
 * and the DELETE handler next door, which sets exactly that state, is an
 * ordinary authenticated route the same owner can call from a second device.
 *
 * So: publish on the phone, delete on the laptop, and the Memory comes back
 * published — past a guard that ran, passed, and was never re-asserted. That is
 * the "blind row last-write-wins" §19 names, on the one field where losing is
 * not a lost edit but a revoked deletion.
 *
 * WHY THE FIX IS A `state` COMPARE-AND-SWAP AND NOT AN `If-Match` HEADER.
 * Census §C.8 raised this as owner decision D-C1 — "should PATCH reject an edit
 * whose base the client did not state?" — and left the row NB because a
 * client-supplied precondition breaks every client that does not send one. The
 * server does not need the client for this: it already READ the base. Pinning
 * the write to the value the guard was evaluated against needs no header, no
 * migration and no client change, and it conflicts ONLY with a concurrent write
 * that moved that same field — which is field-level resolution, not row-level.
 * A concurrent edit to `title` still merges, and the last test here pins that
 * so the fix cannot quietly become a whole-row precondition later.
 *
 * D-C1 IS NOT CLOSED BY THIS. Two concurrent edits of the same non-lifecycle
 * field still resolve by last-write-wins with no detection, because the server
 * has no base for those the client did not state. That is what keeps the census
 * row short of BUILT-AND-CORRECT.
 *
 * Run: node --import tsx/esm --test src/test/memoryPatchConcurrency.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

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

async function patchReq(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", connection: "close", Authorization: "Bearer owner-tok" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const stored = (state: State): Row => state.memories.find((r) => r.id === M)!;

describe("PATCH /memories/:id — the §5 guard survives a concurrent write", () => {
  it("does not republish a Memory a concurrent DELETE soft-deleted mid-flight", async () => {
    const state = baseState({ interleave: { state: "deleted" } });
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { state: "published" });
      assert.notEqual(status, 200, "a Memory deleted under the handler must not report a successful publish");
      assert.equal(
        stored(state).state, "deleted",
        "a deleted Memory was returned to `published` past a guard that had already refused that transition",
      );
    } finally { await app.close(); }
  });

  it("does not republish a Memory a moderator set to `removed` mid-flight", async () => {
    // `removed` is the state assertLifecycleTransition's own comment names:
    // "a plain PATCH {state:published} put moderator-removed content back into
    // the discovery feed". The guard closes that door; this closes the window.
    const state = baseState({ interleave: { state: "removed" } });
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { state: "published" });
      assert.notEqual(status, 200, "a moderation verdict must not be overwritten by a racing owner edit");
      assert.equal(stored(state).state, "removed", "moderator-removed content was put back into the feed");
    } finally { await app.close(); }
  });

  it("answers `conflict`, not a generic failure, when the base moved", async () => {
    // The distinction is the whole point of re-reading after a zero-row update:
    // "somebody else changed this" is a different answer from "the write broke",
    // and a client can only retry intelligently on the first.
    // The base must move to a state the GUARD would still have admitted, or the
    // refusal comes from `guardLifecycle` and never reaches the write: draft ->
    // published is a legal arrow, and the row turns `archived` underneath it.
    const state = baseState({ interleave: { state: "archived" } });
    const app = await startApp(state);
    try {
      const { status, body } = await patchReq(app.baseUrl, `/api/memories/${M}`, { state: "published" });
      assert.equal(status, 409, "expected a conflict status");
      assert.equal(body?.error, "conflict");
      assert.equal(stored(state).state, "archived", "and the other device's write is the one that stands");
    } finally { await app.close(); }
  });

  it("CONTROL: an uncontested lifecycle PATCH still succeeds", async () => {
    // Without this, a fix that simply refused every lifecycle PATCH would pass
    // all three assertions above.
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { state: "published" });
      assert.equal(status, 200);
      assert.equal(stored(state).state, "published");
    } finally { await app.close(); }
  });

  it("CONTROL: an uncontested field PATCH still succeeds", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { caption: "after" });
      assert.equal(status, 200);
      assert.equal(stored(state).caption, "after");
    } finally { await app.close(); }
  });

  it("resolves at FIELD level: a concurrent edit to another field does not conflict", async () => {
    // §19's actual sentence. A caption edit and a title edit are not in
    // competition, and a whole-row precondition would make them so — which is
    // why the guard is pinned to `state` and not to `updated_at`.
    const state = baseState({ interleave: { title: "changed by the other device" } });
    const app = await startApp(state);
    try {
      const { status } = await patchReq(app.baseUrl, `/api/memories/${M}`, { caption: "after" });
      assert.equal(status, 200, "a concurrent edit to a DIFFERENT field must merge, not conflict");
      assert.equal(stored(state).caption, "after", "our field landed");
      assert.equal(stored(state).title, "changed by the other device", "their field survived");
    } finally { await app.close(); }
  });

  it("still 404s a Memory that was already deleted when the handler read it", async () => {
    // The pre-existing answer for a deleted row, unchanged: loadMemoryForCommand
    // filters `state != 'deleted'` and 404s. The fix must not turn that into a
    // conflict, because clients depend on the 404.
    const state = baseState({ memories: [memory({ state: "deleted" })] });
    const app = await startApp(state);
    try {
      const { status, body } = await patchReq(app.baseUrl, `/api/memories/${M}`, { caption: "after" });
      assert.equal(status, 404);
      assert.equal(body?.error, "not_found");
    } finally { await app.close(); }
  });
});
