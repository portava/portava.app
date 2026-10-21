/**
 * census-trust (wave 5, 2026-10-18) — report status: 'open' reports were
 * invisible to the admin resolve routes.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/legacyReportStatusLifecycle.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT. `public.reports.status` is TEXT, DEFAULT 'open', with NO CHECK
 * (production catalog, read 2026-10-18), so nothing in the database holds a
 * writer and a reader to one word. Every intake (POST /reports, thread, message
 * and post reports) files 'open' by default; POST /reviews/:id/report wrote
 * 'pending'; hide-content wrote 'in_review'; adminMedia's flag wrote 'reviewed'.
 * The reported-trips queue, trip report-resolve, the reported-events queue and
 * the event moderate route's report close all asked ONLY for 'pending' — so a
 * report filed through /reports never reached them, and trip report-resolve
 * answered resolvedCount: 0 for every trip. Dismiss asked only for 'open' (an
 * in_review or review report could not be dismissed); resolve asked for
 * anything but 'resolved' (a DISMISSED report could be re-resolved); the
 * moderation-action report_resolved and hide-content moved a report whatever
 * its status (a closed report was re-resolved or reopened).
 *
 * THE FIX. One vocabulary, lib/moderationCounts.ts: open | in_review | resolved
 * | dismissed, the words the admin client already speaks. Every reader that
 * means "unresolved" reads UNRESOLVED_REPORT_STATUSES (open, in_review); every
 * transition moves only an unresolved report; reviews file 'open'; adminMedia's
 * flag writes 'in_review'. Counts are measured, never `?? 0`.
 *
 * DOUBLES. Every route runs on schemaStrictSupabase (each column named is
 * checked against the live schema; 42703 otherwise), with three additions, each
 * stated where it is made:
 *   1. INSERT DEFAULTS for `reports` — the live column defaults (id
 *      gen_random_uuid(), status 'open', severity 'normal', created_at /
 *      updated_at now(); baseline/20260819_baseline_structure.sql). The double
 *      models no defaults, and the default IS the defect: without this a report
 *      filed by POST /reports would carry no status at all.
 *   2. `.range(0, n)` as `.limit(n + 1)` — the double has no range; every list
 *      read here is page 1, and the shim refuses any other page.
 *   3. Per-table ANSWER overrides for the failure cases (a count-less answer, a
 *      failed read): the statement still runs its schema check first. A failed
 *      WRITE uses the double's own `writeError`; a concurrent close is staged by
 *      a hook that runs when the route's `.update()` is built, before it executes.
 * Each case says whether it was RED or GREEN on the code before this change
 * (c9c7933db).
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { countOpenReportsAgainst } from "../lib/moderationCounts.js";
import { resolveSendTier, _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { makeSchemaStrictClient, type Seed, type Row, type SchemaStrictOptions } from "./helpers/schemaStrictSupabase.js";
import adminRouter from "../routes/admin.js";
import adminMediaRouter from "../routes/adminMedia.js";
import reportsRouter from "../routes/reports.js";
import reviewsRouter from "../routes/reviews.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dir, "..");
const REPO = resolve(SRC, "../../..");

/** The vocabulary, written out: the module is read through a dynamic import so one case, not the file, fails on a tree without it. */
const VOCABULARY = ["open", "in_review", "resolved", "dismissed"];
const UNRESOLVED = ["open", "in_review"];

const ADMIN    = "a1111111-1111-4111-8111-1111111150a0";
const REPORTER = "a2222222-2222-4222-8222-2222222250a0";
const OWNER    = "a3333333-3333-4333-8333-3333333350a0";
const TRIP     = "b1111111-1111-4111-8111-1111111150a0";
const EVENT    = "b2222222-2222-4222-8222-2222222250a0";
const POST     = "b3333333-3333-4333-8333-3333333350a0";
const REVIEW   = "b4444444-4444-4444-8444-4444444450a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN, "reporter-token": REPORTER };

const T0 = "2026-10-01T00:00:00.000Z";

function profile(id: string, handle: string, role = "user") {
  return { id, handle, username: handle, name: `${handle} name`, display_name: `${handle} display`, role, account_status: "active", created_at: T0 };
}

