/**
 * A report is filed by someone who could SEE what they are reporting.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * `POST /api/messages/:messageId/report`, `POST /api/threads/:threadId/report`
 * and `POST /api/reports` (target_type `message` / `thread`) took an id and
 * filed a report against it without asking whether the reporter is in the
 * conversation. With `telegraph_report_evidence_enabled` on, the two Telegraph
 * routes then copy the reported content into restricted moderation storage
 * (services/telegraphReportEvidence.ts). So anyone holding a message or thread
 * id could have another conversation's messages snapshotted as "evidence", and
 * an upheld report charges the sender (`message_report_confirmed`) for words
 * the reporter was never shown.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * The reporter must be an ACTIVE member (row present, `left_at` null) of the
 * thread, and a reported message must be inside the reporter's §14.3 history
 * window when the bound is on (their own messages always are) — the same test
 * the message read paths apply (routes/messaging.ts edit-history route).
 * A refusal is a 404, as the thread read is for a non-member: a non-member
 * learns nothing about whether the id exists. An unreadable membership or
 * message read is a 503 `degraded_unavailable`, never a refusal dressed as a
 * fact and never a report filed on an unchecked read.
 *
 * Run: node --import tsx/esm --test src/test/reportReporterMembership.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import reportsRouter from "../routes/reports.js";

const ALICE = "aaaaaaaa-0000-4000-8000-0000000000a1"; // sender, member
const BOB   = "bbbbbbbb-0000-4000-8000-0000000000b2"; // member
const EVE   = "eeeeeeee-0000-4000-8000-0000000000e3"; // NOT a member
const LEFT  = "cccccccc-0000-4000-8000-0000000000c4"; // left the thread
const LATE  = "dddddddd-0000-4000-8000-0000000000d5"; // joined after the message
const THREAD = "00000000-0000-4000-8000-0000000000f1";
const MSG    = "22222222-0000-4000-8000-0000000000f2";

interface Opts {
  membersError?: boolean;
  messagesError?: boolean;
  historyBound?: boolean;
}

function makeClient(opts: Opts = {}) {
  const db: Record<string, any[]> = {
    profiles: [ALICE, BOB, EVE, LEFT, LATE].map((id) => ({ id, account_status: "active" })),
    message_threads: [{ id: THREAD, thread_type: "group", is_e2ee: false }],
    message_thread_members: [
      { thread_id: THREAD, user_id: ALICE, left_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: BOB,   left_at: null, visible_from_at: null },
      { thread_id: THREAD, user_id: LEFT,  left_at: "2026-05-03T00:00:00.000Z", visible_from_at: null },
      { thread_id: THREAD, user_id: LATE,  left_at: null, visible_from_at: "2026-06-01T00:00:00.000Z" },
    ],
    messages: [{
      id: MSG, thread_id: THREAD, sender_id: ALICE, body: "the words", media_url: null,
      msg_type: "text", subtype: null, created_at: "2026-05-01T00:00:00.000Z", deleted_at: null,
    }],
    feature_flags: [
      { flag: "telegraph_report_evidence_enabled", enabled: true },
      { flag: "telegraph_history_bound_enabled", enabled: Boolean(opts.historyBound) },
    ],
    reports: [],
    report_evidence: [],
    telegraph_report_evidence: [],
  };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let limit: number | null = null;

    const failing = () =>
      (table === "message_thread_members" && opts.membersError) ||
      (table === "messages" && opts.messagesError);

    const run = () => {
      if (failing()) return { data: null, error: { message: `${table} unreadable`, code: "XX000" } };
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ id: `${table}-${(db[table] ??= []).length + 1}`, ...r }));
        db[table]!.push(...rows);
        return { data: rows, error: null };
      }
      let rows = (db[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (mode === "update") { rows.forEach((r) => Object.assign(r, payload)); }
      if (mode === "delete") { db[table] = (db[table] ?? []).filter((r) => !rows.includes(r)); }
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: rows, error: null };
    };

    const q: any = {
      select() { return q; },
      insert(p: any) { mode = "insert"; payload = p; return q; },
      upsert(p: any) { mode = "upsert"; payload = p; return q; },
      update(p: any) { mode = "update"; payload = p; return q; },
      delete() { mode = "delete"; return q; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return q; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return q; },
      is(c: string, v: any) { preds.push((r) => (r[c] ?? null) === v); return q; },
      in(c: string, vs: any[]) { preds.push((r) => vs.includes(r[c])); return q; },
      gte() { return q; }, lte() { return q; }, gt() { return q; }, lt() { return q; },
      or() { return q; }, order() { return q; }, range() { return q; },
      limit(n: number) { limit = n; return q; },
      maybeSingle() {
        const r = run();
        return Promise.resolve(r.error ? r : { data: (r.data as any[])[0] ?? null, error: null });
      },
      single() {
        const r = run();
        if (r.error) return Promise.resolve(r);
        const row = (r.data as any[])[0];
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "no rows", code: "PGRST116" } });
      },
      then(ok: any, bad: any) { return Promise.resolve(run()).then(ok, bad); },
    };
    return q;
  }

  return {
    db,
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    channel: () => ({ send: async () => ({}), subscribe: () => ({}), unsubscribe: async () => ({}) }),
    removeChannel: async () => ({}),
  };
}

let server: any = null;

async function boot(client: any): Promise<string> {
  _setTestClient(client, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", messagingRouter);
  app.use("/api", reportsRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}/api`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  server = null;
  _setTestClient(null, false);
});

async function post(base: string, path: string, as: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

describe("POST /api/messages/:messageId/report — the reporter must be able to see the message", () => {
  it("a NON-member is refused 404, and nothing is filed or snapshotted", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, `/messages/${MSG}/report`, EVE, { reason: "spam" });
    assert.equal(r.status, 404, `a non-member filed a message report: ${JSON.stringify(r.body)}`);
    assert.equal(c.db.reports.length, 0, "a report row was written for a message the reporter cannot see");
    assert.equal(c.db.telegraph_report_evidence.length, 0, "another thread's message was snapshotted as evidence");
  });

  it("a member who has LEFT is refused the same way", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, `/messages/${MSG}/report`, LEFT, { reason: "spam" });
    assert.equal(r.status, 404);
    assert.equal(c.db.telegraph_report_evidence.length, 0);
  });

  it("a member outside the history window is refused while the bound is on", async () => {
    const c = makeClient({ historyBound: true });
    const base = await boot(c);
    const r = await post(base, `/messages/${MSG}/report`, LATE, { reason: "spam" });
    assert.equal(r.status, 404);
    assert.equal(c.db.reports.length, 0);
  });

  it("an active member files the report and its evidence is captured", async () => {
    const c = makeClient({ historyBound: true });
    const base = await boot(c);
    const r = await post(base, `/messages/${MSG}/report`, BOB, { reason: "spam" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c.db.reports.length, 1);
    assert.equal(c.db.telegraph_report_evidence.length, 1);
    assert.equal(c.db.telegraph_report_evidence[0].body_snapshot, "the words");
  });

  it("an unreadable membership is a 503, never a filed report and never a 404", async () => {
    const c = makeClient({ membersError: true });
    const base = await boot(c);
    const r = await post(base, `/messages/${MSG}/report`, BOB, { reason: "spam" });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(c.db.reports.length, 0);
  });

  it("an unreadable message is a 503 too", async () => {
    const c = makeClient({ messagesError: true });
    const base = await boot(c);
    const r = await post(base, `/messages/${MSG}/report`, BOB, { reason: "spam" });
    assert.equal(r.status, 503);
    assert.equal(c.db.reports.length, 0);
  });
});

describe("POST /api/threads/:threadId/report — the reporter must be in the thread", () => {
  it("a NON-member is refused 404, and no window of the thread is snapshotted", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, `/threads/${THREAD}/report`, EVE, { reason: "abuse" });
    assert.equal(r.status, 404, `a non-member filed a thread report: ${JSON.stringify(r.body)}`);
    assert.equal(c.db.reports.length, 0);
    assert.equal(c.db.telegraph_report_evidence.length, 0, "a non-member snapshotted another thread's messages");
  });

  it("an active member files it", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, `/threads/${THREAD}/report`, BOB, { reason: "abuse" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c.db.reports.length, 1);
  });
});

describe("POST /api/reports — message and thread targets need the same visibility", () => {
  it("a NON-member cannot file a message report through the unified route", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, "/reports", EVE, { target_type: "message", target_id: MSG, reason_code: "spam" });
    assert.equal(r.status, 404, `the unified route filed it: ${JSON.stringify(r.body)}`);
    assert.equal(c.db.reports.length, 0);
  });

  it("a NON-member cannot file a thread report through the unified route", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, "/reports", EVE, { target_type: "thread", target_id: THREAD, reason_code: "spam" });
    assert.equal(r.status, 404);
    assert.equal(c.db.reports.length, 0);
  });

  it("a member files a message report through the unified route", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, "/reports", BOB, { target_type: "message", target_id: MSG, reason_code: "spam" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(c.db.reports.length, 1);
  });

  it("targets that are not a conversation are untouched by the rule", async () => {
    const c = makeClient();
    const base = await boot(c);
    const r = await post(base, "/reports", LATE, { target_type: "place", target_id: MSG, reason_code: "spam" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});
