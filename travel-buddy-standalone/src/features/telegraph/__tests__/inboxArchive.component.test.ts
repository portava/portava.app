/**
 * Owner ruling 2026-10-17 — "Allow users to unarchive conversations": the two
 * pieces under the inbox's Archived section.
 *
 *   unarchiveThread (inbox/archiveApi.ts) — POST /api/threads/:id/unarchive.
 *     ok ONLY when the server answered 2xx AND its read-back says the
 *     conversation is unarchived; anything else is a failure carrying the
 *     server's own sentence when it sent one. Never throws.
 *   splitArchived (inbox/archivedThreads.ts) — which conversations the main
 *     list shows and which the Archived section shows. An unarchive this screen
 *     made and the server confirmed holds until the server's copy catches up;
 *     an archive the server reports AFTER it (a different archivedAt) wins.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

// NOTE: intentionally exhaustive — lib/supabase builds a client at import time.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the call takes one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1' }));

import { unarchiveThread } from '../inbox/archiveApi.ts';
import { splitArchived } from '../inbox/archivedThreads.ts';

const realFetch = global.fetch;
afterAll(() => { global.fetch = realFetch; });

function answer(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
  return calls;
}

describe('unarchiveThread', () => {
  beforeEach(() => { process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; });

  it('POSTs to the conversation\'s own unarchive route, authenticated', async () => {
    const calls = answer(200, { ok: true, threadId: 't-1', archivedAt: null, changed: true });
    expect(await unarchiveThread('t-1')).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.test/api/threads/t-1/unarchive');
    expect(calls[0]!.init?.method).toBe('POST');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  });

  it('idempotent answer (changed: false) is still ok — it IS unarchived', async () => {
    answer(200, { ok: true, threadId: 't-1', archivedAt: null, changed: false });
    expect(await unarchiveThread('t-1')).toEqual({ ok: true });
  });

  it('a refusal carries the server\'s sentence', async () => {
    answer(403, { error: 'forbidden', message: 'Not a member of this thread' });
    expect(await unarchiveThread('t-1')).toEqual({ ok: false, message: 'Not a member of this thread' });
    answer(503, { error: 'degraded_unavailable', message: 'We could not check your access to this conversation right now. Please try again shortly.' });
    expect(await unarchiveThread('t-1')).toEqual({ ok: false, message: 'We could not check your access to this conversation right now. Please try again shortly.' });
  });

  it('a 2xx whose read-back does not say unarchived is NOT ok', async () => {
    answer(200, { ok: true, threadId: 't-1', archivedAt: '2026-10-16T09:00:00.000Z' });
    expect(await unarchiveThread('t-1')).toEqual({ ok: false, message: null });
    answer(200, null);
    expect(await unarchiveThread('t-1')).toEqual({ ok: false, message: null });
  });

  it('a network failure is a failure, never a throw', async () => {
    global.fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }) as typeof fetch;
    expect(await unarchiveThread('t-1')).toEqual({ ok: false, message: null });
  });

  it('no API configured: a failure, and nothing is sent', async () => {
    process.env.EXPO_PUBLIC_API_BASE_URL = '';
    const calls = answer(200, { ok: true, archivedAt: null });
    expect(await unarchiveThread('t-1')).toEqual({ ok: false, message: null });
    expect(calls).toHaveLength(0);
  });
});

describe('splitArchived', () => {
  const A = '2026-10-16T09:00:00.000Z';
  const t = (id: string, archivedAt: string | null) => ({ id, archivedAt });

  it('keeps the server\'s order within each list', () => {
    const { active, archived } = splitArchived([t('a', null), t('b', A), t('c', null), t('d', A)], new Map());
    expect(active.map((x) => x.id)).toEqual(['a', 'c']);
    expect(archived.map((x) => x.id)).toEqual(['b', 'd']);
  });

  it('a confirmed unarchive moves the conversation to the main list, as unarchived, before the server copy catches up', () => {
    const { active, archived } = splitArchived([t('a', null), t('b', A)], new Map([['b', A]]));
    expect(active).toEqual([t('a', null), t('b', null)]);
    expect(archived).toEqual([]);
  });

  it('an archive the server reports AFTER the unarchive (a different archivedAt) wins', () => {
    const later = '2026-10-18T09:00:00.000Z';
    const { active, archived } = splitArchived([t('b', later)], new Map([['b', A]]));
    expect(active).toEqual([]);
    expect(archived).toEqual([t('b', later)]);
  });
});