function world(): Seed {
  return {
    profiles: [profile(ADMIN, "admin", "admin"), profile(REPORTER, "reporter"), profile(OWNER, "owner")],
    user_account_states: [],
    feature_flags: [],
    trips: [{ id: TRIP, owner_id: OWNER, title: "Reported trip", visibility: "public", status: "planning", created_at: T0 }],
    events: [{ id: EVENT, host_id: OWNER, title: "Reported event", state: "open", visibility: "public", city: "Da Nang", starts_at: T0, created_at: T0, featured: false }],
    posts: [{ id: POST, author_id: OWNER, post_status: "published", created_at: T0 }],
    reviews: [{ id: REVIEW, reviewer_id: OWNER, entity_type: "trip", entity_id: TRIP, rating: 2, body: "meh", state: "published", created_at: T0 }],
    reports: [],
    report_evidence: [],
    moderation_actions: [],
    event_activity_log: [],
    admin_access_log: [],
    trust_events: [],
  };
}

let seq = 0;
/** Addition 1: the live column defaults of public.reports, applied on insert. */
function withReportDefaults(row: Row): Row {
  const now = new Date(Date.UTC(2026, 9, 2, 0, 0, seq)).toISOString();
  seq += 1;
  return {
    id: `c0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    severity: "normal",
    status: "open",
    created_at: now,
    updated_at: now,
    ...row,
  };
}

type Answer = { data: unknown; error: unknown; count?: unknown };
type Overrides = Partial<Record<string, (calls: Array<[string, unknown[]]>) => Answer | null>>;
interface InstallOptions { beforeUpdate?: Partial<Record<string, () => void>>; strict?: SchemaStrictOptions }

function install(seed: Seed, overrides: Overrides = {}, o: InstallOptions = {}) {
  const strict = makeSchemaStrictClient(seed, o.strict);
  const from = (table: string) => {
    const b = strict.from(table);
    const calls: Array<[string, unknown[]]> = [];
    for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "update", "insert"]) {
      const orig = b[m];
      b[m] = (...args: unknown[]) => { calls.push([m, args]); if (m === "update") o.beforeUpdate?.[table]?.(); return orig(...args); };
    }
    // Addition 2: page 1 only.
    b.range = (lo: number, hi: number) => {
      if (lo !== 0) throw new Error(`range shim: page 1 only (asked ${lo}..${hi})`);
      calls.push(["range", [lo, hi]]);
      return b.limit(hi - lo + 1);
    };
    if (table === "reports") {
      const origInsert = b.insert;
      b.insert = (rows: Row | Row[]) => origInsert(Array.isArray(rows) ? rows.map(withReportDefaults) : withReportDefaults(rows));
    }
    // Addition 3: replace the ANSWER (after the schema check has run) when an override claims this statement.
    const override = overrides[table];
    if (override) {
      const then = b.then;
      b.then = (onF: any, onR: any) => then((real: Answer) => override(calls) ?? real).then(onF, onR);
    }
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

let server: http.Server;
let base = "";
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(reportsRouter);
  app.use(reviewsRouter);
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

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const asAdmin = (method: string, path: string, body?: unknown) => call(method, path, "admin-token", body);

/** File a report the way the app does: POST /reports, as the reporter. */
async function file(target_type: string, target_id: string): Promise<string> {
  const r = await call("POST", "/reports", "reporter-token", { target_type, target_id, reason_code: "spam" });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.status, "open");
  return r.body.reportId as string;
}

const rowOf = (seed: Seed, id: string) => (seed.reports as Row[]).find((r) => r.id === id)!;

// ── 1. The trip queue and trip report-resolve ───────────────────────────────

describe("a trip report filed through POST /reports reaches the trip queue and trip report-resolve", () => {
  it("RED before: GET /admin/trips lists a trip whose report was filed through /reports", async () => {
    const { strict, seed } = install(world());
    const id = await file("trip", TRIP);
    assert.equal(rowOf(seed, id).status, "open", "the column default — what production stores");
    const r = await asAdmin("GET", "/admin/trips");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(r.body.trips.length, 1, `the reported trip is in the queue: ${r.raw}`);
    assert.equal(r.body.trips[0].trip.id, TRIP);
    assert.equal(r.body.trips[0].pendingReports, 1);
  });

  it("RED before: GET /admin/trips also lists an in_review report — a moderator touched it, nobody closed it", async () => {
    const { seed } = install(world());
    const id = await file("trip", TRIP);
    rowOf(seed, id).status = "in_review";
    const r = await asAdmin("GET", "/admin/trips");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.trips.map((t: any) => t.reports.map((x: any) => x.status)), [["in_review"]]);
  });

  it("GREEN before (CONTROL): a closed report is not in the trip queue", async () => {
    const { seed } = install(world());
    rowOf(seed, await file("trip", TRIP)).status = "resolved";
    rowOf(seed, await file("trip", TRIP)).status = "dismissed";
    const r = await asAdmin("GET", "/admin/trips");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { trips: [], total: 0, page: 1 }); // wave 5: the queue pages, with its measured total
  });

  it("RED before: report-resolve closes the report it names and counts it — resolvedCount reflects reality", async () => {
    const { strict, seed } = install(world());
    const a = await file("trip", TRIP);
    const b = await file("trip", TRIP);
    rowOf(seed, b).status = "in_review";
    const r = await asAdmin("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "accepted" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(r.body, { tripId: TRIP, resolution: "accepted", resolvedCount: 2, reports: [{ id: a, audit: "recorded" }, { id: b, audit: "recorded" }], closedConcurrently: [] }); // wave 5: each report claimed, then audited
    assert.equal(rowOf(seed, a).status, "resolved");
    assert.equal(rowOf(seed, b).status, "resolved");
  });

  it("RED before: 'rejected' dismisses; a second call moves nothing — a closed report is not re-resolved", async () => {
    const { seed } = install(world());
    const a = await file("trip", TRIP);
    const first = await asAdmin("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "rejected" });
    assert.deepEqual(first.body, { tripId: TRIP, resolution: "rejected", resolvedCount: 1, reports: [{ id: a, audit: "recorded" }], closedConcurrently: [] });
    assert.equal(rowOf(seed, a).status, "dismissed");
    const again = await asAdmin("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "accepted" });
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.resolvedCount, 0, "a measured zero: nothing unresolved was left");
    assert.equal(rowOf(seed, a).status, "dismissed", "the dismissal stands");
    const queue = await asAdmin("GET", "/admin/trips");
    assert.deepEqual(queue.body, { trips: [], total: 0, page: 1 }, "and the queue is clear");
  });

  it("RED before: an update that answers no rows is refused — never `(updated ?? []).length` = 0", async () => {
    const { seed } = install(world(), {
      reports: (calls) => (calls.some(([m]) => m === "update") ? { data: null, error: null } : null),
    });
    await file("trip", TRIP);
    const r = await asAdmin("POST", `/admin/trips/${TRIP}/report-resolve`, { resolution: "accepted" });
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
    assert.match(r.body.message, /how many reports it closed is unknown/);
    assert.equal((seed.reports as Row[]).length, 1);
  });

  it("RED before: a failed trips read is refused, not answered as an empty queue", async () => {
    install(world(), { trips: () => ({ data: null, error: { message: "simulated trips failure", code: "57014" } }) });
    await file("trip", TRIP);
    const r = await asAdmin("GET", "/admin/trips");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
  });
});

// ── 2. The reported-events queue and the event moderate route ───────────────

describe("an event report filed through POST /reports reaches the events queue and is closed by hide/cancel/remove", () => {
  it("RED before: GET /admin/events?reported=true lists the reported event", async () => {
    const { strict } = install(world());
    await file("event", EVENT);
    const r = await asAdmin("GET", "/admin/events?reported=true");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(r.body.events.length, 1, r.raw);
    assert.equal(r.body.events[0].event.id, EVENT);
    assert.equal(r.body.events[0].pendingReports, 1);
  });

  it("RED before: a failed events read is an honest db_error, not a crash in the filter", async () => {
    install(world(), { events: () => ({ data: null, error: { message: "simulated events failure", code: "57014" } }) });
    await file("event", EVENT);
    const r = await asAdmin("GET", "/admin/events?reported=true");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error", `a JSON refusal, not a thrown TypeError: ${r.raw}`);
  });

  it("RED before: hiding the event resolves its open and in_review reports and says how many", async () => {
    const { strict, seed } = install(world());
    const a = await file("event", EVENT);
    const b = await file("event", EVENT);
    rowOf(seed, b).status = "in_review";
    const r = await asAdmin("PATCH", `/admin/events/${EVENT}/moderate`, { action: "hide", reason: "scam" });
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.reportsResolved, 2);
    assert.equal(rowOf(seed, a).status, "resolved");
    assert.equal(rowOf(seed, b).status, "resolved");
    const queue = await asAdmin("GET", "/admin/events?reported=true");
    assert.deepEqual(queue.body, { events: [], total: 0, page: 1 });
  });

  it("RED before: a dismissed event report stays dismissed when the event is later removed", async () => {
    const { seed } = install(world());
    const a = await file("event", EVENT);
    rowOf(seed, a).status = "dismissed";
    const r = await asAdmin("PATCH", `/admin/events/${EVENT}/moderate`, { action: "remove" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.reportsResolved, 0);
    assert.equal(rowOf(seed, a).status, "dismissed");
  });

  it("RED before: a failed report close is NAMED (reportsResolved: null), never swallowed", async () => {
    const seed = world();
    const a = "c1111111-1111-4111-8111-111111111111";
    seed.reports = [withReportDefaults({ id: a, reporter_id: REPORTER, target_type: "event", target_id: EVENT, reason_code: "spam" })];
    install(seed, {}, { strict: { writeError: { table: "reports", error: { message: "simulated reports write failure", code: "57014" } } } });
    const r = await asAdmin("PATCH", `/admin/events/${EVENT}/moderate`, { action: "cancel" });
    assert.equal(r.status, 200, `the event action is already applied: ${r.raw}`);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.reportsResolved, null);
    assert.equal(rowOf(seed, a).status, "open");
  });

  it("GREEN before (CONTROL): feature does not touch the reports and says nothing about them", async () => {
    const { seed } = install(world());
    const a = await file("event", EVENT);
    const r = await asAdmin("PATCH", `/admin/events/${EVENT}/moderate`, { action: "feature" });
    assert.equal(r.status, 200, r.raw);
    assert.equal("reportsResolved" in r.body, false);
    assert.equal(rowOf(seed, a).status, "open");
  });
});

// ── 3. The legacy list, resolve, dismiss and hide-content ──────────────────

describe("GET /admin/reports, resolve, dismiss and hide-content move only unresolved reports", () => {
  it("GREEN before (CONTROL): a post report filed through /reports is in the default (open) list", async () => {
    const { strict } = install(world());
    const id = await file("post", POST);
    const r = await asAdmin("GET", "/admin/reports");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(r.body.reports.map((x: any) => x.id), [id]);
    assert.equal(r.body.total, 1);
  });

  it("RED before: a status no report carries is refused by name — never an empty page", async () => {
    install(world());
    await file("post", POST);
    for (const word of ["pending", "reviewed", "all"]) {
      const r = await asAdmin("GET", `/admin/reports?status=${word}`);
      assert.equal(r.status, 400, `${word}: ${r.raw}`);
      assert.equal(r.body.error, "invalid_payload");
      assert.match(r.body.message, /One of: open, in_review, resolved, dismissed/);
    }
  });

  it("RED before: hide-content moves an open report to in_review; it is listed there and can be DISMISSED", async () => {
    const { seed } = install(world());
    const id = await file("post", POST);
    const hide = await asAdmin("POST", `/admin/reports/${id}/hide-content`, { reason: "spam" });
    assert.equal(hide.status, 200, hide.raw);
    assert.equal(hide.body.status, "in_review");
    assert.equal(rowOf(seed, id).status, "in_review");
    const listed = await asAdmin("GET", "/admin/reports?status=in_review");
    assert.deepEqual(listed.body.reports.map((x: any) => x.id), [id]);
    const dismiss = await asAdmin("POST", `/admin/reports/${id}/dismiss`, { notes: "not spam" });
    assert.equal(dismiss.status, 200, `the admin client offers dismiss on in_review: ${dismiss.raw}`);
    assert.equal(dismiss.body.report.status, "dismissed");
    assert.equal(rowOf(seed, id).status, "dismissed");
    assert.equal(rowOf(seed, id).reviewed_by, ADMIN);
  });

  it("RED before: a DISMISSED report is not re-resolved — 404, and the dismissal stands", async () => {
    const { seed } = install(world());
    const id = await file("post", POST);
    assert.equal((await asAdmin("POST", `/admin/reports/${id}/dismiss`, { notes: "no" })).status, 200);
    const before = { ...rowOf(seed, id) };
    const audits = (seed.moderation_actions as Row[]).length;
    const r = await asAdmin("POST", `/admin/reports/${id}/resolve`, { action: "warned", notes: "late" });
    assert.equal(r.status, 404, r.raw);
    assert.equal(r.body.message, "Report not found or already closed (resolved or dismissed)");
    assert.deepEqual(rowOf(seed, id), before, "nothing on the row moved");
    assert.equal((seed.moderation_actions as Row[]).length, audits, "and no audit row was written for an action that did not happen");
  });

  it("GREEN before (CONTROL): a resolved report is not re-resolved or dismissed", async () => {
    const { seed } = install(world());
    const id = await file("post", POST);
    assert.equal((await asAdmin("POST", `/admin/reports/${id}/resolve`, { action: "removed", notes: "first" })).status, 200);
    const before = { ...rowOf(seed, id) };
    assert.equal((await asAdmin("POST", `/admin/reports/${id}/resolve`, { action: "again" })).status, 404);
    assert.equal((await asAdmin("POST", `/admin/reports/${id}/dismiss`, { notes: "again" })).status, 404);
    assert.deepEqual(rowOf(seed, id), before);
  });

  it("RED before: hide-content does not REOPEN a resolved report; it answers the status the row holds", async () => {
    const { seed } = install(world());
    const id = await file("post", POST);
    assert.equal((await asAdmin("POST", `/admin/reports/${id}/resolve`, { action: "removed" })).status, 200);
    const r = await asAdmin("POST", `/admin/reports/${id}/hide-content`, { reason: "late hide" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.contentHidden, true, "the content step still runs");
    assert.equal(r.body.status, "resolved");
    assert.equal(rowOf(seed, id).status, "resolved");
  });

  it("RED before: a report closed between resolve's read and its write is a 409, not a crash or an overwrite", async () => {
    const seed = world();
    // The read sees the report open; by the time the write runs, someone else has dismissed it.
    install(seed, {}, { beforeUpdate: { reports: () => { for (const r of seed.reports as Row[]) r.status = "dismissed"; } } });
    const id = await file("post", POST);
    const r = await asAdmin("POST", `/admin/reports/${id}/resolve`, { action: "removed" });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "conflict");
    assert.equal(rowOf(seed, id).status, "dismissed", "the concurrent decision stands");
  });
});

// ── 4. The moderation-action report_resolved side effect ───────────────────

describe("PATCH /admin/users/:userId/moderation-action report_resolved moves only an unresolved report", () => {
  it("GREEN before (CONTROL): an open report is resolved", async () => {
    const { seed } = install(world());
    const id = await file("post", POST);
    const r = await asAdmin("PATCH", `/admin/users/${OWNER}/moderation-action`, { action_type: "report_resolved", target_ref_id: id, reason: "handled" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.sideEffects.reportStatus, "resolved");
    assert.equal(rowOf(seed, id).status, "resolved");
  });

  it("RED before: an already-closed report is not re-resolved, and the answer says so", async () => {
    const { seed } = install(world());
    const id = await file("post", POST);
    assert.equal((await asAdmin("POST", `/admin/reports/${id}/dismiss`, { notes: "first decision" })).status, 200);
    const before = { ...rowOf(seed, id) };
    const r = await asAdmin("PATCH", `/admin/users/${OWNER}/moderation-action`, { action_type: "report_resolved", target_ref_id: id, reason: "second" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.sideEffects.reportStatus, "already_closed");
    assert.deepEqual(rowOf(seed, id), before, "the dismissal, its reviewer and its note stand");
  });

  it("GREEN before (CONTROL): an id that names no report is not_found", async () => {
    install(world());
    const r = await asAdmin("PATCH", `/admin/users/${OWNER}/moderation-action`, { action_type: "report_resolved", target_ref_id: "c9999999-9999-4999-8999-999999999999", reason: "x" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.sideEffects.reportStatus, "not_found");
  });
});

// ── 5. Reviews' reports and adminMedia's report moderation ─────────────────

describe("a review report and adminMedia's report moderation speak the same vocabulary", () => {
  it("RED before: POST /reviews/:id/report files 'open', and the report reaches the admin list and resolve", async () => {
    const { strict, seed } = install(world());
    const r = await call("POST", `/reviews/${REVIEW}/report`, "reporter-token", { reason: "spam" });
    assert.equal(r.status, 201, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    const row = (seed.reports as Row[]).find((x) => x.target_type === "review" && x.target_id === REVIEW)!;
    assert.equal(row.status, "open", "not 'pending' — a word no admin list asks for");
    const listed = await asAdmin("GET", "/admin/reports");
    assert.deepEqual(listed.body.reports.map((x: any) => x.id), [row.id]);
    const dismiss = await asAdmin("POST", `/admin/reports/${row.id}/dismiss`, { notes: "fair review" });
    assert.equal(dismiss.status, 200, dismiss.raw);
    assert.equal(row.status, "dismissed");
  });

  it("RED before: adminMedia flag on a report writes in_review — a word the admin client lists — and approve then resolves it", async () => {
    const { seed } = install(world());
    const id = await file("post", POST);
    const flag = await asAdmin("POST", `/admin/media/${id}/moderate`, { action: "flag", target: "report", reason: "look again" });
    assert.equal(flag.status, 200, flag.raw);
    assert.equal(rowOf(seed, id).status, "in_review");
    const listed = await asAdmin("GET", "/admin/reports?status=in_review");
    assert.deepEqual(listed.body.reports.map((x: any) => x.id), [id]);
    const approve = await asAdmin("POST", `/admin/media/${id}/moderate`, { action: "approve", target: "report", reason: "upheld" });
    assert.equal(approve.status, 200, approve.raw);
    assert.equal(rowOf(seed, id).status, "resolved");
    const again = await asAdmin("POST", `/admin/media/${id}/moderate`, { action: "reject", target: "report", reason: "no" });
    assert.equal(again.status, 409, again.raw);
    assert.equal(rowOf(seed, id).status, "resolved");
  });
});

// ── 6. Counts: measured, never `?? 0` ──────────────────────────────────────

describe("the report queues' totals are measured, never `count ?? 0`", () => {
  const countless = (calls: Array<[string, unknown[]]>) => (calls.some(([m]) => m === "range") ? { data: [], error: null, count: null } : null);

  it("RED before: GET /admin/reports refuses a page whose total is unknown", async () => {
    install(world(), { reports: countless });
    await file("post", POST);
    const r = await asAdmin("GET", "/admin/reports");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
    assert.match(r.body.message, /without an exact total/);
  });

  it("RED before: GET /admin/moderation/reports refuses a page whose total is unknown", async () => {
    install(world(), { moderation_reports: countless });
    const r = await asAdmin("GET", "/admin/moderation/reports");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
    assert.match(r.body.message, /without an exact total/);
  });

  it("RED before: a total smaller than the page it came with is not a total", async () => {
    install(world(), { reports: (calls) => (calls.some(([m]) => m === "range") ? { data: [{ id: "x" }, { id: "y" }], error: null, count: 1 } : null) });
    const r = await asAdmin("GET", "/admin/reports");
    assert.equal(r.status, 500, r.raw);
  });

  it("GREEN before (CONTROL): an empty queue is a measured 0", async () => {
    install(world());
    const r = await asAdmin("GET", "/admin/reports");
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body, { reports: [], total: 0, page: 1 });
    const m = await asAdmin("GET", "/admin/moderation/reports");
    assert.equal(m.status, 200, m.raw);
    assert.equal(m.body.total, 0);
  });
});

// ── 7. Every count of a user's open reports reads the unresolved states ────

describe("countOpenReportsAgainst counts unresolved reports — open AND in_review", () => {
  it("RED before: an in_review report against the user still counts; a closed one does not", async () => {
    const seed = world();
    const r = (id: string, status: string) => withReportDefaults({ id, reporter_id: REPORTER, target_type: "user", target_id: OWNER, reason_code: "spam", status });
    seed.reports = [r("d1", "open"), r("d2", "in_review"), r("d3", "resolved"), r("d4", "dismissed")];
    const strict = makeSchemaStrictClient(seed);
    const counted = await countOpenReportsAgainst(strict, OWNER);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(counted, { ok: true, count: 2 });
  });
});

describe("Telegraph's send tier counts unresolved reports against the sender — open AND in_review", () => {
  it("RED before: two unresolved reports (one in_review) drop the sender to the strictest tier", async () => {
    _clearSendTierCache();
    const seed = world();
    const r = (id: string, status: string) => withReportDefaults({ id, reporter_id: REPORTER, target_type: "user", target_id: OWNER, reason_code: "spam", status });
    seed.profiles = [{ ...profile(OWNER, "owner"), created_at: "2026-01-01T00:00:00.000Z", verification_level: "none", trust_score: 50 }];
    seed.message_thread_members = [];
    seed.reports = [r("e1", "open"), r("e2", "in_review"), r("e3", "dismissed")];
    const strict = makeSchemaStrictClient(seed);
    const tier = await resolveSendTier(strict as any, OWNER, Date.parse("2026-10-18T00:00:00.000Z"));
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.equal(tier.inputs.degraded, false);
    assert.equal(tier.inputs.openReportsAgainst, 2, "the in_review report is still an unresolved accusation");
    assert.equal(tier.tier, "stranger");
    assert.deepEqual(tier.reasons, ["open_reports_against_sender"]);
    _clearSendTierCache();
  });
});

// ── 8. One vocabulary — the module, every server statement, the admin client ─

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "test" && name !== "node_modules") out.push(...tsFiles(p)); }
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Each `.from("reports")` statement: from the call to the first `;` or the next `.from(` (a Promise.all list holds several). LIMITS — only literal words in TS statements under api-server/src (test/ excluded) are scanned: a status held in a variable (adminMedia's `newStatus` ternary; the adminMedia flag case above pins that one), SQL (no function or trigger writes `reports` today), the client (the CONTROL below) and a statement that spans another `.from(` are not. */
function reportStatements(src: string): string[] {
  const out: string[] = [];
  const re = /\.from\((["'`])reports\1\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let end = src.indexOf(";", m.index);
    const next = src.indexOf(".from(", m.index + 6);
    if (next !== -1 && (end === -1 || next < end)) end = next;
    out.push(src.slice(m.index, end === -1 ? undefined : end));
  }
  return out;
}

