/**
 * Push device unregistration on sign-out — TM-social, PLAT-F20.
 *
 * POST /me/devices answers `{ ok, deviceId }`. Registration used to discard
 * that id, and nothing ever called DELETE /me/devices/:id, so a device kept
 * receiving the previous account's pushes after sign-out. These tests pin:
 *   - the id a successful registration returns is remembered;
 *   - a failed / refused registration remembers nothing;
 *   - sign-out deletes exactly that id, and reports the outcome truthfully
 *     ('removed' / 'failed' / 'timeout' / 'none'), never throwing;
 *   - a delete that did not succeed keeps the id (a later sign-out can retry).
 *
 * Run: node --import tsx/esm --test src/services/__tests__/pushTokenService.signOutUnregister.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  savePushToken,
  unregisterPushDeviceOnSignOut,
  getRegisteredDeviceId,
  _resetRegisteredDevice,
  _setTestTokenProvider,
} from '../pushTokenService.ts';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('push device registration remembers the device row id', () => {
  beforeEach(() => { _resetRegisteredDevice(); _setTestTokenProvider(async () => 'tok'); });

  it('a successful POST /me/devices remembers deviceId', async () => {
    await savePushToken('ExponentPushToken[x]', { baseUrl: 'http://api', fetchImpl: fakeFetch(200, { ok: true, deviceId: 'dev-1' }) });
    assert.equal(getRegisteredDeviceId(), 'dev-1');
  });

  it('a refused registration remembers nothing', async () => {
    await savePushToken('ExponentPushToken[x]', { baseUrl: 'http://api', fetchImpl: fakeFetch(500, { error: 'db_error' }) });
    assert.equal(getRegisteredDeviceId(), null);
  });

  it('a network failure remembers nothing and does not throw', async () => {
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await savePushToken('ExponentPushToken[x]', { baseUrl: 'http://api', fetchImpl: boom });
    assert.equal(getRegisteredDeviceId(), null);
  });
});

describe('sign-out unregisters exactly the remembered device', () => {
  beforeEach(async () => {
    _resetRegisteredDevice();
    _setTestTokenProvider(async () => 'tok');
    await savePushToken('ExponentPushToken[x]', { baseUrl: 'http://api', fetchImpl: fakeFetch(200, { ok: true, deviceId: 'dev-9' }) });
  });

  it("deletes the remembered id and reports 'removed'", async () => {
    const calls: string[] = [];
    const out = await unregisterPushDeviceOnSignOut({ unregister: async (id) => { calls.push(id); return true; } });
    assert.equal(out, 'removed');
    assert.deepEqual(calls, ['dev-9']);
    assert.equal(getRegisteredDeviceId(), null);
  });

  it("a refused delete is 'failed' and keeps the id", async () => {
    const out = await unregisterPushDeviceOnSignOut({ unregister: async () => false });
    assert.equal(out, 'failed');
    assert.equal(getRegisteredDeviceId(), 'dev-9');
  });

  it("a thrown delete is 'failed', never a throw", async () => {
    const out = await unregisterPushDeviceOnSignOut({ unregister: async () => { throw new Error('offline'); } });
    assert.equal(out, 'failed');
  });

  it("a hung delete is bounded: 'timeout', and sign-out is not held", async () => {
    const t0 = Date.now();
    const out = await unregisterPushDeviceOnSignOut({ unregister: () => new Promise<boolean>(() => {}), timeoutMs: 30 });
    assert.equal(out, 'timeout');
    assert.ok(Date.now() - t0 < 1000);
  });

  it("with no registration this session there is nothing to delete: 'none'", async () => {
    _resetRegisteredDevice();
    let called = false;
    const out = await unregisterPushDeviceOnSignOut({ unregister: async () => { called = true; return true; } });
    assert.equal(out, 'none');
    assert.equal(called, false);
  });
});
