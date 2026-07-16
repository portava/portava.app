/**
 * freshToken() — unit tests
 *
 * Verifies that freshToken() returns a cached token when the session is valid,
 * and that a fresh sign-in after sign-out produces the new token without an
 * unnecessary refreshSession() call.
 *
 * Run with:
 *   node --import tsx/esm --test \
 *     src/services/__tests__/apiToken.freshToken.test.ts
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshToken, _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeSession {
  access_token: string;
  expires_at: number;
}

function makeFakeClient(opts: {
  session: FakeSession | null;
  refreshedSession?: FakeSession | null;
}) {
  let refreshCalls = 0;
  const client = {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: opts.session } }),
      refreshSession: () => {
        refreshCalls++;
        const s = opts.refreshedSession !== undefined ? opts.refreshedSession : null;
        return Promise.resolve({ data: { session: s } });
      },
    },
    get refreshCalls() { return refreshCalls; },
  };
  return client;
}

/** Returns a Unix timestamp that is `offsetSeconds` seconds from now. */
function nowPlusSeconds(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

afterEach(() => {
  _resetTestSupabase();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('freshToken() — valid cached session', () => {
  it('returns the cached access_token when the session is well within expiry', async () => {
    const fake = makeFakeClient({
      session: { access_token: 'token-abc', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake);

    const token = await freshToken();

    assert.equal(token, 'token-abc');
  });

  it('does not call refreshSession() when the cached session is valid', async () => {
    const fake = makeFakeClient({
      session: { access_token: 'token-abc', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake);

    await freshToken();

    assert.equal(fake.refreshCalls, 0, 'refreshSession must not be called for a valid session');
  });
});

describe('freshToken() — fresh sign-in after sign-out', () => {
  it('returns the new session token after sign-out and sign-in without calling refreshSession()', async () => {
    // Simulate: user signed out (no old session) then signed back in.
    // getSession() now returns the freshly-issued session with a far-future expires_at.
    const fake = makeFakeClient({
      session: { access_token: 'new-token-after-signin', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake);

    const token = await freshToken();

    assert.equal(token, 'new-token-after-signin',
      'must return the new session token after sign-in');
    assert.equal(fake.refreshCalls, 0,
      'must not call refreshSession() — the fresh session is already valid');
  });

  it('returns different tokens for two consecutive sign-ins without refreshSession()', async () => {
    // First sign-in
    const fake1 = makeFakeClient({
      session: { access_token: 'first-login-token', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake1);
    const token1 = await freshToken();

    // Sign out then sign back in — new session replaces old one in getSession()
    const fake2 = makeFakeClient({
      session: { access_token: 'second-login-token', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake2);
    const token2 = await freshToken();

    assert.equal(token1, 'first-login-token');
    assert.equal(token2, 'second-login-token',
      'second call must return the new session token, not any stale value');
    assert.equal(fake1.refreshCalls, 0);
    assert.equal(fake2.refreshCalls, 0);
  });
});

describe('freshToken() — expired session triggers refresh', () => {
  it('calls refreshSession() when the session is expired', async () => {
    const fake = makeFakeClient({
      session: { access_token: 'old-token', expires_at: nowPlusSeconds(-10) },
      refreshedSession: { access_token: 'refreshed-token', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake);

    const token = await freshToken();

    assert.equal(token, 'refreshed-token', 'must return the refreshed token');
    assert.equal(fake.refreshCalls, 1, 'must call refreshSession() exactly once');
  });

  it('calls refreshSession() when the session is within the 60-second margin', async () => {
    const fake = makeFakeClient({
      session: { access_token: 'near-expiry-token', expires_at: nowPlusSeconds(30) },
      refreshedSession: { access_token: 'proactive-refresh-token', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake);

    const token = await freshToken();

    assert.equal(token, 'proactive-refresh-token');
    assert.equal(fake.refreshCalls, 1, 'must proactively refresh within the 60-second margin');
  });

  it('returns null when there is no session and refreshSession returns null', async () => {
    const fake = makeFakeClient({
      session: null,
      refreshedSession: null,
    });
    _setTestSupabase(fake);

    const token = await freshToken();

    assert.equal(token, null);
  });
});

describe('freshToken() — no session at all', () => {
  it('calls refreshSession() when getSession returns no session', async () => {
    const fake = makeFakeClient({
      session: null,
      refreshedSession: { access_token: 'recovered-token', expires_at: nowPlusSeconds(3600) },
    });
    _setTestSupabase(fake);

    const token = await freshToken();

    assert.equal(token, 'recovered-token');
    assert.equal(fake.refreshCalls, 1);
  });
});

describe('freshToken() — error handling', () => {
  it('returns null when getSession throws', async () => {
    _setTestSupabase({
      auth: {
        getSession: () => Promise.reject(new Error('network error')),
        refreshSession: () => Promise.resolve({ data: { session: null } }),
      },
    });

    const token = await freshToken();

    assert.equal(token, null, 'must return null when getSession throws');
  });

  it('returns null when refreshSession throws on an expired session', async () => {
    _setTestSupabase({
      auth: {
        getSession: () =>
          Promise.resolve({
            data: { session: { access_token: 'old', expires_at: nowPlusSeconds(-10) } },
          }),
        refreshSession: () => Promise.reject(new Error('server error')),
      },
    });

    const token = await freshToken();

    assert.equal(token, null, 'must return null when refreshSession throws');
  });
});
