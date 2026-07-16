/**
 * Device timezone sync — quiet hours in local time without manual setup.
 *
 * Tests saveDeviceTimezone() from pushTokenService.ts: the best-effort PUT
 * of the device IANA timezone to /api/me/notification-preferences, mirroring
 * the savePushToken() test approach (injected token provider + fetchImpl).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  saveDeviceTimezone,
  getDeviceTimezone,
  _setTestTokenProvider,
} from './pushTokenService.ts';

describe('getDeviceTimezone', () => {
  it('returns a plausible IANA timezone string in this runtime', () => {
    const tz = getDeviceTimezone();
    // Node always resolves a timezone; assert shape rather than value.
    assert.ok(tz === null || (typeof tz === 'string' && tz.length > 0));
  });
});

describe('saveDeviceTimezone', () => {
  afterEach(() => _setTestTokenProvider(null));

  it('PUTs { timezone } to /api/me/notification-preferences with auth header', async () => {
    _setTestTokenProvider(async () => 'test-access-token');

    let captured: { url: string; init: RequestInit } | null = null;
    const mockFetch: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init! };
      return new Response('{"ok":true}', { status: 200 });
    };

    await saveDeviceTimezone({
      baseUrl: 'https://api.example.com',
      fetchImpl: mockFetch,
      timezone: 'Europe/Paris',
    });

    assert.ok(captured, 'fetch must be called');
    assert.equal(captured!.url, 'https://api.example.com/api/me/notification-preferences');
    assert.equal(captured!.init.method, 'PUT');
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer test-access-token');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(String(captured!.init.body)), { timezone: 'Europe/Paris' });
  });

  it('uses the real device timezone when no override is provided', async () => {
    _setTestTokenProvider(async () => 'test-access-token');

    let body: unknown = null;
    const mockFetch: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init!.body));
      return new Response('{"ok":true}', { status: 200 });
    };

    await saveDeviceTimezone({ baseUrl: 'https://api.example.com', fetchImpl: mockFetch });

    const expected = getDeviceTimezone();
    assert.ok(expected, 'runtime should resolve a timezone');
    assert.deepEqual(body, { timezone: expected });
  });

  it('is a no-op when no API base is configured', async () => {
    let fetchCalled = false;
    const mockFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const orig = process.env.EXPO_PUBLIC_API_BASE_URL;
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    await saveDeviceTimezone({ fetchImpl: mockFetch, timezone: 'Europe/Paris' });
    if (orig !== undefined) process.env.EXPO_PUBLIC_API_BASE_URL = orig;
    assert.equal(fetchCalled, false);
  });

  it('is a no-op when unauthenticated (token provider returns null)', async () => {
    _setTestTokenProvider(async () => null);
    let fetchCalled = false;
    const mockFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    await saveDeviceTimezone({
      baseUrl: 'https://api.example.com',
      fetchImpl: mockFetch,
      timezone: 'Europe/Paris',
    });
    assert.equal(fetchCalled, false);
  });

  it('swallows network errors (best-effort)', async () => {
    _setTestTokenProvider(async () => 'test-access-token');
    const mockFetch: typeof fetch = async () => {
      throw new Error('network down');
    };
    await assert.doesNotReject(
      saveDeviceTimezone({
        baseUrl: 'https://api.example.com',
        fetchImpl: mockFetch,
        timezone: 'Europe/Paris',
      }),
    );
  });
});
