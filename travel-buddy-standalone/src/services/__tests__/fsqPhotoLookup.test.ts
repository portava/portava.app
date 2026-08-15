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
import { lookupFsqPhoto, _setSentryForTest } from '../fsqPhotoLookup.ts';

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

const originalFetch = globalThis.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(async () => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test.invalid';
  // Reset the once-per-session auth-failure guard so each test starts clean.
  const { _resetAuthStateForTest } = await import('../fsqPhotoLookup.ts');
  _resetAuthStateForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

// ── lookupFsqPhoto — request shape ────────────────────────────────────────────

describe('lookupFsqPhoto — goes through the server proxy, never to Foursquare', () => {
  // These are the tests that would have caught the original defect, so they are
  // written as NEGATIVE assertions rather than only positive ones. "It calls
  // the proxy" passes just as happily in a build that also calls Foursquare.

  it('sends to the api-server proxy route', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), 1.23, 4.56);

    assert.ok(captured.length > 0, 'fetch was not called');
    assert.match(
      captured[0].url,
      /^https:\/\/api\.test\.invalid\/api\/places\/fsq-photo/,
      'URL must be the api-server proxy route',
    );
  });

  it('NEVER contacts a foursquare.com host', async () => {
    // The CORS failure and the credential leak were the same call. A build that
    // reintroduces it fails here regardless of whether the proxy is also used.
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), 1.23, 4.56);

    for (const c of captured) {
      assert.ok(
        !c.url.includes('foursquare.com'),
        `client must not call Foursquare directly — it cannot succeed cross-origin and it would ship the key: ${c.url}`,
      );
    }
  });

  it('sends NO Authorization header and NO api key', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const headers = (captured[0].init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['Authorization'], undefined, 'the credential belongs on the server');
    const url = new URL(captured[0].url);
    for (const [k, v] of url.searchParams) {
      assert.ok(!/key|token|secret/i.test(k), `query param ${k} looks like a credential`);
      assert.ok(v.length < 100, `query param ${k} is suspiciously long for a proxy call`);
    }
  });

  it('passes the place name as the "name" query param', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    const name = uniqueName();
    await lookupFsqPhoto(name, null, null);

    assert.ok(captured.length > 0, 'fetch was not called');
    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('name'), name.trim());
  });

  it('passes lat/lng as separate params when both are present', async () => {
    const { fetch: mockFetch, captured } = makeFetch(200, { photoUrl: null });
    globalThis.fetch = mockFetch;

    await lookupFsqPhoto(uniqueName(), 1.5, -2.5);

    const url = new URL(captured[0].url);
    assert.equal(url.searchParams.get('lat'), '1.5');
    assert.equal(url.searchParams.get('lng'), '-2.5');
  });
});

// ── lookupFsqPhoto — reading the proxy response ───────────────────────────────
//
// WHAT WAS HERE BEFORE, AND WHY IT IS RECORDED RATHER THAN QUIETLY REPLACED
// ========================================================================
// Two describe blocks stood here, and between them they asserted almost nothing
// they claimed to.
//
//   "photo URL assembly" — five tests, NONE of which tested assembly. Every one
//   fetched a 500 and asserted null. Three carried an orphaned
//   `const body = { results: [{ photos: [] }] }` that was never passed to
//   anything. Two were exact duplicates of each other by name.
//
//   "missing API key" — three tests. The first deleted the key and then
//   asserted only that the result was null, which a 200 with no results would
//   also produce. The other two were both named "caches the null result so a
//   second call does not fetch again"; the first of them never made a second
//   call and so tested no caching at all.
//
// That is VACUOUS COVERAGE, and it is worse than absent coverage: absent
// coverage is visible in a list of test names, vacuous coverage reads as
// reassurance. It is recorded here because "these tests were rewritten" and
// "these tests never tested what they said" are different facts about how much
// this file could previously be trusted.
//
// Assembly now happens on the server (lib/foursquarePlaces.ts), where the
// prefix+suffix response shape is known. What this side must get right is
// narrower: read `photoUrl` out of the proxy response, treat anything non-string
// as null, cache, dedup, and never throw.

