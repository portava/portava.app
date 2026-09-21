/**
 * TV-6c — "monitor attempts per verified user (>2.0 average means UX friction
 * worth fixing)", `docs/trust/verified-foundation-plan.md` phase V-6.
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * The CONTROL existed (rate limiting, V-1: 3 sessions per 24 h) and the
 * MEASUREMENT did not. No metric, counter, report or query read
 * `identity_verifications` to answer the question, so the 2.0 threshold could
 * not be compared against anything — by a lane, or by the person paying
 * ~$1.50–3.00 per attempt at the vendor.
 *
 * ── THE TWO NON-ANSWERS, WHICH ARE THE POINT OF THIS FILE ───────────────────
 * A monitoring figure fails in a specific direction: it reports health. Both of
 * the ways this one can decline to answer are asserted to be distinguishable
 * from "0.0, no friction":
 *
 *   1. UNREADABLE TABLE — must throw. supabase-js RESOLVES on a database
 *      error, so an unbound `error` yields `data: null` -> zero rows -> zero
 *      attempts -> a healthy flow, silently, for as long as the fault lasts.
 *   2. NO VERIFIED USERS — must be its own state with `average: null` and
 *      `exceedsThreshold: null`, not `0.0` / `false`. Production holds no
 *      verification rows today, so this is the state the endpoint is in on the
 *      day it is first read; answering "0.0 — healthy" then would be a false
 *      negative on its first and most consequential reading.
 *
 * ── WHAT WOULD TURN THIS RED ───────────────────────────────────────────────
 * Removing the `if (error) throw` from `scanRows` (test: "REFUSES"). Returning
 * `average: 0` or `exceedsThreshold: false` for an empty denominator (test:
 * "no verified users"). Widening the denominator to all users rather than
 * verified ones — the arithmetic case pins 5 attempts across 2 verified users
 * while a third, never-verified user contributes 3 more rows that must NOT
 * reach either half of the ratio. Dropping the `>` to `>=` at the threshold
 * (test: "exactly 2.0 is not over"). Un-mounting the route (route test 404s).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/verificationAttemptMetrics.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import {
  computeAttemptsPerVerifiedUser,
  ATTEMPT_FRICTION_THRESHOLD,
} from "../services/identityVerification/attemptMetrics.js";

const U1 = "f1000000-0000-4000-a000-000000000001";
const U2 = "f1000000-0000-4000-a000-000000000002";
const U3 = "f1000000-0000-4000-a000-000000000003";

const ADMIN = "f1000000-0000-4000-a000-0000000000ad";
const ADMIN_TOK = "tok-admin-attempts";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

function row(id: string, user: string, status: string) {
  return { id, user_id: user, status, created_at: "2026-09-01T00:00:00.000Z" };
}

/**
 * U1 verified on the 3rd try, U2 verified on the 2nd, U3 never verified.
 * Verified users: 2. Their attempts: 3 + 2 = 5. Average: 2.5 — over threshold.
 * U3's 3 rows are the trap: they belong in neither half of the ratio.
 */
function frictionSpec(): FakeClientSpec {
  return {
    rows: {
      identity_verifications: [
        row("a1", U1, "failed"),
        row("a2", U1, "failed"),
        row("a3", U1, "verified"),
        row("b1", U2, "expired"),
        row("b2", U2, "verified"),
        row("c1", U3, "failed"),
        row("c2", U3, "failed"),
        row("c3", U3, "created"),
      ],
    },
  };
}

function client(spec: FakeClientSpec) {
  return makeFailClosedClient(spec) as any;
}

