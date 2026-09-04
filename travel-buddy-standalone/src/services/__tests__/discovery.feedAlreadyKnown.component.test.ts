/**
 * discovery service — getDiscoveryFeed + recordAlreadyKnown wire behaviour.
 *
 * These are the two client callers this task added for the previously-uncalled
 * endpoints:
 *   • GET  /api/discovery/feed        (serve point 7 — the unified feed)
 *   • POST /api/discovery/already-known (already_known memory feedback)
 *
 * What this pins:
 *   getDiscoveryFeed
 *     • requires city OR lat+lng (no blind request)
 *     • sends the Bearer token when signed in (so the server resolves a viewer
 *       and writes the serve-point-7 impression + returns event posts)
 *     • forwards includePlaces=0 so the posts-only rail never fetches places
 *     • parses the envelope, including the served-rank-context `sessionId`
 *   recordAlreadyKnown
 *     • refuses when signed out (no anonymous already_known write)
 *     • POSTs { placeId } with the Bearer token
 *
 * Named *.component.test.ts so it runs under jest (the node:test runner cannot
 * import discovery.ts → supabase.ts → react-native; see run-node-tests.mjs
 * KNOWN_BROKEN). It renders nothing — it exercises the service directly.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — discovery.ts imports the Supabase client for
// its module side effect only (these functions never touch it); the real module
// pulls react-native native internals that crash under jest-expo.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: false }));

const mockFreshToken = jest.fn(async (): Promise<string | null> => null);
// NOTE: intentionally exhaustive — apiToken.ts reads the Supabase session via
// native storage; the token value is all these tests need and it is controlled
// per test.
jest.mock('../apiToken', () => ({ freshToken: () => mockFreshToken() }));

import { getDiscoveryFeed, recordAlreadyKnown } from '../discovery.ts';

const API_BASE = 'http://api.test';

interface FetchCall { url: string; init: RequestInit }
let calls: FetchCall[];
let nextResponse: { status: number; body: unknown };

const realFetch = global.fetch;

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = API_BASE;
});
afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  mockFreshToken.mockReset();
  mockFreshToken.mockResolvedValue('tok-123');
  global.fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(nextResponse.body), {
        status: nextResponse.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
});

function authHeader(init: RequestInit): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  return h?.Authorization;
}

// ── getDiscoveryFeed ────────────────────────────────────────────────────────

describe('getDiscoveryFeed', () => {
  it('refuses when neither destination nor coordinates are given', async () => {
    const res = await getDiscoveryFeed({ destination: null });
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0); // no blind network call
  });

  it('sends the Bearer token, forwards includePlaces=0, and parses the envelope', async () => {
    nextResponse = {
      status: 200,
      body: {
        places: [],
        posts: [{ id: 'p1', authorId: 'u1', content: 'live!', mediaUrls: [] }],
        events: [],
        memories: [],
        sections: [],
        nextCursor: null,
        total: 1,
        destination: 'Miami',
        sourceSummary: { seededDbCount: 0, osmCount: 0, userCreatedCount: 1 },
        sessionId: 'sess-abc',
      },
    };

    const res = await getDiscoveryFeed({
      destination: 'Miami',
      lat: 25.77,
      lng: -80.19,
      radiusKm: 25,
      includePlaces: false,
      limit: 15,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.posts).toHaveLength(1);
    expect(res.data.posts[0].id).toBe('p1');
    expect(res.data.sessionId).toBe('sess-abc'); // served rank context threaded out

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toContain(`${API_BASE}/api/discovery/feed?`);
    expect(url).toContain('city=Miami');
    expect(url).toContain('lat=25.77');
    expect(url).toContain('includePlaces=0');
    expect(url).toContain('limit=15');
    expect(authHeader(init)).toBe('Bearer tok-123');
  });

  it('still calls the endpoint (no auth header) when signed out', async () => {
    mockFreshToken.mockResolvedValue(null);
    const res = await getDiscoveryFeed({ destination: 'Miami' });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(authHeader(calls[0].init)).toBeUndefined();
  });

  it('returns an error on a non-OK response', async () => {
    nextResponse = { status: 500, body: {} };
    const res = await getDiscoveryFeed({ destination: 'Miami' });
    expect(res.ok).toBe(false);
  });
});

// ── recordAlreadyKnown ──────────────────────────────────────────────────────

describe('recordAlreadyKnown', () => {
  it('refuses to write anonymously when signed out', async () => {
    mockFreshToken.mockResolvedValue(null);
    const res = await recordAlreadyKnown('db/abc');
    expect(res.ok).toBe(false);
    expect(calls.length).toBe(0); // no anonymous already_known write
  });

  it('POSTs { placeId } with the Bearer token', async () => {
    nextResponse = { status: 201, body: { recorded: true } };
    const res = await recordAlreadyKnown('db/abc');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(`${API_BASE}/api/discovery/already-known`);
    expect(init.method).toBe('POST');
    expect(authHeader(init)).toBe('Bearer tok-123');
    expect(JSON.parse(String(init.body))).toEqual({ placeId: 'db/abc' });
  });

  it('returns an error on a non-OK response', async () => {
    nextResponse = { status: 404, body: {} };
    const res = await recordAlreadyKnown('db/missing');
    expect(res.ok).toBe(false);
  });
});
