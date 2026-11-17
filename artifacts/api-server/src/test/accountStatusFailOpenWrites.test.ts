/** Fail-closed account controls. SQL transaction rollback and resulting state are
 * proved in db/accountRecovery.db.test.ts; these tests inject resolved RPC errors
 * and assert no independent write or false success escapes through HTTP. */
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

describe('account status: unavailable authoritative operations never report success', () => {
  const cases = [
    { method: 'POST', path: '/me/deactivate', rpc: 'set_account_self_deactivation', receipt: { ok: true, reactivateUntil: SCHEDULED }, success: 'deactivated' },
    { method: 'POST', path: '/me/delete-request', rpc: 'request_recoverable_account_deletion', receipt: { ok: true, generation: ME, scheduledAt: null, selfRecoverableUntil: SCHEDULED }, success: 'deletionScheduled' },
    { method: 'POST', path: '/me/reactivate', rpc: 'recover_deleted_account', receipt: { ok: true, alreadyRecovered: false, accountStatus: 'active' }, success: 'reactivated' },
    { method: 'GET', path: '/me/account-status', rpc: 'account_recovery_status', receipt: { accountStatus: 'pending_deletion', deletionScheduledAt: null, selfRecoverableUntil: SCHEDULED, reactivateUntil: null }, success: 'accountStatus' },
  ];
  for (const c of cases) {
    const rows = () => baseRows('deactivated', { user_deletion_requests: [{ user_id: ME, status: 'pending', recovery_generation: ME }] });
    it(`HEALTHY: ${c.path} reports the canonical receipt without separate writes`, async () => {
      let invoked = 0;
      const spec: FakeClientSpec = { rows: rows(), rpc: { [c.rpc]: args => { invoked++; assert.equal(args.p_user, ME); return { data: c.receipt, error: null }; } } };
      install(spec); const res = await call(c.method, c.path); assert.equal(res.status, 200); assert.ok(res.body[c.success]); assert.equal(invoked, 1);
      assert.deepEqual(spec.updated ?? {}, {});
      if (c.path === '/me/delete-request') assert.equal(res.body.scheduledAt, null);
    });
    it(`FAILS CLOSED: ${c.path} rejects a resolved database failure`, async () => {
      let invoked = 0;
      const spec: FakeClientSpec = { rows: rows(), rpc: { [c.rpc]: () => { invoked++; return { data: null, error: c.method === 'GET' ? READ_ERROR : WRITE_ERROR }; } } };
      install(spec); const res = await call(c.method, c.path); assert.equal(res.status, c.method === 'GET' ? 500 : 502); assert.equal(invoked, 1); assert.equal(res.body[c.success], undefined); assert.deepEqual(spec.updated ?? {}, {});
    });
  }
  it('an unreadable deletion request cannot select the personal reactivation path', async () => {
    let invoked = false;
    install({ rows: baseRows('deactivated'), failOn: ctx => ctx.table === 'user_deletion_requests' ? READ_ERROR : null,
      rpc: { reactivate_self_deactivated_account: () => { invoked = true; return { data: { ok: true }, error: null }; } } });
    const res = await call('POST', '/me/reactivate'); assert.equal(res.status, 502); assert.equal(invoked, false); assert.notEqual(res.body.reactivated, true);
  });
});
