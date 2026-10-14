/**
 * census-trust TV-4a / lead ruling D-MODACTION-SHAPE — an enforcement taken in
 * answer to a moderation report NAMES that report.
 *
 * WHAT WAS WRONG (main 9e60178be). Only POST /admin/moderation/reports/:id/review
 * linked its own report_actioned / report_dismissed row to the report. The
 * actions that answer a report — warn, restrict, suspend, ban, the profile
 * restrictions, a profile photo's removal, PATCH moderation-action — read only
 * `reason` (and a suspension's `expires_at`): an enforcement a report led to had
 * no link back to it, in the 3705 column or in metadata. And the LEGACY report
 * routes (/admin/reports/:id/*, adminMedia target "report") record a legacy
 * `reports` id as metadata.report_id, which logModerationAction then also wrote
 * to moderation_actions.report_id once 3705 is applied — a column that
 * REFERENCES moderation_reports, so every legacy resolve / dismiss would have
 * failed its audit write (23503) and answered 500 the day 3705 lands.
 *
 * WHAT IS PINNED, against a store-backed fake whose writes PERSIST, wrapped so
 * the database's own refusals are modelled: with 3705, an insert whose
 * report_id names no moderation_reports row is 23503; without 3705, an insert
 * naming the report_id column at all is PGRST204.
 *   - Each report-answerable action takes an optional `report_id`; the row it
 *     writes carries it in metadata and, with 3705, as the column.
 *   - The cited report is checked BEFORE anything is written: unreadable → 503,
 *     missing → 404, not a uuid → 400, closed (actioned / dismissed) → 409,
 *     about someone else / about no one → 409. A refusal writes nothing — no
 *     audit row, no restriction.
 *   - Without 3705 the row is exactly today's plus the metadata link; never 500.
 *   - Without report_id nothing is read and the row is exactly today's.
 *   - A legacy `reports` id never reaches the column.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/moderationActionReportLink.test.ts
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRouter from "../routes/admin.js";
import { makeLayoverDb } from "./helpers/fakeLayoverDb.js";
import { auditReportAction, checkActionReportLink, linkableReportId, LEGACY_REPORTS_TABLE } from "../lib/moderationAudit.js";

const REPORTER = "aaaaaaaa-0000-4000-8000-000000000001";
const AUTHOR = "bbbbbbbb-0000-4000-8000-000000000002";
const ADMIN = "cccccccc-0000-4000-8000-000000000003";
const BYSTANDER = "ffffffff-0000-4000-8000-000000000009";
const POST = "dddddddd-0000-4000-8000-000000000004";
const PLACE = "dddddddd-0000-4000-8000-000000000007";
const REPORT = "eeeeeeee-0000-4000-8000-000000000005";
const LEGACY_REPORT = "12121212-0000-4000-8000-000000000008";
const TOKEN_ADMIN = "token-admin";
const TOKEN_USER = "token-user";

function modReport(over: Record<string, any> = {}) {
  return {
    id: REPORT, reporter_id: REPORTER, subject_type: "post", subject_id: POST, subject_user_id: AUTHOR,
    category: "scam_fraud", details: "asked for my bank login", status: "open",
    created_at: "2026-10-02T00:00:00.000Z", resolved_at: null, resolver_id: null, resolver_note: null, ...over,
  };
}

function world(opts: { reports?: any[]; legacy?: any[] } = {}) {
  return {
    feature_flags: [],
    profiles: [
      { id: REPORTER, account_status: "active", role: "user", name: "Rae", handle: "rae" },
      { id: AUTHOR, account_status: "active", role: "user", name: "Author", handle: "author", avatar_url: null, cover_photo_url: null, bio: "hi" },
      { id: BYSTANDER, account_status: "active", role: "user", name: "Bee", handle: "bee" },
      { id: ADMIN, account_status: "active", role: "admin", name: "Admin", handle: "admin", display_name: "Admin", username: "admin" },
    ],
    posts: [{ id: POST, author_id: AUTHOR, user_id: AUTHOR, content: "Send me your bank login", created_at: "2026-10-01T00:00:00.000Z", deleted_at: null }],
    moderation_reports: opts.reports ?? [modReport()],
    moderation_report_captures: [],
    moderation_actions: [],
    user_account_states: [],
    profile_privacy_settings: [],
    reports: opts.legacy ?? [],
  } as Record<string, any[]>;
}

/** A chain that answers `{ data: null, error }` however it is terminated. */
function failingChain(error: { code: string; message: string }): any {
  const answer = { data: null, error };
  const chain: any = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === "then") return (f: any, r: any) => Promise.resolve(answer).then(f, r);
      if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer);
      return () => chain;
    },
  });
  return chain;
}

