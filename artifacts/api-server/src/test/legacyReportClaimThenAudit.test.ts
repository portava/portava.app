/**
 * census-trust (wave 5, 2026-10-18) — a legacy report is CLAIMED, then AUDITED;
 * trip hide and the event moderate route check their own reads and writes.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/legacyReportClaimThenAudit.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECTS.
 *   - POST /admin/reports/:id/resolve, /dismiss and adminMedia's moderate on a
 *     report wrote the moderation_actions row FIRST and the status-guarded
 *     update second: a report someone closed in between answered 409 having
 *     already recorded an action that never happened.
 *   - POST /admin/trips/:tripId/report-resolve and the event moderate route's
 *     report close (hide / cancel / remove) closed reports with NO audit row and
 *     no reviewed_by / reviewed_at; trip report-resolve's documented `reason`
 *     was never written.
 *   - POST /admin/trips/:tripId/hide discarded its trips update and its audit
 *     insert, and answered a failed trip read with 404; PATCH
 *     /admin/events/:eventId/moderate answered a failed event read with 404.
 *
 * THE ORDER (lib/legacyReportClose.ts), as POST /admin/moderation/reports/:id/
 * review already does it: claim the row out of the status it was read in
 * (stamping reviewed_by / reviewed_at); zero rows is a 409 with nothing
 * written; then audit; a failed audit undoes the claim, and a failed undo is
 * NAMED (the report reads closed with no audit row — fix by hand).
 *
 * DOUBLES. schemaStrictSupabase (live columns; 42703 otherwise) with: an
 * update hook (runs when a route BUILDS an `.update()`, before it executes —
 * the concurrent close), and a per-table OVERRIDE that may answer one statement
 * without running it (a failed write, a failed read). Each case says whether it
 * was RED or GREEN on the code before this change (4140b5ad8).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { makeSchemaStrictClient, type Seed, type Row, type SchemaStrictOptions } from "./helpers/schemaStrictSupabase.js";
import adminRouter from "../routes/admin.js";
import adminMediaRouter from "../routes/adminMedia.js";

const ADMIN    = "a1111111-1111-4111-8111-1111111180a0";
const REPORTER = "a2222222-2222-4222-8222-2222222280a0";
const OWNER    = "a3333333-3333-4333-8333-3333333380a0";
const FLAGGER  = "a4444444-4444-4444-8444-4444444480a0";
const POST     = "b1111111-1111-4111-8111-1111111180a0";
const TRIP     = "b3333333-3333-4333-8333-3333333380a0";
const GONE_TRIP = "b3333333-3333-4333-8333-3333333380ff";
const EVENT    = "b4444444-4444-4444-8444-4444444480a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN };
const FAIL = { message: "simulated failure", code: "57014" };

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const rid = (n: number) => `c0000000-0000-4000-8000-0000000080${String(n).padStart(2, "0")}`;

function profile(id: string, handle: string, role = "user"): Row {
  return { id, handle, username: handle, name: `${handle} name`, display_name: `${handle} display`, role, account_status: "active", created_at: at(0) };
}
function report(id: string, target_type: string, target_id: string, status = "open", n = 10, extra: Row = {}): Row {
  return { id, reporter_id: REPORTER, target_type, target_id, reason_code: "spam", reason_detail: null, severity: "normal", status, moderation_notes: null, reviewed_by: null, reviewed_at: null, created_at: at(n), updated_at: at(n), ...extra };
}
function world(reports: Row[] = []): Seed {
  return {
    profiles: [profile(ADMIN, "admin", "admin"), profile(REPORTER, "reporter"), profile(OWNER, "owner"), profile(FLAGGER, "flagger", "admin")],
    admin_access_log: [], feature_flags: [], user_account_states: [], moderation_actions: [], event_activity_log: [], trust_events: [],
    posts: [{ id: POST, author_id: OWNER, post_status: "published", created_at: at(1) }],
    trips: [{ id: TRIP, owner_id: OWNER, title: "Reported trip", visibility: "public", status: "planning", created_at: at(2) }],
    events: [{ id: EVENT, host_id: OWNER, title: "Reported event", state: "open", visibility: "public", city: "Da Nang", starts_at: at(3), created_at: at(3), featured: false }],
    reports,
  };
}

type Call = [string, unknown[]];
type Answer = { data: unknown; error: unknown; count?: unknown };
type Override = (calls: Call[], run: () => Promise<Answer>) => Answer | Promise<Answer> | null | undefined;
interface InstallOptions { overrides?: Partial<Record<string, Override>>; beforeUpdate?: Partial<Record<string, () => void>>; strict?: SchemaStrictOptions }

function install(seed: Seed, o: InstallOptions = {}) {
  const strict = makeSchemaStrictClient(seed, o.strict);
  const from = (table: string) => {
    const b = strict.from(table);
    const calls: Call[] = [];
    for (const m of ["select", "eq", "neq", "in", "is", "not", "gt", "gte", "lt", "lte", "order", "limit", "update", "insert", "upsert", "delete"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); if (m === "update") o.beforeUpdate?.[table]?.(); return orig(...args); };
    }
    const ov = o.overrides?.[table];
    const gate = (run: () => Promise<Answer>): Promise<Answer> => {
      try { const r = ov?.(calls, run); return r == null ? run() : Promise.resolve(r); } catch (e) { return Promise.reject(e); }
    };
    const origThen = b.then, origMaybe = b.maybeSingle, origSingle = b.single;
    b.then = (onF: any, onR: any) => gate(() => new Promise<Answer>((res, rej) => origThen(res, rej))).then(onF, onR);
    b.maybeSingle = () => { calls.push(["maybeSingle", []]); return gate(() => origMaybe()); };
    b.single = () => { calls.push(["single", []]); return gate(() => origSingle()); };
    return b;
  };
  const client = {
    from,
    rpc: strict.rpc,
    auth: {
      getUser: async (token: string) => (TOKENS[token]
        ? { data: { user: { id: TOKENS[token] } }, error: null }
        : { data: { user: null }, error: { message: "bad token", status: 401 } }),
    },
  };
  _setTestClient(client, true);
  _setTestServiceClient(client as any);
  return { strict, seed };
}

const isWrite = (calls: Call[], m: "update" | "insert") => calls.some(([x]) => x === m);
/** The undo's signature: an update guarded on the reviewed_at the claim stamped. */
const isUndo = (calls: Call[]) => isWrite(calls, "update") && calls.some(([m, a]) => m === "eq" && a[0] === "reviewed_at");
/** Every moderation_actions insert fails (after its schema check), and never lands. */
const auditFails: Override = (calls) => (isWrite(calls, "insert") ? { data: null, error: { message: "simulated audit insert failure", code: "57014" } } : null);
/** Only the nth moderation_actions insert fails. */
function nthAuditFails(n: number): Override {
  let seen = 0;
  return (calls) => { if (!isWrite(calls, "insert")) return null; seen += 1; return seen === n ? { data: null, error: { message: "simulated audit insert failure", code: "57014" } } : null; };
}
const maybeSingleFails: Override = (calls) => (calls.some(([m]) => m === "maybeSingle") && !isWrite(calls, "update") && !isWrite(calls, "insert") ? { data: null, error: FAIL } : null);

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminMediaRouter);
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => { _resetRateLimit(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const rowOf = (seed: Seed, id: string) => (seed.reports as Row[]).find((r) => r.id === id)!;
const audits = (seed: Seed) => seed.moderation_actions as Row[];

// ── 1. the single-report routes: resolve, dismiss, adminMedia's report moderate ──

const SINGLE: Array<{ name: string; go: (id: string) => Promise<{ status: number; body: any; raw: string }>; to: string; actionType: string }> = [
  { name: "POST /admin/reports/:id/resolve", go: (id) => call("POST", `/admin/reports/${id}/resolve`, { action: "removed", notes: "spam" }), to: "resolved", actionType: "removed" },
  { name: "POST /admin/reports/:id/dismiss", go: (id) => call("POST", `/admin/reports/${id}/dismiss`, { notes: "not spam" }), to: "dismissed", actionType: "report_dismissed" },
  { name: "POST /admin/media/:id/moderate (target report, approve)", go: (id) => call("POST", `/admin/media/${id}/moderate`, { target: "report", action: "approve", reason: "spam" }), to: "resolved", actionType: "report_resolved" },
];

describe("the single-report routes CLAIM the report first, then audit it", () => {
  for (const s of SINGLE) {
    it(`RED before: ${s.name} — a report someone else closed first is a 409 with NO audit row`, async () => {
      const seed = world([report(rid(1), "post", POST)]);
      install(seed, { beforeUpdate: { reports: () => { rowOf(seed, rid(1)).status = "dismissed"; } } });
      const r = await s.go(rid(1));
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.body.error, "conflict");
      assert.deepEqual(audits(seed), [], "no audit row for an action that did not happen");
      assert.equal(rowOf(seed, rid(1)).status, "dismissed", "the other decision stands");
    });

    it(`GREEN before (CONTROL): ${s.name} — the report moves, names its reviewer, and has exactly one audit row against the content owner`, async () => {
      const seed = world([report(rid(1), "post", POST)]);
      const { strict } = install(seed);
      const r = await s.go(rid(1));
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual(strict.deadColumnErrors, []);
      const row = rowOf(seed, rid(1));
      assert.deepEqual([row.status, row.reviewed_by, typeof row.reviewed_at], [s.to, ADMIN, "string"]);
      assert.equal(audits(seed).length, 1);
      assert.deepEqual([audits(seed)[0]!.target_user_id, audits(seed)[0]!.action_type, (audits(seed)[0]!.metadata as any).report_id], [OWNER, s.actionType, rid(1)]);
      assert.equal(r.body.audit, "recorded");
    });

    it(`GREEN before (CONTROL): ${s.name} — a failed audit leaves the report exactly as it was read (now by an undo)`, async () => {
      const seed = world([report(rid(1), "post", POST, "in_review", 10, { reviewed_by: FLAGGER, reviewed_at: at(50), moderation_notes: "flagged" })]);
      const before = { ...rowOf(seed, rid(1)) };
      install(seed, { overrides: { moderation_actions: auditFails } });
      const r = await s.go(rid(1));
      assert.equal(r.status, 500, r.raw);
      const after = rowOf(seed, rid(1));
      for (const k of ["status", "reviewed_by", "reviewed_at", "moderation_notes"]) assert.equal(after[k], before[k], k);
      assert.deepEqual(audits(seed), []);
    });

    it(`RED before: ${s.name} — the failed-audit answer says the report was restored`, async () => {
      const seed = world([report(rid(1), "post", POST, "in_review")]);
      install(seed, { overrides: { moderation_actions: auditFails } });
      const r = await s.go(rid(1));
      assert.equal(r.body.error, "db_error", r.raw);
      assert.match(r.body.message, /Audit write failed, so the report was restored to 'in_review'\. Nothing was recorded\./);
    });

    it(`NEW STATE, named: ${s.name} — the audit AND the undo fail: the 500 says the report reads moved with no audit row`, async () => {
      const seed = world([report(rid(1), "post", POST)]);
      install(seed, { overrides: { moderation_actions: auditFails, reports: (calls) => (isUndo(calls) ? { data: null, error: FAIL } : null) } });
      const r = await s.go(rid(1));
      assert.equal(r.status, 500, r.raw);
      assert.match(r.body.message, new RegExp(`could not be restored: it now reads '${s.to}' with no audit row\\. Fix by hand\\.`));
      assert.equal(rowOf(seed, rid(1)).status, s.to, "the answer is the truth: the report did move");
    });
  }
});

// ── 2. trip report-resolve ──────────────────────────────────────────────────

describe("POST /admin/trips/:tripId/report-resolve claims each report, then audits it", () => {
  it("RED before: every closed report names its reviewer and has one audit row against the trip OWNER", async () => {
    const seed = world([report(rid(1), "trip", TRIP, "open", 10), report(rid(2), "trip", TRIP, "in_review", 11), report(rid(3), "trip", TRIP, "dismissed", 12)]);
    const { strict } = install(seed);
    const r = await call("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "accepted", reason: "itinerary is a scam" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(r.body, { tripId: TRIP, resolution: "accepted", resolvedCount: 2, reports: [{ id: rid(1), audit: "recorded" }, { id: rid(2), audit: "recorded" }], closedConcurrently: [] });
    for (const id of [rid(1), rid(2)]) {
      const row = rowOf(seed, id);
      assert.deepEqual([row.status, row.reviewed_by, row.moderation_notes], ["resolved", ADMIN, "itinerary is a scam"], id);
    }
    assert.equal(rowOf(seed, rid(3)).status, "dismissed", "a closed report is not re-closed");
    assert.deepEqual(audits(seed).map((a) => [a.target_user_id, a.action_type, a.reason, (a.metadata as any).report_id]), [
      [OWNER, "report_resolved", "itinerary is a scam", rid(1)],
      [OWNER, "report_resolved", "itinerary is a scam", rid(2)],
    ]);
  });

  it("RED before: 'rejected' dismisses with a report_dismissed audit row", async () => {
    const seed = world([report(rid(1), "trip", TRIP)]);
    install(seed);
    const r = await call("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "rejected" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(rowOf(seed, rid(1)).status, "dismissed");
    assert.deepEqual(audits(seed).map((a) => a.action_type), ["report_dismissed"]);
  });

  it("RED before: the second report's audit fails — the answer names the one closed, the restored one, and stops", async () => {
    const seed = world([report(rid(1), "trip", TRIP, "open", 10), report(rid(2), "trip", TRIP, "open", 11), report(rid(3), "trip", TRIP, "open", 12)]);
    install(seed, { overrides: { moderation_actions: nthAuditFails(2) } });
    const r = await call("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "accepted" });
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, new RegExp(`1 report\\(s\\) were closed and audited \\(${rid(1)}\\)\\. Report ${rid(2)}: Audit write failed, so the report was restored to 'open'.* 1 more were not attempted and stay open\\.`));
    assert.deepEqual([rid(1), rid(2), rid(3)].map((id) => rowOf(seed, id).status), ["resolved", "open", "open"]);
    assert.equal(audits(seed).length, 1, "every closed report has its row; no other row exists");
  });

  it("RED before: a report against a deleted trip is still closed — its audit skipped by rule (no accountable owner), and said", async () => {
    const seed = world([report(rid(1), "trip", GONE_TRIP)]);
    install(seed);
    const r = await call("POST", `/admin/trips/${GONE_TRIP}/report-resolve`, { resolution: "accepted" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.reports, [{ id: rid(1), audit: "skipped_no_owner" }]);
    assert.equal(rowOf(seed, rid(1)).reviewed_by, ADMIN, "the report row itself names who closed it");
  });

  it("RED before: a report someone closes between the read and its claim is NAMED, not counted", async () => {
    const seed = world([report(rid(1), "trip", TRIP, "open", 10), report(rid(2), "trip", TRIP, "open", 11)]);
    let fired = false;
    install(seed, { beforeUpdate: { reports: () => { if (!fired) { fired = true; rowOf(seed, rid(2)).status = "dismissed"; } } } });
    const r = await call("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "accepted" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.resolvedCount, 1);
    assert.deepEqual(r.body.closedConcurrently, [rid(2)]);
    assert.equal(rowOf(seed, rid(2)).status, "dismissed");
  });
});

// ── 3. the event moderate route ─────────────────────────────────────────────

describe("PATCH /admin/events/:eventId/moderate: the report close is claimed then audited; a failed event read is not a 404", () => {
  it("RED before: hide closes each report with its reviewer and one report_resolved audit row against the HOST", async () => {
    const seed = world([report(rid(1), "event", EVENT, "open", 10), report(rid(2), "event", EVENT, "in_review", 11)]);
    const { strict } = install(seed);
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "hide", reason: "scam" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(r.body.reportsResolved, 2);
    for (const id of [rid(1), rid(2)]) assert.deepEqual([rowOf(seed, id).status, rowOf(seed, id).reviewed_by], ["resolved", ADMIN]);
    const closes = audits(seed).filter((a) => a.action_type === "report_resolved");
    assert.deepEqual(closes.map((a) => [a.target_user_id, (a.metadata as any).report_id]), [[OWNER, rid(1)], [OWNER, rid(2)]]);
  });

  it("RED before: a report whose audit cannot be written is restored, and the answer says so (reportsResolved: null, reportsCloseError)", async () => {
    const seed = world([report(rid(1), "event", EVENT)]);
    install(seed, { overrides: { moderation_actions: (calls) => (isWrite(calls, "insert") && (calls.find(([m]) => m === "insert")![1][0] as any)?.action_type === "report_resolved" ? { data: null, error: FAIL } : null) } });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "cancel" });
    assert.equal(r.status, 200, `the event action is applied either way: ${r.raw}`);
    assert.equal(r.body.reportsResolved, null);
    assert.match(r.body.reportsCloseError, /restored to 'open'/);
    assert.equal(rowOf(seed, rid(1)).status, "open");
  });

  it("RED before: a failed event read is 503 and nothing is written — it answered 404 'Event not found'", async () => {
    const seed = world([report(rid(1), "event", EVENT)]);
    install(seed, { overrides: { events: maybeSingleFails } });
    const r = await call("PATCH", `/admin/events/${EVENT}/moderate`, { action: "hide" });
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.deepEqual([(seed.event_activity_log as Row[]).length, audits(seed).length, rowOf(seed, rid(1)).status], [0, 0, "open"]);
  });
});

// ── 4. trip hide ────────────────────────────────────────────────────────────

describe("POST /admin/trips/:tripId/hide checks its read, its write and its audit row", () => {
  const trip = (seed: Seed) => (seed.trips as Row[]).find((t) => t.id === TRIP);

  it("RED before: success writes one trip_hidden audit row that names the trip it hid", async () => {
    const seed = world();
    const { strict } = install(seed);
    const r = await call("POST", `/admin/trips/${TRIP}/hide`, { reason: "unsafe meetup" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(r.body, { tripId: TRIP, visibility: "private", hidden: true });
    assert.equal(trip(seed)!.visibility, "private");
    assert.deepEqual(audits(seed).map((a) => [a.action_type, a.target_user_id, (a.metadata as any)?.trip_id, (a.metadata as any)?.prior_visibility]), [["trip_hidden", OWNER, TRIP, "public"]]);
  });

  it("RED before: a failed trip read is 503 — it answered 404 'Trip not found'", async () => {
    const seed = world();
    install(seed, { overrides: { trips: maybeSingleFails } });
    const r = await call("POST", `/admin/trips/${TRIP}/hide`, {});
    assert.equal(r.status, 503, r.raw);
    assert.deepEqual([trip(seed)!.visibility, audits(seed).length], ["public", 0]);
  });

  it("RED before: a failed hide is a 500 that says nothing changed — it answered `hidden: true`", async () => {
    const seed = world();
    install(seed, { strict: { writeError: { table: "trips", error: FAIL } } });
    const r = await call("POST", `/admin/trips/${TRIP}/hide`, {});
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /could not be hidden: simulated failure\. Nothing was changed\./);
    assert.deepEqual([trip(seed)!.visibility, audits(seed).length], ["public", 0]);
  });

  it("RED before: a hide that matches no row (the trip was removed meanwhile) is a 404 — it answered `hidden: true`", async () => {
    const seed = world();
    install(seed, { beforeUpdate: { trips: () => { seed.trips = []; } } });
    const r = await call("POST", `/admin/trips/${TRIP}/hide`, {});
    assert.equal(r.status, 404, r.raw);
    assert.match(r.body.message, /removed while this request ran/);
    assert.equal(audits(seed).length, 0);
  });

  it("RED before: the trip IS hidden but its audit row fails — the 500 says exactly that (it answered `hidden: true`)", async () => {
    const seed = world();
    install(seed, { overrides: { moderation_actions: auditFails } });
    const r = await call("POST", `/admin/trips/${TRIP}/hide`, {});
    assert.equal(r.status, 500, r.raw);
    assert.match(r.body.message, /The trip IS hidden \(visibility private\), but its audit row could not be written/);
    assert.equal(trip(seed)!.visibility, "private");
  });
});

// ── 5. lib/legacyReportClose.ts, as a unit ──────────────────────────────────

describe("moveLegacyReport: every outcome is said, nothing is guessed", () => {
  const ROW = { id: rid(9), target_type: "post", target_id: POST, status: "open", reviewed_by: null, reviewed_at: null, moderation_notes: null };
  const opts = { to: "resolved" as const, adminUserId: ADMIN, notes: null, actionType: "report_resolved" };

  /** A client whose reports update answers `answer` (or throws) and whose audit insert is counted. */
  function fake(answer: Answer | "throw") {
    const seen = { updates: 0, inserts: 0 };
    const sc = {
      from(table: string) {
        const b: any = {};
        for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
        b.update = () => { seen.updates += 1; return b; };
        b.insert = () => { seen.inserts += 1; return b; };
        b.maybeSingle = async () => ({ data: table === "posts" ? { author_id: OWNER } : null, error: null });
        b.then = (onF: any, onR: any) => (answer === "throw" ? Promise.reject(new Error("socket hang up")) : Promise.resolve(answer)).then(onF, onR);
        return b;
      },
    };
    return { sc, seen };
  }

  it("UNIT (lib/legacyReportClose.ts is new): a row already closed is a conflict, and nothing is written", async () => {
    const { moveLegacyReport } = await import("../lib/legacyReportClose.js");
    const { sc, seen } = fake({ data: [], error: null });
    const r = await moveLegacyReport(sc, null, { ...ROW, status: "dismissed" }, opts);
    assert.equal(r.outcome, "conflict");
    assert.deepEqual(seen, { updates: 0, inserts: 0 });
  });

  it("UNIT (lib/legacyReportClose.ts is new): a claim that answers no rows to count is `unknown`, and no audit row is written", async () => {
    const { moveLegacyReport } = await import("../lib/legacyReportClose.js");
    const { sc, seen } = fake({ data: null, error: null });
    const r = await moveLegacyReport(sc, null, ROW, opts);
    assert.deepEqual([r.outcome, (r as any).state], ["failed", "unknown"]);
    assert.equal(seen.inserts, 0);
  });

  it("UNIT (lib/legacyReportClose.ts is new): a thrown claim is `unknown`; a failed claim is `nothing_written`; zero rows is a conflict — none audited", async () => {
    const { moveLegacyReport } = await import("../lib/legacyReportClose.js");
    const thrown = fake("throw");
    assert.equal(((await moveLegacyReport(thrown.sc, null, ROW, opts)) as any).state, "unknown");
    const errored = fake({ data: null, error: FAIL });
    assert.equal(((await moveLegacyReport(errored.sc, null, ROW, opts)) as any).state, "nothing_written");
    const none = fake({ data: [], error: null });
    assert.equal((await moveLegacyReport(none.sc, null, ROW, opts)).outcome, "conflict");
    assert.deepEqual([thrown.seen.inserts, errored.seen.inserts, none.seen.inserts], [0, 0, 0]);
  });

  it("UNIT (lib/legacyReportClose.ts is new): the claim is guarded on the status the row was READ in, and the undo on the stamp the claim wrote", async () => {
    const { moveLegacyReport } = await import("../lib/legacyReportClose.js");
    const seed = world([report(rid(9), "post", POST, "in_review", 10, { reviewed_by: FLAGGER, reviewed_at: at(40), moderation_notes: "flagged" })]);
    const calls: Array<[string, Call[]]> = [];
    const strict = makeSchemaStrictClient(seed);
    const sc = {
      from(table: string) {
        const b = strict.from(table); const c: Call[] = []; calls.push([table, c]);
        for (const m of ["update", "insert", "eq", "select"]) { const orig = b[m]; b[m] = (...a: unknown[]) => { c.push([m, a]); return orig(...a); }; }
        if (table === "moderation_actions") b.maybeSingle = async () => ({ data: null, error: FAIL });
        return b;
      },
    };
    const r = await moveLegacyReport(sc, null, rowOf(seed, rid(9)) as any, { ...opts, now: at(99) });
    assert.deepEqual([r.outcome, (r as any).state], ["failed", "restored"]);
    const updates = calls.filter(([t, c]) => t === "reports" && c.some(([m]) => m === "update")).map(([, c]) => c.filter(([m]) => m === "eq").map(([, a]) => a));
    assert.deepEqual(updates, [[["id", rid(9)], ["status", "in_review"]], [["id", rid(9)], ["status", "resolved"], ["reviewed_at", at(99)]]]);
    const row = rowOf(seed, rid(9));
    assert.deepEqual([row.status, row.reviewed_by, row.reviewed_at, row.moderation_notes], ["in_review", FLAGGER, at(40), "flagged"]);
  });
});
