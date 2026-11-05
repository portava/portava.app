import { fetchOwnedApi } from '../../../../services/ownedApiRequest.ts';
import { fetchCarryForwardPage } from '../carryForwardApi.ts';
// NOTE: intentionally isolated boundary; real HTTP would leave this synthetic fixture.
jest.mock('../../../../services/ownedApiRequest.ts', () => ({ fetchOwnedApi: jest.fn() }));
const owner = { ownerId: 'me', sessionId: 'session', isCurrent: jest.fn(() => true), invalidate: jest.fn() };
const response = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });
const message = (id: string, kind = 'PLACE', extra = {}) => ({ id, msgType: 'portava_object', createdAt: '2026-11-05T10:00:00Z', sequence: 10, body: JSON.stringify({ kind: 'PORTAVA_OBJECT', objectType: kind, objectId: id, shareProjectionVersion: '1', title: 'Stale copied title' }), ...extra });
const projection = (id: string, kind = 'PLACE') => ({ objectType: kind, objectId: id, available: true, projection: { title: `Current ${id}` } });
beforeEach(() => { jest.clearAllMocks(); owner.isCurrent.mockReturnValue(true); });
it('resolves only plan/place references and uses fresh titles, never copied message text', async () => {
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({ threadId: 'chat', messages: [message('place'), message('plan', 'PLAN'), message('private', 'MEMORY'), message('deleted', 'PLACE', { deleted: true }), message('future', 'PLACE', { body: JSON.stringify({ kind: 'PORTAVA_OBJECT', objectType: 'PLACE', objectId: 'future', shareProjectionVersion: '2' }) })] }));
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({ threadId: 'chat', projections: [projection('place'), projection('plan', 'PLAN'), projection('unexpected')] }));
  const signal = new AbortController().signal;
  const result = await fetchCarryForwardPage('chat', owner, signal);
  expect(result.items).toEqual([{ kind: 'PLACE', objectId: 'place', title: 'Current place' }, { kind: 'PLAN', objectId: 'plan', title: 'Current plan' }]);
  expect(fetchOwnedApi).toHaveBeenLastCalledWith('/api/threads/chat/share-projections', { owner, signal, method: 'POST', body: { refs: [{ objectType: 'PLACE', objectId: 'place', messageId: 'place' }, { objectType: 'PLAN', objectId: 'plan', messageId: 'plan' }] } });
});
it('withholds revoked sources and de-duplicates repeated shares', async () => {
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({ threadId: 'chat', messages: [message('a'), message('b')] }));
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({ threadId: 'chat', projections: [projection('a'), projection('a'), { objectType: 'PLACE', objectId: 'b', available: false, reason: 'private', projection: null }] }));
  expect((await fetchCarryForwardPage('chat', owner, new AbortController().signal)).items).toEqual([{ kind: 'PLACE', objectId: 'a', title: 'Current a' }]);
});
it('does not turn an unreadable source into an empty result', async () => {
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({ threadId: 'chat', messages: [message('a')] }));
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({ threadId: 'chat', projections: [{ objectType: 'PLACE', objectId: 'a', available: false, reason: 'unknown' }] }));
  await expect(fetchCarryForwardPage('chat', owner, new AbortController().signal)).rejects.toThrow('sharing rules');
});
it('uses the oldest sequence cursor and stops if a server repeats the same page', async () => {
  jest.mocked(fetchOwnedApi).mockResolvedValue(response({ threadId: 'chat', messages: [message('text', 'POST')] }));
  const signal = new AbortController().signal;
  const first = await fetchCarryForwardPage('chat', owner, signal);
  expect(first.next).toEqual({ createdAt: '2026-11-05T10:00:00Z', sequence: 10 });
  expect((await fetchCarryForwardPage('chat', owner, signal, first.next)).next).toBeNull();
  expect(fetchOwnedApi).toHaveBeenLastCalledWith(expect.stringContaining('beforeSequence=10'), { owner, signal });
});
it('rejects another conversation and a failed read instead of rendering cached choices', async () => {
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({ threadId: 'other', messages: [] }));
  await expect(fetchCarryForwardPage('chat', owner, new AbortController().signal)).rejects.toThrow('unavailable');
  jest.mocked(fetchOwnedApi).mockResolvedValueOnce(response({}, false));
  await expect(fetchCarryForwardPage('chat', owner, new AbortController().signal)).rejects.toThrow('could not be loaded');
});
it('refuses a late result after the initiating session or screen ends', async () => {
  jest.mocked(fetchOwnedApi).mockResolvedValue(response({ threadId: 'chat', messages: [] }));
  owner.isCurrent.mockReturnValue(false);
  await expect(fetchCarryForwardPage('chat', owner, new AbortController().signal)).rejects.toThrow('changed');
  owner.isCurrent.mockReturnValue(true);
  const controller = new AbortController(); controller.abort();
  await expect(fetchCarryForwardPage('chat', owner, controller.signal)).rejects.toThrow('changed');
});
