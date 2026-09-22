/**
 * §17 COMMAND BOUNDARY over routes/highlights.ts — the four artifacts, the
 * §19 replay, and the flag-off path that still runs on production today.
 *
 * Spec: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §5   the Highlight lifecycle (ACTIVE / PINNED / HIDDEN / EXPIRED)
 *   §12  "Pinned/manual order always outranks automatic ordering."
 *   §17  "All canonical writes should cross an explicit command boundary for
 *        authorization, invariants, idempotency, audit, and downstream event
 *        generation" + PIN/UNPIN/PUBLISH/HIDE_HIGHLIGHT + "canonical mutation
 *        and event-outbox insert occur in one database transaction"
 *   §19  "client-generated operation IDs and server-side idempotency"
 *   §21  Archive is REVERSIBLE and is a different operation from Delete
 *   §23  owner-only
 *   §24  reason codes
 *
 * MEASURED BEFORE THIS LANE (census-highlights-memories.md H142):
 *   "§17's requirement is the COMMAND BOUNDARY, and PIN_HIGHLIGHT is still
 *    absent from MEMORY_COMMAND_TYPES — no idempotency key, no receipt, no
 *    audit row, no outbox insert."
 *   And, measured here against the 20260915 production schema: NO row bearing
 *   any `highlight.*` type could be written at all, because
 *   memory_domain_events.memory_id was `uuid NOT NULL REFERENCES memories(id)`
 *   and `highlights` has no memory_id. Five event names were in the vocabulary
 *   and unreachable.
 *
 * THE FALSE-GREEN RULE, APPLIED TO THIS FILE
 * ==========================================
 *   * The four artifacts are asserted by COUNT and by CONTENT. "An event
 *     exists" would pass against a kernel that wrote one per request; these
 *     assert exactly one, and assert that its subject column is the Highlight
 *     and that `memory_id` is NULL — the shape migration 2993's
 *     one-subject CHECK requires and the shape that did not exist before.
 *   * The replay test asserts ONE state change, the SAME body twice, and NO
 *     second event. A test that only checked "the second call did not crash"
 *     would pass against a route that applied the command twice.
 *   * Every refusal asserts a SPECIFIC status AND the §24 reason code. A
 *     crash-500 satisfies `status !== 200` and satisfies none of these, and the
 *     `req.log` shim means a thrown handler produces exactly that 500.
 *   * Every refusal is PAIRED with the same fixture succeeding, so "the route
 *     is simply broken" cannot produce the green.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightCommandBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import highlightsRouter from "../routes/highlights.js";
import {
  COMMAND_CAPABILITY,
  COMMAND_EVENT,
  COMMAND_SUBJECT,
  HIGHLIGHT_COMMAND_TYPES,
  HIGHLIGHT_KERNEL_FN,
  MEMORY_COMMAND_TYPES_NOT_DECLARED,
} from "../lib/memoryCommandBus.js";
import { eventPayloadIsPrivacyFiltered } from "../lib/memoryOutbox.js";
import { makeKernelRpc, _resetKernelIds, type KernelState, type KernelWriteTarget } from "./memoryCommandKernelFake.js";

const OWNER    = "10000000-0000-4000-8000-00000000a001";
const OUTSIDER = "10000000-0000-4000-8000-00000000a003";

const H_LIVE    = "50000000-0000-4000-8000-00000000d001"; // owner's, active
const H_OTHER   = "50000000-0000-4000-8000-00000000d002"; // someone else's
const H_DELETED = "50000000-0000-4000-8000-00000000d003"; // owner's, soft-deleted
const H_ABSENT  = "50000000-0000-4000-8000-00000000d0ff"; // no row at all

const highlight = (id: string, owner: string, extra: Record<string, unknown> = {}) => ({
  id, owner_id: owner,
  // A caption and a media URL are in the fixture ON PURPOSE: §23 forbids them
  // from reaching an event payload, and a fixture with neither could not catch
  // a kernel that copied the row in.
  media_url: "https://x/storage/v1/object/public/post-media/h.jpg",
  media_type: "image/jpeg", caption: "a private caption",
  location_name: null, location_city: null, location_country: null,
  visibility: "public", expires_at: "2099-01-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z", updated_at: null,
  deleted_at: null, archived_at: null, pinned_at: null,
  lifetime_class: null, lifecycle_state: null, highlight_type: null,
  ...extra,
});

function fixtureTables(kernelOn: boolean): Record<string, any[]> {
  return {
    feature_flags: kernelOn ? [{ flag: "memory_kernel_enabled", enabled: true }] : [],
    profiles: [OWNER, OUTSIDER].map((id) => ({
      id, handle: `h${id.slice(-3)}`, name: "n", avatar_url: null,
      account_status: "active", is_private: false,
    })),
    highlights: [
      highlight(H_LIVE, OWNER),
      highlight(H_OTHER, OUTSIDER),
      highlight(H_DELETED, OWNER, { deleted_at: "2026-02-01T00:00:00.000Z" }),
    ],
    blocks: [], user_follows: [], circle_memberships: [],
    memory_domain_events: [], memory_event_outbox: [],
    memory_command_receipts: [], memory_command_audit: [],
  };
}

function makeFakeClient(state: KernelState) {
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
      gt() { return obj; }, lt() { return obj; }, gte() { return obj; }, lte() { return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      const all = (tables[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r, id: r.id ?? `new-${Math.random().toString(16).slice(2)}` }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      const matched = all.filter((r) => filters.every((f) => f(r)));
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
  return {
    from(table: string) { return chain(table); },
    rpc: makeKernelRpc(state),
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
  kernelOn?: boolean; failOn?: KernelWriteTarget[]; absent?: boolean;
} = {}): Promise<App> {
  _resetKernelIds();
  const state: KernelState = {
    tables: fixtureTables(opts.kernelOn ?? false),
    rpcCalls: [],
    failOn: new Set(opts.failOn ?? []),
    absent: opts.absent ?? false,
  };
  _setTestClient(makeFakeClient(state) as any, true);
  const errors: Array<{ obj: any; msg: string }> = [];
  const realInfo = logger.info.bind(logger);
  const realWarn = logger.warn.bind(logger);
  (logger as any).info = () => {};
  (logger as any).warn = () => {};
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (obj: any, msg: string) => errors.push({ obj, msg }), info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", highlightsRouter);
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

async function call(app: App, method: string, path: string, viewer: string, idem?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${viewer}`, "Content-Type": "application/json", connection: "close",
  };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch(app.baseUrl + path, { method, headers });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body };
}

const row = (app: App, id: string) => app.tables.highlights.find((h) => h.id === id)!;

// ── 1. The vocabulary, and the one command that is still refused ─────────────

describe("§17 vocabulary — three Highlight commands are declared, PUBLISH_HIGHLIGHT is not", () => {
  it("the three declared Highlight commands are owner-capability and map to §17 event names", () => {
    assert.deepEqual([...HIGHLIGHT_COMMAND_TYPES].sort(),
      ["HIDE_HIGHLIGHT", "PIN_HIGHLIGHT", "UNPIN_HIGHLIGHT"]);
    for (const t of HIGHLIGHT_COMMAND_TYPES) {
      assert.equal(COMMAND_SUBJECT[t], "highlight");
      assert.equal(COMMAND_CAPABILITY[t], "owner", `${t} must be owner-only (§23)`);
    }
    // §17 lists no `highlight.unpinned`, so the pin and the unpin share an
    // event name and the payload distinguishes them — the ADD_MEDIA /
    // REMOVE_MEDIA precedent.
    assert.equal(COMMAND_EVENT.PIN_HIGHLIGHT, "highlight.pinned");
    assert.equal(COMMAND_EVENT.UNPIN_HIGHLIGHT, "highlight.pinned");
    assert.equal(COMMAND_EVENT.HIDE_HIGHLIGHT, "highlight.hidden");
  });

  it("PUBLISH_HIGHLIGHT stays undeclared, and its reason is a schema fact", () => {
    assert.ok("PUBLISH_HIGHLIGHT" in MEMORY_COMMAND_TYPES_NOT_DECLARED);
    const reason = (MEMORY_COMMAND_TYPES_NOT_DECLARED as any).PUBLISH_HIGHLIGHT as string;
    assert.match(reason, /published_at/);
    assert.match(reason, /lifecycle_state/);
    assert.ok(!/lane/i.test(reason), `an ownership reason is not a technical one: ${reason}`);
  });
});

// ── 2. The flag-off path: production today ───────────────────────────────────

describe("kernel OFF — the direct write is byte-identical and emits nothing", () => {
  it("POST /highlights/:id/pin writes pinned_at, calls no RPC and writes no kernel row", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-off-1");
      assert.equal(r.status, 200);
      assert.equal(r.body.id, H_LIVE);
      assert.ok(r.body.pinnedAt, "the body still carries the pin timestamp");
      assert.notEqual(row(app, H_LIVE).pinned_at, null);

      assert.deepEqual(app.state.rpcCalls, [], "the kernel must not be called with the flag off");
      assert.equal(app.tables.memory_domain_events.length, 0);
      assert.equal(app.tables.memory_event_outbox.length, 0);
      assert.equal(app.tables.memory_command_receipts.length, 0);
      assert.equal(app.tables.memory_command_audit.length, 0);
    } finally { await app.close(); }
  });

  it("a second identical key with the flag off applies AGAIN — there is no receipt to stop it, and the test says so", async () => {
    // This is not a bug being asserted as behaviour; it is the measured cost of
    // the flag being false, recorded so the difference the kernel makes is
    // visible rather than assumed. With the flag off there is no receipt table
    // to consult, so §19 idempotency is NOT in force on production today.
    const app = await startApp({ kernelOn: false });
    try {
      await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-off-2");
      const first = row(app, H_LIVE).pinned_at;
      await call(app, "DELETE", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-off-2");
      assert.equal(row(app, H_LIVE).pinned_at, null, "the unpin applied; no key stopped it");
      assert.ok(first, "and the pin had applied first");
      assert.equal(app.tables.memory_command_receipts.length, 0);
    } finally { await app.close(); }
  });

  it("the zero-row answer is still one 404 for not-yours, not-there and deleted", async () => {
    const app = await startApp({ kernelOn: false });
    try {
      for (const id of [H_OTHER, H_ABSENT, H_DELETED]) {
        const r = await call(app, "POST", `/api/highlights/${id}/pin`, OWNER, `k-off-404-${id}`);
        assert.equal(r.status, 404, `${id} must be 404`);
        assert.equal(r.body.error, "not_found");
        assert.equal(r.body.message, "Highlight not found");
      }
      // PAIRED with the success, so "the route is broken" cannot produce this.
      const ok = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-off-404-ok");
      assert.equal(ok.status, 200);
    } finally { await app.close(); }
  });
});

// ── 3. The four artifacts ────────────────────────────────────────────────────

describe("§17 the command boundary — one transaction, four artifacts", () => {
  it("PIN_HIGHLIGHT writes the column, ONE event, ONE outbox row, ONE receipt and ONE audit row", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-pin");
      assert.equal(r.status, 200);
      assert.equal(r.body.id, H_LIVE);
      assert.ok(r.body.pinnedAt);
      assert.notEqual(row(app, H_LIVE).pinned_at, null);

      assert.equal(app.state.rpcCalls.length, 1);
      assert.equal(app.state.rpcCalls[0].name, HIGHLIGHT_KERNEL_FN,
        "a Highlight command must not be sent to the Memory kernel");

      assert.equal(app.tables.memory_domain_events.length, 1);
      const ev = app.tables.memory_domain_events[0];
      assert.equal(ev.type, "highlight.pinned");
      // THE SHAPE THAT DID NOT EXIST BEFORE MIGRATION 2993.
      assert.equal(ev.highlight_id, H_LIVE);
      assert.equal(ev.memory_id, null, "exactly one subject, and it is not the Memory column");

      assert.equal(app.tables.memory_event_outbox.length, 1);
      assert.equal(app.tables.memory_event_outbox[0].event_id, ev.event_id);
      assert.equal(app.tables.memory_event_outbox[0].highlight_id, H_LIVE);
      assert.equal(app.tables.memory_event_outbox[0].memory_id, null);
      assert.equal(app.tables.memory_event_outbox[0].published_at, null);

      assert.equal(app.tables.memory_command_receipts.length, 1);
      assert.equal(app.tables.memory_command_receipts[0].idempotency_key, "k-pin");
      assert.equal(app.tables.memory_command_receipts[0].command_type, "PIN_HIGHLIGHT");
      assert.equal(app.tables.memory_command_receipts[0].highlight_id, H_LIVE);

      assert.equal(app.tables.memory_command_audit.length, 1);
      assert.equal(app.tables.memory_command_audit[0].outcome, "accepted");
      assert.equal(app.tables.memory_command_audit[0].highlight_id, H_LIVE);
      assert.equal(app.tables.memory_command_audit[0].event_id, ev.event_id);
    } finally { await app.close(); }
  });

  it("the event payload is §23 privacy-filtered — the caption and media URL do not travel", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-priv");
      const ev = app.tables.memory_domain_events[0];
      assert.ok(eventPayloadIsPrivacyFiltered(ev.payload_json),
        `payload carries a forbidden key: ${JSON.stringify(ev.payload_json)}`);
      assert.equal(JSON.stringify(ev.payload_json).includes("a private caption"), false);
      // The state it reports is DERIVED, and it says so rather than implying a
      // stored lifecycle_state that nothing writes.
      assert.equal(ev.payload_json.state_provenance, "derived");
      assert.equal(ev.payload_json.from_state, "ACTIVE");
      assert.equal(ev.payload_json.to_state, "PINNED");
    } finally { await app.close(); }
  });

  it("UNPIN_HIGHLIGHT emits highlight.pinned and the payload carries the command and the resulting state", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-u1");
      const r = await call(app, "DELETE", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-u2");
      assert.equal(r.status, 200);
      assert.equal(r.body.pinnedAt, null);
      assert.equal(row(app, H_LIVE).pinned_at, null);

      assert.equal(app.tables.memory_domain_events.length, 2);
      const ev = app.tables.memory_domain_events[1];
      assert.equal(ev.type, "highlight.pinned", "§17 names no highlight.unpinned");
      assert.equal(ev.payload_json.command_type, "UNPIN_HIGHLIGHT");
      assert.equal(ev.payload_json.pinned, false);
      assert.equal(ev.payload_json.from_state, "PINNED");
      assert.equal(ev.payload_json.to_state, "ACTIVE");
    } finally { await app.close(); }
  });

  it("HIDE_HIGHLIGHT writes archived_at and NOT deleted_at — §21 keeps Archive and Delete apart", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_LIVE}/archive`, OWNER, "k-hide");
      assert.equal(r.status, 200);
      assert.ok(r.body.archivedAt);
      assert.notEqual(row(app, H_LIVE).archived_at, null);
      assert.equal(row(app, H_LIVE).deleted_at, null, "the reversible hide must not touch the terminal column");

      assert.equal(app.tables.memory_domain_events.length, 1);
      assert.equal(app.tables.memory_domain_events[0].type, "highlight.hidden");
      assert.equal(app.tables.memory_domain_events[0].payload_json.to_state, "HIDDEN");
    } finally { await app.close(); }
  });

  it("DELETE /highlights/:id/archive is still a direct write — §17 names no inverse of HIDE_HIGHLIGHT", async () => {
    // Recorded as a test rather than only as a comment: the un-hide reverses a
    // command that crossed the boundary and does not cross it itself, so the
    // event stream shows a hide with no matching un-hide. That is a real gap
    // and this is where a future lane will find it.
    const app = await startApp({ kernelOn: true });
    try {
      await call(app, "POST", `/api/highlights/${H_LIVE}/archive`, OWNER, "k-h1");
      const before = app.state.rpcCalls.length;
      const r = await call(app, "DELETE", `/api/highlights/${H_LIVE}/archive`, OWNER, "k-h2");
      assert.equal(r.status, 200);
      assert.equal(row(app, H_LIVE).archived_at, null, "§21: Archive is reversible");
      assert.equal(app.state.rpcCalls.length, before, "no command was issued for the un-hide");
      assert.equal(app.tables.memory_domain_events.length, 1, "and no event was emitted for it");
    } finally { await app.close(); }
  });
});

// ── 4. §19 — the same key twice ──────────────────────────────────────────────

describe("§19 idempotency — one key, one state change, one event", () => {
  it("the same Idempotency-Key twice produces ONE effect, the SAME body, and no second event", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const first = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-replay");
      assert.equal(first.status, 200);
      const pinnedAfterFirst = row(app, H_LIVE).pinned_at;
      assert.ok(pinnedAfterFirst);

      // Move the world between the two calls. A route that recomputed the
      // answer on replay would now return a DIFFERENT body; the receipt must
      // answer with the original.
      row(app, H_LIVE).pinned_at = null;

      const second = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-replay");
      assert.equal(second.status, 200);
      assert.deepEqual(second.body, first.body, "the replay returns the ORIGINAL result, not a recomputed one");
      assert.equal(row(app, H_LIVE).pinned_at, null, "the replay applied no second transition");

      assert.equal(app.tables.memory_domain_events.length, 1, "a replay must not emit a second event");
      assert.equal(app.tables.memory_event_outbox.length, 1);
      assert.equal(app.tables.memory_command_receipts.length, 1);

      // The audit records BOTH attempts, and says which was which — §24 has
      // nothing to count if only the first is recorded.
      assert.equal(app.tables.memory_command_audit.length, 2);
      assert.deepEqual(app.tables.memory_command_audit.map((a: any) => a.outcome), ["accepted", "duplicate"]);
      assert.equal(app.tables.memory_command_audit[1].event_id, app.tables.memory_domain_events[0].event_id);
    } finally { await app.close(); }
  });

  it("one key reused for a DIFFERENT command is a 409, not the earlier command's answer", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      assert.equal((await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-shared")).status, 200);
      const r = await call(app, "DELETE", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-shared");
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "conflict");
      assert.equal(r.body.reason, "MEMORY_IDEMPOTENCY_KEY_REUSED");
      assert.notEqual(row(app, H_LIVE).pinned_at, null, "the unpin did not apply");
      assert.equal(app.tables.memory_domain_events.length, 1);
      // PAIRED: a FRESH key does apply the unpin, so the 409 is the key rule
      // and not a broken handler.
      assert.equal((await call(app, "DELETE", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-fresh")).status, 200);
      assert.equal(row(app, H_LIVE).pinned_at, null);
    } finally { await app.close(); }
  });

  it("an Idempotency-Key outside 1-200 characters is a 400 and issues no command", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "x".repeat(201));
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "invalid_payload");
      assert.deepEqual(app.state.rpcCalls, []);
      assert.equal(row(app, H_LIVE).pinned_at, null);
    } finally { await app.close(); }
  });
});

// ── 5. §23 — ownership, and what the outside is told ─────────────────────────

describe("§23 ownership — precise inside, uniform outside", () => {
  it("a stranger's Highlight answers 404, and the AUDIT records that it was an ownership refusal", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_OTHER}/pin`, OWNER, "k-owner");
      // 404, not 403: a 403 would confirm the Highlight exists.
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "not_found");
      assert.equal(r.body.message, "Highlight not found");
      assert.equal(r.body.reason, "HIGHLIGHT_AUTH_NOT_OWNER");
      assert.equal(row(app, H_OTHER).pinned_at, null, "no write happened");
      assert.equal(app.tables.memory_domain_events.length, 0);

      // The distinction the HTTP answer withholds is kept where §24 wants it.
      assert.equal(app.tables.memory_command_audit.length, 1);
      assert.equal(app.tables.memory_command_audit[0].outcome, "rejected");
      assert.equal(app.tables.memory_command_audit[0].reason, "HIGHLIGHT_AUTH_NOT_OWNER");
    } finally { await app.close(); }
  });

  it("an absent or soft-deleted Highlight answers the SAME 404 with HIGHLIGHT_NOT_FOUND", async () => {
    const app = await startApp({ kernelOn: true });
    try {
      for (const id of [H_ABSENT, H_DELETED]) {
        const r = await call(app, "POST", `/api/highlights/${id}/pin`, OWNER, `k-nf-${id}`);
        assert.equal(r.status, 404);
        assert.equal(r.body.message, "Highlight not found");
        assert.equal(r.body.reason, "HIGHLIGHT_NOT_FOUND");
      }
      assert.equal(app.tables.memory_domain_events.length, 0);
      // PAIRED with the success.
      assert.equal((await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-nf-ok")).status, 200);
    } finally { await app.close(); }
  });
});

// ── 6. Atomicity and honest degradation ──────────────────────────────────────

describe("§17 atomicity and honest failure", () => {
  for (const target of ["event", "outbox", "receipt", "audit"] as KernelWriteTarget[]) {
    it(`a failed ${target} write rolls the pin back — no column change survives without all four artifacts`, async () => {
      const app = await startApp({ kernelOn: true, failOn: [target] });
      try {
        const r = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, `k-fail-${target}`);
        assert.equal(r.status, 503);
        assert.equal(r.body.reason, "MEMORY_KERNEL_UNAVAILABLE");
        assert.equal(row(app, H_LIVE).pinned_at, null, "the canonical change must not survive a failed artifact");
        assert.equal(app.tables.memory_domain_events.length, 0);
        assert.equal(app.tables.memory_event_outbox.length, 0);
        assert.equal(app.tables.memory_command_receipts.length, 0);
      } finally { await app.close(); }
    });
  }

  it("with the flag ON and the function absent the answer is 503 — never a silent fallback to the direct write", async () => {
    const app = await startApp({ kernelOn: true, absent: true });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_LIVE}/pin`, OWNER, "k-absent");
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "kernel_unavailable");
      assert.equal(r.body.reason, "MEMORY_KERNEL_UNAVAILABLE");
      assert.equal(row(app, H_LIVE).pinned_at, null,
        "a fallback here would be the unaudited write the boundary exists to remove");
    } finally { await app.close(); }
  });
});
