/**
 * ACCOUNT STATUS — an unwritten restriction must never be reported as an
 * applied one, and an unread restriction must never be reported as an absent
 * one.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. It does not reject. So
 *
 *     await sc.from("profiles").update({ account_status: "deactivated" })
 *       .eq("id", user.id)
 *       .then(undefined, () => {});
 *
 * observes NOTHING when the write fails: the second argument to `.then` is a
 * REJECTION handler, and the failure arrives RESOLVED as `{ data: null, error }`
 * with no branch reading it and no log recording it. Four sites in
 * routes/profile.ts had that shape on the account-status path, and
 * `profiles.account_status` is the field every downstream restriction consults
 * — the ban gate in lib/http.ts, the public map (lib/mapTravelers.ts), Circle
 * location serving (lib/circleLocationsRead.ts gate 7), lib/mediaAccess.ts and
 * lib/profileVisibility.ts.
 *
 * The four outcomes this file pins, each of which shipped:
 *
 *   1. POST /me/deactivate answered `200 { deactivated: true }` while the
 *      account stayed ACTIVE and fully visible everywhere.
 *   2. POST /me/delete-request answered `200 { deletionScheduled: true }` while
 *      the account stayed ACTIVE for the whole 30-day hold it claimed to hide
 *      the user for.
 *   3. POST /me/reactivate answered `200 { reactivated: true }` while the
 *      pending `user_deletion_requests` row survived — so
 *      lib/accountDeletionScheduler.ts DESTROYED the account on its original
 *      schedule, after the user had cancelled and been told it was cancelled.
 *   4. GET /me/account-status answered plain "deactivated" when
 *      `user_deletion_requests` could not be read, hiding the irreversible
 *      countdown (and the cancel affordance) from the person it belongs to.
 *
 * ── WHY EVERY FAILURE CASE IS PAIRED ────────────────────────────────────────
 * A test where the account genuinely has no restriction and a test where the
 * restriction table cannot be read PASS FOR THE SAME REASON. So every failure
 * case below sits next to a HEALTHY case with the row present and readable: a
 * "fix" that refused every request would satisfy all the failure assertions and
 * would have broken deactivation outright. Both halves are asserted on the
 * exact status CODE, never on `!== 200` — a request that died at validation
 * would satisfy that and prove nothing about the gate.
 *
 * The double is src/test/helpers/failClosedSupabase.ts, which is contract-
 * checked against the real supabase-js client every CI run. Its injected
 * failures RESOLVE, exactly as production's do; a fake that THREW would take a
 * code path production never takes (a try/catch around a supabase call is dead
 * code) and the test would pass for the wrong reason.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/accountStatusFailOpenWrites.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import profileRouter from "../routes/profile.js";

const ME = "aa000000-0000-4000-a000-0000000000t1".replace("t1", "11");
const TOK = "tok-me";
const SCHEDULED = "2026-10-08T00:00:00.000Z";

const WRITE_ERROR = { message: "could not serialize access due to concurrent update", code: "40001" };
const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

/**
 * Build the client and install it as BOTH the auth client and the service
 * client. The spec object is mutated IN PLACE (`spec.users = …`) rather than
 * spread into a copy: makeFailClosedClient records issued writes back onto the
 * spec it was handed, so a copy would leave `spec.updated` permanently empty
 * and every "was this write issued?" assertion would read 0 for a reason that
 * has nothing to do with the code under test.
 */
function install(spec: FakeClientSpec) {
  spec.users = { [TOK]: ME };
  const client = makeFailClosedClient(spec);
  _setTestClient(client, true);
  _setTestServiceClient(client);
  return client;
}

function baseRows(accountStatus: string, extra: Record<string, any[]> = {}) {
  return {
    // requireUser reads profiles.account_status on every authenticated request;
    // it must be READABLE or the ban gate refuses before the route is entered.
    profiles: [{ id: ME, account_status: accountStatus, is_private: false }],
    user_deletion_requests: [] as any[],
    user_account_states: [] as any[],
    profile_privacy_settings: [] as any[],
    user_privacy_settings: [] as any[],
    circle_context_settings: [] as any[],
    circle_presence: [] as any[],
    ...extra,
  };
}

// ── Server ───────────────────────────────────────────────────────────────────

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  // The req.log shim. Without it every one of these routes CRASHES on its
  // first `req.log.error(...)` and a 500-from-crash masquerades as fail-closed.
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", profileRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    // The address argument makes bind DEFERRED, so the listening callback is
    // the only correct place to resolve — and it must be a real callback, not
    // a bare `resolve` reference passed through.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

async function call(
  method: string,
  path: string,
  opts: { tok?: string | null } = {},
): Promise<{ status: number; body: any }> {
  const { tok = TOK } = opts;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (tok) headers.authorization = `Bearer ${tok}`;
  const res = await fetch(`${base}${path}`, { method, headers });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}