type Install = { deployed3705?: boolean; failures?: Record<string, { message: string; code?: string }> };

/**
 * The fake, wrapped so the database's refusals are real: with 3705 the column is
 * a foreign key to moderation_reports; without it the column does not exist.
 * `reads` counts moderation_reports reads.
 */
function install(tables: Record<string, any[]>, opts: Install = {}) {
  const deployed = opts.deployed3705 !== false;
  const failures = { ...(opts.failures ?? {}) };
  if (!deployed) {
    failures["moderation_report_captures:select"] = { code: "42P01", message: 'relation "public.moderation_report_captures" does not exist' };
    failures["moderation_actions:select"] = { code: "42703", message: "column moderation_actions.report_id does not exist" };
  }
  const db = makeLayoverDb(tables, { users: { [TOKEN_ADMIN]: ADMIN, [TOKEN_USER]: REPORTER }, failures });
  const counter = { reads: 0 };
  const wrapped = {
    ...db,
    from(t: string) {
      const b = db.from(t);
      if (t === "moderation_reports") counter.reads++;
      if (t !== "moderation_actions") return b;
      const insert = b.insert.bind(b);
      b.insert = (rows: any) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const r of list) {
          if (!("report_id" in r)) continue;
          if (!deployed) return failingChain({ code: "PGRST204", message: "Could not find the 'report_id' column of 'moderation_actions' in the schema cache" });
          if (r.report_id !== null && !(tables.moderation_reports ?? []).some((m) => m.id === r.report_id)) {
            return failingChain({ code: "23503", message: 'insert or update on table "moderation_actions" violates foreign key constraint "moderation_actions_report_id_fkey"' });
          }
        }
        return insert(rows);
      };
      return b;
    },
  };
  _setTestClient(wrapped as any, true);
  _setTestServiceClient(wrapped as any);
  return counter;
}

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => { r.log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); });
afterEach(() => { _setTestClient(null as any, false); _setTestServiceClient(null as any); });

async function call(method: string, path: string, body?: unknown, token = TOKEN_ADMIN) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text };
}

const FUTURE = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

/** Every report-answerable action: [label, method, path, extra body, expected 2xx, action_type]. */
const ACTIONS: Array<[string, string, string, Record<string, unknown>, number, string]> = [
  ["warn", "POST", `/admin/users/${AUTHOR}/warn`, {}, 201, "warn"],
  ["restrict", "POST", `/admin/users/${AUTHOR}/restrict`, {}, 200, "message_limit"],
  ["suspend", "POST", `/admin/users/${AUTHOR}/suspend`, { expires_at: "FUTURE" }, 200, "temporary_suspension"],
  ["ban", "POST", `/admin/users/${AUTHOR}/ban`, {}, 200, "permanent_ban"],
  ["restrict-bio", "POST", `/admin/users/${AUTHOR}/restrict-bio`, {}, 200, "bio_restricted"],
  ["restrict-messaging", "POST", `/admin/users/${AUTHOR}/restrict-messaging`, {}, 200, "messaging_restricted"],
  ["restrict-visibility", "POST", `/admin/users/${AUTHOR}/restrict-visibility`, {}, 200, "visibility_restricted"],
  ["hide-posts", "POST", `/admin/users/${AUTHOR}/hide-posts`, {}, 200, "posts_hidden"],
  ["avatar removal", "DELETE", `/admin/users/${AUTHOR}/avatar`, {}, 200, "content_removed"],
  ["cover removal", "DELETE", `/admin/users/${AUTHOR}/cover`, {}, 200, "content_removed"],
  ["PATCH moderation-action", "PATCH", `/admin/users/${AUTHOR}/moderation-action`, { action_type: "warn" }, 200, "warn"],
];

function bodyFor(extra: Record<string, unknown>, reportId?: unknown) {
  const b: Record<string, unknown> = { reason: "scam DMs", ...extra };
  if (b.expires_at === "FUTURE") b.expires_at = FUTURE();
  if (reportId !== undefined) b.report_id = reportId;
  return b;
}

