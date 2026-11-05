import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { makeFakeMapDb, type FakeState } from './helpers/fakeMapDb.js';
import { readNavigationContributionSignals } from '../lib/mapNavigationContribution.js';
import { runMapNavigationRetention } from '../lib/mapNavigationRetentionScheduler.js';
const previous = process.env.MAP_ROUTE_FLOW_REVIEWED_DISCLOSURE;
afterEach(() => { if (previous === undefined) delete process.env.MAP_ROUTE_FLOW_REVIEWED_DISCLOSURE; else process.env.MAP_ROUTE_FLOW_REVIEWED_DISCLOSURE = previous; });
const now = Date.parse('2026-11-05T10:00:00Z');
function fixture(changes: FakeState = {}) {
  process.env.MAP_ROUTE_FLOW_REVIEWED_DISCLOSURE = JSON.stringify({ version: 'v1', title: 'Reviewed test', what: 'Test collection', who: 'Test audience', retention: '15 minutes', off: 'Withdrawal removes intent' });
  return makeFakeMapDb({ feature_flags: [{ flag: 'map_route_flow_consent_enabled', enabled: true }], map_navigation_contributions: [{ user_id: 'a', from_zone_id: 'z1', to_zone_id: 'z2', observed_at: new Date(now - 10000).toISOString(), expires_at: new Date(now + 10000).toISOString() }], route_flow_contribution_consent: [{ user_id: 'a', enabled: true, consent_version: 'v1', withdrawn_at: null }], ...changes }, { token: 'fixture', userId: 'a' });
}
test('latest consented hop contains no coordinates and receives no invented party credit', async () => {
  const result = await readNavigationContributionSignals(fixture(), now);
  assert.equal(result.refusal, null);
  assert.deepEqual(result.signals, [{ actorId: 'a', family: 'navigation_start', fromZoneId: 'z1', toZoneId: 'z2', groupKey: null, observedAt: now - 10000 }]);
});
test('withdrawn and superseded consent cannot publish a retained hop', async () => {
  for (const row of [{ enabled: false, consent_version: 'v1' }, { enabled: true, consent_version: 'old' }, { enabled: true, consent_version: 'v1', withdrawn_at: new Date(now).toISOString() }]) {
    const result = await readNavigationContributionSignals(fixture({ route_flow_contribution_consent: [{ user_id: 'a', withdrawn_at: null, ...row }] }), now);
    assert.deepEqual(result.signals, []);
  }
});
test('missing reviewed disclosure refuses before accessing navigation rows', async () => {
  delete process.env.MAP_ROUTE_FLOW_REVIEWED_DISCLOSURE;
  const result = await readNavigationContributionSignals({ from() { throw new Error('No reads permitted'); } }, now);
  assert.equal(result.refusal, 'not_available');
});
test('expired, future and malformed hops are omitted', async () => {
  for (const [observed, expires] of [[now - 10000, now], [now + 1, now + 10000], [now - 1000000, now + 1], [now - 1, now + 900001]]) {
    const result = await readNavigationContributionSignals(fixture({ map_navigation_contributions: [{ user_id: 'a', from_zone_id: 'z1', to_zone_id: 'z2', observed_at: new Date(observed).toISOString(), expires_at: new Date(expires).toISOString() }] }), now);
    assert.deepEqual(result.signals, []);
  }
});
test('privacy read failure is reported rather than an empty successful family', async () => {
  const result = await readNavigationContributionSignals(fixture({ route_flow_contribution_consent: { error: { message: 'offline' } } }), now);
  assert.equal(result.refusal, 'consent_unreadable'); assert.deepEqual(result.signals, []);
});
test('retention drains bounded batches and reports a failed continuation honestly', async () => {
  const responses = [{ data: 500 }, { data: 3 }]; const calls: unknown[] = [];
  const db = { rpc(name: string, args: unknown) { calls.push([name,args]); return { abortSignal(signal: AbortSignal) { assert.ok(signal); return Promise.resolve(responses.shift()); } }; } };
  assert.deepEqual(await runMapNavigationRetention(db), { purged: 503, ok: true }); assert.equal(calls.length, 2);
  assert.deepEqual(await runMapNavigationRetention({ rpc() { return { abortSignal: async () => ({ error: { message: 'offline' } }) }; } }), { purged: 0, ok: false });
});