describe("account status: an unwritten restriction is not an applied one", () => {
  // ── POST /me/deactivate ────────────────────────────────────────────────────

  it("HEALTHY: deactivate writes profiles.account_status and reports success", async () => {
    const spec: FakeClientSpec = { rows: baseRows("active") };
    install(spec);

    const res = await call("POST", "/me/deactivate");
    assert.equal(res.status, 200, "a healthy deactivation must still succeed");
    assert.equal(res.body.deactivated, true);

    // The AUTHORITATIVE write was actually issued with the right value.
    const profileWrites = spec.updated?.["profiles"] ?? [];
    assert.equal(profileWrites.length, 1, "expected exactly one profiles write");
    assert.equal(profileWrites[0].account_status, "deactivated");
  });

  it("FAILS CLOSED: deactivate does not report success when the account_status write fails", async () => {
    const spec: FakeClientSpec = {
      rows: baseRows("active"),
      // Only the authoritative write fails. Reads of `profiles` still succeed,
      // so requireUser's ban gate admits the request and the 500 below cannot
      // be the ban gate answering instead of the route.
      failWritesOn: (t) => (t === "profiles" ? WRITE_ERROR : null),
    };
    install(spec);

    const res = await call("POST", "/me/deactivate");
    assert.equal(res.status, 500, "an unwritten deactivation must not answer 200");
    assert.equal(res.body.error, "db_error");
    assert.notEqual(res.body.deactivated, true, "must never claim the account was deactivated");
  });

  // ── POST /me/delete-request ────────────────────────────────────────────────

  it("HEALTHY: delete-request schedules and hides the account", async () => {
    const spec: FakeClientSpec = { rows: baseRows("active") };
    install(spec);

    const res = await call("POST", "/me/delete-request");
    assert.equal(res.status, 200);
    assert.equal(res.body.deletionScheduled, true);
    assert.equal(typeof res.body.scheduledAt, "string");

    const profileWrites = spec.updated?.["profiles"] ?? [];
    assert.equal(profileWrites.length, 1);
    assert.equal(profileWrites[0].account_status, "deactivated");
  });

  it("FAILS CLOSED: delete-request does not claim the account is hidden when the write fails", async () => {
    const spec: FakeClientSpec = {
      rows: baseRows("active"),
      failWritesOn: (t) => (t === "profiles" ? WRITE_ERROR : null),
    };
    install(spec);

    const res = await call("POST", "/me/delete-request");
    assert.equal(res.status, 500, "a 30-day hold that hides nothing must not answer 200");
    assert.equal(res.body.error, "db_error");
    assert.notEqual(res.body.deletionScheduled, true);
  });

  // ── POST /me/reactivate ────────────────────────────────────────────────────

  it("HEALTHY: reactivate cancels the pending deletion and reports success", async () => {
    const spec: FakeClientSpec = {
      rows: baseRows("deactivated", {
        user_deletion_requests: [{ user_id: ME, status: "pending", scheduled_at: SCHEDULED }],
      }),
    };
    install(spec);

    const res = await call("POST", "/me/reactivate");
    assert.equal(res.status, 200, "a healthy reactivation must still succeed");
    assert.equal(res.body.reactivated, true);

    const cancels = spec.updated?.["user_deletion_requests"] ?? [];
    assert.equal(cancels.length, 1, "the cancellation write must be ISSUED, not merely constructed");
    assert.equal(cancels[0].status, "cancelled");
  });

  it("FAILS CLOSED: reactivate does not report success when the deletion cancel fails", async () => {
    const spec: FakeClientSpec = {
      rows: baseRows("deactivated", {
        user_deletion_requests: [{ user_id: ME, status: "pending", scheduled_at: SCHEDULED }],
      }),
      // The profiles write (account_status -> active) succeeds; only the
      // cancellation of the standing DESTROY instruction fails. That is the
      // exact combination that used to answer 200 and then delete the account.
      failWritesOn: (t) => (t === "user_deletion_requests" ? WRITE_ERROR : null),
    };
    install(spec);

    const res = await call("POST", "/me/reactivate");
    assert.equal(
      res.status,
      500,
      "an uncancelled scheduled deletion must not be reported as a completed reactivation",
    );
    assert.equal(res.body.error, "db_error");
    assert.notEqual(res.body.reactivated, true);
  });

  // ── GET /me/account-status ────────────────────────────────────────────────

  it("HEALTHY: account-status surfaces pending_deletion when the row is readable", async () => {
    install({
      rows: baseRows("deactivated", {
        user_deletion_requests: [{ user_id: ME, status: "pending", scheduled_at: SCHEDULED }],
      }),
    });

    const res = await call("GET", "/me/account-status");
    assert.equal(res.status, 200);
    assert.equal(res.body.accountStatus, "pending_deletion");
    assert.equal(res.body.deletionScheduledAt, SCHEDULED);
  });

  it("HEALTHY: account-status says deactivated when there is genuinely no pending deletion", async () => {
    install({ rows: baseRows("deactivated") });

    const res = await call("GET", "/me/account-status");
    assert.equal(res.status, 200);
    assert.equal(res.body.accountStatus, "deactivated");
    assert.equal(res.body.deletionScheduledAt, null);
  });

  it("FAILS CLOSED: an unreadable user_deletion_requests is not reported as 'no pending deletion'", async () => {
    install({
      rows: baseRows("deactivated", {
        user_deletion_requests: [{ user_id: ME, status: "pending", scheduled_at: SCHEDULED }],
      }),
      // `profiles` reads stay healthy so requireUser and the handler's own
      // account_status read both succeed — the ONLY unreadable input is the
      // deletion schedule.
      failOn: (ctx) => (ctx.table === "user_deletion_requests" ? READ_ERROR : null),
    });

    const res = await call("GET", "/me/account-status");
    assert.equal(res.status, 500, "an unread countdown must not be answered as an absent one");
    assert.equal(res.body.error, "db_error");
    assert.notEqual(
      res.body.accountStatus,
      "deactivated",
      "reporting plain 'deactivated' hides an irreversible scheduled deletion from its subject",
    );
  });
});
