/**
 * useNotificationStream.test.ts
 *
 * Unit tests for the `_connectOnce` helper extracted from
 * `useNotificationStream`'s connect() callback.
 *
 * Coverage (per task spec):
 *   1. When `freshToken` returns null → no XHR is opened (returns null)
 *   2. When base URL is absent → no XHR is opened (returns null)
 *   3. When token is valid → XHR is opened with the correct Authorization header
 *   4. When token is valid → XHR is opened to the correct SSE endpoint URL
 *   5. When token is valid → Accept and Cache-Control headers are set
 *
 * Strategy:
 *   `_connectOnce(token, base, xhrFactory?)` is the extracted pure function
 *   that contains the "should we open a connection, and with what headers"
 *   logic. Tests inject a FakeXHR via the optional xhrFactory so no real
 *   network calls are made and XMLHttpRequest need not exist in the test env.
 *
 * Run:
 *   node --import tsx/esm --test src/hooks/__tests__/useNotificationStream.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _connectOnce } from '../notificationStreamUtils.ts';

// ── FakeXHR ───────────────────────────────────────────────────────────────────

class FakeXHR {
  openMethod: string | null = null;
  openUrl: string | null = null;
  openAsync: boolean | null = null;
  headers: Record<string, string> = {};

  open(method: string, url: string, async: boolean): void {
    this.openMethod = method;
    this.openUrl = url;
    this.openAsync = async;
  }

  setRequestHeader(key: string, value: string): void {
    this.headers[key] = value;
  }

  send(): void { /* no-op in tests */ }
  abort(): void { /* no-op in tests */ }
}

function makeFakeXhrFactory(): { factory: () => FakeXHR; instances: FakeXHR[] } {
  const instances: FakeXHR[] = [];
  return {
    factory: () => {
      const xhr = new FakeXHR();
      instances.push(xhr);
      return xhr;
    },
    instances,
  };
}

const API_BASE = 'https://api.example.com';
const VALID_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.test-token';

// ── null token / missing base ─────────────────────────────────────────────────

describe('useNotificationStream._connectOnce — null token / missing base', () => {
  it('returns null and does not create an XHR when token is null', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const result = _connectOnce(null, API_BASE, factory as unknown as () => XMLHttpRequest);
    assert.equal(result, null, 'should return null when token is null');
    assert.equal(instances.length, 0, 'XHR constructor must not be called when token is null');
  });

  it('returns null and does not create an XHR when base is null', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const result = _connectOnce(VALID_TOKEN, null, factory as unknown as () => XMLHttpRequest);
    assert.equal(result, null, 'should return null when base is null');
    assert.equal(instances.length, 0, 'XHR constructor must not be called when base is null');
  });

  it('returns null and does not create an XHR when both token and base are null', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const result = _connectOnce(null, null, factory as unknown as () => XMLHttpRequest);
    assert.equal(result, null);
    assert.equal(instances.length, 0);
  });

  it('returns null and does not create an XHR when token is an empty string', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const result = _connectOnce('', API_BASE, factory as unknown as () => XMLHttpRequest);
    assert.equal(result, null, 'empty string is falsy — no XHR should be created');
    assert.equal(instances.length, 0);
  });

  it('returns null and does not create an XHR when base is an empty string', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const result = _connectOnce(VALID_TOKEN, '', factory as unknown as () => XMLHttpRequest);
    assert.equal(result, null, 'empty base is falsy — no XHR should be created');
    assert.equal(instances.length, 0);
  });
});

// ── valid token + base → XHR opened correctly ─────────────────────────────────

describe('useNotificationStream._connectOnce — valid token, XHR setup', () => {
  it('returns an XHR (not null) when token and base are both present', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const result = _connectOnce(VALID_TOKEN, API_BASE, factory as unknown as () => XMLHttpRequest);
    assert.ok(result !== null, 'should return an XHR when token and base are present');
    assert.equal(instances.length, 1, 'exactly one XHR must be created');
  });

  it('opens the XHR with a GET request to the SSE stream endpoint', () => {
    const { factory, instances } = makeFakeXhrFactory();
    _connectOnce(VALID_TOKEN, API_BASE, factory as unknown as () => XMLHttpRequest);
    const xhr = instances[0];
    assert.equal(xhr.openMethod, 'GET', 'must use GET method');
    assert.equal(
      xhr.openUrl,
      `${API_BASE}/api/me/notifications/stream`,
      'must open the correct SSE endpoint URL',
    );
    assert.equal(xhr.openAsync, true, 'must open the request asynchronously');
  });

  it('sets the Authorization header to "Bearer <token>"', () => {
    const { factory, instances } = makeFakeXhrFactory();
    _connectOnce(VALID_TOKEN, API_BASE, factory as unknown as () => XMLHttpRequest);
    const xhr = instances[0];
    assert.equal(
      xhr.headers['Authorization'],
      `Bearer ${VALID_TOKEN}`,
      'Authorization header must carry the freshToken value',
    );
  });

  it('sets the Accept header to text/event-stream', () => {
    const { factory, instances } = makeFakeXhrFactory();
    _connectOnce(VALID_TOKEN, API_BASE, factory as unknown as () => XMLHttpRequest);
    assert.equal(instances[0].headers['Accept'], 'text/event-stream');
  });

  it('sets the Cache-Control header to no-cache', () => {
    const { factory, instances } = makeFakeXhrFactory();
    _connectOnce(VALID_TOKEN, API_BASE, factory as unknown as () => XMLHttpRequest);
    assert.equal(instances[0].headers['Cache-Control'], 'no-cache');
  });

  it('propagates a different valid token into the Authorization header', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const otherToken = 'other.token.value';
    _connectOnce(otherToken, API_BASE, factory as unknown as () => XMLHttpRequest);
    assert.equal(
      instances[0].headers['Authorization'],
      `Bearer ${otherToken}`,
      'token value must be taken from the argument, not hardcoded',
    );
  });

  it('constructs the endpoint URL from the supplied base — not a hardcoded value', () => {
    const { factory, instances } = makeFakeXhrFactory();
    const customBase = 'https://other-api.example.com';
    _connectOnce(VALID_TOKEN, customBase, factory as unknown as () => XMLHttpRequest);
    assert.equal(
      instances[0].openUrl,
      `${customBase}/api/me/notifications/stream`,
    );
  });
});
