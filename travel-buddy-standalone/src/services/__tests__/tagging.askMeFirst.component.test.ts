/**
 * tagging — "Ask me first" (census-discovery §95, lane W11-X3; §81.4 routed
 * hunk R3; DV-76).
 *
 *   A1  the settings list is the four options, unchanged, unless the server
 *       offers "Ask me first" or it is already the stored choice
 *   A2  GET /api/me/tags/pending: 404 feature_disabled ⇒ `disabled`; 200 ⇒ the
 *       tags; anything else (5xx, no session, network) ⇒ `error`, never `disabled`
 *       and never an empty inbox
 *   A3  approve posts to /api/tags/:id/approve; decline is DELETE /api/tags/:id
 *   A4  the inbox loses exactly the answered tag; the line names the tagger by @handle
 *
 * Run with: pnpm test:component (jest: the module chain reaches react-native)
 */
// NOTE: intentionally exhaustive — the real Supabase client pulls react-native
// native internals that crash under jest-expo. apiToken's session reads go through
// its own `_setTestSupabase` seam, so the token chain below is the production one.
jest.mock('../../lib/supabase', () => ({ supabase: {}, isSupabaseConfigured: true }));

import assert from 'node:assert/strict';
import { _setTestSupabase, _resetTestSupabase } from '../apiToken.ts';
import {
  TAG_PERMISSION_OPTIONS, ASK_ME_FIRST_OPTION, tagPermissionOptions, fetchPendingTags, approvePendingTag,
  declinePendingTag, withoutPendingTag, pendingTagLine, type PendingTag,
} from '../tagging.ts';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const session = (token: string | null) => ({
  auth: {
    getSession: () => Promise.resolve({ data: { session: token ? { access_token: token, expires_at: FAR_FUTURE } : null } }),
    refreshSession: () => Promise.resolve({ data: { session: token ? { access_token: token } : null } }),
  },
});
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string }> = [];
function serve(r: { status: number; body: unknown } | 'throw') {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url).replace(/^.*\/api/, '/api'), method: String(init.method ?? 'GET') });
    if (r === 'throw') throw new Error('down');
    return { ok: r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
}
beforeEach(() => { calls = []; _setTestSupabase(session('tok') as any); });
afterEach(() => { globalThis.fetch = realFetch; _resetTestSupabase(); });

const T = (id: string, over: Partial<PendingTag> = {}): PendingTag =>
  ({ id, sourceType: 'post', sourceId: 's', taggedAt: null, taggerId: 'u', taggerHandle: 'ana', ...over });

describe('A — Ask me first', () => {
  it('A1 the four options unless offered or already chosen', () => {
    assert.equal(tagPermissionOptions(false), TAG_PERMISSION_OPTIONS, 'the same list, not a copy');
    assert.deepEqual(TAG_PERMISSION_OPTIONS.map((o) => o.key), ['anyone', 'interacted', 'friends_only', 'nobody']);
    assert.deepEqual(tagPermissionOptions(true).map((o) => o.key), ['anyone', 'interacted', 'friends_only', 'nobody', 'approval_required']);
    assert.deepEqual(tagPermissionOptions(false, 'approval_required').at(-1), ASK_ME_FIRST_OPTION);
    assert.equal(ASK_ME_FIRST_OPTION.label, 'Ask me first');
  });

  it('A2 the probe: disabled, ok, or error — never a guessed empty inbox', async () => {
    serve({ status: 404, body: { error: 'feature_disabled' } });
    assert.deepEqual(await fetchPendingTags(), { status: 'disabled' });
    assert.deepEqual(calls, [{ url: '/api/me/tags/pending', method: 'GET' }]);
    serve({ status: 200, body: { tags: [{ id: 't1', sourceType: 'comment', sourceId: 's1', taggedAt: '2026-09-28T00:00:00Z', taggerId: 'u1', taggerHandle: 'ana' }, { id: 7 }] } });
    assert.deepEqual(await fetchPendingTags(), { status: 'ok', tags: [{ id: 't1', sourceType: 'comment', sourceId: 's1', taggedAt: '2026-09-28T00:00:00Z', taggerId: 'u1', taggerHandle: 'ana' }] });
    serve({ status: 503, body: { error: 'db_error', message: 'Could not read your pending tags' } });
    assert.deepEqual(await fetchPendingTags(), { status: 'error', error: 'Could not read your pending tags' });
    serve({ status: 404, body: { error: 'not_found' } });
    assert.equal((await fetchPendingTags()).status, 'error', 'a 404 that is not feature_disabled is not "off"');
    serve('throw');
    assert.equal((await fetchPendingTags()).status, 'error');
    _setTestSupabase(session(null) as any);
    calls = [];
    assert.equal((await fetchPendingTags()).status, 'error');
    assert.equal(calls.length, 0);
  });

  it('A3 approve and decline reach their routes; a refusal is reported', async () => {
    serve({ status: 200, body: { ok: true, tagId: 't/1', status: 'approved' } });
    assert.deepEqual(await approvePendingTag('t/1'), { ok: true });
    assert.deepEqual(calls.at(-1), { url: '/api/tags/t%2F1/approve', method: 'POST' });
    serve({ status: 409, body: { error: 'conflict', message: 'This tag was removed' } });
    assert.deepEqual(await approvePendingTag('t1'), { ok: false, error: 'This tag was removed' });
    serve({ status: 200, body: { ok: true } });
    assert.deepEqual(await declinePendingTag('t1'), { ok: true });
    assert.deepEqual(calls.at(-1), { url: '/api/tags/t1', method: 'DELETE' });
    serve({ status: 403, body: { error: 'forbidden', message: 'You can only remove your own tags' } });
    assert.equal((await declinePendingTag('t1')).ok, false);
  });

  it('A4 the inbox loses exactly the answered tag; the tagger is named by @handle', () => {
    const tags = [T('a'), T('b'), T('c')];
    assert.deepEqual(withoutPendingTag(tags, 'b').map((t) => t.id), ['a', 'c']);
    assert.equal(pendingTagLine(T('a')), '@ana tagged you in a post');
    assert.equal(pendingTagLine(T('a', { taggerHandle: null, sourceType: 'message' })), 'Someone tagged you in a message');
  });
});
