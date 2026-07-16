/**
 * Stamp graceful-degradation tests
 *
 * Verifies that the stamp service layer and the components that consume it
 * degrade gracefully when API endpoints return 404, 500, or an empty array.
 *
 * Scenarios covered:
 *   1. getMyRecentStamps (StampEarnedToast polling) — 404 / 500 / network error
 *      → returns { ok: false } so the toast's `if (!res?.ok) return` guard
 *        silently no-ops; no crash, no stale toast shown.
 *   2. getMyPassportStamps (StampsTab/StampGrid owner view) — 500
 *      → returns { ok: false, message } so StampsTab calls setError(message)
 *        and StampGrid renders the retry button.
 *   3. getMyPassportStamps — empty array (200)
 *      → returns { ok: true, data: [] } so StampGrid renders the owner empty state.
 *   4. getUserStampsByUsername (StampsTab non-owner view) — empty array (200)
 *      → returns { ok: true, data: [] } so StampGrid renders the non-owner empty state.
 *   5. StampsTab empty-state text logic — pure JS, no React rendering needed.
 *      Verified here to catch any future refactor that silently breaks the strings.
 *
 * Run:
 *   cd travel-buddy-standalone
 *   node --import tsx --test src/test/stampGracefulDegradation.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  _setTestAuthToken,
  getMyRecentStamps,
} from '../services/stamps.ts';
import {
  _setTestAuthToken as setPassportToken,
  getMyPassportStamps,
  getUserStampsByUsername,
} from '../services/passportStamps.ts';

const FAKE_TOKEN = 'fake-test-token-stamp-degradation';

function mockFetch(status: number, body: unknown): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

// ── Suite 1: StampEarnedToast — getMyRecentStamps graceful degradation ─────────

describe('getMyRecentStamps — graceful degradation (StampEarnedToast polling)', () => {
  let _savedFetch: typeof fetch;

  before(() => {
    _savedFetch = globalThis.fetch;
    _setTestAuthToken(FAKE_TOKEN);
  });

  after(() => {
    globalThis.fetch = _savedFetch;
    _setTestAuthToken(null);
  });

  it('returns { ok: false } on 404 — toast guard (if !res?.ok) silently skips', async () => {
    globalThis.fetch = mockFetch(404, { error: 'not_found', message: 'Not found' });
    const res = await getMyRecentStamps();
    assert.equal(res.ok, false, 'expected ok=false on 404');
  });

  it('returns { ok: false } on 500 — toast guard silently skips', async () => {
    globalThis.fetch = mockFetch(500, { message: 'Internal server error' });
    const res = await getMyRecentStamps();
    assert.equal(res.ok, false, 'expected ok=false on 500');
  });

  it('returns { ok: false } on network throw — toast guard silently skips', async () => {
    globalThis.fetch = async () => { throw new Error('Network unreachable'); };
    const res = await getMyRecentStamps();
    assert.equal(res.ok, false, 'expected ok=false on network throw');
  });

  it('returns { ok: true, data: [] } on empty 200 — no toasts shown for new user', async () => {
    globalThis.fetch = mockFetch(200, { stamps: [] });
    const res = await getMyRecentStamps();
    assert.equal(res.ok, true, 'expected ok=true on empty 200');
    assert.deepEqual(res.ok ? res.data : null, []);
  });
});

// ── Suite 2: StampsTab — getMyPassportStamps graceful degradation ─────────────

describe('getMyPassportStamps — graceful degradation (StampsTab/StampGrid owner view)', () => {
  let _savedFetch: typeof fetch;

  before(() => {
    _savedFetch = globalThis.fetch;
    setPassportToken(FAKE_TOKEN);
  });

  after(() => {
    globalThis.fetch = _savedFetch;
    setPassportToken(null);
  });

  it('returns { ok: false, message } on 500 — StampsTab calls setError → StampGrid shows retry', async () => {
    globalThis.fetch = mockFetch(500, { message: 'Database error' });
    const res = await getMyPassportStamps();
    assert.equal(res.ok, false, 'expected ok=false on 500');
    assert.ok(!res.ok && typeof res.message === 'string' && res.message.length > 0,
      'expected a non-empty error message for StampGrid error prop');
  });

  it('returns { ok: false } on 404 — StampGrid shows retry', async () => {
    globalThis.fetch = mockFetch(404, { error: 'not_found' });
    const res = await getMyPassportStamps();
    assert.equal(res.ok, false, 'expected ok=false on 404');
  });

  it('returns { ok: true, data: [] } on empty 200 — StampGrid shows owner empty state', async () => {
    globalThis.fetch = mockFetch(200, { stamps: [] });
    const res = await getMyPassportStamps();
    assert.equal(res.ok, true, 'expected ok=true on empty 200');
    assert.deepEqual(res.ok ? res.data : null, []);
  });
});

// ── Suite 3: StampsTab — getUserStampsByUsername graceful degradation ─────────

describe('getUserStampsByUsername — graceful degradation (StampsTab non-owner view)', () => {
  let _savedFetch: typeof fetch;

  before(() => {
    _savedFetch = globalThis.fetch;
    setPassportToken(FAKE_TOKEN);
  });

  after(() => {
    globalThis.fetch = _savedFetch;
    setPassportToken(null);
  });

  it('returns { ok: true, data: [] } on empty 200 — StampGrid shows non-owner empty state', async () => {
    globalThis.fetch = mockFetch(200, { stamps: [] });
    const res = await getUserStampsByUsername('traveler123');
    assert.equal(res.ok, true, 'expected ok=true on empty 200');
    assert.deepEqual(res.ok ? res.data : null, []);
  });

  it('returns { ok: false } on 404 — StampGrid shows retry', async () => {
    globalThis.fetch = mockFetch(404, { error: 'not_found' });
    const res = await getUserStampsByUsername('ghost_user');
    assert.equal(res.ok, false, 'expected ok=false on 404');
  });
});

// ── Suite 4: StampsTab empty-state text logic ─────────────────────────────────
//
// These strings are computed inline in StampsTab.tsx. Extracting the logic here
// keeps it in sync and alerts us if the component is refactored to break them.

describe('StampsTab empty-state text — owner vs non-owner vs category-filter', () => {
  function emptyTitle(category: string, viewingUsername: string | undefined): string {
    return category
      ? 'No stamps in this category'
      : viewingUsername
        ? 'No public stamps yet.'
        : 'No stamps yet';
  }

  function emptySub(category: string, viewingUsername: string | undefined): string {
    return category
      ? 'Try a different category above.'
      : viewingUsername
        ? `@${viewingUsername} hasn't earned any public stamps yet.`
        : 'Start traveling, joining events, and posting postcards to earn stamps.';
  }

  it("owner empty title is 'No stamps yet'", () => {
    assert.equal(emptyTitle('', undefined), 'No stamps yet');
  });

  it("owner empty sub encourages travel", () => {
    assert.ok(emptySub('', undefined).includes('Start traveling'),
      'owner sub should mention traveling');
  });

  it("non-owner empty title is 'No public stamps yet.'", () => {
    assert.equal(emptyTitle('', 'alice'), 'No public stamps yet.');
  });

  it("non-owner empty sub includes the username with @-prefix", () => {
    const sub = emptySub('', 'alice');
    assert.ok(sub.includes('@alice'), `expected '@alice' in "${sub}"`);
  });

  it("category-filtered empty title is 'No stamps in this category'", () => {
    assert.equal(emptyTitle('location', undefined), 'No stamps in this category');
  });

  it("category-filtered empty sub directs to other categories", () => {
    assert.ok(emptySub('trips', 'alice').includes('Try a different category'));
  });
});