describe("TV-4a — every action that can answer a report names it", () => {
  for (const [label, method, path, extra, ok, actionType] of ACTIONS) {
    it(`${label}: with 3705, the row carries report_id as the COLUMN and in metadata; the report stays open`, async () => {
      const t = world();
      install(t);
      const r = await call(method, path, bodyFor(extra, REPORT));
      assert.equal(r.status, ok, r.text);
      assert.equal(t.moderation_actions.length, 1, "exactly one audit row");
      const row = t.moderation_actions[0];
      assert.equal(row.action_type, actionType);
      assert.equal(row.target_user_id, AUTHOR);
      assert.equal(row.report_id, REPORT, "the 3705 column names the report");
      assert.equal(row.metadata?.report_id, REPORT, "metadata names the report too");
      assert.equal(row.metadata?.report_table, "moderation_reports");
      assert.equal(t.moderation_reports[0].status, "open", "acting does not close the report; the review route does");
    });

    it(`${label}: WITHOUT 3705, the link is in metadata only — the row names no report_id column and the action succeeds`, async () => {
      const t = world();
      install(t, { deployed3705: false });
      const r = await call(method, path, bodyFor(extra, REPORT));
      assert.equal(r.status, ok, r.text);
      assert.equal(t.moderation_actions.length, 1);
      assert.ok(!("report_id" in t.moderation_actions[0]), "a column the database does not have was named");
      assert.equal(t.moderation_actions[0].metadata?.report_id, REPORT);
    });
  }

  it("suspend and ban cited to a report are IN FORCE as well as linked", async () => {
    for (const [path, state] of [[`/admin/users/${AUTHOR}/suspend`, "suspended"], [`/admin/users/${AUTHOR}/ban`, "banned"]] as const) {
      const t = world();
      install(t);
      const r = await call("POST", path, { reason: "scam", report_id: REPORT, ...(state === "suspended" ? { expires_at: FUTURE() } : {}) });
      assert.equal(r.status, 200, r.text);
      assert.equal(t.user_account_states.filter((s) => s.user_id === AUTHOR && s.state === state).length, 1);
      assert.equal(t.moderation_actions[0].report_id, REPORT);
    }
  });

  it("the review route's own row and an enforcement's row name the same report: act, then close", async () => {
    const t = world();
    install(t);
    assert.equal((await call("POST", `/admin/users/${AUTHOR}/suspend`, { reason: "scam", report_id: REPORT, expires_at: FUTURE() })).status, 200);
    const closed = await call("POST", `/admin/moderation/reports/${REPORT}/review`, { decision: "actioned", note: "suspended 7 days" });
    assert.equal(closed.status, 200, closed.text);
    assert.deepEqual(t.moderation_actions.map((a) => [a.action_type, a.report_id]), [["temporary_suspension", REPORT], ["report_actioned", REPORT]]);
  });
});

