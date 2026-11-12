import { act, cleanup, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { useCommentTyping } from '../useCommentTyping.ts';
const mockRead = jest.fn(); const mockSend = jest.fn();
let mockCurrent = true; let mockUserId = 'owner'; let mockEpoch = 0;
const mockOwner = { ownerId: 'owner', sessionId: 'session', isCurrent: () => mockCurrent };
jest.mock('../../context/SessionContext.tsx', () => ({ ...jest.requireActual('../../context/SessionContext.tsx'), useSession: () => ({ userId: mockUserId }) }));
jest.mock('../../services/messagingOwnerRequest.ts', () => ({ ...jest.requireActual('../../services/messagingOwnerRequest.ts'), captureMessagingOwnerRequest: () => mockCurrent ? mockOwner : null }));
jest.mock('../../services/commentTyping.ts', () => ({ ...jest.requireActual('../../services/commentTyping.ts'), readCommentTyping: (...args: unknown[]) => mockRead(...args), sendCommentTyping: (...args: unknown[]) => mockSend(...args) }));
jest.mock('../../platform/input-assistance/hooks/useInputAccountEpoch.ts', () => ({ ...jest.requireActual('../../platform/input-assistance/hooks/useInputAccountEpoch.ts'), useInputAccountEpoch: () => mockEpoch }));
let onState: (state: AppStateStatus) => void;
beforeEach(() => {
  jest.useFakeTimers(); jest.setSystemTime(10000); mockCurrent = true; mockUserId = 'owner'; mockEpoch = 0;
  mockRead.mockReset().mockResolvedValue(1); mockSend.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => { onState = callback; return { remove: jest.fn() }; });
});
afterEach(async () => { await cleanup(); jest.useRealTimers(); jest.restoreAllMocks(); });
const flush = async () => { await act(async () => {}); };
it('sends only booleans, throttles keystrokes and stops when idle', async () => {
  const hook = await renderHook<number, { text: string }>(({ text }) => useCommentTyping('post', true, text), { initialProps: { text: '' } });
  await flush(); expect(hook.result.current).toBe(1);
  await hook.rerender({ text: 'private draft' }); await flush();
  expect(mockSend).toHaveBeenCalledTimes(1); expect(mockSend.mock.calls[0]?.slice(0, 2)).toEqual(['post', true]);
  await hook.rerender({ text: 'private draft more' }); await flush();
  expect(mockSend).toHaveBeenCalledTimes(1); expect(mockRead).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(4000); });
  expect(mockSend.mock.calls.at(-1)?.slice(0, 2)).toEqual(['post', false]);
});
it('clears on background and rejects a late read', async () => {
  let finish!: (count: number) => void;
  mockRead.mockReturnValueOnce(new Promise<number>(resolve => { finish = resolve; }));
  const hook = await renderHook(() => useCommentTyping('post', true, ''));
  await act(async () => { onState('background'); }); await act(async () => { finish(4); });
  expect(hook.result.current).toBe(0);
  await act(async () => { jest.advanceTimersByTime(8000); }); expect(mockRead).toHaveBeenCalledTimes(1);
});
it('rejects old post answers and replaced account activity', async () => {
  let finish!: (count: number) => void;
  mockRead.mockReturnValueOnce(new Promise<number>(resolve => { finish = resolve; }));
  const hook = await renderHook<number, { postId: string }>(({ postId }) => useCommentTyping(postId, true, ''), { initialProps: { postId: 'old' } });
  await hook.rerender({ postId: 'new' }); await flush();
  await act(async () => { finish(7); }); expect(hook.result.current).toBe(1);
  mockCurrent = false; mockUserId = 'replacement'; await hook.rerender({ postId: 'new' }); await flush();
  expect(hook.result.current).toBe(0); expect(mockSend).not.toHaveBeenCalled();
});
it('retires an outstanding start before the final stop', async () => {
  let finish!: () => void;
  mockSend.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const hook = await renderHook<number, { text: string; active: boolean }>(({ text, active }) => useCommentTyping('post', active, text), { initialProps: { text: '', active: true } });
  await flush(); await hook.rerender({ text: 'hello', active: true }); await flush();
  await hook.rerender({ text: 'hello', active: false }); await flush(); expect(mockSend).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); }); expect(mockSend.mock.calls.at(-1)?.slice(0, 2)).toEqual(['post', false]);
});

it('clears the indicator immediately when the same account session changes', async () => {
  const hook = await renderHook(() => useCommentTyping('post', true, ''));
  await flush(); expect(hook.result.current).toBe(1);
  mockCurrent = false; mockEpoch++;
  await hook.rerender({});
  expect(hook.result.current).toBe(0);
});
