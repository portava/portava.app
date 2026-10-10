/**
 * Lead rulings Q-L23 / D-38a and D-MODACTION-SHAPE (2026-10-06), migration 3705.
 *
 * WHAT WAS WRONG. A moderator saw the reported content only LIVE
 * (lib/moderationReportSnapshots.ts reads it when the queue is opened), so the
 * person reported could edit or delete it before review and leave nothing to
 * judge. And a moderation action recorded the report it answered only inside
 * `metadata` — no foreign key, so a deleted report left a dangling id.
 *
 * WHAT IS PINNED, against a store-backed fake whose writes PERSIST:
 *   - INTAKE (POST /api/moderation/report): with moderation_report_capture_enabled
 *     ON and 3705 present, the content is captured AT REPORT TIME into
 *     moderation_report_captures (an edit or deletion afterwards does not reach
 *     it); it is never in any response, carries no person uuid, and a failed
 *     content read is captured as `unavailable`. OFF, absent, unreadable, or 3705
 *     missing: nothing is read or written and the report is filed exactly as
 *     before. A capture that cannot be stored never un-files the report.
 *   - THE REPORTER never sees it: GET /moderation/reports/mine names its columns.
 *   - THE MODERATOR'S QUEUE (GET /admin/moderation/reports) carries
 *     `captured_content`: captured / none / unavailable / not_deployed — an
 *     outage or an unapplied migration is never read as "nothing captured".
 *   - THE AUDIT LINK: logModerationAction writes moderation_actions.report_id
 *     (and still metadata.report_id) once 3705 is present; without it, the old
 *     row shape; a report id that is not a uuid is never written to the column.
 *
 * The SQL itself (privileges, the cascade, SET NULL) is certified by the
 * live-DB tier: src/test/db/moderationReportCapture.db.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/moderationReportCapture.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import moderationRouter from "../routes/moderation.js";
import adminRouter from "../routes/admin.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { logModerationAction } from "../lib/moderationAudit.js";
import {
  loadCapturedReportContent,
  MODERATION_REPORT_CAPTURE_FLAG,
  SNAPSHOT_EXCERPT_CHARS,
} from "../lib/moderationReportSnapshots.js";

const REPORTER = "aaaaaaaa-0000-4000-8000-000000000001";
const AUTHOR = "bbbbbbbb-0000-4000-8000-000000000002";
const ADMIN = "cccccccc-0000-4000-8000-000000000003";
const POST = "dddddddd-0000-4000-8000-000000000004";
const REPORT_A = "eeeeeeee-0000-4000-8000-000000000005";
const REPORT_B = "eeeeeeee-0000-4000-8000-000000000006";
const WORDS = "Send me your bank login and I'll double your money";
const TOKEN_REPORTER = "token-reporter";
const TOKEN_ADMIN = "token-admin";

type Failures = Record<string, { message: string; code?: string }>;
const MISSING_TABLE: Failures = { "moderation_report_captures:select": { code: "42P01", message: 'relation "public.moderation_report_captures" does not exist' } };

function world(opts: { flag?: boolean | "absent"; captures?: any[]; reports?: any[]; actions?: any[] } = {}) {
  return {
    feature_flags: opts.flag === "absent" || opts.flag === undefined ? [] : [{ flag: MODERATION_REPORT_CAPTURE_FLAG, enabled: opts.flag }],
    profiles: [
      { id: REPORTER, account_status: "active", role: "user", name: "Rae", handle: "rae" },
      { id: AUTHOR, account_status: "active", role: "user", name: "Author", handle: "author" },
      { id: ADMIN, account_status: "active", role: "admin", name: "Admin", handle: "admin", display_name: "Admin", username: "admin" },
    ],
    posts: [{ id: POST, author_id: AUTHOR, user_id: AUTHOR, content: WORDS, created_at: "2026-10-01T00:00:00.000Z", deleted_at: null }],
    moderation_reports: opts.reports ?? [],
    moderation_report_captures: opts.captures ?? [],
    moderation_actions: opts.actions ?? [],
  } as Record<string, any[]>;
}

function install(tables: Record<string, any[]>, failures: Failures = {}) {
  const db = makeLayoverDb(tables, { users: { [TOKEN_REPORTER]: REPORTER, [TOKEN_ADMIN]: ADMIN }, failures });
  _setTestClient(db, true);
  _setTestServiceClient(db);
  return db;
}

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", moderationRouter);
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); });
afterEach(() => { _resetRateLimit(); _setTestClient(null as any, false); _setTestServiceClient(null as any); });

async function call(method: string, path: string, token: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}

const report = (token = TOKEN_REPORTER) =>
  call("POST", "/api/moderation/report", token, { subjectType: "post", subjectId: POST, category: "scam_fraud", details: "asked for my bank login" });

describe("Q-L23 intake — the reported content is captured WHEN IT IS REPORTED", () => {
  it("ON and 3705 present: one capture row, in the content's own words, taken at report time; no person uuid; nothing in the response", async () => {
    const t = world({ flag: true });
    install(t);
    const before = Date.now();
    const r = await report();
    assert.equal(r.status, 201, r.text);
    assert.equal(t.moderation_reports.length, 1);
    const reportId = t.moderation_reports[0].id;
    assert.equal(t.moderation_report_captures.length, 1);
    const cap = t.moderation_report_captures[0];
    assert.equal(cap.report_id, reportId);
    assert.equal(cap.capture_state, "ok");
    assert.equal(cap.snapshot.excerpt, WORDS);
    assert.equal(cap.snapshot.deleted, false);
    assert.ok(!("accountableUserId" in cap.snapshot), "the capture carries no person uuid of its own");
    assert.doesNotMatch(JSON.stringify(cap), new RegExp(AUTHOR), "no author id anywhere in the capture");
    assert.ok(Date.parse(cap.captured_at) >= before - 1000 && Date.parse(cap.captured_at) <= Date.now() + 1000);
    // The reporter's response says nothing about it.
    assert.doesNotMatch(r.text, /bank login and I'll|excerpt|capture/i);
  });

  it("the capture survives the author editing and then deleting the post (the reason it exists)", async () => {
    const t = world({ flag: true });
    install(t);
    assert.equal((await report()).status, 201);
    t.posts[0].content = "nothing to see here";
    t.posts[0].deleted_at = new Date().toISOString();
    assert.equal(t.moderation_report_captures[0].snapshot.excerpt, WORDS);
    const q = await call("GET", "/admin/moderation/reports?status=open", TOKEN_ADMIN);
    assert.equal(q.status, 200, q.text);
    const row = q.body.reports[0];
    assert.equal(row.subject_snapshot.excerpt, null, "the LIVE snapshot now shows nothing — the author deleted it");
    assert.equal(row.captured_content.state, "captured");
    assert.equal(row.captured_content.capture.snapshot.excerpt, WORDS, "the moderator still sees what was reported");
  });

  it("a long post is captured truncated, exactly as the live snapshot truncates", async () => {
    const t = world({ flag: true });
    t.posts[0].content = "y".repeat(SNAPSHOT_EXCERPT_CHARS + 40);
    install(t);
    assert.equal((await report()).status, 201);
    assert.equal(String(t.moderation_report_captures[0].snapshot.excerpt).length, SNAPSHOT_EXCERPT_CHARS);
  });

  it("OFF, absent or unreadable flag: nothing is captured and the report is filed as before", async () => {
    for (const [name, flag, failures] of [
      ["off", false, {}], ["absent", "absent", {}], ["unreadable", true, { "feature_flags:select": { message: "connection reset", code: "08006" } }],
    ] as const) {
      const t = world({ flag: flag as any });
      install(t, failures as Failures);
      const r = await report();
      assert.equal(r.status, 201, `${name}: ${r.text}`);
      assert.equal(t.moderation_reports.length, 1, name);
      assert.equal(t.moderation_report_captures.length, 0, `${name}: captured with the capability off`);
      _resetRateLimit();
    }
  });

  it("ON but 3705 not applied (the table is missing): refused, nothing written, the report is filed", async () => {
    const t = world({ flag: true });
    install(t, MISSING_TABLE);
    const r = await report();
    assert.equal(r.status, 201, r.text);
    assert.equal(t.moderation_reports.length, 1);
    assert.equal(t.moderation_report_captures.length, 0);
  });

  it("a content read that FAILS is captured as `unavailable` — said, not dressed as missing content — and the report is filed", async () => {
    const t = world({ flag: true });
    install(t, { "posts:select": { message: "posts unavailable", code: "XX000" } });
    const r = await report();
    assert.equal(r.status, 201, r.text);
    assert.equal(t.moderation_report_captures.length, 1);
    assert.equal(t.moderation_report_captures[0].capture_state, "unavailable");
    assert.deepEqual(t.moderation_report_captures[0].snapshot, {});
  });

  it("a capture that cannot be STORED does not un-file the report", async () => {
    const t = world({ flag: true });
    install(t, { "moderation_report_captures:insert": { message: "insert refused", code: "42501" } });
    const r = await report();
    assert.equal(r.status, 201, r.text);
    assert.equal(t.moderation_reports.length, 1);
    assert.equal(t.moderation_report_captures.length, 0);
  });

  it("the reporter's own history never carries the capture", async () => {
    const t = world({ flag: true });
    install(t);
    assert.equal((await report()).status, 201);
    const mine = await call("GET", "/api/moderation/reports/mine", TOKEN_REPORTER);
    assert.equal(mine.status, 200, mine.text);
    assert.equal(mine.body.reports.length, 1);
    assert.doesNotMatch(mine.text, /bank login and I'll|captured|excerpt/i);
  });
});

describe("Q-L23 queue — what a moderator is shown about each report's capture", () => {
  const reports = () => [
    { id: REPORT_A, reporter_id: REPORTER, subject_type: "post", subject_id: POST, subject_user_id: AUTHOR, category: "scam_fraud", details: "x", status: "open", created_at: "2026-10-02T00:00:00.000Z", resolved_at: null },
    { id: REPORT_B, reporter_id: REPORTER, subject_type: "post", subject_id: POST, subject_user_id: AUTHOR, category: "spam", details: "y", status: "open", created_at: "2026-10-01T00:00:00.000Z", resolved_at: null },
  ];
  const captured = { report_id: REPORT_A, capture_state: "ok", snapshot: { excerpt: WORDS, deleted: false }, captured_at: "2026-10-02T00:00:00.000Z" };

  it("captured for the report that has one, `none` for the one that does not", async () => {
    install(world({ reports: reports(), captures: [captured] }));
    const q = await call("GET", "/admin/moderation/reports", TOKEN_ADMIN);
    assert.equal(q.status, 200, q.text);
    const by = new Map(q.body.reports.map((r: any) => [r.id, r.captured_content]));
    assert.deepEqual(by.get(REPORT_A), { state: "captured", capture: { capture_state: "ok", snapshot: { excerpt: WORDS, deleted: false }, captured_at: "2026-10-02T00:00:00.000Z" } });
    assert.deepEqual(by.get(REPORT_B), { state: "none" });
    assert.equal(q.body.capturedContentUnavailable, undefined);
  });

  it("3705 not applied: `not_deployed` on every row — not `none`", async () => {
    install(world({ reports: reports() }), MISSING_TABLE);
    const q = await call("GET", "/admin/moderation/reports", TOKEN_ADMIN);
    assert.equal(q.status, 200, q.text);
    for (const r of q.body.reports) assert.deepEqual(r.captured_content, { state: "not_deployed" });
  });

  it("an UNREADABLE capture table: `unavailable` on every row, and the page says so", async () => {
    install(world({ reports: reports(), captures: [captured] }), { "moderation_report_captures:select": { message: "timeout", code: "57014" } });
    const q = await call("GET", "/admin/moderation/reports", TOKEN_ADMIN);
    assert.equal(q.status, 200, q.text);
    for (const r of q.body.reports) assert.deepEqual(r.captured_content, { state: "unavailable" });
    assert.equal(q.body.capturedContentUnavailable, true);
  });

  it("3705 present but the capture READ fails: `unavailable`, never `none`", async () => {
    const t = world({ reports: reports(), captures: [captured] });
    const db = install(t);
    // The readiness probe (.eq on the sentinel) answers; the page read (.in on the ids) does not.
    const sc = { ...db, from: (tb: string) => {
      const b = db.from(tb);
      if (tb === "moderation_report_captures") b.in = () => ({ then: (ok: any) => ok({ data: null, error: { message: "timeout", code: "57014" } }) });
      return b;
    } };
    const r = await loadCapturedReportContent(sc, [REPORT_A, REPORT_B]);
    assert.equal(r.unavailable, true);
    assert.deepEqual([...r.captures.values()], [{ state: "unavailable" }, { state: "unavailable" }]);
  });

  it("loadCapturedReportContent: no ids, no read", async () => {
    let reads = 0;
    const sc = { from: () => { reads++; throw new Error("no read expected"); } };
    const r = await loadCapturedReportContent(sc, []);
    assert.equal(r.captures.size, 0);
    assert.equal(reads, 0);
  });
});

describe("D-MODACTION-SHAPE — moderation_actions.report_id", () => {
  it("3705 present: the action row carries report_id as a column AND in metadata", async () => {
    const t = world();
    const db = install(t);
    const r = await logModerationAction(db, AUTHOR, ADMIN, "report_actioned", "scam", { report_id: REPORT_A, target_type: "post", target_id: POST });
    assert.equal(r.ok, true);
    assert.equal(t.moderation_actions.length, 1);
    assert.equal(t.moderation_actions[0].report_id, REPORT_A);
    assert.equal(t.moderation_actions[0].metadata.report_id, REPORT_A);
  });

  it("3705 not applied: the old row shape — no report_id column named — and the link stays in metadata", async () => {
    const t = world();
    const db = install(t, { "moderation_actions:select": { code: "42703", message: "column moderation_actions.report_id does not exist" } });
    const r = await logModerationAction(db, AUTHOR, ADMIN, "report_dismissed", null, { report_id: REPORT_A, target_type: "post", target_id: POST });
    assert.equal(r.ok, true);
    assert.equal(t.moderation_actions.length, 1);
    assert.ok(!("report_id" in t.moderation_actions[0]), "a column the database does not have was named");
    assert.equal(t.moderation_actions[0].metadata.report_id, REPORT_A);
  });

  it("a report id that is not a uuid is never written to the column; no metadata, no probe", async () => {
    const t = world();
    let probes = 0;
    const db = install(t);
    const counting = { ...db, from: (tb: string) => { if (tb === "moderation_report_captures") probes++; return db.from(tb); } };
    await logModerationAction(counting, AUTHOR, ADMIN, "warn", null, { report_id: "not-a-uuid", target_type: "post", target_id: POST });
    assert.ok(!("report_id" in t.moderation_actions[0]));
    await logModerationAction(counting, AUTHOR, ADMIN, "warn", null);
    assert.ok(!("report_id" in t.moderation_actions[1]));
    assert.equal(probes, 0, "the schema was probed for an action with no report");
  });

  it("the review route links the action it writes to the report it closes", async () => {
    const t = world({ reports: [{ id: REPORT_A, reporter_id: REPORTER, subject_type: "post", subject_id: POST, subject_user_id: AUTHOR, category: "scam_fraud", details: "x", status: "open", created_at: "2026-10-02T00:00:00.000Z", resolved_at: null, resolver_id: null, resolver_note: null }] });
    install(t);
    const r = await call("POST", `/admin/moderation/reports/${REPORT_A}/review`, TOKEN_ADMIN, { decision: "actioned", note: "confirmed" });
    assert.equal(r.status, 200, r.text);
    assert.equal(t.moderation_actions.length, 1);
    assert.equal(t.moderation_actions[0].report_id, REPORT_A);
    assert.equal(t.moderation_actions[0].action_type, "report_actioned");
  });
});
