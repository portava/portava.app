/**
 * SAFETY SURFACE — a failed read or a failed write must never render as safe.
 *
 * Every case here drives a REAL router over HTTP with a supabase fake whose
 * reads resolve `{ data: null, error }` — the shape supabase-js actually
 * produces, which is why `const { data } = await …` turned each of these into
 * a confident, reassuring answer:
 *
 *   sessions/active        → `{ session: null }`   "no Safe Return is running"
 *   trusted-contacts       → `{ contacts: [] }`    "you have nobody to alert"
 *   cancel                 → 404 "already closed"  for a session still counting
 *   trigger-missed         → `{ ok: true }`        with nobody alerted
 *   POST /block            → `{ blocked: true }`   with the follow edge intact
 *   geofence override      → `{ ok: true }`        with the status unchanged
 *   geofence attendance    → everyone "Not checked in"
 *   feature_flags blip     → 404 "not yet enabled" for a feature that IS on
 *
 * THREE VACUITY TRAPS ARE AVOIDED DELIBERATELY:
 *
 *  1. No `assert.notEqual(status, 200)`. A request rejected at validation, or a
 *     500 from a crash, satisfies that without the code under test running.
 *     Every case asserts the EXACT status and the exact `error` code or body
 *     field.
 *  2. The `req.log` shim the real server installs is present. Without it these
 *     handlers throw a TypeError on their first `req.log.error(...)` and the
 *     resulting 500-from-crash would masquerade as a deliberate refusal.
 *  3. Failures are scoped by `ctx.filters`, never by whole table. `requireUser`
 *     reads `profiles` for account_status on EVERY request, so failing that
 *     table wholesale would 503 the request before any handler ran — a green
 *     test proving nothing about the handler.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/safetySurfaceFailClosed.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, noopLog, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import safeReturnRouter from "../routes/safeReturn.js";
import blocksRouter from "../routes/blocks.js";
import geofenceRouter from "../routes/geofence.js";
import moderationRouter from "../routes/moderation.js";

const USER    = "aaaaaaaa-1111-4000-a000-000000000001";
const TARGET  = "bbbbbbbb-2222-4000-a000-000000000002";
const MEMBER  = "cccccccc-3333-4000-a000-000000000003";
const SESSION = "dddddddd-4444-4000-a000-000000000004";
const TRIP    = "eeeeeeee-5555-4000-a000-000000000005";
const GEOFENCE= "ffffffff-6666-4000-a000-000000000006";
const CONTACT = "aaaaaaaa-7777-4000-a000-000000000007";
const TOKEN   = "tok-user";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

/**
 * A `req.log` shim that RECORDS instead of discarding.
 *
 * Two cases below assert an OPERATOR-VISIBLE signal rather than a response
 * field, because for them the response is deliberately unchanged: the
 * moderation-report path is fail-OPEN on purpose and must keep filing the
 * report. "Visible to an operator" is then the whole remedy, and a test that
 * only checked the 201 would pass just as well with the signal deleted.
 */