describe("TV-4a — the cited report is checked BEFORE anything is written", () => {
  /** Nothing written: no audit row, no account state, no privacy change, the report untouched. */
  function assertNothingWritten(t: Record<string, any[]>, status = "open") {
    assert.equal(t.moderation_actions.length, 0, "an audit row was written for a refused link");
    assert.equal(t.user_account_states.length, 0, "a restriction was put in force for a refused link");
    assert.equal(t.profile_privacy_settings.length, 0);
    assert.equal(t.moderation_reports[0]?.status ?? status, status);
  }

  it("a report about SOMEONE ELSE is 409 on every action, and nothing is written", async () => {
    for (const [label, method, path, extra] of ACTIONS) {
      const t = world({ reports: [modReport({ subject_user_id: BYSTANDER })] });
      install(t);
      const r = await call(method, path, bodyFor(extra, REPORT));
      assert.equal(r.status, 409, `${label}: ${r.text}`);
      assertNothingWritten(t);
    }
  });

  it("a CLOSED report (actioned, dismissed) is 409; open and reviewing are accepted", async () => {
    for (const status of ["actioned", "dismissed"]) {
      const t = world({ reports: [modReport({ status })] });
      install(t);
      const r = await call("POST", `/admin/users/${AUTHOR}/ban`, { reason: "x", report_id: REPORT });
      assert.equal(r.status, 409, `${status}: ${r.text}`);
      assert.match(r.body.message, new RegExp(status));
      assertNothingWritten(t, status);
    }
    for (const status of ["open", "reviewing"]) {
      const t = world({ reports: [modReport({ status })] });
      install(t);
      const r = await call("POST", `/admin/users/${AUTHOR}/warn`, { reason: "x", report_id: REPORT });
      assert.equal(r.status, 201, `${status}: ${r.text}`);
      assert.equal(t.moderation_actions[0].report_id, REPORT);
    }
  });

  it("a report that does not exist is 404; a report_id that is not a uuid is 400 — nothing written", async () => {
    const t = world({ reports: [] });
    install(t);
    const missing = await call("POST", `/admin/users/${AUTHOR}/suspend`, { reason: "x", report_id: REPORT, expires_at: FUTURE() });
    assert.equal(missing.status, 404, missing.text);
    for (const bad of ["not-a-uuid", "", 42, { id: REPORT }]) {
      const r = await call("POST", `/admin/users/${AUTHOR}/warn`, { reason: "x", report_id: bad });
      assert.equal(r.status, 400, `${JSON.stringify(bad)}: ${r.text}`);
    }
    assertNothingWritten(t);
  });

  it("an UNREADABLE report is a retryable 503 — never 'no link', never 'not found' — and nothing is written", async () => {
    const t = world();
    install(t, { failures: { "moderation_reports:select": { code: "57014", message: "canceling statement due to statement timeout" } } });
    const r = await call("POST", `/admin/users/${AUTHOR}/suspend`, { reason: "x", report_id: REPORT, expires_at: FUTURE() });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.retryable, true);
    assertNothingWritten(t);
  });

  it("no owner recorded at intake: the content's live owner decides; a lookup that cannot run is 503", async () => {
    const t = world({ reports: [modReport({ subject_user_id: null })] });
    install(t);
    const ok = await call("POST", `/admin/users/${AUTHOR}/warn`, { reason: "x", report_id: REPORT });
    assert.equal(ok.status, 201, ok.text);
    assert.equal(t.moderation_actions[0].report_id, REPORT);
    const other = await call("POST", `/admin/users/${BYSTANDER}/warn`, { reason: "x", report_id: REPORT });
    assert.equal(other.status, 409, "the live owner is AUTHOR, not the bystander");

    const t2 = world({ reports: [modReport({ subject_user_id: null })] });
    install(t2, { failures: { "posts:select": { message: "connection reset" } } });
    const down = await call("POST", `/admin/users/${AUTHOR}/ban`, { reason: "x", report_id: REPORT });
    assert.equal(down.status, 503, down.text);
    assertNothingWritten(t2);
  });

  it("the owner RECORDED at intake decides even after the content is gone", async () => {
    const t = world();
    t.posts.length = 0;
    install(t);
    const r = await call("POST", `/admin/users/${AUTHOR}/warn`, { reason: "x", report_id: REPORT });
    assert.equal(r.status, 201, r.text);
    assert.equal(t.moderation_actions[0].report_id, REPORT);
  });

  it("a report naming NO accountable user (an unowned place) cannot be cited: 409, nothing written", async () => {
    const t = world({ reports: [modReport({ subject_type: "place", subject_id: PLACE, subject_user_id: null })] });
    install(t);
    const r = await call("POST", `/admin/users/${AUTHOR}/restrict`, { reason: "x", report_id: REPORT });
    assert.equal(r.status, 409, r.text);
    assertNothingWritten(t);
  });

  it("a suspension with a bad expires_at is still refused first (400), before the report is read", async () => {
    const t = world();
    const counter = install(t);
    const r = await call("POST", `/admin/users/${AUTHOR}/suspend`, { reason: "x", report_id: REPORT, expires_at: "2001-01-01T00:00:00.000Z" });
    assert.equal(r.status, 400, r.text);
    assert.equal(counter.reads, 0);
    assertNothingWritten(t);
  });

  it("a non-admin cannot cite a report (or act at all)", async () => {
    const t = world();
    install(t);
    const r = await call("POST", `/admin/users/${AUTHOR}/ban`, { reason: "x", report_id: REPORT }, TOKEN_USER);
    assert.equal(r.status, 403, r.text);
    assertNothingWritten(t);
  });
});

describe("CONTROL — without report_id, every action is exactly what it was", () => {
  it("no moderation_reports read, and suspend / ban / restrict write no metadata at all", async () => {
    for (const [label, method, path, extra, ok] of ACTIONS) {
      const t = world();
      const counter = install(t);
      const r = await call(method, path, bodyFor(extra));
      assert.equal(r.status, ok, `${label}: ${r.text}`);
      assert.equal(counter.reads, 0, `${label}: a report was read for an action that cites none`);
      assert.equal(t.moderation_actions.length, 1);
      assert.ok(!("report_id" in t.moderation_actions[0]), `${label}: report_id column named`);
      assert.equal(t.moderation_actions[0].metadata?.report_id, undefined, label);
    }
  });

  it("report_id: null is the same as absent", async () => {
    const t = world();
    const counter = install(t);
    const r = await call("POST", `/admin/users/${AUTHOR}/ban`, { reason: "x", report_id: null });
    assert.equal(r.status, 200, r.text);
    assert.equal(counter.reads, 0);
    assert.ok(!("metadata" in t.moderation_actions[0]));
  });
});

