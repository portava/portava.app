/**
 * Shared Moment participation reads — testing mode WP-07 (HM-F17, HM-F18).
 *
 * The existing `request()` in `services/sharedMoments.ts` answers `null` for
 * EVERY failure, so the detail screen could not tell "you are not a member —
 * here is the invitation" from "the network dropped", and an unreadable feed
 * rendered as "Approved contributions will appear here". The participation
 * reads added at the foot of that module answer a typed result instead, and
 * this suite pins the routes they call and the refusals they keep apart.
 *
 * Run with: pnpm test:component
 */

// NOTE: exhaustive-by-design — the module reads only isSupabaseConfigured from
// lib/supabase, and the real module drags the native SecureStore chain in.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {},
  authedClient: () => ({}),
}));
// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));

import {
  loadSharedMoment,
  loadSharedMomentFeed,
  getSharedMomentPreview,
  listMySharedMomentInvites,
  listSharedMomentJoinRequests,
  listPendingSharedMomentContributions,
  listContributablePosts,
  listSharedMomentSuggestions,
  dismissSharedMomentSuggestion,
} from '../sharedMoments.ts';

const SM = '55555555-5555-4555-8555-555555555555';

interface Call { url: string; method: string }
let calls: Call[] = [];
let responses: Array<{ status: number; json: unknown } | 'throw'> = [];

const fakeFetch = jest.fn((url: string, opts: RequestInit = {}) => {
  calls.push({ url: String(url), method: String(opts.method ?? 'GET') });
  const next = responses.shift();
  if (next === 'throw' || next === undefined) return Promise.reject(new TypeError('Network request failed'));
  return Promise.resolve({ ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.json } as Response);
});

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  (globalThis as { fetch: unknown }).fetch = fakeFetch;
});
beforeEach(() => { calls = []; responses = []; });

describe('detail vs preview', () => {
  it('a member gets the detail', async () => {
    const detail = { moment: { id: SM, title: 'Sunset' }, members: [], chat: { available: false, reason: 'x' } };
    responses.push({ status: 200, json: detail });
    const r = await loadSharedMoment(SM);
    expect(calls[0].url).toBe(`http://api.test/api/shared-moments/${SM}`);
    expect(r).toEqual({ ok: true, data: detail });
  });

  it('a non-member is told not_member — distinct from a network drop', async () => {
    responses.push({ status: 403, json: { error: 'not_member', message: 'Join this Moment to view it' } });
    const r = await loadSharedMoment(SM);
    expect(r).toEqual({ ok: false, code: 'not_member', message: 'Join this Moment to view it' });

    responses.push('throw');
    const r2 = await loadSharedMoment(SM);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('network');
  });

  it('the preview reads GET /shared-moments/:id/preview', async () => {
    const preview = { moment: { id: SM, title: 'Sunset', joinPolicy: 'approval_required', status: 'active' }, myStatus: 'invited', myRole: null };
    responses.push({ status: 200, json: preview });
    const r = await getSharedMomentPreview(SM);
    expect(calls[0].url).toBe(`http://api.test/api/shared-moments/${SM}/preview`);
    expect(r).toEqual({ ok: true, data: preview });
  });

  it('an unreadable feed is an error, not "no contributions yet"', async () => {
    responses.push({ status: 500, json: { error: 'db_error', message: 'boom' } });
    const r = await loadSharedMomentFeed(SM);
    expect(calls[0].url).toBe(`http://api.test/api/shared-moments/${SM}/feed`);
    expect(r.ok).toBe(false);
  });
});

describe('participation lists', () => {
  it('invites come from GET /me/shared-moment-invites', async () => {
    responses.push({ status: 200, json: { invites: [{ moment: { id: SM }, invitedBy: null, invitedAt: null }] } });
    const r = await listMySharedMomentInvites();
    expect(calls[0].url).toBe('http://api.test/api/me/shared-moment-invites');
    expect(r.ok && r.data.length).toBe(1);
  });

  it('an unreadable invite list is an error', async () => {
    responses.push({ status: 503, json: { error: 'degraded_unavailable', message: 'We could not load your invitations. Please try again.' } });
    const r = await listMySharedMomentInvites();
    expect(r).toEqual({ ok: false, code: 'degraded_unavailable', message: 'We could not load your invitations. Please try again.' });
  });

  it('join requests, pending contributions and contributable posts read their routes', async () => {
    responses.push({ status: 200, json: { requests: [] } });
    responses.push({ status: 200, json: { contributions: [] } });
    responses.push({ status: 200, json: { posts: [] } });
    const a = await listSharedMomentJoinRequests(SM);
    const b = await listPendingSharedMomentContributions(SM);
    const c = await listContributablePosts(SM);
    expect(calls.map((x) => x.url)).toEqual([
      `http://api.test/api/shared-moments/${SM}/requests`,
      `http://api.test/api/shared-moments/${SM}/contributions`,
      `http://api.test/api/shared-moments/${SM}/contributable-posts`,
    ]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
  });

  it('a malformed 200 is an error, not an empty list', async () => {
    responses.push({ status: 200, json: { nope: true } });
    const r = await listSharedMomentJoinRequests(SM);
    expect(r.ok).toBe(false);
  });
});

describe('suggestions (HM-F18)', () => {
  it('reads GET /shared-moments/suggestions/mine and keeps the label', async () => {
    responses.push({ status: 200, json: { suggestions: [{ id: 'sg1', momentId: SM, kind: 'compass', reason: 'r', label: 'Suggestion — no one is joined or added automatically.', createdAt: 'x' }], labeled: true } });
    const r = await listSharedMomentSuggestions();
    expect(calls[0].url).toBe('http://api.test/api/shared-moments/suggestions/mine');
    expect(r.ok && r.data[0].label).toBe('Suggestion — no one is joined or added automatically.');
  });

  it('dismiss POSTs /shared-moments/suggestions/:id/dismiss', async () => {
    responses.push({ status: 200, json: { ok: true } });
    const r = await dismissSharedMomentSuggestion('sg1');
    expect(calls[0]).toEqual({ url: 'http://api.test/api/shared-moments/suggestions/sg1/dismiss', method: 'POST' });
    expect(r.ok).toBe(true);
  });
});
