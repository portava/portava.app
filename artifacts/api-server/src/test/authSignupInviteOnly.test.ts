/**
 * POST /api/auth/signup ENFORCES invite_only_beta — it used to only be REPORTED
 * by GET /auth/signup-status while this route, which creates accounts with the
 * service role, ignored it.
 *
 * State asserted: whether `auth.admin.createUser` was called (an account exists
 * or it does not), plus the status and error code the app reads.
 *
 *   ON  → 403 invite_required, NO account created;
 *   OFF → 201, the account is created (the healthy pair: a change that refused
 *         signup unconditionally would pass every refusal case and fail here);
 *   unreadable feature_flags → still refused, by disable_signups (STOP, engages
 *         on error) — invite_only_beta keeps its recorded CAPABILITY polarity,
 *         and the door does not open on a database failure;
 *   disable_signups ON as well → feature_disabled wins (it is checked first and
 *         is the emergency stop).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/authSignupInviteOnly.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeFailClosedClient, type FakeClientSpec } from "./helpers/failClosedSupabase.js";
import authRouter, { _resetAuthRateLimits } from "../routes/auth.js";

const READ_ERROR = { message: "server closed the connection unexpectedly", code: "08006" };

let created: Array<{ email: string }> = [];
let createdArgs: Array<Record<string, unknown>> = [];

function install(spec: FakeClientSpec) {
  const client = makeFailClosedClient(spec);
  client.auth.admin = {
    createUser: async (args: { email: string; password: string }) => {
      created.push({ email: args.email });
      createdArgs.push(args as unknown as Record<string, unknown>);
      return { data: { user: { id: "00000000-0000-0000-0000-0000000000aa", email: args.email } }, error: null };
    },
  };
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(() => { server.close(); });

beforeEach(() => {
  created = [];
  createdArgs = [];
  _resetAuthRateLimits();
});

async function signup(email: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery", ...extra }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("POST /api/auth/signup — invite_only_beta", () => {
  it("ON: 403 invite_required and NO account is created", async () => {
    install({ rows: { feature_flags: [
      { flag: "disable_signups", enabled: false },
      { flag: "invite_only_beta", enabled: true },
    ] } });
    const r = await signup("stranger@example.com");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "invite_required");
    assert.deepEqual(created, [], "an invite-only beta must not create an account for an uninvited caller");
  });

  it("OFF: the account is created (signup is narrowed by the flag, not broken)", async () => {
    install({ rows: { feature_flags: [
      { flag: "disable_signups", enabled: false },
      { flag: "invite_only_beta", enabled: false },
    ] } });
    const r = await signup("Open@Example.com");
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(created, [{ email: "open@example.com" }]);
  });

  it("OFF: the app's name / handle reach the auth user's metadata (what handle_new_user reads); junk is dropped", async () => {
    install({ rows: { feature_flags: [
      { flag: "disable_signups", enabled: false },
      { flag: "invite_only_beta", enabled: false },
    ] } });
    const r = await signup("meta@example.com", { name: "  Ada  ", handle: "ada_l", role: "admin", is_official: true });
    assert.equal(r.status, 201);
    assert.deepEqual(createdArgs[0].user_metadata, { name: "Ada", handle: "ada_l" });
    assert.ok(!("app_metadata" in createdArgs[0]), "nothing from the body may reach app_metadata");
    const r2 = await signup("plain@example.com", { name: 42, handle: "x".repeat(51) });
    assert.equal(r2.status, 201);
    assert.ok(!("user_metadata" in createdArgs[1]), "non-string or over-long values are not stored");
  });

  it("UNREADABLE feature_flags: refused by the disable_signups STOP — no account, whatever invite_only_beta's polarity", async () => {
    install({
      rows: { feature_flags: [
        { flag: "disable_signups", enabled: false },
        { flag: "invite_only_beta", enabled: true },
      ] },
      failOn: (ctx) => (ctx.table === "feature_flags" ? READ_ERROR : null),
    });
    const r = await signup("stranger2@example.com");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
    assert.deepEqual(created, []);
  });

  it("disable_signups AND invite_only_beta ON: the emergency stop answers first", async () => {
    install({ rows: { feature_flags: [
      { flag: "disable_signups", enabled: true },
      { flag: "invite_only_beta", enabled: true },
    ] } });
    const r = await signup("stranger3@example.com");
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "feature_disabled");
    assert.deepEqual(created, []);
  });

  it("signup-status and signup AGREE while invite-only: inviteOnly=true and the POST refuses", async () => {
    install({ rows: { feature_flags: [
      { flag: "disable_signups", enabled: false },
      { flag: "invite_only_beta", enabled: true },
    ] } });
    const status = await (await fetch(`${base}/auth/signup-status`)).json() as any;
    assert.deepEqual(status, { signupsEnabled: true, inviteOnly: true });
    const r = await signup("stranger4@example.com");
    assert.equal(r.body.error, "invite_required");
    assert.deepEqual(created, []);
  });
});
