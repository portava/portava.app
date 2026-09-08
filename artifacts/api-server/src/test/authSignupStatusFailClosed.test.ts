/**
 * GET /api/auth/signup-status — the STOP flag and the CAPABILITY flag fail in
 * OPPOSITE directions, on purpose, and the endpoint must agree with what
 * POST /auth/signup will actually do.
 *
 * ── THE TWO FLAGS ───────────────────────────────────────────────────────────
 * scripts/check-flag-polarity.mjs records both classifications, and this file
 * pins the CODE against them:
 *
 *   disable_signups   STOP (by the `disable_*` convention). Read through
 *                     isKillSwitchEngaged, which ENGAGES on an unreadable row.
 *                     A stop that disengages when the database is unhealthy is
 *                     a stop that is gone exactly when an operator reaches for
 *                     it.
 *   invite_only_beta  CAPABILITY (CLASSIFIED, with a written reason). Read
 *                     through isFlagEnabled, which returns FALSE on an
 *                     unreadable row — opening signup to everyone rather than
 *                     narrowing it to invitees. That is a recorded rollout
 *                     decision, not an outage, and this test asserts it rather
 *                     than "fixing" it.
 *
 * The no-service-client branch of the same handler is pinned in
 * src/test/authSignupStatusNoClient.test.ts, which has to clear the Supabase
 * env vars before the module graph loads and therefore cannot share a process
 * with the cases here.
 *
 * ── PAIRING ─────────────────────────────────────────────────────────────────
 * "The stop is engaged" and "the stop could not be read" produce the same
 * `signupsEnabled: false`, so each of those sits next to the healthy case where
 * the flag row is PRESENT, readable and false. A change that hard-closed signup
 * unconditionally would satisfy every closed assertion here and would take the
 * product offline; the healthy cases are what stop that.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/authSignupStatusFailClosed.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import authRouter, { _resetAuthRateLimits } from "../routes/auth.js";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

function install(spec: FakeClientSpec) {
  const client = makeFailClosedClient(spec);
  _setTestServiceClient(client);
  return client;
}

let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", authRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, body: parsed };
}

describe("GET /api/auth/signup-status", () => {
  it("HEALTHY: a readable, false disable_signups reports signups OPEN", async () => {
    install({ rows: { feature_flags: [{ flag: "disable_signups", enabled: false }] } });

    const res = await get("/auth/signup-status");
    assert.equal(res.status, 200);
    assert.equal(res.body.signupsEnabled, true, "a readable 'stop is off' must keep signup open");
    assert.equal(res.body.inviteOnly, false);
  });

  it("HEALTHY: a readable, true disable_signups reports signups CLOSED", async () => {
    install({ rows: { feature_flags: [{ flag: "disable_signups", enabled: true }] } });

    const res = await get("/auth/signup-status");
    assert.equal(res.status, 200);
    assert.equal(res.body.signupsEnabled, false);
  });

  it("STOP polarity: an UNREADABLE feature_flags engages the stop", async () => {
    install({
      rows: { feature_flags: [{ flag: "disable_signups", enabled: false }] },
      // The row exists and says "do not stop"; only the READ fails. If the code
      // ever reverts to capability polarity this returns true and fails here.
      failOn: (ctx) => (ctx.table === "feature_flags" ? READ_ERROR : null),
    });

    const res = await get("/auth/signup-status");
    assert.equal(res.status, 200);
    assert.equal(
      res.body.signupsEnabled,
      false,
      "disable_signups is CLASSIFIED STOP: an unreadable row must ENGAGE it (isKillSwitchEngaged)",
    );
  });

  it("CAPABILITY polarity: an UNREADABLE feature_flags leaves invite_only_beta OFF (recorded rollout decision)", async () => {
    install({
      rows: { feature_flags: [{ flag: "invite_only_beta", enabled: true }] },
      failOn: (ctx) => (ctx.table === "feature_flags" ? READ_ERROR : null),
    });

    const res = await get("/auth/signup-status");
    assert.equal(res.status, 200);
    assert.equal(
      res.body.inviteOnly,
      false,
      "invite_only_beta is CLASSIFIED CAPABILITY: false-on-unreadable opens signup to everyone, " +
        "which check-flag-polarity.mjs records as a deliberate rollout decision rather than an outage",
    );
  });

  it("HEALTHY: a readable, true invite_only_beta reports inviteOnly", async () => {
    install({ rows: { feature_flags: [{ flag: "invite_only_beta", enabled: true }] } });

    const res = await get("/auth/signup-status");
    assert.equal(res.status, 200);
    assert.equal(res.body.inviteOnly, true);
    assert.equal(res.body.signupsEnabled, true, "invite-only narrows signup; it does not stop it");
  });
});

describe("POST /api/auth/signup agrees with signup-status", () => {
  it("STOP polarity: an unreadable feature_flags blocks signup with 403 feature_disabled", async () => {
    _resetAuthRateLimits();
    install({
      rows: { feature_flags: [{ flag: "disable_signups", enabled: false }] },
      failOn: (ctx) => (ctx.table === "feature_flags" ? READ_ERROR : null),
    });

    const res = await post("/auth/signup", { email: "someone2@example.com", password: "hunter2" });
    assert.equal(res.status, 403, "assert the CODE: a 400 here would mean the request died at validation");
    assert.equal(res.body.error, "feature_disabled");
  });
});
