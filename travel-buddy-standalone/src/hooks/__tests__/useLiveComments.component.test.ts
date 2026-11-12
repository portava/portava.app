import { act, cleanup, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useLiveComments } from '../useLiveComments.ts';
import type { EngagementComment, EngagementReply } from '../../services/postEngagement.ts';
import type { CommentSnapshot } from '../../services/commentActivity.ts';
import type { MessagingOwnerRequest } from '../../services/messagingOwnerRequest.ts';
const mockRead = jest.fn(); const mockReplies = jest.fn();
let mockUserId: string | null = 'owner'; let mockEpoch = 0;
let mockOwner: MessagingOwnerRequest;
jest.mock('../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../context/SessionContext.tsx'), useSession: () => ({ userId: mockUserId }) }));
jest.mock('../../services/messagingOwnerRequest.ts', () => ({ ...jest.requireActual('../../services/messagingOwnerRequest.ts'), captureMessagingOwnerRequest: () => mockUserId ? mockOwner : null }));
jest.mock('../../services/commentActivity.ts', () => ({ ...jest.requireActual('../../services/commentActivity.ts'), readLiveComments: (...args: unknown[]) => mockRead(...args), readLiveReplies: (...args: unknown[]) => mockReplies(...args) }));
jest.mock('../../platform/input-assistance/hooks/useInputAccountEpoch.ts', () => ({ ...jest.requireActual('../../platform/input-assistance/hooks/useInputAccountEpoch.ts'), useInputAccountEpoch: () => mockEpoch }));
let onState: (state: AppStateStatus) => void;
const count = jest.fn();
const row = (id: string, body = id, authorId = 'other'): EngagementComment => ({ id, body, author: { id: authorId, handle: '@author', name: 'Author', avatarUrl: null }, createdAt: '2026-11-12T00:00:00Z', updatedAt: null, canDelete: false });
const reply = (id: string, body = id): EngagementReply => ({...row(id, body), parentCommentId: 'one'});
const response = (...comments: EngagementComment[]): CommentSnapshot => ({ok: true, comments});
function deferred<T>() { let resolve!: (value: T) => void; return {promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value)}; }
function owner(id = 'owner'): MessagingOwnerRequest { let current = true; return {ownerId: id, sessionId: `s-${mockEpoch}`, isCurrent: () => current, invalidate: () => { current = false; }}; }
const flush = () => act(async () => {});
const tick = () => act(async () => { jest.advanceTimersByTime(4000); });
beforeEach(() => {
  jest.useFakeTimers({doNotFake: ['queueMicrotask']}); mockUserId = 'owner'; mockEpoch = 0; mockOwner = owner(); count.mockReset();
  mockRead.mockReset().mockResolvedValue(response(row('one'))); mockReplies.mockReset().mockResolvedValue({ok: true, replies: [reply('reply')]});
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => { onState = callback; return {remove: jest.fn()}; });
});
afterEach(async () => { await cleanup(); jest.restoreAllMocks(); jest.useRealTimers(); });
const mount = () => renderHook<ReturnType<typeof useLiveComments>, {postId: string; active: boolean}>(({postId, active}) => useLiveComments(postId, active, count), {initialProps: {postId: 'post', active: true}});