describe('lookupFsqPhoto — reading the proxy response', () => {
  it('returns the photoUrl the server resolved', async () => {
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: 'https://fastly.4sqi.net/img/general/original/abc.jpg' });
    globalThis.fetch = mockFetch;

    assert.equal(
      await lookupFsqPhoto(uniqueName(), 10.0, 20.0),
      'https://fastly.4sqi.net/img/general/original/abc.jpg',
    );
  });

  it('returns null when the server reports no photo', async () => {
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: null, reason: 'no_photo' });
    globalThis.fetch = mockFetch;
    assert.equal(await lookupFsqPhoto(uniqueName(), 10.0, 20.0), null);
  });

  it('returns null when the server has no key configured', async () => {
    // Not an error condition: the endpoint answers 200 with a reason, exactly
    // like its Google-backed sibling, so a missing key degrades to category
    // artwork rather than to a broken card.
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: null, reason: 'no_foursquare_key' });
    globalThis.fetch = mockFetch;
    assert.equal(await lookupFsqPhoto(uniqueName(), 10.0, 20.0), null);
  });

  it('returns null when photoUrl is present but not a string', async () => {
    const { fetch: mockFetch } = makeFetch(200, { photoUrl: { nope: true } });
    globalThis.fetch = mockFetch;
    assert.equal(await lookupFsqPhoto(uniqueName(), 10.0, 20.0), null);
  });

  it('returns null on a 500 without throwing', async () => {
    const { fetch: mockFetch } = makeFetch(500, { message: 'Internal Server Error' });
    globalThis.fetch = mockFetch;
    assert.equal(await lookupFsqPhoto(uniqueName(), 10.0, 20.0), null);
  });

  it('returns null when fetch itself rejects', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof globalThis.fetch;
    assert.equal(await lookupFsqPhoto(uniqueName(), 10.0, 20.0), null);
  });

  it('returns null without fetching when the name is blank', async () => {
    let called = 0;
    globalThis.fetch = (async () => { called += 1; return new Response('{}'); }) as typeof globalThis.fetch;

    assert.equal(await lookupFsqPhoto('   ', 1, 2), null);
    assert.equal(called, 0, 'a blank name must not reach the server');
  });
});

// ── lookupFsqPhoto — caching ──────────────────────────────────────────────────

describe('lookupFsqPhoto — caching', () => {
  it('caches a RESOLVED url — a second call does not fetch again', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ photoUrl: 'https://fastly.4sqi.net/img/x.jpg' }), { status: 200 });
    }) as typeof globalThis.fetch;

    const name = uniqueName();
    assert.equal(await lookupFsqPhoto(name, 48.0, 2.0), 'https://fastly.4sqi.net/img/x.jpg');
    assert.equal(calls, 1);
    assert.equal(await lookupFsqPhoto(name, 48.0, 2.0), 'https://fastly.4sqi.net/img/x.jpg');
    assert.equal(calls, 1, 'a resolved url must be cached');
  });

  it('caches a NULL result too — the second call must actually be made and must not fetch', async () => {
    // The previous version of this test never made the second call, so it
    // asserted nothing about caching. Making the second call is the test.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as typeof globalThis.fetch;

    const name = uniqueName();
    assert.equal(await lookupFsqPhoto(name, 48.0, 2.0), null);
    assert.equal(calls, 1, 'first call fetches');
    assert.equal(await lookupFsqPhoto(name, 48.0, 2.0), null);
    assert.equal(calls, 1, 'a null result must be cached — otherwise every card retries a dead lookup');
  });

  it('a different place is a different cache entry', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ photoUrl: null }), { status: 200 });
    }) as typeof globalThis.fetch;

    await lookupFsqPhoto(uniqueName(), 1, 2);
    await lookupFsqPhoto(uniqueName(), 1, 2);
    assert.equal(calls, 2, 'the cache key must include the place name');
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
    const { _setSentryForTest, _resetAuthStateForTest, lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    _resetAuthStateForTest();
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
    const { _setSentryForTest, _resetAuthStateForTest, lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    _resetAuthStateForTest();
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
    const { _setSentryForTest, _resetAuthStateForTest, lookupFsqPhoto } = await import('../fsqPhotoLookup.ts');
    _resetAuthStateForTest();
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
