/**
 * The Highlights client keeps the SERVER's word for "the read did not happen".
 *
 * Highlights/Memories Development Architecture Spec v1 §28.11.
 *
 * THE DEFECT THIS GUARDS. `GET /api/highlights/following-feed` answers 503
 * `degraded_unavailable` when the follow graph could not be read, with this in
 * the handler's own words: *"NOBODY YOU FOLLOW HAS AN ACTIVE HIGHLIGHT IS A
 * CLAIM ABOUT OTHER PEOPLE, AND IT MUST BE TRUE"*. It is a distinct, RETRYABLE
 * code, deliberately separate from `db_error`.
 *
 * `mapApiError` did not list `degraded_unavailable` among the codes it knows,
 * so it flattened it to `db_error` — a second, disagreeing vocabulary on the
 * client for a word the server owns. The two failures the server went to the
 * trouble of splitting arrived at the UI indistinguishable.
 *
 * Run with: pnpm test:component
 */
process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';

jest.mock('../../lib/supabase.ts', () => ({
  ...jest.requireActual('../../lib/supabase.ts'),
  isSupabaseConfigured: true,
}));

jest.mock('../../services/apiToken.ts', () => ({
  ...jest.requireActual('../../services/apiToken.ts'),
  freshToken: async () => 'test-token',
}));

import { fetchFollowingHighlightsFeed, fetchUserHighlights } from '../highlights.ts';

const realFetch = global.fetch;

function respondWith(status: number, body: unknown) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
});

describe('highlights client — the server\'s refusal keeps its name', () => {
  it('preserves degraded_unavailable from the following feed instead of flattening it to db_error', async () => {
    respondWith(503, {
      error: 'degraded_unavailable',
      message: 'We could not load your highlights feed. Please try again.',
    });

    const r = await fetchFollowingHighlightsFeed();

    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('degraded_unavailable');
  });

  it('preserves degraded_unavailable on a profile Highlights read too', async () => {
    respondWith(503, { error: 'degraded_unavailable', message: 'try again' });

    const r = await fetchUserHighlights('some-user-id');

    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('degraded_unavailable');
  });

  it('still reports a genuine db_error as db_error', async () => {
    respondWith(500, { error: 'db_error', message: 'boom' });

    const r = await fetchFollowingHighlightsFeed();

    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('db_error');
  });
});
