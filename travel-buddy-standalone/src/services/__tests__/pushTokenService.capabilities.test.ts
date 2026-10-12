/**
 * OD-1012-LAY-4a (owner, 2026-10-12): PUSH_IOS_TIME_SENSITIVE_ENTITLED is "a
 * rollout switch—not proof of an installed app's entitlement. Account for
 * older or unknown app builds; use ordinary notifications when capability is
 * unavailable or uncertain."
 *
 * The device itself reports what it can do with its push-token registration
 * (POST /api/me/devices `capabilities.iosTimeSensitive`), computed by
 * usePushToken from the build's own entitlement gate
 * (safeNotifications `iosTimeSensitiveAvailable()`). The server asks for the
 * time-sensitive level only for a device that reported true. These tests pin
 * the body: the capability is sent exactly as given, and when nothing is
 * given (the shape every older build sends) no capability field is sent.
 *
 * Run: node --import tsx/esm --test src/services/__tests__/pushTokenService.capabilities.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { savePushToken, _resetRegisteredDevice, _setTestTokenProvider } from '../pushTokenService.ts';

function capturing(): { fetchImpl: typeof fetch; bodies: any[] } {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? 'null')));
    return { ok: true, status: 201, json: async () => ({ ok: true, deviceId: 'd1' }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe('LAY-4a: push-token registration reports THIS build\'s time-sensitive capability', () => {
  beforeEach(() => { _resetRegisteredDevice(); _setTestTokenProvider(async () => 'tok'); });

  it('reports true when the build has the entitlement', async () => {
    const c = capturing();
    await savePushToken('ExponentPushToken[x]', { baseUrl: 'http://api', fetchImpl: c.fetchImpl, deviceId: null, iosTimeSensitive: true });
    assert.deepEqual(c.bodies[0], { pushToken: 'ExponentPushToken[x]', platform: 'expo', capabilities: { iosTimeSensitive: true } });
  });

  it('reports false when it does not (Android, or an iOS build without the entitlement)', async () => {
    const c = capturing();
    await savePushToken('ExponentPushToken[x]', { baseUrl: 'http://api', fetchImpl: c.fetchImpl, deviceId: null, iosTimeSensitive: false });
    assert.deepEqual(c.bodies[0].capabilities, { iosTimeSensitive: false });
  });

  it('reports nothing when not told — the same body an older build sends (unknown = ordinary)', async () => {
    const c = capturing();
    await savePushToken('ExponentPushToken[x]', { baseUrl: 'http://api', fetchImpl: c.fetchImpl, deviceId: null });
    assert.deepEqual(c.bodies[0], { pushToken: 'ExponentPushToken[x]', platform: 'expo' });
  });

  it('usePushToken passes the build\'s own entitlement gate, not a constant', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../hooks/usePushToken.ts'), 'utf8');
    assert.match(src, /savePushToken\(pushToken, \{ iosTimeSensitive: iosTimeSensitiveAvailable\(\) \}\)/);
  });
});
