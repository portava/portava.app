/**
 * §5 / §17 — highlight.created, highlight.published and highlight.expired get
 * their producers (census H155, H156, H157; migration 3677).
 *
 *   H155/H156  POST /highlights and POST /stories/:id/save-to-highlight issue
 *              CREATE_HIGHLIGHT (EXT) through dispatchMemoryCommand. Kernel ON:
 *              public.highlight_create_execute inserts the row and writes
 *              highlight.created (seq 1) + highlight.published (seq 2) and their
 *              outbox rows in the SAME transaction. Kernel OFF (the seed): the
 *              legacy insert, unchanged, and no event.
 *   H157       lib/highlightExpiryEventScheduler.ts calls
 *              public.highlight_expiry_emit behind TWO flags, both fail-closed.
 *
 * The SQL functions themselves are rehearsed against PostgreSQL in
 * sql/rehearsals/3677_01_highlight_lifecycle_events.sql (the full migration
 * chain on a throwaway database). This file pins the TypeScript half: routing,
 * the envelope, the flag-off path, the replay fold, the scheduler's gates.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightLifecycleEvents.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import highlightsRouter from "../routes/highlights.js";
import storiesRouter from "../routes/stories.js";
import {
  COMMAND_ALSO_EMITS, COMMAND_CAPABILITY, COMMAND_EVENT, COMMAND_KERNEL_FN, COMMAND_SUBJECT,
  HIGHLIGHT_CREATE_FN, MEMORY_COMMAND_TYPES_NOT_DECLARED,
} from "../lib/memoryCommandBus.js";
import { eventPayloadIsPrivacyFiltered } from "../lib/memoryOutbox.js";
import { replayHighlightEvents, replayAgreesWithRow } from "../services/memoryProjections/highlightEventReplay.js";
import {
  runHighlightExpiryPass, runHighlightExpiryTick, highlightExpiryHealthDetail, _resetHighlightExpiryStatus,
  HIGHLIGHT_EXPIRY_FLAG, HIGHLIGHT_EXPIRY_FN, HIGHLIGHT_EXPIRY_BATCH, HIGHLIGHT_EXPIRY_MAX_BATCHES, HIGHLIGHT_EXPIRY_JOB_KEY,
} from "../lib/highlightExpiryEventScheduler.js";
import { makeKernelRpc, _resetKernelIds, type KernelState } from "./memoryCommandKernelFake.js";

const OWNER = "10000000-0000-4000-8000-00000000e001";
const STORY = "20000000-0000-4000-8000-00000000e001";

function fixtureTables(kernelOn: boolean): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "stories_enabled", enabled: true }, ...(kernelOn ? [{ flag: "memory_kernel_enabled", enabled: true }] : [])],
    profiles: [{ id: OWNER, handle: "own", name: "n", avatar_url: null, account_status: "active", is_private: false }],
    highlights: [],
    stories: [{
      id: STORY, owner_id: OWNER, media_url: "post-media/owner/story.jpg", media_type: "image/jpeg", caption: "a private caption",
      visibility: "public", close_friends_only: false, allowed_user_ids: [], hidden_user_ids: [], trip_id: null,
      state: "active", expires_at: "2099-01-01T00:00:00.000Z", saved_to_highlight_id: null,
    }],
    blocks: [], user_follows: [], circle_memberships: [],
    memory_domain_events: [], memory_event_outbox: [], memory_command_receipts: [], memory_command_audit: [],
  };
}

function makeFakeClient(state: KernelState) {
  const failHighlightRead = (state as any).failHighlightRead === true;
  const tables = state.tables;
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "update" | "upsert" | null = null;
    let payload: any = null;
    const obj: any = {
      select() { if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any) { isWrite = true; mode = "upsert"; payload = d; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      neq() { return obj; }, gt() { return obj; }, lt() { return obj; }, gte() { return obj; }, lte() { return obj; },
      not() { return obj; }, or() { return obj; }, order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      const all = (tables[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r, id: r.id ?? `legacy-${table}-${all.length + 1}` }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null };
      }
      if (failHighlightRead && table === "highlights" && mode === null) return { data: null, error: { message: "read failed", code: "57014" } };
      const matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        if (!selectedAfterWrite) return { data: null, error: null };
      }
      return { data: single ? (matched[0] ?? null) : matched, error: null };
    }
    return obj;
  }
  return {
    from: chain,
    rpc: makeKernelRpc(state),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

async function startApp(opts: { kernelOn?: boolean; absent?: boolean; expiresAtNotNull?: boolean; failHighlightRead?: boolean } = {}) {
  _resetKernelIds();
  const state: KernelState = { tables: fixtureTables(opts.kernelOn ?? false), rpcCalls: [], failOn: new Set(), absent: opts.absent ?? false };
  (state as any).expiresAtNotNull = opts.expiresAtNotNull ?? false;
  (state as any).failHighlightRead = opts.failHighlightRead ?? false;
  _setTestClient(makeFakeClient(state) as any, true);
  const realInfo = logger.info.bind(logger), realWarn = logger.warn.bind(logger);
  const lines: string[] = [];
  (logger as any).info = (_o: unknown, msg?: string) => { lines.push(String(msg ?? "")); }; (logger as any).warn = (_o: unknown, msg?: string) => { lines.push(String(msg ?? "")); };
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", highlightsRouter);
  app.use("/api", storiesRouter);
  return new Promise<{ baseUrl: string; state: KernelState; t: Record<string, any[]>; lines: string[]; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, state, t: state.tables, lines,
        close: () => new Promise<void>((r) => { (logger as any).info = realInfo; (logger as any).warn = realWarn; srv.closeAllConnections(); srv.close(() => r()); }),
      });
    });
    srv.on("error", reject);
  });
}

async function post(base: string, path: string, body: unknown, idem?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json", connection: "close" };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const CREATE = { mediaUrl: "https://x/storage/v1/object/public/post-media/h.jpg", mediaType: "image/jpeg", caption: "a private caption", visibility: "circle_only", expiresInHours: 24, lifetimeClass: "DAY" };

describe("§17 CREATE_HIGHLIGHT — the vocabulary", () => {
  it("is a Highlight command run by 3677's own function, emitting highlight.created then highlight.published", () => {
    assert.equal(COMMAND_SUBJECT.CREATE_HIGHLIGHT, "highlight");
    assert.equal(COMMAND_KERNEL_FN.CREATE_HIGHLIGHT, HIGHLIGHT_CREATE_FN);
    assert.equal(HIGHLIGHT_CREATE_FN, "highlight_create_execute");
    assert.equal(COMMAND_EVENT.CREATE_HIGHLIGHT, "highlight.created");
    assert.deepEqual([...(COMMAND_ALSO_EMITS.CREATE_HIGHLIGHT ?? [])], ["highlight.published"]);
    assert.equal(COMMAND_CAPABILITY.CREATE_HIGHLIGHT, "none");
    // PUBLISH_HIGHLIGHT stays undeclared: publication happens at creation.
    assert.ok("PUBLISH_HIGHLIGHT" in MEMORY_COMMAND_TYPES_NOT_DECLARED);
    assert.equal(COMMAND_KERNEL_FN.PIN_HIGHLIGHT, "highlight_kernel_execute");
  });
});

describe("H155/H156 POST /highlights crosses the boundary", () => {
  it("kernel ON: one RPC to highlight_create_execute, the row, created + published, two outbox rows, ids-only payloads", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await post(app.baseUrl, "/api/highlights", CREATE, "op-1");
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(app.state.rpcCalls.map((c) => c.name), [HIGHLIGHT_CREATE_FN]);
      const p = app.state.rpcCalls[0].args.p_command;
      assert.equal(p.type, "CREATE_HIGHLIGHT");
      assert.equal(p.actor_user_id, OWNER);
      assert.equal(p.idempotency_key, "op-1");
      assert.equal(p.payload.expires_in_hours, 24);
      assert.equal(p.payload.lifetime_class, "DAY");
      assert.equal(app.t.highlights.length, 1);
      const hl = app.t.highlights[0];
      assert.equal(r.body.id, hl.id, "the response is the created row, read back");
      assert.equal(r.body.caption, "a private caption");
      assert.equal(hl.owner_id, OWNER);
      const evs = app.t.memory_domain_events.filter((e) => e.highlight_id === hl.id).sort((a, b) => a.sequence - b.sequence);
      assert.deepEqual(evs.map((e) => [e.sequence, e.type, e.memory_id]), [[1, "highlight.created", null], [2, "highlight.published", null]]);
      for (const e of evs) {
        assert.equal(e.payload_json.to_state, "ACTIVE");
        assert.equal(e.payload_json.visibility, null, "F4: NULL, as 2993/3001 write it");
        assert.ok(eventPayloadIsPrivacyFiltered(e.payload_json), "§23: no body in the payload");
        assert.ok(!JSON.stringify(e.payload_json).includes("private caption"));
      }
      assert.equal(evs[1].payload_json.published_at_creation, true);
      assert.deepEqual(app.t.memory_event_outbox.map((o) => o.type).sort(), ["highlight.created", "highlight.published"]);
      assert.equal(app.t.memory_command_receipts.length, 1);
      assert.ok(!JSON.stringify(app.t.memory_command_receipts[0].result_json).includes("private caption"), "the receipt holds ids only");
    } finally { await app.close(); }
  });

  it("a replay of the key answers the SAME Highlight and writes nothing new", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const a = await post(app.baseUrl, "/api/highlights", CREATE, "op-2");
      const b = await post(app.baseUrl, "/api/highlights", { ...CREATE, caption: "different" }, "op-2");
      assert.equal(a.status, 201); assert.equal(b.status, 201);
      assert.equal(b.body.id, a.body.id);
      assert.equal(app.t.highlights.length, 1);
      assert.equal(app.t.memory_domain_events.length, 2);
      assert.equal(app.t.memory_event_outbox.length, 2);
    } finally { await app.close(); }
  });

  it("kernel OFF: a malformed Idempotency-Key changes nothing and no audit line is written (verifier F2)", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await post(app.baseUrl, "/api/highlights", CREATE, "k".repeat(201));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(app.t.highlights.length, 1);
      const s = await post(app.baseUrl, `/api/stories/${STORY}/save-to-highlight`, {}, "k".repeat(201));
      assert.equal(s.status, 201, JSON.stringify(s.body));
      assert.ok(!app.lines.some((l) => /memory command/.test(l)), JSON.stringify(app.lines));
    } finally { await app.close(); }
  });

  it("kernel ON: a malformed Idempotency-Key is refused 400 before any write", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await post(app.baseUrl, "/api/highlights", CREATE, "k".repeat(201));
      assert.equal(r.status, 400);
      assert.equal(app.t.highlights.length, 0);
      assert.equal(app.state.rpcCalls.length, 0);
    } finally { await app.close(); }
  });

  it("kernel ON, the read-back fails: 201 with the id and readBack:false — never 'nothing was created'", async () => {
    const app = await startApp({ kernelOn: true, failHighlightRead: true });
    try {
      const r = await post(app.baseUrl, "/api/highlights", CREATE, "op-rb");
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.readBack, false);
      assert.equal(app.t.highlights.length, 1);
      assert.equal(r.body.id, app.t.highlights[0].id);
    } finally { await app.close(); }
  });

  it("kernel OFF (the seed): the legacy insert, no RPC, no event — the flag-off path is unchanged", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await post(app.baseUrl, "/api/highlights", CREATE);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(app.state.rpcCalls.length, 0);
      assert.equal(app.t.highlights.length, 1);
      assert.equal(app.t.highlights[0].owner_id, OWNER);
      assert.ok(typeof app.t.highlights[0].expires_at === "string", "the legacy path computes the expiry itself");
      assert.equal(app.t.memory_domain_events.length, 0);
      assert.equal(app.t.memory_event_outbox.length, 0);
    } finally { await app.close(); }
  });

  it("kernel ON, function absent: 503 and NO row — never a fallback to the unaudited insert", async () => {
    const app = await startApp({ kernelOn: true, absent: true });
    try {
      const r = await post(app.baseUrl, "/api/highlights", CREATE);
      assert.equal(r.status, 503);
      assert.equal(r.body.reason, "MEMORY_KERNEL_UNAVAILABLE");
      assert.equal(app.t.highlights.length, 0);
    } finally { await app.close(); }
  });

  it("PERMANENT goes with no window; on a database that cannot hold it, refused BY NAME with the legacy answer", async () => {
    const ok = await startApp({ kernelOn: true });
    try {
      const r = await post(ok.baseUrl, "/api/highlights", { ...CREATE, lifetimeClass: "PERMANENT" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(ok.state.rpcCalls[0].args.p_command.payload.expires_in_hours, null);
      assert.equal(ok.t.highlights[0].expires_at, null);
    } finally { await ok.close(); }
    const no = await startApp({ kernelOn: true, expiresAtNotNull: true });
    try {
      const r = await post(no.baseUrl, "/api/highlights", { ...CREATE, lifetimeClass: "PERMANENT" });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "feature_disabled");
      assert.equal(r.body.reason, "HIGHLIGHT_LIFETIME_UNAVAILABLE");
      assert.equal(no.t.highlights.length, 0);
    } finally { await no.close(); }
  });
});

describe("H155/H156 POST /stories/:id/save-to-highlight crosses the boundary too", () => {
  it("kernel ON: the Highlight comes from the kernel with both events, and the Story is linked to it", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await post(app.baseUrl, `/api/stories/${STORY}/save-to-highlight`, {});
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(app.state.rpcCalls.map((c) => c.name), [HIGHLIGHT_CREATE_FN]);
      assert.equal(app.state.rpcCalls[0].args.p_command.payload.expires_in_hours, 24);
      assert.equal(app.t.highlights.length, 1, "the kernel's row only — the legacy insert must not ALSO run");
      const hl = app.t.highlights[0];
      assert.equal(r.body.highlightId, hl.id);
      assert.equal(app.t.stories[0].saved_to_highlight_id, hl.id);
      assert.deepEqual(app.t.memory_domain_events.map((e) => e.type), ["highlight.created", "highlight.published"]);
    } finally { await app.close(); }
  });

  it("kernel OFF: the legacy insert and no event", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await post(app.baseUrl, `/api/stories/${STORY}/save-to-highlight`, {});
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(app.state.rpcCalls.length, 0);
      assert.equal(app.t.highlights.length, 1);
      assert.equal(app.t.memory_domain_events.length, 0);
    } finally { await app.close(); }
  });
});

describe("§25 replay folds the creating transaction and the clock", () => {
  const ev = (sequence: number, type: string, payload: any) => ({ event_id: `e${sequence}`, highlight_id: "h", sequence, type, payload_json: payload });
  it("created + published + a clock expiry replay to a live, unpinned, unhidden row", () => {
    const events = [
      ev(1, "highlight.created", { command_type: "CREATE_HIGHLIGHT" }),
      ev(2, "highlight.published", { command_type: "CREATE_HIGHLIGHT", published_at_creation: true }),
      ev(3, "highlight.expired", { command_type: null, cause: "clock" }),
    ];
    const r = replayHighlightEvents("h", events);
    assert.ok(r.ok);
    if (r.ok) { assert.equal(r.state.sequence, 3); assert.deepEqual(r.state.applied, ["CREATE_HIGHLIGHT", "CREATE_HIGHLIGHT"]); }
    assert.deepEqual(replayAgreesWithRow("h", events, { archived_at: null, pinned_at: null }), { ok: true, agrees: true });
  });
  it("published under any other command is still a producer bug, and an expiry that is not the clock is refused", () => {
    const bad = replayHighlightEvents("h", [ev(1, "highlight.published", { command_type: "PIN_HIGHLIGHT" })]);
    assert.ok(!bad.ok && bad.reason === "event_type_mismatch");
    const noCause = replayHighlightEvents("h", [ev(1, "highlight.expired", { command_type: null })]);
    assert.ok(!noCause.ok && noCause.reason === "command_type_absent");
  });
});

describe("H157 the expiry producer — gated twice, bounded, honest about failure", () => {
  function client(opts: { flags: Record<string, boolean>; rpc?: (n: string, a: any) => any }) {
    const calls: any[] = []; const health: any[] = [];
    return {
      calls, health,
      from(table: string) {
        const q: any = {
          _f: {} as Record<string, any>,
          select() { return q; }, eq(c: string, v: any) { q._f[c] = v; return q; }, limit() { return q; },
          maybeSingle: async () => table === "feature_flags" ? { data: q._f.flag in opts.flags ? { flag: q._f.flag, enabled: opts.flags[q._f.flag] } : null, error: null } : { data: null, error: null },
          upsert: async (row: any) => { health.push(row); return { error: null }; },
          then(f: any, r: any) { return Promise.resolve(table === "feature_flags" ? { data: q._f.flag in opts.flags ? [{ flag: q._f.flag, enabled: opts.flags[q._f.flag] }] : [], error: null } : { data: [], error: null }).then(f, r); },
        };
        return q;
      },
      rpc: async (n: string, a: any) => { calls.push({ n, a }); return opts.rpc ? opts.rpc(n, a) : { data: { emitted: 0, more: false }, error: null }; },
    };
  }
  const now = new Date("2026-10-10T12:00:00.000Z");

  it("OFF by its own flag: no RPC", async () => {
    const c = client({ flags: { [HIGHLIGHT_EXPIRY_FLAG]: false, memory_kernel_enabled: true } });
    const r = await runHighlightExpiryPass({ client: c, now });
    assert.equal(r.reason, "disabled"); assert.equal(c.calls.length, 0);
  });
  it("ON but the kernel OFF: no RPC — no stream exists to expire", async () => {
    const c = client({ flags: { [HIGHLIGHT_EXPIRY_FLAG]: true, memory_kernel_enabled: false } });
    const r = await runHighlightExpiryPass({ client: c, now });
    assert.equal(r.reason, "kernel_disabled"); assert.equal(c.calls.length, 0);
  });
  it("both ON: batches of HIGHLIGHT_EXPIRY_BATCH at ONE instant until the backlog is gone, capped per tick", async () => {
    let n = 0;
    const c = client({ flags: { [HIGHLIGHT_EXPIRY_FLAG]: true, memory_kernel_enabled: true },
      rpc: () => ({ data: { emitted: n++ < 2 ? HIGHLIGHT_EXPIRY_BATCH : 7, more: n <= 2 }, error: null }) });
    const r = await runHighlightExpiryPass({ client: c, now });
    assert.equal(r.reason, null);
    assert.equal(r.emitted, 2 * HIGHLIGHT_EXPIRY_BATCH + 7);
    assert.equal(r.batches, 3);
    assert.ok(c.calls.every((x) => x.n === HIGHLIGHT_EXPIRY_FN && x.a.p_limit === HIGHLIGHT_EXPIRY_BATCH && x.a.p_now === now.toISOString()));
    const cap = client({ flags: { [HIGHLIGHT_EXPIRY_FLAG]: true, memory_kernel_enabled: true },
      rpc: () => ({ data: { emitted: HIGHLIGHT_EXPIRY_BATCH, more: true }, error: null }) });
    const rc = await runHighlightExpiryPass({ client: cap, now });
    assert.equal(cap.calls.length, HIGHLIGHT_EXPIRY_MAX_BATCHES);
    assert.equal(rc.backlogRemains, true);
  });
  it("an absent function is not_deployed; a failing call is an error and the tick says so", async () => {
    const absent = client({ flags: { [HIGHLIGHT_EXPIRY_FLAG]: true, memory_kernel_enabled: true }, rpc: () => ({ data: null, error: { code: "PGRST202", message: "x" } }) });
    assert.equal((await runHighlightExpiryPass({ client: absent, now })).reason, "not_deployed");
    _resetHighlightExpiryStatus();
    const broken = client({ flags: { [HIGHLIGHT_EXPIRY_FLAG]: true, memory_kernel_enabled: true }, rpc: () => ({ data: null, error: { code: "57014", message: "timeout" } }) });
    const s = await runHighlightExpiryTick({ client: broken, now });
    assert.equal(s.lastResult?.reason, "error");
    assert.equal(s.consecutiveFailures, 1);
    assert.equal(s.lastSuccessAt, null);
    assert.deepEqual(broken.health, [{ job: HIGHLIGHT_EXPIRY_JOB_KEY, last_run_at: now.toISOString() }], "attempt recorded, success not");
    const ok = client({ flags: { [HIGHLIGHT_EXPIRY_FLAG]: true, memory_kernel_enabled: true } });
    const s2 = await runHighlightExpiryTick({ client: ok, now });
    assert.equal(s2.consecutiveFailures, 0);
    assert.deepEqual(ok.health, [{ job: HIGHLIGHT_EXPIRY_JOB_KEY, last_run_at: now.toISOString(), last_success_at: now.toISOString() }]);
    const off = client({ flags: {} });
    const s3 = await runHighlightExpiryTick({ client: off, now });
    assert.equal(off.health.length, 0, "an OFF tick writes nothing");
    assert.match(highlightExpiryHealthDetail(s3) ?? "", /is OFF/);
  });
});
