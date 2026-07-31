/**
 * fsqPhotoLookup.test.ts
 *
 * Unit tests for lookupFsqPhoto() — verifies the correct Foursquare
 * Places API endpoint, auth headers, photo URL assembly, and silent
 * null return on non-ok responses.
 *
 * Run:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/fsqPhotoLookup.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── helpers ──────────────────────────────────────────────────────────────────

type CapturedRequest = { url: string; init?: RequestInit };

function makeFetch(
  status: number,
  body: unknown,
): { fetch: typeof globalThis.fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const mockFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    captured.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  };
  return { fetch: mockFetch as typeof globalThis.fetch, captured };
}

// Counter for unique place names so each test bypasses the in-memory cache.
let nameCounter = 0;
function uniqueName(): string {
  return `TestPlace_${++nameCounter}_${Math.random().toString(36).slice(2)}`;
}

// ── setup ─────────────────────────────────────────────────────────────────────

const FAKE_KEY = 'test-fsq-key-abc123';
const originalFetch = globalThis.fetch;
const originalEnv = process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY;

beforeEach(async () => {
  process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY = FAKE_KEY;
  // Reset the once-per-session auth-failure guard so each test starts clean.
  const { _resetAuthStateForTest } = await import('../fsqPhotoLookup.ts');
  _resetAuthStateForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY = originalEnv;
});

// ── lookupFsqPhoto — request shape ────────────────────────────────────────────

describe('lookupFsqPhoto — request URL', () => {
  it('sends to the places-api.foursquare.com endpoint', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { results: [] });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    await lookupFsqPhoto(uniqueName(), 1.23, 4.56);

    assert.ok(captured.length > 0, 'fetch was not called');
    assert.match(
      captured[0].url,
      /^https:\/\/places-api\.foursquare\.com\/places\/search/,
      'URL must start with the new places-api.foursquare.com base',
    );
  });

  it('includes the place name as the "query" query param', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { results: [] });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const name = uniqueName();
    await lookupFsqPhoto(name, null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('query'), name.trim());
  });
});

describe('lookupFsqPhoto — request headers', () => {
  it('sends Authorization: Bearer <key>', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { results: [] });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    await lookupFsqPhoto(uniqueName(), null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const headers = captured[0].init?.headers as Record<string, string> | undefined;
    assert.ok(headers, 'headers must be present');
    assert.equal(
      (headers as Record<string, string>)['Authorization'],
      `Bearer ${FAKE_KEY}`,
    );
  });

  it('sends X-Places-Api-Version header', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { results: [] });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    await lookupFsqPhoto(uniqueName(), null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const headers = captured[0].init?.headers as Record<string, string> | undefined;
    assert.ok(headers, 'headers must be present');
    assert.ok(
      typeof (headers as Record<string, string>)['X-Places-Api-Version'] === 'string' &&
        (headers as Record<string, string>)['X-Places-Api-Version'].length > 0,
      'X-Places-Api-Version must be a non-empty string',
    );
  });
});

// ── lookupFsqPhoto — photo URL assembly ───────────────────────────────────────

describe('lookupFsqPhoto — photo URL assembly', () => {
  it('assembles prefix + original + suffix into the photo URL', async () => {
    const body = {
      results: [
        {
          photos: [
            { prefix: 'https://fastly.4sqi.net/img/general/', suffix: '/venue-photo.jpg' },
          ],
        },
      ],
    };
    const { fetch: mockFetch } = makeFetch(200, body);
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const result = await lookupFsqPhoto(uniqueName(), null, null);

    assert.equal(
      result,
      'https://fastly.4sqi.net/img/general/original/venue-photo.jpg',
    );
  });

  it('returns null when results array is empty', async () => {
    const body = { results: [] };
    const { fetch: mockFetch } = makeFetch(200, body);
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const result = await lookupFsqPhoto(uniqueName(), null, null);

    assert.equal(result, null);
  });

  it('returns null when the first result has no photos', async () => {
    const body = { results: [{ photos: [] }] };
    const { fetch: mockFetch } = makeFetch(200, body);
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const result = await lookupFsqPhoto(uniqueName(), null, null);

    assert.equal(result, null);
  });
});

// ── lookupFsqPhoto — non-ok response ─────────────────────────────────────────

describe('lookupFsqPhoto — non-ok response', () => {
  it('returns null on a 401 response without throwing', async () => {
    const { fetch: mockFetch } = makeFetch(401, { message: 'Unauthorized' });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const result = await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });

  it('returns null on a 500 response without throwing', async () => {
    const { fetch: mockFetch } = makeFetch(500, {});
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const result = await lookupFsqPhoto(uniqueName(), null, null);

    assert.equal(result, null);
  });
});

// ── lookupFsqPhoto — no API key ───────────────────────────────────────────────

describe('lookupFsqPhoto — missing API key', () => {
  it('returns null immediately when EXPO_PUBLIC_FOURSQUARE_API_KEY is unset', async () => {
    delete process.env.EXPO_PUBLIC_FOURSQUARE_API_KEY;
    const { fetch: mockFetch, captured } = makeFetch(200, { results: [] });
    globalThis.fetch = mockFetch;

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const result = await lookupFsqPhoto(uniqueName(), null, null);

    assert.equal(result, null);
    assert.equal(captured.length, 0, 'fetch must not be called when no API key is set');
  });
});

// ── lookupFsqPhoto — AbortSignal timeout ─────────────────────────────────────

describe('lookupFsqPhoto — AbortSignal timeout', () => {
  it('returns null without throwing when fetch throws an AbortError', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    globalThis.fetch = async () => { throw abortError; };

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const result = await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

    assert.equal(result, null);
  });

  it('caches the null result so a second call does not fetch again', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      throw abortError;
    };

    const { lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const name = uniqueName();
    const lat = 48.0;
    const lng = 2.0;

    const first = await lookupFsqPhoto(name, lat, lng);
    assert.equal(first, null);
    assert.equal(fetchCallCount, 1, 'fetch should be called once on the first request');

    const second = await lookupFsqPhoto(name, lat, lng);
    assert.equal(second, null);
    assert.equal(fetchCallCount, 1, 'fetch must not be called again — null result is cached');
  });
});

// ── lookupFsqPhoto — Sentry auth error reporting ──────────────────────────────
//
// fsqPhotoLookup.ts exposes _setSentryForTest() so node:test suites can inject
// a stub without needing to mock the @sentry/react-native module (which tsx
// routes through the ESM loader, bypassing the CJS require.cache).

type SentryCall = unknown[];

function makeSentryStub(): {
  stub: { captureMessage: (...args: SentryCall) => void; addBreadcrumb: (...args: SentryCall) => void };
  captureMessageCalls: SentryCall[];
  addBreadcrumbCalls: SentryCall[];
} {
  const captureMessageCalls: SentryCall[] = [];
  const addBreadcrumbCalls: SentryCall[] = [];
  return {
    stub: {
      captureMessage: (...args: SentryCall) => { captureMessageCalls.push(args); },
      addBreadcrumb:  (...args: SentryCall) => { addBreadcrumbCalls.push(args); },
    },
    captureMessageCalls,
    addBreadcrumbCalls,
  };
}

describe('lookupFsqPhoto — Sentry auth error reporting', () => {
  it('calls addBreadcrumb and captureMessage with level "error" on a 401 response', async () => {
    const { _setSentryForTest, _resetAuthFailedForTest, lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    _resetAuthFailedForTest();
    const { stub, captureMessageCalls, addBreadcrumbCalls } = makeSentryStub();
    _setSentryForTest(stub);
    try {
      const { fetch: mockFetch } = makeFetch(401, { message: 'Unauthorized' });
      globalThis.fetch = mockFetch;

      await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

      assert.equal(
        addBreadcrumbCalls.length,
        1,
        'addBreadcrumb must be called once for a 401 auth error',
      );
      assert.equal(
        (addBreadcrumbCalls[0][0] as any)?.level,
        'error',
        'addBreadcrumb level must be "error" for a 401',
      );
      assert.equal(
        captureMessageCalls.length,
        1,
        'captureMessage must be called for a 401 auth failure',
      );
      assert.equal(
        (captureMessageCalls[0][1] as any)?.level,
        'error',
        'captureMessage must be called with level "error" for a 401',
      );
    } finally {
      _setSentryForTest(undefined);
    }
  });

  it('calls addBreadcrumb and captureMessage with level "error" on a 403 response', async () => {
    const { _setSentryForTest, _resetAuthFailedForTest, lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    _resetAuthFailedForTest();
    const { stub, captureMessageCalls, addBreadcrumbCalls } = makeSentryStub();
    _setSentryForTest(stub);
    try {
      const { fetch: mockFetch } = makeFetch(403, { message: 'Forbidden' });
      globalThis.fetch = mockFetch;

      await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

      assert.equal(
        addBreadcrumbCalls.length,
        1,
        'addBreadcrumb must be called once for a 403 auth error',
      );
      assert.equal(
        (addBreadcrumbCalls[0][0] as any)?.level,
        'error',
        'addBreadcrumb level must be "error" for a 403',
      );
      assert.equal(
        captureMessageCalls.length,
        1,
        'captureMessage must be called for a 403 auth failure',
      );
      assert.equal(
        (captureMessageCalls[0][1] as any)?.level,
        'error',
        'captureMessage must be called with level "error" for a 403',
      );
    } finally {
      _setSentryForTest(undefined);
    }
  });

  it('calls addBreadcrumb but NOT captureMessage on a non-auth error (500)', async () => {
    const { _setSentryForTest, lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    const { stub, captureMessageCalls, addBreadcrumbCalls } = makeSentryStub();
    _setSentryForTest(stub);
    try {
      const { fetch: mockFetch } = makeFetch(500, { message: 'Internal Server Error' });
      globalThis.fetch = mockFetch;

      await lookupFsqPhoto(uniqueName(), 10.0, 20.0);

      assert.equal(
        addBreadcrumbCalls.length,
        1,
        'addBreadcrumb must be called for any non-ok response',
      );
      assert.equal(
        (addBreadcrumbCalls[0][0] as any)?.level,
        'warning',
        'addBreadcrumb level must be "warning" for a non-auth error',
      );
      assert.equal(
        captureMessageCalls.length,
        0,
        'captureMessage must NOT be called for a non-auth error like 500',
      );
    } finally {
      _setSentryForTest(undefined);
    }
  });
});
