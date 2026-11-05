// NOTE: Supabase is unused here; the owner-bound transport is tested independently.
jest.mock('../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: isolate response mapping from the real owner-bound transport's separate lifecycle contract suite.
jest.mock('../ownedApiRequest.ts', () => ({ fetchOwnedApi: jest.fn() }));
import { fetchHighlightDetail } from '../highlightDetail.ts';
import { fetchOwnedApi } from '../ownedApiRequest.ts';
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const row = () => ({ id: ID, owner_id: '11111111-1111-4111-8111-111111111111', media_url: 'post-media/owner/image.jpg', media_type: 'image/jpeg',
  visibility: 'public', created_at: '2026-01-01T00:00:00Z', expires_at: null, deleted_at: null, archived_at: null,
  viewCount: 2, likeCount: 1, viewedByMe: true, likedByMe: false });
function reply(body: unknown, status = 200) { jest.mocked(fetchOwnedApi).mockResolvedValue({ ok: status === 200, status, json: async () => body }); }
beforeEach(() => { jest.clearAllMocks(); reply(row()); });
it('maps the authorized detail and keeps private storage references unmodified for hydration', async () => {
  const abort = new AbortController(); const r = await fetchHighlightDetail(ID, { signal: abort.signal });
  expect(fetchOwnedApi).toHaveBeenCalledWith(`/api/highlights/${ID}`, { signal: abort.signal }); expect(r.data?.mediaUrl).toBe(row().media_url); expect(r.data?.viewCount).toBe(2);
});
for (const status of [401, 403, 404, 503]) it(`keeps ${status} distinct from a successful detail`, async () => {
  reply({ error: 'refused' }, status); const r = await fetchHighlightDetail(ID); expect(r.data).toBeNull();
  expect(r.errorKind).toBe(status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'degraded_unavailable');
});
for (const patch of [{ id: 'wrong' }, { owner_id: undefined }, { expires_at: undefined }, { media_url: '' }, { visibility: 'invalid' }, { viewCount: undefined }, { likedByMe: undefined }, { archived_at: '2026-01-01' }]) it(`refuses malformed response ${JSON.stringify(patch)}`, async () => {
  reply({ ...row(), ...patch }); const r = await fetchHighlightDetail(ID); expect(r.ok).toBe(false); expect(r.errorKind).toBe('degraded_unavailable');
});
it('does not display a Highlight that expires while transport is pending', async () => { reply({ ...row(), expires_at: '2026-01-01T00:00:00Z' }); expect((await fetchHighlightDetail(ID)).errorKind).toBe('not_found'); });
it('does not dispatch malformed route IDs', async () => { expect((await fetchHighlightDetail('../active')).ok).toBe(false); expect(fetchOwnedApi).not.toHaveBeenCalled(); });
it('reports failed transport as retryable rather than unavailable', async () => { jest.mocked(fetchOwnedApi).mockRejectedValue(new Error('offline')); expect((await fetchHighlightDetail(ID)).errorKind).toBe('network_unreachable'); });