const logged: Array<{ level: string; obj: any; msg: string }> = [];
function recordingLog(): any {
  const mk = (level: string) => (obj: any, msg?: string) =>
    logged.push({ level, obj: typeof obj === "object" ? obj : {}, msg: String(msg ?? obj ?? "") });
  const l: any = { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") };
  l.child = () => l;
  return l;
}

// ── Server ───────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // The shim the real server installs (see trap 2 above).
  app.use((req, _res, next) => { (req as any).log = recordingLog(); void noopLog; next(); });
  app.use("/api", safeReturnRouter);
  app.use("/api", blocksRouter);
  app.use("/api", geofenceRouter);
  app.use("/api", moderationRouter);
  server = http.createServer(app);
  // 127.0.0.1 explicitly, and awaited through the CALLBACK: a host-less
  // listen(0) binds the IPv6 wildcard and the kernel may hand back a port a
  // foreign process already holds on loopback. The address also makes the bind
  // deferred, so address() is only readable inside the callback.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/** Rows every request needs: a valid token, an un-banned profile, flags ON. */
function baseRows(): Record<string, any[]> {
  return {
    profiles: [
      { id: USER,   account_status: "active", handle: "me",     name: "Me",     display_name: "Me",     avatar_url: null },
      { id: TARGET, account_status: "active", handle: "them",   name: "Them",   display_name: "Them",   avatar_url: null },
      { id: MEMBER, account_status: "active", handle: "member", name: "Member", display_name: "Member", avatar_url: null },
    ],
    feature_flags: [
      { flag: "safe_return_enabled", enabled: true },
      { flag: "safe_return_live_share_enabled", enabled: true },
      { flag: "safe_return_trusted_circle_alerts_enabled", enabled: true },
      { flag: "plan_geofence_enabled", enabled: true },
    ],
  };
}

function install(spec: FakeClientSpec) {
  const c = makeFailClosedClient({ users: { [TOKEN]: USER }, ...spec });
  _setTestClient(c, true);
  _setTestServiceClient(c);
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return — "you have no Safe Return running"
// ═══════════════════════════════════════════════════════════════════════════

describe("safe-return: an unreadable session table must not report 'nothing is running'", () => {
  it("GET /me/safe-return/sessions/active answers 503 degraded_unavailable, not { session: null }", async () => {
    install({
      rows: baseRows(),
      failOn: (ctx) => (ctx.table === "safe_return_sessions" ? READ_FAIL : null),
    });

    const res = await req("GET", "/api/me/safe-return/sessions/active");

    assert.equal(res.status, 503, "an unreadable safe_return_sessions must not answer 200");
    assert.equal(res.body.error, "degraded_unavailable");
    assert.equal(res.body.retryable, true, "the client must be told to retry, not that nothing is running");
    assert.equal(
      Object.prototype.hasOwnProperty.call(res.body, "session"), false,
      "the response must not carry a `session` field at all — `session: null` IS the defect",
    );
  });

  it("a genuinely empty table still answers 200 { session: null } — empty is a real answer", async () => {
    install({ rows: baseRows() });

    const res = await req("GET", "/api/me/safe-return/sessions/active");

    assert.equal(res.status, 200);
    assert.equal(res.body.session, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return — the trusted-contact picker
// ═══════════════════════════════════════════════════════════════════════════

describe("safe-return: an unreadable follow graph must not report an empty trusted circle", () => {
  it("GET /me/safe-return/trusted-contacts answers 503, not { contacts: [] }", async () => {
    install({
      rows: baseRows(),
      failOn: (ctx) => (ctx.table === "user_follows" ? READ_FAIL : null),
    });

    const res = await req("GET", "/api/me/safe-return/trusted-contacts");

    assert.equal(res.status, 503, "the screen where you choose who to alert must not render 'nobody' from a failed read");
    assert.equal(res.body.error, "degraded_unavailable");
    assert.equal(Object.prototype.hasOwnProperty.call(res.body, "contacts"), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return — a cancel that failed must not display as cancelled
// ═══════════════════════════════════════════════════════════════════════════

describe("safe-return: a cancel whose write failed must not answer 'already closed'", () => {
  it("POST /sessions/:id/cancel answers 503 and says the session may still be running", async () => {
    install({
      rows: baseRows(),
      // The UPDATE ... .select("*").single() goes through the write path, so the
      // failure is injected on writes to this table only.
      failWritesOn: (table) => (table === "safe_return_sessions" ? READ_FAIL : null),
    });

    const res = await req("POST", `/api/me/safe-return/sessions/${SESSION}/cancel`);

    assert.equal(res.status, 503, "404 'already closed' would tell someone their timer is off when it is not");
    assert.equal(res.body.error, "degraded_unavailable");
    assert.match(String(res.body.message), /still be running/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return — the missed check-in escalation
// ═══════════════════════════════════════════════════════════════════════════

describe("safe-return: escalation must report who was NOT alerted", () => {
  function escalationRows() {
    const rows = baseRows();
    rows.safe_return_sessions = [{
      id: SESSION, user_id: USER, status: "active",
      escalation_level: 1, trusted_circle_enabled: true, live_share_enabled: false,
      notify_host_enabled: false, notify_trip_crew_enabled: false,
      timer_end_at: new Date(Date.now() - 60_000).toISOString(),
      timer_start_at: null, last_prompt_at: null, last_safe_confirmation_at: null,
      plan_item_id: null, trip_id: null, trigger_reason: null, emergency_note: null,
      closed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }];
    rows.safe_return_contacts = [{
      id: CONTACT, session_id: SESSION, contact_user_id: TARGET, contact_name: "Them",
      contact_phone: null, contact_email: null, contact_method: "in_app",
      can_receive_live_location: false, notified_at: null, acknowledged_at: null,
    }];
    return rows;
  }

  it("an unreadable safe_return_contacts yields alertsIncomplete: true, not a clean { ok: true }", async () => {
    install({
      rows: escalationRows(),
      // Scoped to the CONTACTS table only. Failing safe_return_sessions too
      // would abort at markMissed and never reach the escalation under test.
      failOn: (ctx) => (ctx.table === "safe_return_contacts" ? READ_FAIL : null),
    });

    const res = await req("POST", `/api/me/safe-return/sessions/${SESSION}/trigger-missed`);

    assert.equal(res.status, 200, "the escalation is not abandoned — reaching some people beats reaching none");
    assert.equal(res.body.ok, true);
    assert.equal(
      res.body.alertsIncomplete, true,
      "an unreadable contacts table must not be reported as a completed escalation",
    );
    assert.equal(res.body.alerts.trustedCircle.incomplete, true);
    assert.match(String(res.body.message), /could not confirm that everyone was alerted/i);
  });

  it("a readable, genuinely empty circle is NOT reported as incomplete", async () => {
    const rows = escalationRows();
    rows.safe_return_contacts = [];
    install({ rows });

    const res = await req("POST", `/api/me/safe-return/sessions/${SESSION}/trigger-missed`);

    assert.equal(res.status, 200);
    assert.equal(res.body.alerts.trustedCircle.incomplete, false);
    assert.equal(res.body.alerts.trustedCircle.attempted, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return — an unreadable feature flag is not a disabled feature
// ═══════════════════════════════════════════════════════════════════════════

describe("safe-return: an unreadable flag must not answer 'not yet enabled'", () => {
  it("POST /me/safe-return/sessions answers 503, not 404 feature_disabled", async () => {
    install({
      rows: baseRows(),
      failOn: (ctx) => (ctx.table === "feature_flags" ? READ_FAIL : null),
    });

    const res = await req("POST", "/api/me/safe-return/sessions", { escalationLevel: 0, timerMinutes: 30 });

    assert.equal(res.status, 503, "telling someone walking home that Safe Return does not exist is not a graceful degradation");
    assert.equal(res.body.error, "degraded_unavailable");
    assert.notEqual(res.body.error, "feature_disabled");
  });

  it("a flag row that is genuinely absent still answers 404 feature_disabled", async () => {
    const rows = baseRows();
    rows.feature_flags = [];
    install({ rows });

    const res = await req("POST", "/api/me/safe-return/sessions", { escalationLevel: 0, timerMinutes: 30 });

    assert.equal(res.status, 404);
    assert.equal(res.body.error, "feature_disabled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Blocks — "blocked" must not stand for cleanup that did not happen
// ═══════════════════════════════════════════════════════════════════════════

describe("blocks: a block whose social-edge cleanup failed must say so", () => {
  it("POST /users/:id/block reports cleanup.complete === false and names the residual edges", async () => {
    const rows = baseRows();
    rows.blocks = [];
    rows.user_follows = [{ follower_id: TARGET, following_id: USER }];
    install({
      rows,
      // Only the follow-edge deletes fail. `blocks` must still be writable, or
      // the handler refuses earlier and this proves nothing about cleanup.
      failWritesOn: (table) => (table === "user_follows" ? READ_FAIL : null),
    });

    const res = await req("POST", `/api/users/${TARGET}/block`);

    assert.equal(res.status, 200, "the block row is written; refusing the whole block would undo the part that worked");
    assert.equal(res.body.blocked, true);
    assert.equal(res.body.cleanup.complete, false, "a cleanup that failed must not be reported as complete");
    assert.deepEqual(
      [...res.body.cleanup.residual].sort(),
      ["follow_in", "follow_out"],
      "the response must name which edges may still be live",
    );
  });

  it("a clean block reports cleanup.complete === true", async () => {
    const rows = baseRows();
    rows.blocks = [];
    install({ rows });

    const res = await req("POST", `/api/users/${TARGET}/block`);

    assert.equal(res.status, 200);
    assert.equal(res.body.blocked, true);
    assert.equal(res.body.cleanup.complete, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Geofence — attendance and the host override
// ═══════════════════════════════════════════════════════════════════════════

describe("geofence: attendance must not render an unreadable table as 'nobody arrived'", () => {
  function attendanceRows() {
    const rows = baseRows();
    rows.trips = [{ id: TRIP, owner_id: USER }];
    rows.plan_geofences = [{ id: GEOFENCE, trip_id: TRIP, check_in_radius_m: 150, check_in_window_start: null, check_in_window_end: null }];
    rows.trip_members = [{ trip_id: TRIP, user_id: MEMBER, role: "member", status: "accepted" }];
    rows.plan_checkins = [{ geofence_id: GEOFENCE, trip_id: TRIP, user_id: MEMBER, status: "arrived", checked_in_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
    return rows;
  }

  it("GET /trips/:id/geofence/attendance answers 503 when plan_checkins is unreadable", async () => {
    install({
      rows: attendanceRows(),
      failOn: (ctx) => (ctx.table === "plan_checkins" ? READ_FAIL : null),
    });

    const res = await req("GET", `/api/trips/${TRIP}/geofence/attendance`);

    assert.equal(res.status, 503, "showing the whole group as 'Not checked in' is the reassuring-unknown this exists to stop");
    assert.equal(res.body.error, "degraded_unavailable");
  });

  it("a readable attendance page still answers 200 with the real totals", async () => {
    install({ rows: attendanceRows() });

    const res = await req("GET", `/api/trips/${TRIP}/geofence/attendance`);

    assert.equal(res.status, 200);
    assert.equal(res.body.totals.accepted, 1);
    assert.equal(res.body.totals.checkedIn, 1);
  });

  it("POST .../override answers 500 db_error when the plan_checkins write fails — never { ok: true }", async () => {
    install({
      rows: attendanceRows(),
      failWritesOn: (table) => (table === "plan_checkins" ? READ_FAIL : null),
    });

    const res = await req("POST", `/api/trips/${TRIP}/geofence/attendance/${MEMBER}/override`, { status: "no_show" });

    assert.equal(res.status, 500, "a host marking someone no-show must not be told it worked when nothing changed");
    assert.equal(res.body.error, "db_error");
    assert.notEqual(res.body.ok, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Safe Return — the recipient's view of a live share
// ═══════════════════════════════════════════════════════════════════════════

describe("safe-return: an unreadable live share must not be reported as 'not found'", () => {
  it("GET /safe-return/live-share/:id answers 503, not 404", async () => {
    install({
      rows: baseRows(),
      failOn: (ctx) => (ctx.table === "safe_return_live_shares" ? READ_FAIL : null),
    });

    const res = await req("GET", `/api/safe-return/live-share/${SESSION}`);

    assert.equal(
      res.status, 503,
      "'not found' / 'expired' / 'stopped' all tell a worried contact there is nothing left to look at",
    );
    assert.equal(res.body.error, "degraded_unavailable");
  });

  it("a share that genuinely does not exist still answers 404", async () => {
    install({ rows: { ...baseRows(), safe_return_live_shares: [] } });

    const res = await req("GET", `/api/safe-return/live-share/${SESSION}`);

    assert.equal(res.status, 404);
    assert.equal(res.body.error, "not_found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Geofence — a reveal that matched no row is not a reveal
// ═══════════════════════════════════════════════════════════════════════════

describe("geofence: revealing an exact location that matched no row must not answer ok", () => {
  it("POST /trips/:id/geofence/reveal answers 404 when there is no geofence to reveal", async () => {
    const rows = baseRows();
    rows.trips = [{ id: TRIP, owner_id: USER }];
    rows.plan_geofences = [];
    install({ rows });

    const res = await req("POST", `/api/trips/${TRIP}/geofence/reveal`);

    assert.equal(
      res.status, 404,
      "without RETURNING, a zero-row UPDATE answers 204 exactly like a real one — the host was told the address was shared",
    );
    assert.equal(res.body.error, "not_found");
    assert.notEqual(res.body.ok, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Moderation — the DELIBERATE fail-OPEN, preserved, and made visible
// ═══════════════════════════════════════════════════════════════════════════

describe("moderation: a report is still filed when a supporting read fails", () => {
  it("an unreadable owner lookup does NOT block the report, and logs that it is unattributed", async () => {
    // This is the one exception in this repository that must stay fail-OPEN:
    // refusing to record a safety report because a lookup blinked is strictly
    // worse than filing one that a moderator has to attribute by hand. The fix
    // here is the operator signal, not a refusal — so the assertion is on BOTH:
    // the 201 must survive, and the log line must exist.
    logged.length = 0;
    const rows = baseRows();
    rows.moderation_reports = [];
    rows.posts = [{ id: TARGET, author_id: MEMBER }];
    // `inserted` is the fake's record of what actually reached the table, which
    // is the fact this case is about: the report must still be WRITTEN.
    const inserted: Record<string, any[]> = {};
    install({
      rows,
      inserted,
      // Only the owner lookup fails. `moderation_reports` stays writable, or
      // the insert would fail for an unrelated reason and prove nothing.
      failOn: (ctx) => (ctx.table === "posts" ? READ_FAIL : null),
    });

    const res = await req("POST", "/api/moderation/report", {
      subjectType: "post", subjectId: TARGET, category: "safety_concern",
    });

    assert.equal(res.status, 201, "the deliberate fail-OPEN on the reporting path must be preserved");
    assert.equal(
      (inserted.moderation_reports ?? []).length, 1,
      "a report never filed is gone — the row must still reach moderation_reports",
    );
    assert.equal(
      (inserted.moderation_reports ?? [])[0]?.subject_user_id, null,
      "and it lands unattributed, which is exactly why an operator must be told",
    );

    // The assertion used to match /no accountable subject user/ and went RED
    // once routes/moderation.ts split that one message in two. The split is the
    // improvement, not the regression: "the content row is missing" is a fact
    // about the content, and "the lookup could not run" is an operations event,
    // and the old single message could not tell an operator which one had
    // happened. THIS case is the unreadable one, so it must take the unreadable
    // branch — matching the old wording here would now assert the WRONG branch.
    const unattributed = logged.filter(
      (l) => l.level === "error" && /subject-owner lookup COULD NOT RUN/i.test(l.msg),
    );
    assert.equal(
      unattributed.length, 1,
      `the unattributed report must be visible to an operator; logged: ${JSON.stringify(logged.map((l) => l.msg))}`,
    );
    assert.match(
      unattributed[0]!.msg,
      /NOT because the content is unowned/i,
      "and it must say which of the two it was — an operator who reads 'unowned' will close the ticket",
    );
    // The OTHER branch must not have fired. If both messages appear, the two
    // cases are being told apart in the text and not in the code.
    assert.equal(
      logged.filter((l) => /no accountable subject user/i.test(l.msg)).length, 0,
      "a failed lookup must not also be reported as a missing content row",
    );
  });

  it("a MISSING content row takes the other branch, and says so", async () => {
    // The positive control for the split above. Same endpoint, same fail-OPEN,
    // but the owner lookup SUCCEEDS and finds nothing — so the operator must be
    // told the content is unowned rather than that the database blinked.
    logged.length = 0;
    const rows = baseRows();
    rows.moderation_reports = [];
    rows.posts = [];
    const inserted: Record<string, any[]> = {};
    install({ rows, inserted });

    const res = await req("POST", "/api/moderation/report", {
      subjectType: "post", subjectId: TARGET, category: "safety_concern",
    });

    assert.equal(res.status, 201, "the fail-OPEN posture is the same on this branch");
    assert.equal((inserted.moderation_reports ?? []).length, 1, "the report is still written");
    assert.equal(
      logged.filter((l) => l.level === "error" && /no accountable subject user/i.test(l.msg)).length, 1,
      `the missing-row branch must fire here; logged: ${JSON.stringify(logged.map((l) => l.msg))}`,
    );
    assert.equal(
      logged.filter((l) => /COULD NOT RUN/i.test(l.msg)).length, 0,
      "and the unreadable-database message must NOT — nothing was unreadable",
    );
  });
});
