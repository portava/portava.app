/**
 * Unit tests for locationPrefsLogic — load and save helpers used by the
 * Location Settings screen (app/settings/location.tsx).
 *
 * Tests verify:
 *   Load:
 *     1. Returns ok:true with parsed prefs on a 200 response.
 *     2. Returns ok:false (not a silent fallback) on a non-2xx HTTP response.
 *     3. Returns ok:false when fetch throws (network unreachable).
 *     4. Defaults are applied correctly when server omits optional fields.
 *   Save:
 *     5. Returns true on a 200 response.
 *     6. Returns false on a non-2xx HTTP response — caller must surface error.
 *     7. Returns false when fetch throws — caller must surface error.
 *     8. PATCH body contains exactly the patch keys provided.
 *
 * Run via:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/locationPrefs.load.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadLocationPrefs, saveLocationPrefs } from '../locationPrefsLogic.ts';
import type { LocationPrefs } from '../locationPrefsLogic.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = 'https://api.example.com';
const TOKEN = 'test-token';

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function fetchOk(body: unknown): typeof fetch {
  return async () => makeResponse(200, body);
}

function fetchStatus(status: number, body: unknown = {}): typeof fetch {
  return async () => makeResponse(status, body);
}

function fetchThrows(message = 'Network error'): typeof fetch {
  return async () => { throw new Error(message); };
}

const fullServerPrefs = {
  locationMode: 'nearby',
  sharingPaused: true,
  pulseVisibility: 'neighborhood',
  discoveryVisibility: 'city_only',
  safeReturnEnabled: false,
  trustedCircleShare: true,
  hotelBlurEnabled: false,
};

// ── Load tests ────────────────────────────────────────────────────────────────

describe('loadLocationPrefs', () => {
  it('returns ok:true with correctly parsed prefs on a 200 response', async () => {
    const result = await loadLocationPrefs(API_BASE, TOKEN, fetchOk(fullServerPrefs));

    assert.strictEqual(result.ok, true);
    assert.ok(result.data !== null);
    assert.strictEqual(result.data!.locationMode, 'nearby');
    assert.strictEqual(result.data!.sharingPaused, true);
    assert.strictEqual(result.data!.pulseVisibility, 'neighborhood');
    assert.strictEqual(result.data!.discoveryVisibility, 'city_only');
    assert.strictEqual(result.data!.safeReturnEnabled, false);
    assert.strictEqual(result.data!.trustedCircleShare, true);
    assert.strictEqual(result.data!.hotelBlurEnabled, false);
  });

  it('returns ok:false — not silently ok — on a 401 response', async () => {
    const result = await loadLocationPrefs(API_BASE, TOKEN, fetchStatus(401, { error: 'Unauthorized' }));

    assert.strictEqual(result.ok, false, 'must signal failure so caller shows an error, not silent defaults');
    assert.strictEqual(result.data, null);
  });

  it('returns ok:false on a 500 response', async () => {
    const result = await loadLocationPrefs(API_BASE, TOKEN, fetchStatus(500));

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.data, null);
  });

  it('returns ok:false when fetch throws (network unreachable)', async () => {
    const result = await loadLocationPrefs(API_BASE, TOKEN, fetchThrows('Failed to fetch'));

    assert.strictEqual(result.ok, false, 'network error must surface as ok:false, not silently use defaults');
    assert.strictEqual(result.data, null);
  });

  it('applies correct defaults when server omits optional fields', async () => {
    const result = await loadLocationPrefs(API_BASE, TOKEN, fetchOk({}));

    assert.strictEqual(result.ok, true);
    const d = result.data!;
    assert.strictEqual(d.locationMode, 'city_only', 'locationMode default');
    assert.strictEqual(d.sharingPaused, false, 'sharingPaused default');
    assert.strictEqual(d.pulseVisibility, null, 'pulseVisibility default');
    assert.strictEqual(d.discoveryVisibility, null, 'discoveryVisibility default');
    assert.strictEqual(d.safeReturnEnabled, true, 'safeReturnEnabled default');
    assert.strictEqual(d.trustedCircleShare, false, 'trustedCircleShare default');
    assert.strictEqual(d.hotelBlurEnabled, true, 'hotelBlurEnabled default');
  });

  it('applies correct defaults for fields explicitly set to null by the server', async () => {
    const result = await loadLocationPrefs(API_BASE, TOKEN, fetchOk({
      pulseVisibility: null,
      discoveryVisibility: null,
    }));

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data!.pulseVisibility, null);
    assert.strictEqual(result.data!.discoveryVisibility, null);
  });

  it('sends the Authorization header with the provided token', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse(200, fullServerPrefs);
    };

    await loadLocationPrefs(API_BASE, 'my-secret-token', fetch);

    assert.strictEqual(capturedHeaders?.Authorization, 'Bearer my-secret-token');
  });
});

// ── Save tests ────────────────────────────────────────────────────────────────

describe('saveLocationPrefs', () => {
  it('returns true on a 200 response', async () => {
    const result = await saveLocationPrefs(API_BASE, TOKEN, { sharingPaused: true }, fetchOk({}));

    assert.strictEqual(result, true);
  });

  it('returns false — not silently discarded — on a 400 response', async () => {
    const result = await saveLocationPrefs(API_BASE, TOKEN, { sharingPaused: true }, fetchStatus(400));

    assert.strictEqual(result, false, 'save failure must be signalled so caller can roll back and show an error');
  });

  it('returns false on a 503 response (API unreachable)', async () => {
    const result = await saveLocationPrefs(API_BASE, TOKEN, { hotelBlurEnabled: false }, fetchStatus(503));

    assert.strictEqual(result, false);
  });

  it('returns false when fetch throws (network unreachable)', async () => {
    const result = await saveLocationPrefs(
      API_BASE, TOKEN, { locationMode: 'nearby' }, fetchThrows('Network error'),
    );

    assert.strictEqual(result, false, 'network error must surface as false, not be silently swallowed');
  });

  it('sends PATCH with exactly the patch keys in the body', async () => {
    const patch: Partial<LocationPrefs> = { sharingPaused: true, hotelBlurEnabled: false };
    let capturedBody: unknown;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return makeResponse(200, {});
    };

    await saveLocationPrefs(API_BASE, TOKEN, patch, fetch);

    assert.deepStrictEqual(capturedBody, patch,
      'body must contain exactly the patch — no extra or missing keys');
  });

  it('uses PATCH method', async () => {
    let capturedMethod: string | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      capturedMethod = init?.method;
      return makeResponse(200, {});
    };

    await saveLocationPrefs(API_BASE, TOKEN, { safeReturnEnabled: false }, fetch);

    assert.strictEqual(capturedMethod, 'PATCH');
  });

  it('sends the Authorization header with the provided token', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return makeResponse(200, {});
    };

    await saveLocationPrefs(API_BASE, 'my-secret-token', {}, fetch);

    assert.strictEqual(capturedHeaders?.Authorization, 'Bearer my-secret-token');
  });
});