describe("TV-6c: attempts per verified user", () => {
  it("THE THRESHOLD IS THE PLAN'S, not a re-typed copy", () => {
    assert.equal(
      ATTEMPT_FRICTION_THRESHOLD,
      2.0,
      "verified-foundation-plan V-6: '>2.0 average means UX friction worth fixing'",
    );
  });

  it("counts attempts of VERIFIED users only — a never-verified user is in neither half", async () => {
    const m = await computeAttemptsPerVerifiedUser(client(frictionSpec()));

    assert.equal(m.state, "measured");
    assert.equal(m.verifiedUsers, 2, "U1 and U2 verified; U3 never did");
    assert.equal(
      m.attemptsByVerifiedUsers,
      5,
      "U1's three rows plus U2's two — U3's three must not be counted, or the ratio " +
        "measures abandonment rather than friction",
    );
    assert.equal(m.totalRows, 8, "all eight rows were scanned; three are context, not numerator");
    assert.equal(m.average, 2.5);
    assert.equal(m.exceedsThreshold, true, "2.5 > 2.0 is the alarm the plan asks for");
  });

  it("exactly 2.0 is NOT over the threshold — the plan says `>2.0`", async () => {
    const m = await computeAttemptsPerVerifiedUser(
      client({
        rows: {
          identity_verifications: [
            row("a1", U1, "failed"),
            row("a2", U1, "verified"),
            row("b1", U2, "failed"),
            row("b2", U2, "verified"),
          ],
        },
      }),
    );

    assert.equal(m.average, 2.0);
    assert.equal(m.exceedsThreshold, false, "`>` not `>=` — 2.0 is the boundary, not a breach");
  });

  it("a healthy flow reads below the threshold", async () => {
    const m = await computeAttemptsPerVerifiedUser(
      client({
        rows: {
          identity_verifications: [row("a1", U1, "verified"), row("b1", U2, "verified")],
        },
      }),
    );

    assert.equal(m.average, 1.0, "everyone verified first time — the floor");
    assert.equal(m.exceedsThreshold, false);
  });

  it("NO VERIFIED USERS is its own state — NOT 0.0, NOT `false`", async () => {
    // The state production is in today: the table holds no verification rows.
    const m = await computeAttemptsPerVerifiedUser(client({ rows: { identity_verifications: [] } }));

    assert.equal(m.state, "no_verified_users");
    assert.equal(m.average, null, "there is no ratio when the denominator is zero");
    assert.equal(
      m.exceedsThreshold,
      null,
      "`false` here would render as 'measured, and healthy' — a false negative on the " +
        "endpoint's first reading",
    );
    assert.equal(m.verifiedUsers, 0);
  });

  it("REFUSES to report a figure from a table it could not read", async () => {
    const spec: FakeClientSpec = {
      rows: { identity_verifications: [] },
      failOn: (ctx) => (ctx.table === "identity_verifications" ? READ_ERROR : null),
    };

    await assert.rejects(
      () => computeAttemptsPerVerifiedUser(client(spec)),
      /REFUSING to report an attempts-per-verified-user figure/,
      "an unreadable table must not resolve as zero attempts — that renders as a healthy flow",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The reachable caller. A measurement nothing can read is the defect TV-7a was
// (`requestProviderDeletion`: declared, stubbed, mapped, called from nowhere),
// so the module is asserted to be reachable by an admin over HTTP.
// ─────────────────────────────────────────────────────────────────────────────

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  const { default: adminRouter } = await import("../routes/admin.js");
  app.use("/api", adminRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

function installAdmin(spec: FakeClientSpec, isAdmin = true) {
  spec.users = { [ADMIN_TOK]: ADMIN };
  spec.rows = spec.rows ?? {};
  // `requireAdmin` matches on profiles.role — the consolidated guard's contract.
  // The non-admin case is a real signed-in user with an ordinary role, not an
  // absent profile, so the 403 is an authorisation refusal rather than a
  // fail-closed miss that would pass this assertion for the wrong reason.
  spec.rows["profiles"] = [
    { id: ADMIN, account_status: "active", role: isAdmin ? "admin" : "member", display_name: "Admin" },
  ];
  const c = makeFailClosedClient(spec);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

async function get(path: string, token: string | null) {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}

describe("GET /admin/verification/attempt-metrics", () => {
  it("an admin reads the measured ratio", async () => {
    installAdmin(frictionSpec());

    const res = await get("/admin/verification/attempt-metrics", ADMIN_TOK);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.state, "measured");
    assert.equal(res.body.average, 2.5);
    assert.equal(res.body.threshold, 2.0);
    assert.equal(res.body.exceedsThreshold, true);
  });

  it("is admin-only", async () => {
    installAdmin(frictionSpec(), false);

    const res = await get("/admin/verification/attempt-metrics", ADMIN_TOK);
    assert.ok(
      res.status === 403 || res.status === 401,
      `a non-admin must not read platform-wide verification metrics — got ${res.status}`,
    );
  });

  it("answers 503, NOT a zero figure, when identity_verifications cannot be read", async () => {
    const spec: FakeClientSpec = {
      rows: { identity_verifications: [] },
      failOn: (ctx) => (ctx.table === "identity_verifications" ? READ_ERROR : null),
    };
    installAdmin(spec);

    const res = await get("/admin/verification/attempt-metrics", ADMIN_TOK);
    assert.equal(
      res.status,
      503,
      `an unreadable table must surface as a refusal, not as a 200 with 0 attempts — got ${res.status}`,
    );
    assert.notEqual(res.body?.average, 0, "the failure must not be dressed as a measurement");
  });
});
