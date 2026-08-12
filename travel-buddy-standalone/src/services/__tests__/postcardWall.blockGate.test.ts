/**
 * Postcard-wall block gate — bidirectional coverage
 *
 * Confirms that `getPublicPostcards` — the client-side function that parses
 * the postcards-endpoint response and converts it into a `PostcardsSentinel` —
 * locks the postcard wall (returns `sentinel: 'blocked'`) when the server
 * signals a block relationship in **either** direction:
 *
 *   Direction A: viewer blocked the target
 *                Server emits: { blocked: true, direction: 'iBlockedThem' }
 *
 *   Direction B: target blocked the viewer
 *                Server emits: { blocked: true, direction: 'theyBlockedMe' }
 *
 * In both cases the client-side code must produce `sentinel: 'blocked'` so the
 * PostcardsTab renders PostcardSentinelView("blocked") rather than the live
 * postcard grid.  The wall must also be fully unlocked (no sentinel) when
 * neither user has blocked the other.
 *
 * Architecture note
 * ─────────────────
 * The actual block-relationship query runs server-side.  The client receives
 * a single boolean sentinel `{ blocked: true }` regardless of direction;
 * `getPublicPostcards` then maps this to `sentinel: 'blocked'`.  The test
 * exercises this mapping function with realistic server payloads for all three
 * scenarios.
 *
 * Red-proof variant
 * ─────────────────
 * A plausible regression: a future developer adds a direction guard and only
 * locks the wall when `direction === 'theyBlockedMe'` (target blocked viewer),
 * forgetting to also handle the `iBlockedThem` direction.  The test for
 * "viewer blocked target" would then fail — confirming the test is not a
 * tautology.
 *
 * NOTE: this file uses Jest syntax (not node:test) and is excluded from
 * run-node-tests.mjs's KNOWN_BROKEN list — importing getPublicPostcards pulls
 * in profile.ts -> apiToken.ts -> supabase.ts -> SecureStoreAdapter ->
 * react-native, which esbuild/tsx cannot transform outside Jest's own
 * transform pipeline ("Unexpected typeof" in react-native's Flow-typed
 * index.js). Same wall as auth.requestPasswordReset.test.ts.
 *
 * Run with: npx jest --forceExit --testPathPattern="postcardWall.blockGate"
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Environment bootstrap (must precede the module import) ────────────────
// profile.ts reads EXPO_PUBLIC_API_BASE_URL via apiBase(); if empty the
// function short-circuits and returns `{ ok: true, data: [] }` without making
// a fetch call, which would cause every test to silently pass.
process.env.EXPO_PUBLIC_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';

// ── Module under test ─────────────────────────────────────────────────────
import { getPublicPostcards, type PostcardsSentinel } from '../profile.ts';

// ── Fetch helpers ─────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown): typeof fetch {
  return async (_input: RequestInfo | URL, _init?: RequestInit) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response;
}

let savedFetch: typeof fetch;

beforeEach(() => {
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

// ── Direction A: viewer blocked the target ────────────────────────────────
//
// The server detects that the *viewer* has blocked the target and emits
// { blocked: true, direction: 'iBlockedThem' }.  The wall must be locked.

describe('postcard wall — viewer blocked target (direction: iBlockedThem)', () => {
  it('returns sentinel "blocked" when the server signals viewer-blocked-target', async () => {
    globalThis.fetch = mockFetch(200, { blocked: true, direction: 'iBlockedThem' });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return; // type-narrow, never reached
    expect(result.sentinel).toBe<PostcardsSentinel>('blocked');
  });

  it('returns an empty postcard list (not the real grid) for viewer-blocked-target', async () => {
    globalThis.fetch = mockFetch(200, { blocked: true, direction: 'iBlockedThem' });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });
});

// ── Direction B: target blocked the viewer ────────────────────────────────
//
// The server detects that the *target* has blocked the viewer and emits
// { blocked: true, direction: 'theyBlockedMe' }.  The wall must also be locked.

describe('postcard wall — target blocked viewer (direction: theyBlockedMe)', () => {
  it('returns sentinel "blocked" when the server signals target-blocked-viewer', async () => {
    globalThis.fetch = mockFetch(200, { blocked: true, direction: 'theyBlockedMe' });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sentinel).toBe<PostcardsSentinel>('blocked');
  });

  it('returns an empty postcard list (not the real grid) for target-blocked-viewer', async () => {
    globalThis.fetch = mockFetch(200, { blocked: true, direction: 'theyBlockedMe' });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });
});

// ── No block — wall must be open ──────────────────────────────────────────
//
// When neither user has blocked the other the server returns a normal postcards
// payload.  No sentinel must be set; the full grid is rendered.

describe('postcard wall — no block relationship', () => {
  it('returns no sentinel when the server returns a normal postcards payload', async () => {
    globalThis.fetch = mockFetch(200, {
      postcards: [
        { id: 'p1', postId: 'post1', caption: 'Hello!', media: [], createdAt: '2024-01-01T00:00:00Z' },
      ],
    });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // sentinel must be absent — PostcardsTab renders the grid, not a locked state
    expect(result.sentinel).toBeUndefined();
  });

  it('returns the postcard list when there is no block', async () => {
    globalThis.fetch = mockFetch(200, {
      postcards: [
        { id: 'p1', postId: 'post1', caption: 'Hello!', media: [], createdAt: '2024-01-01T00:00:00Z' },
      ],
    });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.length).toBe(1);
    expect(result.data[0].id).toBe('p1');
  });

  it('returns an empty postcard list with no sentinel when the user has no postcards', async () => {
    globalThis.fetch = mockFetch(200, { postcards: [] });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sentinel).toBeUndefined();
    expect(result.data).toEqual([]);
  });
});

// ── Direction-agnostic check: bare { blocked: true } with no direction field ─
//
// The current API may or may not emit a `direction` field.  The client must
// lock the wall regardless — `blocked: true` alone is sufficient.

describe('postcard wall — bare blocked sentinel (no direction field)', () => {
  it('returns sentinel "blocked" when payload is { blocked: true } with no direction', async () => {
    globalThis.fetch = mockFetch(200, { blocked: true });

    const result = await getPublicPostcards('targetuser');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sentinel).toBe<PostcardsSentinel>('blocked');
  });
});

// ── Red-proof documentation ────────────────────────────────────────────────
//
// The plausible regressed implementation:
//
//   // BUG: only locks the wall when *they* blocked *us* — forgets viewer-blocked-target
//   if (body.blocked === true && body.direction === 'theyBlockedMe') {
//     return { ok: true, data: [], sentinel: 'blocked' };
//   }
//
// Under that broken version:
//   - Direction A test ("viewer blocked target") would fail:
//       sentinel → undefined  (not 'blocked')
//   - Direction B test ("target blocked viewer") would still pass.
//   - Bare-sentinel test would also fail (no direction field → condition false).
//
// This was confirmed during development:
//   1. Temporarily applied the regressed one-directional guard to a local copy.
//   2. Ran: npx jest --forceExit --testPathPattern="postcardWall.blockGate"
//   3. Direction A test + bare-sentinel test both failed with:
//        Expected: "blocked"  /  Received: undefined
//   4. Direction B test remained green (as expected — the broken code still
//      handles one direction).
//   5. Restored the correct `if (body.blocked === true)` check → all green.
//
// Because the code-under-test lives in the production file (profile.ts line 390)
// and a jest.mock / manual stub is NOT used, the test exercises the real
// production path — not a tautology.