describe("a LEGACY `reports` id never reaches moderation_actions.report_id (it references moderation_reports)", () => {
  const legacy = () => [{ id: LEGACY_REPORT, reporter_id: REPORTER, target_type: "post", target_id: POST, status: "open", created_at: "2026-10-02T00:00:00.000Z" }];

  it("POST /admin/reports/:id/dismiss on a database WITH 3705: 200, the legacy id in metadata only", async () => {
    const t = world({ legacy: legacy() });
    install(t);
    const r = await call("POST", `/admin/reports/${LEGACY_REPORT}/dismiss`, { notes: "not a scam" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.audit, "recorded");
    assert.equal(t.moderation_actions.length, 1);
    assert.ok(!("report_id" in t.moderation_actions[0]), "a legacy reports id was written to the moderation_reports foreign key");
    assert.equal(t.moderation_actions[0].metadata.report_id, LEGACY_REPORT);
    assert.equal(t.moderation_actions[0].metadata.report_table, LEGACY_REPORTS_TABLE);
  });

  it("POST /admin/reports/:id/resolve on a database WITH 3705: 200, the legacy id in metadata only", async () => {
    const t = world({ legacy: legacy() });
    install(t);
    const r = await call("POST", `/admin/reports/${LEGACY_REPORT}/resolve`, { action: "content removed", notes: "scam" });
    assert.equal(r.status, 200, r.text);
    assert.ok(!("report_id" in t.moderation_actions[0]));
    assert.equal(t.moderation_actions[0].metadata.report_id, LEGACY_REPORT);
  });

  it("auditReportAction (also adminMedia's target 'report') labels the id as legacy", async () => {
    const t = world({ legacy: legacy() });
    const db = makeLayoverDb(t, {}); // 3705 present: the probe answers ready
    const r = await auditReportAction(db, null, { reportId: LEGACY_REPORT, targetType: "post", targetId: POST, adminUserId: ADMIN, actionType: "report_resolved", reason: null });
    assert.equal(r.ok, true);
    assert.equal((r as any).metadata.report_table, LEGACY_REPORTS_TABLE);
    assert.ok(!("report_id" in t.moderation_actions[0]));
  });

  it("linkableReportId: a uuid, unless labelled legacy", () => {
    assert.equal(linkableReportId({ report_id: REPORT }), REPORT);
    assert.equal(linkableReportId({ report_id: REPORT, report_table: "moderation_reports" }), REPORT);
    assert.equal(linkableReportId({ report_id: LEGACY_REPORT, report_table: LEGACY_REPORTS_TABLE }), null);
    assert.equal(linkableReportId({ report_id: "nope" }), null);
    assert.equal(linkableReportId(undefined), null);
  });
});

describe("checkActionReportLink — the rule, directly", () => {
  it("absent and null cite nothing and read nothing", async () => {
    let reads = 0;
    const sc = { from: () => { reads++; throw new Error("read"); } };
    assert.deepEqual(await checkActionReportLink(sc, undefined, AUTHOR), { ok: true, reportId: null, metadata: undefined });
    assert.deepEqual(await checkActionReportLink(sc, null, AUTHOR), { ok: true, reportId: null, metadata: undefined });
    assert.equal(reads, 0);
  });

  it("a client that throws is 503, not a crash and not 'no link'", async () => {
    const sc = { from: () => { throw new Error("socket hang up"); } };
    const r = await checkActionReportLink(sc, REPORT, AUTHOR);
    assert.equal(r.ok, false);
    assert.equal((r as any).code, "degraded_unavailable");
  });

  it("an upper-case uuid is the same report, stored lower-case", async () => {
    const t = world();
    const db = makeLayoverDb(t, {});
    const r = await checkActionReportLink(db, REPORT.toUpperCase(), AUTHOR.toUpperCase());
    assert.equal(r.ok, true);
    assert.equal((r as any).reportId, REPORT);
  });
});
