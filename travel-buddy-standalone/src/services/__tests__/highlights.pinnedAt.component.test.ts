/**
 * highlights service — `pinnedAt` survives the read.
 *
 * Highlights/Memories Development Architecture Spec v1 §12 (manual_pin) and
 * §17 (UNPIN_HIGHLIGHT). Census H100 / H142 / H143.
 *
 * ── THE DEFECT THIS GUARDS ─────────────────────────────────────────────────
 *
 * `POST /highlights/:id/pin` writes `pinned_at`, `GET /users/:id/highlights`
 * projects it as `pinnedAt` and orders on it, and HighlightViewer renders a pin
 * affordance off it. But `mapHighlight` did not copy the field, so every
 * Highlight reaching the client carried `pinnedAt: undefined` no matter what
 * the server had stored.
 *
 * That is not a cosmetic drop. The viewer decides PIN versus UNPIN from that
 * value, so a Highlight pinned in an earlier session reopened as "not pinned":
 * the only affordance offered was PIN again, and UNPIN_HIGHLIGHT — the command
 * §17 requires precisely so that a pin is not a trap — was unreachable for any
 * Highlight the user had not pinned in the current session.
 *
 * The second test is the one that would have caught it in the shape it shipped:
 * a `pinnedAt` of `null` (the server's answer for "not pinned") and an ABSENT
 * `pinnedAt` (a deployment without migration 2723, where the route omits the
 * class fields entirely) must not be flattened into the same value, because
 * "this deployment cannot pin" and "this Highlight is not pinned" are different
 * answers and only one of them should offer the affordance.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — lib/supabase initialises a real client from
// env at import time, which the jest-expo runner has no credentials for. Only
// the configured flag is read by the code under test.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: null,
}));

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session
// for a live JWT. The service only needs a non-empty token to proceed past its
// unauthenticated guard.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import { fetchUserHighlights, type Highlight } from '../highlights.ts';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PINNED_AT = '2026-09-15T10:00:00.000Z';

/** One row exactly as `GET /api/users/:id/highlights` serves it. */
function wireRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    owner_id: OWNER,
    media_url: 'https://example.test/h.jpg',
    media_type: 'image/jpeg',
    video_duration_seconds: null,
    caption: null,
    location_name: null,
    location_city: null,
    location_country: null,
    visibility: 'public',
    expires_at: '2026-09-23T10:00:00.000Z',
    created_at: '2026-09-22T10:00:00.000Z',
    deleted_at: null,
    viewCount: 0,
    likeCount: 0,
    viewedByMe: false,
    likedByMe: false,
    ...over,
  };
}

function serve(rows: Array<Record<string, unknown>>) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ highlights: rows }),
  })) as unknown as typeof fetch;
}

describe('fetchUserHighlights — §12 pin state', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  });

  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  });

  it('carries the server’s pinnedAt through to the client model', async () => {
    global.fetch = serve([wireRow({ pinnedAt: PINNED_AT })]);

    const r = await fetchUserHighlights(OWNER);

    expect(r.ok).toBe(true);
    const highlights: Highlight[] = r.data ?? [];
    expect(highlights).toHaveLength(1);
    // Without this the viewer cannot tell a pinned Highlight from an unpinned
    // one, and UNPIN_HIGHLIGHT is unreachable across sessions.
    expect(highlights[0].pinnedAt).toBe(PINNED_AT);
  });

  it('keeps "not pinned" and "this deployment cannot pin" apart', async () => {
    global.fetch = serve([
      wireRow({ id: 'a0000000-0000-4000-8000-000000000001', pinnedAt: null }),
      // Migration 2723 absent: the route omits the class fields entirely rather
      // than failing the whole PostgREST select.
      wireRow({ id: 'a0000000-0000-4000-8000-000000000002' }),
    ]);

    const r = await fetchUserHighlights(OWNER);
    const highlights: Highlight[] = r.data ?? [];

    expect(highlights[0].pinnedAt).toBeNull();
    expect(highlights[1].pinnedAt).toBeUndefined();
  });
});
