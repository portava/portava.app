/**
 * §17 Command Bus over routes/memories.ts — the boundary, the §5 machine, the
 * §17 REMOVE_PERSON authorization, §19 idempotent replay, and honest failure.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §5   Memory lifecycle (line 207)
 *   §5   "only after participant consent" (line 226)
 *   §10  "Being tagged or referenced does not make another user a co-owner" (338)
 *   §17  Command Bus and Domain Events (478)
 *   §19  server-side idempotency (539)
 *   §23  canEditMemory; "Participant membership alone does not grant full
 *        Memory access" (599)
 *   Appendix A step 7: the OWNER "removes one participant" (776)
 *
 * MEASURED BEFORE (census §17 + re-measured against the file this lane edited):
 *   * PATCH /memories/:id accepted any of draft/published/archived with NO
 *     transition guard, so published -> draft and (for a moderator-set row)
 *     removed -> published both applied.
 *   * PATCH /memories/:id/tags/:userId opened with
 *     `if (userId !== user.id) forbidden`, so the OWNER could not remove a
 *     tagged person from their own Memory and no other route could either.
 *   * No write carried an idempotency key, an audit row or a domain event.
 *
 * THE FALSE-GREEN RULE, APPLIED TO THIS FILE
 * ==========================================
 *   * Every refusal asserts a SPECIFIC status AND the reason code, never
 *     `status !== 200` — a crash-500 would satisfy that and does not satisfy
 *     these.
 *   * The `req.log` shim is installed on every app, so a handler that threw
 *     would produce a 500 with no reason code and fail the assertion rather
 *     than masquerading as a considered refusal.
 *   * Every refusal is PAIRED with the same fixture succeeding, so "the route
 *     is simply broken" cannot produce the green.
 *   * The replay test asserts ONE effect and the SAME body twice. A test that
 *     only asserted "no crash on the second call" would pass against a route
 *     that applied the command twice.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryCommandRoutes.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import memoriesRouter from "../routes/memories.js";
import { makeKernelRpc, _resetKernelIds, type KernelState, type KernelWriteTarget } from "./memoryCommandKernelFake.js";

const OWNER   = "10000000-0000-4000-8000-00000000a001";
const TAGGED  = "10000000-0000-4000-8000-00000000a002";
const OUTSIDER= "10000000-0000-4000-8000-00000000a003";

const M_PUB   = "30000000-0000-4000-8000-00000000b001"; // published
const M_DRAFT = "30000000-0000-4000-8000-00000000b002"; // draft
const M_ARCH  = "30000000-0000-4000-8000-00000000b003"; // archived
const M_RMVD  = "30000000-0000-4000-8000-00000000b004"; // moderator-removed
const ITEM    = "40000000-0000-4000-8000-00000000c001";

const memory = (id: string, state: string) => ({
  id, owner_id: OWNER, visibility: "public", trip_id: null,
  title: "t", caption: null, allowed_user_ids: [], hidden_user_ids: [],
  event_id: null, place_id: null, location_city: null, location_country: null,
  location_lat: null, location_lng: null, canonical_location_id: null,
  starts_at: null, ends_at: null, state,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: null,
});

function fixtureTables(kernelOn: boolean): Record<string, any[]> {
  return {
    feature_flags: kernelOn ? [{ flag: "memory_kernel_enabled", enabled: true }] : [],
    profiles: [OWNER, TAGGED, OUTSIDER].map((id) => ({
      id, handle: `h${id.slice(-3)}`, name: "n", avatar_url: null,
      account_status: "active", is_private: false,
    })),
    memories: [memory(M_PUB, "published"), memory(M_DRAFT, "draft"), memory(M_ARCH, "archived"), memory(M_RMVD, "removed")],
    memory_items: [{ id: ITEM, memory_id: M_PUB, media_url: "https://x/storage/v1/object/public/post-media/memories/other/f.jpg", media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-01T00:00:00.000Z" }],
    memory_tags: [{ memory_id: M_PUB, tagged_user_id: TAGGED, status: "pending", created_at: "2026-01-01T00:00:00.000Z" }],
    memory_likes: [], memory_saves: [], blocks: [], user_follows: [],
    circle_memberships: [], notifications: [], hidden_gems: [], trips: [], trip_members: [],
    memory_domain_events: [], memory_event_outbox: [], memory_command_receipts: [], memory_command_audit: [],
  };
}

function makeFakeClient(state: KernelState, opts: { failTables?: Set<string> } = {}) {
  const failTables = opts.failTables ?? new Set<string>();
  const tables = state.tables;
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "update" | "upsert" | "delete" | null = null;
    let payload: any = null;
    const obj: any = {
      select(_c?: string, _o?: any) { if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any) { isWrite = true; mode = "upsert"; payload = d; return obj; },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt() { return obj; }, lt() { return obj; }, not() { return obj; },
      ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const all = (tables[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r, id: r.id ?? `new-${Math.random().toString(16).slice(2)}` }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        const gone = new Set(matched);
        tables[table] = all.filter((r) => !gone.has(r));
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
      }
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched, error: null, count: null };
    }
    return obj;
  }
  const rpc = makeKernelRpc(state);
  return {
    from(table: string) { return chain(table); },
    rpc,
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

interface App {
  baseUrl: string; close: () => Promise<void>;
  errors: Array<{ obj: any; msg: string }>;
  state: KernelState;
  tables: Record<string, any[]>;
}

async function startApp(opts: {
  kernelOn?: boolean; failOn?: KernelWriteTarget[]; absent?: boolean; failTables?: Set<string>;
} = {}): Promise<App> {
  _resetKernelIds();
  const state: KernelState = {
    tables: fixtureTables(opts.kernelOn ?? false),
    rpcCalls: [],
    failOn: new Set(opts.failOn ?? []),
    absent: opts.absent ?? false,
  };
  _setTestClient(makeFakeClient(state, { failTables: opts.failTables }) as any, true);
  const errors: Array<{ obj: any; msg: string }> = [];
  const realInfo = logger.info.bind(logger);
  const realWarn = logger.warn.bind(logger);
  (logger as any).info = () => {};
  (logger as any).warn = () => {};
  const app = express();
  app.use(express.json());
  // The req.log shim. Without it a handler that throws produces a 500 that a
  // loose assertion would read as a considered refusal.
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (obj: any, msg: string) => errors.push({ obj, msg }), info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", memoriesRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, errors, state, tables: state.tables,
        close: () => new Promise<void>((r) => {
          (logger as any).info = realInfo; (logger as any).warn = realWarn;
          srv.close(() => r());
        }),
      });
    });
    srv.on("error", reject);
  });
}

async function call(app: App, method: string, path: string, viewer: string, body?: unknown, idem?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${viewer}`, "Content-Type": "application/json", connection: "close",
  };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(app.baseUrl + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const stateOf = (app: App, id: string) => app.tables.memories.find((m) => m.id === id)?.state;

// ═════════════════════════════════════════════════════════════════════════════
// 1. §5 lifecycle. The guard runs with the kernel OFF, which is the point:
//    it needs no table that does not exist.
// ═════════════════════════════════════════════════════════════════════════════

describe("§5 Memory lifecycle — PATCH refuses an illegal transition instead of applying it", () => {
  const LEGAL: Array<[string, string, string]> = [
    [M_DRAFT, "published", "CANDIDATE -> ACTIVE (§5's drawn path, one step)"],
    [M_PUB, "archived", "ACTIVE -> ARCHIVED (drawn)"],
    [M_ARCH, "published", "ARCHIVED -> ACTIVE (§21: archive is reversible by design)"],
  ];
  for (const [id, to, why] of LEGAL) {
    it(`ALLOWS ${stateName(id)} -> ${to} — ${why}`, async () => {
      const app = await startApp();
      try {
        const r = await call(app, "PATCH", `/api/memories/${id}`, OWNER, { state: to });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(stateOf(app, id), to, "the row was actually written");
      } finally { await app.close(); }
    });
  }

  const ILLEGAL: Array<[string, string, string, string]> = [
    [M_PUB, "draft", "MEMORY_LIFECYCLE_INVALID_TRANSITION", "§5 draws no arrow back into CANDIDATE; §21 names Archive for this"],
    [M_ARCH, "draft", "MEMORY_LIFECYCLE_INVALID_TRANSITION", "same arrow"],
    [M_RMVD, "published", "MEMORY_LIFECYCLE_TERMINAL", "a moderator-removed memory restored to the discovery feed by its owner"],
    [M_RMVD, "archived", "MEMORY_LIFECYCLE_TERMINAL", "same row, any target"],
  ];
  for (const [id, to, reason, why] of ILLEGAL) {
    it(`REFUSES ${stateName(id)} -> ${to} with ${reason} — ${why}`, async () => {
      const app = await startApp();
      const before = stateOf(app, id);
      try {
        const r = await call(app, "PATCH", `/api/memories/${id}`, OWNER, { state: to });
        assert.equal(r.status, 409, JSON.stringify(r.body));
        assert.equal(r.body?.reason, reason);
        assert.equal(r.body?.error, "invalid_state_transition");
        assert.equal(stateOf(app, id), before, "the row must be untouched");
      } finally { await app.close(); }
    });
  }

  it("DELETE of a moderator-removed memory is refused as terminal, and the row keeps state='removed'", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_RMVD}`, OWNER);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body?.reason, "MEMORY_LIFECYCLE_TERMINAL");
      assert.equal(stateOf(app, M_RMVD), "removed");
    } finally { await app.close(); }
  });

  it("PAIRED: DELETE of a published memory still works and writes state='deleted'", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_PUB}`, OWNER);
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.equal(stateOf(app, M_PUB), "deleted");
    } finally { await app.close(); }
  });

  it("a PATCH that touches no state is unaffected by the machine", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "new" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(app.tables.memories.find((m) => m.id === M_PUB)?.title, "new");
      assert.equal(stateOf(app, M_PUB), "published");
    } finally { await app.close(); }
  });
});

function stateName(id: string): string {
  return id === M_PUB ? "published" : id === M_DRAFT ? "draft" : id === M_ARCH ? "archived" : "removed";
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. §17 REMOVE_PERSON — the owner may; the tagged person may; nobody else.
//    ADD_PERSON (approve) is the tagged person's consent alone.
// ═════════════════════════════════════════════════════════════════════════════

const tagStatus = (app: App) =>
  app.tables.memory_tags.find((t) => t.memory_id === M_PUB && t.tagged_user_id === TAGGED)?.status;

describe("§17 REMOVE_PERSON — who may change a Memory's participant set", () => {
  it("THE OWNER MAY REMOVE A TAGGED PERSON (Appendix A line 776) — this was 'forbidden' before this lane", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}/tags/${TAGGED}`, OWNER, { action: "remove" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body?.status, "removed");
      assert.equal(tagStatus(app), "removed", "the tag row actually changed");
    } finally { await app.close(); }
  });

  it("the tagged person may still remove themselves (§5 line 226 — consent is theirs to withdraw)", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}/tags/${TAGGED}`, TAGGED, { action: "remove" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(tagStatus(app), "removed");
    } finally { await app.close(); }
  });

  it("a stranger may not remove someone else's tag — 403 MEMORY_AUTH_NOT_OWNER, tag unchanged", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}/tags/${TAGGED}`, OUTSIDER, { action: "remove" });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body?.reason, "MEMORY_AUTH_NOT_OWNER");
      assert.equal(tagStatus(app), "pending");
    } finally { await app.close(); }
  });

  it("THE OWNER MAY NOT APPROVE A TAG ON THE PERSON'S BEHALF — 403 MEMORY_AUTH_NOT_PARTICIPANT (§5 line 226)", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}/tags/${TAGGED}`, OWNER, { action: "approve" });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body?.reason, "MEMORY_AUTH_NOT_PARTICIPANT");
      assert.equal(tagStatus(app), "pending", "consent was not manufactured");
    } finally { await app.close(); }
  });

  it("PAIRED: the tagged person approving their own tag still works", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}/tags/${TAGGED}`, TAGGED, { action: "approve" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(tagStatus(app), "approved");
    } finally { await app.close(); }
  });

  it("an unreadable memory_tags is a 500, not 'Tag not found' (supabase-js resolves on a DB error)", async () => {
    const app = await startApp({ failTables: new Set(["memory_tags"]) });
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}/tags/${TAGGED}`, TAGGED, { action: "remove" });
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.notEqual(r.body?.error, "not_found");
    } finally { await app.close(); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. §19 idempotency — the same key twice applies ONCE and returns the ORIGINAL
//    body. Kernel ON, because the receipt is the kernel's.
// ═════════════════════════════════════════════════════════════════════════════

describe("§19 idempotent replay — same key twice, one effect, same body", () => {
  it("PATCH replay: one command applied, identical response body, one event, one outbox row", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const key = "op-patch-0001";
      const first = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "first" }, key);
      assert.equal(first.status, 200, JSON.stringify(first.body));

      // A DIFFERENT body under the SAME key. §19's operation id identifies the
      // operation; the server must answer the operation it already performed,
      // not the new payload. A route that recomputed would write "second".
      const second = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "second" }, key);
      assert.equal(second.status, 200, JSON.stringify(second.body));

      assert.deepEqual(second.body, first.body, "the ORIGINAL result, not a fresh one");
      assert.equal(app.tables.memories.find((m) => m.id === M_PUB)?.title, "first",
        "the second call must not have applied its own payload");
      assert.equal(app.tables.memory_domain_events.length, 1, "exactly one domain event");
      assert.equal(app.tables.memory_event_outbox.length, 1, "exactly one outbox row");
      assert.equal(app.tables.memory_command_receipts.length, 1, "one receipt");
      // The audit records BOTH attempts — the second as a duplicate. §24.
      assert.deepEqual(app.tables.memory_command_audit.map((a: any) => a.outcome), ["accepted", "duplicate"]);
    } finally { await app.close(); }
  });

  it("ADD_MEDIA replay: one item, not two", async () => {
    const app = await startApp({ kernelOn: true });
    const before = app.tables.memory_items.length;
    try {
      const key = "op-media-0001";
      const body = { mediaUrl: "https://example.test/a.jpg", mediaType: "image/jpeg", position: 0 };
      const first = await call(app, "POST", `/api/memories/${M_PUB}/items`, OWNER, body, key);
      const second = await call(app, "POST", `/api/memories/${M_PUB}/items`, OWNER, body, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.deepEqual(second.body, first.body);
      assert.equal(app.tables.memory_items.length, before + 1, "exactly one item was added");
      assert.equal(app.tables.memory_event_outbox.length, 1);
    } finally { await app.close(); }
  });

  it("PAIRED: two DIFFERENT keys apply twice — the dedup is the key's, not an accident of the route", async () => {
    const app = await startApp({ kernelOn: true });
    const before = app.tables.memory_items.length;
    try {
      const body = { mediaUrl: "https://example.test/a.jpg", mediaType: "image/jpeg", position: 0 };
      await call(app, "POST", `/api/memories/${M_PUB}/items`, OWNER, body, "k-1");
      await call(app, "POST", `/api/memories/${M_PUB}/items`, OWNER, body, "k-2");
      assert.equal(app.tables.memory_items.length, before + 2);
      assert.equal(app.tables.memory_event_outbox.length, 2);
    } finally { await app.close(); }
  });

  it("reusing one key for a DIFFERENT command is a 409, not a wrong-answer replay", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const key = "op-shared-0001";
      const first = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "x" }, key);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const second = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { state: "archived" }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body?.reason, "MEMORY_IDEMPOTENCY_KEY_REUSED");
      assert.equal(stateOf(app, M_PUB), "published", "the second command was not applied");
    } finally { await app.close(); }
  });

  it("an over-long Idempotency-Key is a 400 before any write", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "x" }, "k".repeat(201));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(app.state.rpcCalls.length, 0, "no command was issued");
      assert.equal(app.tables.memories.find((m) => m.id === M_PUB)?.title, "t");
    } finally { await app.close(); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Honest degradation — the kernel flag is on but the function is not there.
// ═════════════════════════════════════════════════════════════════════════════

describe("kernel enabled, migration 2710 NOT applied — the route reports unavailable, never success", () => {
  for (const [method, path, body] of [
    ["PATCH", `/api/memories/${M_PUB}`, { title: "x" }],
    ["DELETE", `/api/memories/${M_PUB}`, undefined],
    ["POST", `/api/memories/${M_PUB}/items`, { mediaUrl: "https://example.test/a.jpg", mediaType: "image/jpeg", position: 0 }],
  ] as Array<[string, string, any]>) {
    it(`${method} ${path.replace(M_PUB, ":id")} → 503 MEMORY_KERNEL_UNAVAILABLE, canonical row untouched`, async () => {
      const app = await startApp({ kernelOn: true, absent: true });
      const titleBefore = app.tables.memories.find((m) => m.id === M_PUB)?.title;
      const itemsBefore = app.tables.memory_items.length;
      try {
        const r = await call(app, method, path, OWNER, body);
        assert.equal(r.status, 503, JSON.stringify(r.body));
        assert.equal(r.body?.reason, "MEMORY_KERNEL_UNAVAILABLE");
        assert.equal(app.tables.memories.find((m) => m.id === M_PUB)?.title, titleBefore);
        assert.equal(stateOf(app, M_PUB), "published");
        assert.equal(app.tables.memory_items.length, itemsBefore);
        assert.equal(app.tables.memory_event_outbox.length, 0, "no event for a command that did not apply");
      } finally { await app.close(); }
    });
  }

  it("it does NOT fall back to the unaudited direct write", async () => {
    const app = await startApp({ kernelOn: true, absent: true });
    try {
      await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "sneaky" });
      assert.equal(app.tables.memories.find((m) => m.id === M_PUB)?.title, "t");
      assert.equal(app.tables.memory_command_audit.length, 0);
    } finally { await app.close(); }
  });

  it("PAIRED: with the function present the same three calls succeed", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      assert.equal((await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "x" })).status, 200);
      assert.equal((await call(app, "POST", `/api/memories/${M_PUB}/items`, OWNER,
        { mediaUrl: "https://example.test/a.jpg", mediaType: "image/jpeg", position: 0 })).status, 201);
      assert.equal((await call(app, "DELETE", `/api/memories/${M_PUB}`, OWNER)).status, 204);
    } finally { await app.close(); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The flag OFF path is the pre-lane behaviour, plus the guard.
// ═════════════════════════════════════════════════════════════════════════════

describe("kernel flag OFF — the legacy direct write still runs and no event is invented", () => {
  it("PATCH applies and writes NO event, NO outbox row, NO receipt", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { title: "legacy" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(app.tables.memories.find((m) => m.id === M_PUB)?.title, "legacy");
      assert.equal(app.state.rpcCalls.length, 0, "the kernel function was never called");
      assert.equal(app.tables.memory_domain_events.length, 0);
      assert.equal(app.tables.memory_event_outbox.length, 0);
      assert.equal(app.tables.memory_command_receipts.length, 0);
    } finally { await app.close(); }
  });

  it("the §5 guard still refuses published -> draft with the flag off", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}`, OWNER, { state: "draft" });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body?.reason, "MEMORY_LIFECYCLE_INVALID_TRANSITION");
      assert.equal(app.state.rpcCalls.length, 0);
      assert.equal(stateOf(app, M_PUB), "published");
    } finally { await app.close(); }
  });

  it("the owner can still remove a tagged person with the flag off", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_PUB}/tags/${TAGGED}`, OWNER, { action: "remove" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(tagStatus(app), "removed");
    } finally { await app.close(); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. The create path's swallowed participant insert.
// ═════════════════════════════════════════════════════════════════════════════

describe("CREATE_MEMORY — a failed memory_tags insert is no longer invisible", () => {
  it("the Memory is still created (201) but the failure is logged and nobody is notified", async () => {
    const app = await startApp({ failTables: new Set(["memory_tags"]) });
    try {
      const r = await call(app, "POST", "/api/memories", OWNER, {
        title: "n", visibility: "public", taggedUserIds: [TAGGED],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const logged = app.errors.find((e) => e.msg.includes("memory_tags insert failed"));
      assert.ok(logged, `the failed tag insert must be logged; saw ${JSON.stringify(app.errors.map((e) => e.msg))}`);
      assert.equal(app.tables.notifications.length, 0, "nobody is told about a tag that does not exist");
    } finally { await app.close(); }
  });

  it("PAIRED: with memory_tags writable the tag lands and no failure is logged", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", "/api/memories", OWNER, {
        title: "n", visibility: "public", taggedUserIds: [TAGGED],
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const created = r.body.memory.id;
      assert.ok(app.tables.memory_tags.some((t: any) => t.memory_id === created && t.tagged_user_id === TAGGED));
      assert.equal(app.errors.find((e) => e.msg.includes("memory_tags insert failed")), undefined);
    } finally { await app.close(); }
  });
});
