/**
 * WP-08 / TEL-F09 (lane tm-telegraph) — the per-message report carries WHY.
 *
 * `POST /api/messages/:messageId/report` is the Telegraph report route: it
 * writes the unified `reports` table (census-telegraph §32.2, the one queue the
 * admin surface reads), snapshots the message into restricted moderation
 * storage before answering (§22), and tells the reporter alone
 * (`safety.reported`). Until this lane no client called it — the long-press
 * "Report" filed through `/api/moderation/report` (a different table, no
 * evidence snapshot) or `/api/reports` (no evidence snapshot either).
 *
 * Wiring the client to it exposed one gap: the route wrote `reason_code:
 * 'other'` and `severity: 'normal'` for EVERY report. lib/reportReasons.ts says
 * what that costs — "a path that writes `reports` without computing this leaves
 * the reporter unprotected by omission" — and a harassment report filed from a
 * thread would have queued behind spam.
 *
 * Rules, each shown red on the unmodified route:
 *   1. A known `reason_code` is stored as given, and severity is computed from
 *      it by the shared `reportSeverityFor` (harassment → high).
 *   2. An unknown `reason_code` is refused 400 and writes nothing — a typo in a
 *      client must not silently become "other".
 *   3. No `reason_code` keeps the old contract exactly: 'other' / 'normal'
 *      (the control — an older client is not broken).
 *   4. `reason` stays required.
 *
 * Run: node --import tsx/esm --test src/test/telegraphMessageReportReason.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import messagingRouter from "../routes/messaging.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const THREAD = "eeeeeeee-0000-4000-8000-00000000000e";
const MSG = "11110000-0000-4000-8000-00000000000a";

function makeClient() {
  const db: Record<string, any[]> = {
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null },
      { thread_id: THREAD, user_id: BOB, left_at: null },
    ],
    messages: [
      { id: MSG, thread_id: THREAD, sender_id: ALICE, body: "you again", deleted_at: null, created_at: new Date().toISOString() },
    ],
    reports: [],
    report_evidence: [],
    feature_flags: [],
  };

  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingDelete = false;
    const rowsNow = () => (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const settle = () => {
      if (pendingInsert) {
        const rows = (Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert])
          .map((r: any, i: number) => ({ id: `row-${table}-${(db[table] ?? []).length + i}`, ...r }));
        for (const r of rows) (db[table] ??= []).push(r);
        return { data: rows, error: null };
      }
      if (pendingDelete) {
        const hit = rowsNow();
        db[table] = (db[table] ?? []).filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      if (pendingUpdate) {
        const hit = rowsNow();
        for (const r of hit) Object.assign(r, pendingUpdate);
        return { data: hit, error: null };
      }
      return { data: JSON.parse(JSON.stringify(rowsNow())), error: null };
    };
    const target: any = {
      select() { return proxy; },
      insert(p: any) { pendingInsert = p; return proxy; },
      upsert(p: any) { pendingInsert = p; return proxy; },
      update(p: any) { pendingUpdate = p; return proxy; },
      delete() { pendingDelete = true; return proxy; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return proxy; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return proxy; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return proxy; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return proxy; },
      order() { return proxy; },
      limit() { return proxy; },
      maybeSingle() { const s = settle(); return Promise.resolve({ data: (s.data as any[])[0] ?? null, error: s.error }); },
      single() { const s = settle(); return Promise.resolve({ data: (s.data as any[])[0] ?? null, error: s.error }); },
      then(res: (v: any) => void, rej?: (e: any) => void) { return Promise.resolve(settle()).then(res, rej); },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }
  return {
    _db: db,
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

let server: ReturnType<typeof createServer>;
let baseUrl = "";

function use() {
  const c = makeClient();
  _setTestClient(c as any, true);
  _setTestServiceClient(c as any);
  return c;
}

async function report(asUser: string, body: unknown) {
  const r = await fetch(`${baseUrl}/api/messages/${MSG}/report`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", messagingRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  await new Promise<void>((r) => server.close(() => r()));
});

describe("TEL-F09 — a per-message report carries its reason", () => {
  it("stores a known reason_code and computes severity from it (harassment → high)", async () => {
    const c = use();
    const r = await report(BOB, { reason: "Harassment or bullying", reason_code: "harassment" });
    assert.equal(r.status, 201);
    const rows = (c as any)._db.reports;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target_type, "message");
    assert.equal(rows[0].target_id, MSG);
    assert.equal(rows[0].reason_code, "harassment");
    assert.equal(rows[0].severity, "high");
    assert.equal(rows[0].reason_detail, "Harassment or bullying");
  });

  it("a normal-severity code stays normal (spam)", async () => {
    const c = use();
    const r = await report(BOB, { reason: "Spam", reason_code: "spam" });
    assert.equal(r.status, 201);
    assert.equal((c as any)._db.reports[0].reason_code, "spam");
    assert.equal((c as any)._db.reports[0].severity, "normal");
  });

  it("refuses an unknown reason_code and writes nothing — a typo is not 'other'", async () => {
    const c = use();
    const r = await report(BOB, { reason: "x", reason_code: "harrassment" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
    assert.equal((c as any)._db.reports.length, 0);
  });

  it("no reason_code keeps the old contract: 'other' / 'normal' (control)", async () => {
    const c = use();
    const r = await report(BOB, { reason: "Something else" });
    assert.equal(r.status, 201);
    assert.equal((c as any)._db.reports[0].reason_code, "other");
    assert.equal((c as any)._db.reports[0].severity, "normal");
  });

  it("reason stays required", async () => {
    const c = use();
    const r = await report(BOB, { reason_code: "spam" });
    assert.equal(r.status, 400);
    assert.equal((c as any)._db.reports.length, 0);
  });
});
