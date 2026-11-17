/** Account-status transport. Actual state transitions are proved in db/accountRecovery.db.test.ts. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import express from 'express';
import { _setTestClient } from '../lib/http.js';
import { _setTestServiceClient } from '../lib/supabase.js';
import { makeFailClosedClient } from './helpers/failClosedSupabase.js';
import profileRouter from '../routes/profile.js';
import { logger } from '../lib/logger.js';
const ME = 'aa000000-0000-4000-a000-000000000001', GEN = 'aa000000-0000-4000-a000-000000000002';
const DEADLINE = '2027-11-16T12:00:00+00:00';
let base: string, server: Server;
before(async () => {
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.log = logger; next(); }); app.use(profileRouter);
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { _setTestClient(null, false); _setTestServiceClient(null); await new Promise<void>(resolve => server.close(() => resolve())); });
function install(status: string, command: string, receipt: unknown, deleted = false) {
  const calls: unknown[] = [];
  const client = makeFailClosedClient({ users: { token: ME }, rows: {
    profiles: [{ id: ME, account_status: status }], user_account_states: [],
    user_deletion_requests: deleted ? [{ user_id: ME, status: 'pending', recovery_generation: GEN }] : [],
  }, rpc: { [command]: args => { calls.push(args); return { data: receipt, error: null }; } } });
  _setTestClient(client, true); _setTestServiceClient(client); return calls;
}
async function call(path: string, method = 'GET', authenticated = true) {
  const response = await fetch(base + path, { method, headers: authenticated ? { authorization: 'Bearer token' } : {} });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
describe('account status and recovery transport', () => {
  for (const status of ['active', 'deactivated', 'pending_deletion']) it(`returns authoritative ${status} and its recovery deadline`, async () => {
    const receipt = { accountStatus: status, deletionScheduledAt: null, reactivateUntil: status === 'deactivated' ? DEADLINE : null, selfRecoverableUntil: status === 'pending_deletion' ? DEADLINE : null };
    const calls = install(status, 'account_recovery_status', receipt);
    const response = await call('/me/account-status'); assert.equal(response.status, 200); assert.deepEqual(response.body, receipt); assert.deepEqual(calls, [{ p_user: ME }]);
  });
  it('does not confuse a missing profile with an active account', async () => {
    install('active', 'account_recovery_status', null); assert.equal((await call('/me/account-status')).status, 404);
  });
  it('rejects a malformed successful status response', async () => {
    install('active', 'account_recovery_status', { accountStatus: 'active' }); assert.equal((await call('/me/account-status')).status, 502);
  });
  it('requires authentication before reading recovery details', async () => {
    const calls = install('active', 'account_recovery_status', null); assert.equal((await call('/me/account-status', 'GET', false)).status, 401); assert.deepEqual(calls, []);
  });
  it('routes a deleted-profile reactivation through the original recovery generation', async () => {
    const calls = install('deactivated', 'recover_deleted_account', { ok: true, alreadyRecovered: false, accountStatus: 'active' }, true);
    const response = await call('/me/reactivate', 'POST'); assert.equal(response.status, 200); assert.equal(response.body.reactivated, true);
    assert.equal(calls.length, 1); assert.deepEqual(calls[0], { p_actor: ME, p_user: ME, p_generation: GEN, p_reason: 'Owner requested profile reactivation' });
  });
  it('does not announce activation when deleted-profile recovery returns a previously deactivated profile', async () => {
    install('deactivated', 'recover_deleted_account', { ok: true, alreadyRecovered: false, accountStatus: 'deactivated' }, true);
    const response = await call('/me/reactivate', 'POST'); assert.equal(response.status, 200); assert.equal(response.body.reactivated, false); assert.equal(response.body.accountStatus, 'deactivated');
  });
  it('uses the personal-deactivation command for a personally deactivated account', async () => {
    const calls = install('deactivated', 'reactivate_self_deactivated_account', { ok: true, alreadyReactivated: false });
    assert.equal((await call('/me/reactivate', 'POST')).body.reactivated, true); assert.deepEqual(calls, [{ p_user: ME }]);
  });
});