it('refreshes edits and removals, announces only new other-user comments once, and prunes removed replies', async () => {
  const hook = await mount(); await flush();
  expect(hook.result.current.comments[0]?.body).toBe('one'); expect(hook.result.current.newCount).toBe(0);
  await act(async () => { await hook.result.current.loadReplies('one'); });
  mockRead.mockResolvedValue(response(row('one', 'edited'), row('two'), row('own', 'my comment', 'owner')));
  await tick(); expect(hook.result.current.comments[0]?.body).toBe('edited'); expect(hook.result.current.newCount).toBe(1);
  await tick(); expect(hook.result.current.newCount).toBe(1);
  await act(async () => { hook.result.current.clearNewCount(); });
  mockRead.mockResolvedValue(response(row('two'))); await tick();
  expect(hook.result.current.newCount).toBe(0); expect(hook.result.current.repliesMap).toEqual({}); expect(hook.result.current.repliesOpen.size).toBe(0); expect(count).toHaveBeenLastCalledWith(1);
});
it('keeps last good content during a failed refresh and retries without reporting a fake zero', async () => {
  const hook = await mount(); await flush(); count.mockClear();
  mockRead.mockResolvedValue({ok: false, denied: false}); await tick();
  expect(hook.result.current.comments.map(c => c.id)).toEqual(['one']); expect(hook.result.current.error).toBe(true); expect(count).not.toHaveBeenCalled();
  mockRead.mockResolvedValue(response(row('new'))); await act(async () => { hook.result.current.load(); });
  expect(hook.result.current.comments.map(c => c.id)).toEqual(['new']); expect(hook.result.current.error).toBe(false);
});
it('clears comments and expanded replies immediately after authoritative access denial', async () => {
  const hook = await mount(); await flush(); await act(async () => { await hook.result.current.loadReplies('one'); });
  mockRead.mockResolvedValue({ok: false, denied: true}); await tick();
  expect(hook.result.current.comments).toEqual([]); expect(hook.result.current.repliesMap).toEqual({}); expect(hook.result.current.error).toBe(true);
});
it('does not overlap polls, aborts on background, and refreshes on returning without accepting the aborted answer', async () => {
  const pending = deferred<CommentSnapshot>(); mockRead.mockReturnValueOnce(pending.promise);
  const hook = await mount(); await tick(); expect(mockRead).toHaveBeenCalledTimes(1);
  await act(async () => { onState('background'); }); expect(mockRead.mock.calls[0][1].signal.aborted).toBe(true);
  await tick(); expect(mockRead).toHaveBeenCalledTimes(1);
  await act(async () => { onState('active'); pending.resolve(response(row('old background result'))); });
  expect(mockRead).toHaveBeenCalledTimes(2); expect(hook.result.current.comments.map(c => c.id)).toEqual(['one']);
});
for (const change of ['post', 'close', 'account', 'same-account session'] as const) {
  it(`rejects late comment/reply answers and clears the previous view on ${change}`, async () => {
    const hook = await mount(); await flush();
    const comments = deferred<CommentSnapshot>(); const replies = deferred<{ok: true; replies: EngagementReply[]}>();
    mockRead.mockReturnValueOnce(comments.promise); mockReplies.mockReturnValueOnce(replies.promise);
    await act(async () => { hook.result.current.load(); void hook.result.current.loadReplies('one'); });
    if (change === 'account' || change === 'same-account session') { mockOwner.invalidate(); mockEpoch++; mockUserId = change === 'account' ? 'new-owner' : 'owner'; mockOwner = owner(mockUserId); }
    mockRead.mockResolvedValue(response(row('fresh')));
    await hook.rerender({postId: change === 'post' ? 'new-post' : 'post', active: change !== 'close'});
    await act(async () => { comments.resolve(response(row('private old'))); replies.resolve({ok: true, replies: [reply('private reply')]}); });
    expect(hook.result.current.comments.map(c => c.id)).toEqual(change === 'close' ? [] : ['fresh']); expect(hook.result.current.repliesMap).toEqual({});
  });
}
it('never starts reads when hidden or signed out, and clears already loaded private data on sign-out', async () => {
  const hook = await mount(); await flush();
  mockOwner.invalidate(); mockEpoch++; mockUserId = null; await hook.rerender({postId: 'post', active: true});
  expect(hook.result.current.comments).toEqual([]); await tick(); expect(mockRead).toHaveBeenCalledTimes(1);
  await hook.rerender({postId: 'post', active: false}); await tick(); expect(mockRead).toHaveBeenCalledTimes(1);
});
it('holds polling during a mutation and refuses an older snapshot after an accepted edit', async () => {
  const hook = await mount(); await flush(); const old = deferred<CommentSnapshot>(); mockRead.mockReturnValueOnce(old.promise);
  await act(async () => { hook.result.current.load(); });
  const mutation = hook.result.current.beginMutation()!;
  await act(async () => { hook.result.current.setComments([row('one', 'accepted edit')]); }); await tick();
  expect(mockRead).toHaveBeenCalledTimes(2); expect(mockRead.mock.calls[1][1].signal.aborted).toBe(true);
  await act(async () => { old.resolve(response(row('one', 'stale'))); }); expect(hook.result.current.comments[0]?.body).toBe('accepted edit');
  mockRead.mockResolvedValue(response(row('one', 'accepted edit'), row('new')));
  await act(async () => { mutation.finish(); mutation.finish(); });
  expect(hook.result.current.comments.map(c => c.body)).toEqual(['accepted edit', 'new']); expect(mockRead).toHaveBeenCalledTimes(3);
});
it('finishes an accepted write in the background without restarting reads until foreground', async () => {
  const hook = await mount(); await flush(); const mutation = hook.result.current.beginMutation()!;
  await act(async () => { onState('background'); hook.result.current.setComments([row('one', 'accepted')]); mutation.finish(); });
  expect(mutation.isCurrent()).toBe(true); expect(hook.result.current.comments[0]?.body).toBe('accepted'); expect(mockRead).toHaveBeenCalledTimes(1);
  mockRead.mockResolvedValue(response(row('one', 'accepted'))); await act(async () => { onState('active'); }); expect(mockRead).toHaveBeenCalledTimes(2);
});
it('preserves readable replies on temporary failures, supports retry, and removes replies on access denial', async () => {
  const hook = await mount(); await flush(); mockReplies.mockResolvedValueOnce({ok: false, denied: false});
  await act(async () => { await hook.result.current.loadReplies('one'); });
  expect(hook.result.current.repliesErrors.has('one')).toBe(true); expect(hook.result.current.repliesLoaded.has('one')).toBe(false);
  await act(async () => { await hook.result.current.loadReplies('one'); }); expect(hook.result.current.repliesErrors.has('one')).toBe(false);
  mockReplies.mockResolvedValue({ok: false, denied: false}); await tick();
  expect(hook.result.current.repliesMap.one?.[0]?.id).toBe('reply'); expect(hook.result.current.repliesErrors.has('one')).toBe(true);
  mockReplies.mockResolvedValue({ok: false, denied: true}); await tick(); expect(hook.result.current.repliesMap.one).toBeUndefined();
});
it('does not replace an edited reply with a delayed refresh or reopen a collapsed reply thread', async () => {
  const hook = await mount(); await flush(); await act(async () => { await hook.result.current.loadReplies('one'); });
  const old = deferred<{ok: true; replies: EngagementReply[]}>(); mockReplies.mockReturnValueOnce(old.promise); await tick();
  const mutation = hook.result.current.beginMutation()!;
  await act(async () => { hook.result.current.setRepliesMap({one: [reply('reply', 'edited reply')]}); old.resolve({ok: true, replies: [reply('reply', 'stale')]}); });
  expect(hook.result.current.repliesMap.one?.[0]?.body).toBe('edited reply');
  mockReplies.mockResolvedValue({ok: true, replies: [reply('reply', 'edited reply')]});
  await act(async () => { hook.result.current.setRepliesOpen(new Set()); mutation.finish(); });
  expect(hook.result.current.repliesOpen.size).toBe(0);
});

it('cannot restore a pending reply after the post becomes inaccessible', async () => {
  const hook = await mount(); await flush();
  const pending = deferred<{ok: true; replies: EngagementReply[]}>(); mockReplies.mockReturnValueOnce(pending.promise);
  await act(async () => { void hook.result.current.loadReplies('one'); });
  mockRead.mockResolvedValue({ok: false, denied: true}); await tick();
  await act(async () => { pending.resolve({ok: true, replies: [reply('private late reply')]}); });
  expect(hook.result.current.comments).toEqual([]); expect(hook.result.current.repliesMap).toEqual({});
  expect(mockReplies.mock.calls[0][2].signal.aborted).toBe(true);
});
