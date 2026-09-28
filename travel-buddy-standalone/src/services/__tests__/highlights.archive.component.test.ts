/**
 * highlights service — §21 Archive, and the refusal that must not become a list.
 *
 * Highlights/Memories Development Architecture Spec v1 §21 and §28.11 ("never
 * swallow projection/schema failures into plausible-looking empty history
 * without structured error state").
 *
 * `GET /highlights/archived` refuses with `degraded_unavailable` rather than
 * serving `{highlights: []}`, and it does that FOR THIS FUNCTION: the archive
 * is the owner's retained record, and "you have archived nothing" printed for
 * an outage tells somebody their retained record is gone. The three tests
 * below are the three ways that refusal could have been lost on the way to a
 * screen — a mapped error, a network throw, and the unconfigured branch, which
 * the older reads in this module answer with `{ok: true, data: []}` and this
 * one deliberately does not.
 *
 * Run with: pnpm test:component
 */

// NOTE: intentionally exhaustive — lib/supabase builds a real client from env
// at import time. Only the configured flag is read by the code under test.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: null,
}));

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import {
  fetchArchivedHighlights,
  archiveHighlight,
  unarchiveHighlight,
} from '../highlights.ts';

const HID = '22222222-2222-4222-8222-222222222222';

function archivedRow() {
  return {
    id: HID,
    owner_id: '11111111-1111-4111-8111-111111111111',
    media_url: 'https://example.test/h.jpg',
    media_type: 'image/jpeg',
    caption: 'Lanterns',
    visibility: 'public',
    expires_at: '2026-09-01T00:00:00.000Z',
    created_at: '2026-08-30T00:00:00.000Z',
    deleted_at: null,
    archived_at: '2026-09-10T00:00:00.000Z',
  };
}

describe('§21 archive — the client half', () => {
  const realFetch = global.fetch;
  const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;

  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });
  afterEach(() => {
    global.fetch = realFetch;
    process.env.EXPO_PUBLIC_API_BASE_URL = realBase;
  });

  it('lists the archive and carries archivedAt through', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200, json: async () => ({ highlights: [archivedRow()] }),
    })) as unknown as typeof fetch;

    const r = await fetchArchivedHighlights();
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data?.[0].archivedAt).toBe('2026-09-10T00:00:00.000Z');
  });

  it('passes the server’s degraded_unavailable through instead of an empty archive', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false, status: 503,
      json: async () => ({ error: 'degraded_unavailable', message: 'could not load' }),
    })) as unknown as typeof fetch;

    const r = await fetchArchivedHighlights();
    expect(r.ok).toBe(false);
    // Not `db_error`: the retry is worth offering for this one and the word is
    // the server's.
    expect(r.errorKind).toBe('degraded_unavailable');
    expect(r.data).toBeNull();
  });

  it('reports an offline read as offline, not as an empty archive', async () => {
    global.fetch = jest.fn(async () => { throw new Error('Network request failed'); }) as unknown as typeof fetch;

    const r = await fetchArchivedHighlights();
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('network_unreachable');
    expect(r.data).toBeNull();
  });

  it('refuses when the backend is not configured rather than answering "nothing archived"', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = '';
    const r = await fetchArchivedHighlights();
    expect(r.ok).toBe(false);
    expect(r.errorKind).toBe('config_error');
    expect(r.data).toBeNull();
  });

  it('archives with POST and un-archives with DELETE on the same path', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), method: init?.method });
      return { ok: true, status: 200, json: async () => ({ id: HID, archivedAt: null }) };
    }) as unknown as typeof fetch;

    await archiveHighlight(HID);
    await unarchiveHighlight(HID);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://api.test/api/highlights/${HID}/archive`);
    expect(calls[0].method).toBe('POST');
    expect(calls[1].url).toBe(`https://api.test/api/highlights/${HID}/archive`);
    expect(calls[1].method).toBe('DELETE');
  });
});