describe("one vocabulary for public.reports.status", () => {
  it("RED before: lib/moderationCounts.ts declares it, and UNRESOLVED is open + in_review", async () => {
    const mod: any = await import("../lib/moderationCounts.js");
    assert.deepEqual(mod.LEGACY_REPORT_STATUSES, VOCABULARY);
    assert.deepEqual(mod.UNRESOLVED_REPORT_STATUSES, UNRESOLVED);
  });

  it("RED before: no server statement on `reports` writes or filters a status outside it, or filters one literal status", () => {
    const outside: string[] = [];
    const literalFilters: string[] = [];
    let statements = 0;
    for (const file of tsFiles(SRC)) {
      const src = readFileSync(file, "utf8");
      for (const stmt of reportStatements(src)) {
        statements += 1;
        const where = relative(SRC, file);
        for (const w of stmt.matchAll(/\bstatus\s*:\s*["'`]([a-z_]+)["'`]/g)) if (!VOCABULARY.includes(w[1]!)) outside.push(`${where}: writes '${w[1]}'`);
        for (const f of stmt.matchAll(/\.(eq|neq)\(\s*["'`]status["'`]\s*,\s*["'`]([a-z_]+)["'`]/g)) literalFilters.push(`${where}: .${f[1]}("status", "${f[2]}")`);
        for (const l of stmt.matchAll(/\.in\(\s*["'`]status["'`]\s*,\s*\[([^\]]*)\]/g)) {
          for (const w of l[1]!.matchAll(/["'`]([a-z_]+)["'`]/g)) if (!VOCABULARY.includes(w[1]!)) outside.push(`${where}: filters '${w[1]}'`);
        }
      }
    }
    assert.ok(statements >= 30, `the scan found the reports statements (${statements}) — it is not vacuous`);
    assert.deepEqual(outside, [], "a status word no reader shares strands the report");
    assert.deepEqual(literalFilters, [], "a reader that means 'unresolved' reads UNRESOLVED_REPORT_STATUSES; a single literal is how 'pending' happened");
  });

  it("GREEN before (CONTROL): the admin client lists exactly the vocabulary and acts on exactly the unresolved states", () => {
    const service = readFileSync(join(REPO, "travel-buddy-standalone/src/services/reportsAdmin.ts"), "utf8");
    const screen = readFileSync(join(REPO, "travel-buddy-standalone/app/admin/content-reports.tsx"), "utf8");
    const words = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const all = service.match(/const ALL_STATUSES = \[([^\]]*)\]/);
    const actionable = screen.match(/const ACTIONABLE_STATUSES = new Set\(\[([^\]]*)\]\)/);
    assert.ok(all && actionable, "both client lists were found");
    assert.deepEqual(words(all![1]!), VOCABULARY);
    assert.deepEqual(words(actionable![1]!), UNRESOLVED);
  });
});
