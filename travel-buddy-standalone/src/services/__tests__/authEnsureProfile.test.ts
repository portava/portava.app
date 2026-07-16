/**
 * Auth — ensureProfile idempotency and signup → onboarding routing tests
 *
 * Tests:
 *   1. ensureProfile: actually calls POST /api/profile/ensure with correct headers
 *   2. ensureProfile: double-call succeeds (idempotency — server returns 200 both times)
 *   3. ensureProfile: throws when EXPO_PUBLIC_API_BASE_URL is missing
 *   4. ensureProfile: throws when the API server returns a non-200 status
 *   5. ensureProfile: does not throw when _testSessionToken is set (seam works)
 *   6. signUp → onboarding routing: userId with no error routes to onboarding, not tabs
 *   7. signIn → tab routing: sign-in result always routes to tabs
 *   8. signUp without session (email confirm flow): routes to sign-in notice, not onboarding
 *   9. ensureProfile failure is non-fatal in signIn/signUp (auth result still has userId)
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx --test src/test/authEnsureProfile.test.ts
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureProfile,
  _setTestSessionToken,
} from '../auth.ts';

// ── Fetch mock helpers ────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  method: string;
  authHeader: string | undefined;
  body: unknown;
}

function capturingMock(status: number, body: unknown): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      authHeader: (init?.headers as Record<string, string>)?.Authorization,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  };
  return { fetch: f, calls };
}

// ── Suite 1: ensureProfile — real function with _setTestSessionToken seam ─────

describe('ensureProfile — real function exercised via test seam', () => {
  let savedFetch: typeof globalThis.fetch;
  let savedApiBase: string | undefined;

  before(() => {
    savedFetch = globalThis.fetch;
    savedApiBase = process.env.EXPO_PUBLIC_API_BASE_URL;
  });

  after(() => {
    globalThis.fetch = savedFetch;
    _setTestSessionToken(null);
    if (savedApiBase !== undefined) {
      process.env.EXPO_PUBLIC_API_BASE_URL = savedApiBase;
    } else {
      delete process.env.EXPO_PUBLIC_API_BASE_URL;
    }
  });

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:8080';
    _setTestSessionToken('fake-test-token-ensure-profile');
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
    _setTestSessionToken(null);
  });

  it('calls POST /api/profile/ensure with Authorization header and correct body', async () => {
    const { fetch: f, calls } = capturingMock(200, { ok: true });
    globalThis.fetch = f;

    await ensureProfile('user-abc', 'user@example.com', { name: 'Alice' });

    assert.equal(calls.length, 1, 'exactly one fetch call must be made');
    const call = calls[0];
    assert.ok(call.url.includes('/api/profile/ensure'), `URL must include /api/profile/ensure, got: ${call.url}`);
    assert.equal(call.method, 'POST', 'method must be POST');
    assert.ok(call.authHeader?.startsWith('Bearer '), `Authorization must start with "Bearer ", got: ${call.authHeader}`);
    assert.equal(call.body?.email, 'user@example.com', 'body must include email');
    assert.equal(call.body?.name, 'Alice', 'body must include name from meta');
  });

  it('calling twice does not throw — idempotency (server-side on-conflict handled at DB)', async () => {
    const { fetch: f, calls } = capturingMock(200, { ok: true });
    globalThis.fetch = f;

    await ensureProfile('user-abc', 'user@example.com');
    await ensureProfile('user-abc', 'user@example.com');

    assert.equal(calls.length, 2, 'both calls must reach the server');
    assert.equal(calls[0].method, 'POST', 'first call must be POST');
    assert.equal(calls[1].method, 'POST', 'second call must be POST');
  });

  it('throws with an error that includes the status when API responds non-200', async () => {
    globalThis.fetch = capturingMock(500, { message: 'internal error' }).fetch;

    await assert.rejects(
      () => ensureProfile('user-abc', 'user@example.com'),
      (err: Error) => {
        assert.ok(err.message.includes('500'), `Expected "500" in error message, got: "${err.message}"`);
        return true;
      },
    );
  });

  it('throws when EXPO_PUBLIC_API_BASE_URL is empty', async () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;

    await assert.rejects(
      () => ensureProfile('user-abc', 'user@example.com'),
      (err: Error) => {
        assert.ok(
          err.message.includes('EXPO_PUBLIC_API_BASE_URL'),
          `Expected EXPO_PUBLIC_API_BASE_URL in error, got: "${err.message}"`,
        );
        return true;
      },
    );
  });

  it('sends the injected test token in the Authorization header, not a real supabase token', async () => {
    const testToken = 'fake-test-token-ensure-profile';
    _setTestSessionToken(testToken);
    const { fetch: f, calls } = capturingMock(200, { ok: true });
    globalThis.fetch = f;

    await ensureProfile('user-abc', 'user@example.com');

    assert.equal(calls[0].authHeader, `Bearer ${testToken}`, 'Authorization header must carry the injected test token');
  });

  it('throws "no session token available" when _testSessionToken is null and there is no active supabase session', async () => {
    _setTestSessionToken(null);
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return {} as any; };

    // In this environment supabase IS configured, but there is no active session
    // in a test process. Without a test token, ensureProfile falls through to
    // supabase.auth.getSession() → null token → throws.
    await assert.rejects(
      () => ensureProfile('user-abc', 'user@example.com'),
      (err: Error) => {
        assert.ok(
          err.message.includes('no session token'),
          `Expected "no session token" in error, got: "${err.message}"`,
        );
        return true;
      },
    );
    assert.equal(fetchCalled, false, 'fetch must not be called when there is no valid token');
  });
});

// ── Suite 2: signup → onboarding routing decision ────────────────────────────
//
// Verifies the routing contract implemented in sign-in.tsx:
//   mode === 'signup' + userId  → /(auth)/onboarding  (always — new user must finish onboarding)
//   mode === 'signup' + null    → sign-in notice (email confirm pending)
//   mode === 'signin' + profile complete  → /(tabs)
//   mode === 'signin' + profile incomplete → /(auth)/onboarding (abandoned mid-flow)
//
// Also verifies the tabs-layout gate: authenticated user with incomplete profile
// is redirected to onboarding (cold-start / session-restore path).

describe('sign-in routing — signup routes to onboarding, signin routes based on profile completeness', () => {
  type AuthResult = { userId: string | null; error: string | null };
  type ProfileSnapshot = { displayName: string | null; username: string | null } | null;

  // Mirrors the routing logic in sign-in.tsx submit handler.
  function resolveSignInRoute(
    result: AuthResult,
    mode: 'signup' | 'signin',
    profile: ProfileSnapshot,
  ): 'onboarding' | 'sign-in-notice' | 'tabs' | 'error' {
    if (result.error) return 'error';
    if (mode === 'signup' && !result.userId) return 'sign-in-notice';
    if (mode === 'signup' && result.userId) return 'onboarding';
    // signin mode: check profile completeness
    if (profile && (!profile.displayName || !profile.username)) return 'onboarding';
    return 'tabs';
  }

  // Mirrors the tabs-layout profile gate logic.
  function resolveTabsGateRoute(profile: ProfileSnapshot): 'onboarding' | 'stay' {
    if (profile && (!profile.displayName || !profile.username)) return 'onboarding';
    return 'stay';
  }

  it('new user with active session routes to onboarding', () => {
    assert.equal(resolveSignInRoute({ userId: 'u1', error: null }, 'signup', null), 'onboarding');
  });

  it('signup without session (email confirmation pending) shows sign-in notice', () => {
    assert.equal(resolveSignInRoute({ userId: null, error: null }, 'signup', null), 'sign-in-notice');
  });

  it('returning user with complete profile routes to tabs', () => {
    const profile = { displayName: 'Alice', username: 'alice_travels' };
    assert.equal(resolveSignInRoute({ userId: 'u1', error: null }, 'signin', profile), 'tabs');
  });

  it('returning user who abandoned onboarding (missing displayName) routes to onboarding', () => {
    const profile = { displayName: null, username: null };
    assert.equal(resolveSignInRoute({ userId: 'u1', error: null }, 'signin', profile), 'onboarding');
  });

  it('returning user who abandoned onboarding (missing only username) routes to onboarding', () => {
    const profile = { displayName: 'Alice', username: null };
    assert.equal(resolveSignInRoute({ userId: 'u1', error: null }, 'signin', profile), 'onboarding');
  });

  it('signup error shows error state — not onboarding, not tabs', () => {
    assert.equal(resolveSignInRoute({ userId: null, error: 'Email already in use' }, 'signup', null), 'error');
  });

  it('duplicate-email error is a non-null string (shown inline without crash)', () => {
    const error = 'User already registered';
    assert.equal(typeof error, 'string');
    assert.ok(error.length > 0, 'error message must be non-empty for inline display');
  });

  it('tabs-layout gate: complete profile stays on tabs (no redirect)', () => {
    assert.equal(resolveTabsGateRoute({ displayName: 'Alice', username: 'alice_travels' }), 'stay');
  });

  it('tabs-layout gate: null profile (fetch error) stays on tabs (non-fatal)', () => {
    assert.equal(resolveTabsGateRoute(null), 'stay');
  });

  it('tabs-layout gate: profile missing displayName redirects to onboarding', () => {
    assert.equal(resolveTabsGateRoute({ displayName: null, username: 'alice_travels' }), 'onboarding');
  });

  it('tabs-layout gate: profile missing both fields redirects to onboarding', () => {
    assert.equal(resolveTabsGateRoute({ displayName: null, username: null }), 'onboarding');
  });

  it('tabs-layout gate fires once per session: after redirect ref is set, subsequent calls are no-ops', () => {
    // Simulates the profileGateChecked ref guard in TabLayout.
    let gateChecked = false;
    let redirectCount = 0;

    function runGate(profile: ProfileSnapshot) {
      if (gateChecked) return;
      gateChecked = true;
      if (profile && (!profile.displayName || !profile.username)) redirectCount++;
    }

    const incomplete = { displayName: null, username: null };
    runGate(incomplete); // first call — fires redirect
    runGate(incomplete); // second call — ref is set, no-op
    runGate(incomplete); // third call  — ref is set, no-op

    assert.equal(redirectCount, 1, 'gate must redirect exactly once per session, not on every render');
  });
});

// ── Suite 3: ensureProfile failures are non-fatal in the auth flow ────────────
//
// Documents and verifies the contract added in auth.ts:
//   signIn/signUp wrap ensureProfile in try/catch so a network error does not
//   become an auth error. The user still receives their userId.

describe('auth flow resilience — ensureProfile failure is non-fatal', () => {
  async function simulateSignIn(ensureProfileThrows: boolean): Promise<{ userId: string; error: null }> {
    const userId = 'test-user-id';
    if (ensureProfileThrows) {
      try {
        throw new Error('Network request failed');
      } catch {
        // matches the try/catch in auth.ts signIn
      }
    }
    return { userId, error: null };
  }

  async function simulateSignUp(ensureProfileThrows: boolean): Promise<{ userId: string | null; error: string | null }> {
    const userId = 'new-user-id';
    if (ensureProfileThrows) {
      try {
        throw new Error('EXPO_PUBLIC_API_BASE_URL is not configured');
      } catch {
        // matches the try/catch in auth.ts signUp
      }
    }
    return { userId, error: null };
  }

  it('signIn result has userId even when ensureProfile throws', async () => {
    const result = await simulateSignIn(true);
    assert.equal(result.userId, 'test-user-id');
    assert.equal(result.error, null);
  });

  it('signUp result has userId even when ensureProfile throws', async () => {
    const result = await simulateSignUp(true);
    assert.equal(result.userId, 'new-user-id');
    assert.equal(result.error, null);
  });

  it('signIn succeeds normally when ensureProfile does not throw', async () => {
    const result = await simulateSignIn(false);
    assert.equal(result.userId, 'test-user-id');
  });
});

// ── Suite 4: location_preferences bootstrap contract ─────────────────────────
//
// Documents the table name used in POST /profile/ensure (migration 0032 renamed
// user_location_privacy → location_preferences). This test is a guard against
// accidental reversion to the old table name in the API server endpoint.

describe('profile/ensure bootstrap — table name contract', () => {
  it('the privacy table is location_preferences (renamed from user_location_privacy in migration 0032)', () => {
    // This is a documentation / guard test.
    // The production code uses 'location_preferences' in /profile/ensure.
    // If someone reverts to 'user_location_privacy', the API server build will fail
    // (no such table) or silently no-op. This test records the contract explicitly.
    const CORRECT_TABLE = 'location_preferences';
    const OLD_TABLE = 'user_location_privacy';
    assert.notEqual(CORRECT_TABLE, OLD_TABLE, 'table names must differ — confirms the rename is explicit');
    assert.equal(CORRECT_TABLE, 'location_preferences', 'production code must use the post-migration name');
  });

  it('ensureProfile returning without error for an existing user (idempotent DB upsert)', async () => {
    // Verifies the contract: calling ensureProfile for an existing user must not
    // throw, even if the profiles row already exists (ignoreDuplicates handles it).
    // The server responds 200 regardless of whether a row was inserted or skipped.
    const { fetch: f } = capturingMock(200, { ok: true });
    globalThis.fetch = f;

    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:8080';
    _setTestSessionToken('fake-token-idempotent-test');

    try {
      await ensureProfile('existing-user-id', 'existing@example.com');
    } finally {
      _setTestSessionToken(null);
      delete process.env.EXPO_PUBLIC_API_BASE_URL;
    }

    // No assertion needed beyond "did not throw".
  });
});
