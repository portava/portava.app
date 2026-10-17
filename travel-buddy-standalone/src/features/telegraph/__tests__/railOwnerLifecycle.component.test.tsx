import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SharedContextRail } from '../sharedContext/SharedContextRail.tsx';
import { fetchSharedContext } from '../sharedContext/api.ts';
import { getCurrentAccountId } from '../../../services/accountId.ts';
import { clearRailSeenForUser, railSeenKey } from '../sharedContext/railSeenStore.ts';
import { supabase } from '../../../lib/supabase.ts';
import type { SharedContextResponse } from '../sharedContext/types.ts';

let mockUserId: string | null = 'owner-a';
const mockAuthListeners = new Set<(userId: string | null) => void>();
const mockAuthListener = (userId: string | null) => { for (const listener of [...mockAuthListeners]) listener(userId); };

jest.mock('../../../context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../context/SessionContext.tsx'), useSession: () => ({ userId: mockUserId }),
}));
jest.mock('../../../services/auth.ts', () => ({
  ...jest.requireActual('../../../services/auth.ts'), onAuthChange: (listener: (userId: string | null) => void) => {
    mockAuthListeners.add(listener);
    return () => { mockAuthListeners.delete(listener); };
  },
}));
jest.mock('../../../services/accountId.ts', () => ({
  ...jest.requireActual('../../../services/accountId.ts'), getCurrentAccountId: jest.fn(),
}));
jest.mock('../sharedContext/api.ts', () => ({
  ...jest.requireActual('../sharedContext/api.ts'), fetchSharedContext: jest.fn(),
}));
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({
  ...jest.requireActual('../../wall/hooks/useReducedMotionSetting.ts'), useReducedMotionSetting: () => false,
}));

const mockedFetch = jest.mocked(fetchSharedContext);
const mockedAccount = jest.mocked(getCurrentAccountId);
const beforeTime = '2026-10-16T18:00:00Z';
const afterTime = '2026-10-16T20:00:00Z';

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function served(label: string, threadId = 'thread', startsAt = beforeTime): SharedContextResponse {
  return {
    sharedContext: {
      conversationId: threadId, generatedAt: '2026-10-16T12:00:00Z', now: [], unresolved: [], past: [],
      upcoming: [{
        objectType: 'EVENT', objectId: 'event', title: label, status: 'open', startsAt,
        relationship: 'BOTH_PARTICIPANTS', availableActions: ['MEET_HERE'], orderBand: 'UPCOMING',
        eventAttendance: [{ userId: label, label }],
      }],
    },
    railMode: 'COMPACT_UPCOMING', collapsedSummary: '', incomplete: false, refusedCount: 0,
  };
}

function request() {
  return deferred<Awaited<ReturnType<typeof fetchSharedContext>>>();
}

async function switchOwner(userId: string | null) {
  await act(async () => { mockUserId = userId; mockAuthListener?.(userId); });
}

async function seedSeen(ownerId = 'owner-a') {
  await AsyncStorage.setItem(railSeenKey('thread', ownerId), JSON.stringify({
    v: 1, items: { event: { status: 'open', startsAt: beforeTime } },
  }));
}

beforeEach(async () => {
  mockUserId = 'owner-a';
  mockedFetch.mockReset().mockResolvedValue({ ok: true, data: served('@current') });
  mockedAccount.mockReset().mockImplementation(async () => mockUserId);
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

afterAll(async () => { await supabase.auth.stopAutoRefresh(); });

it('does not fetch, display a seed, or write seen state while signed out', async () => {
  mockUserId = null;
  await render(<SharedContextRail threadId="thread" initialResponse={served('@private')} />);
  expect(screen.queryByText('@private')).toBeNull();
  expect(mockedFetch).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('does not install or persist A after unmount and a B mount', async () => {
  const oldRequest = request();
  mockedFetch.mockReturnValueOnce(oldRequest.promise);
  const first = await render(<SharedContextRail threadId="thread" />);
  await first.unmount();
  mockUserId = 'owner-b';
  mockedFetch.mockResolvedValue({ ok: true, data: served('@owner-b', 'thread-b') });
  await render(<SharedContextRail threadId="thread-b" />);
  await act(async () => { oldRequest.resolve({ ok: true, data: served('@private-a') }); });
  expect(screen.getByText('Going from this conversation: @owner-b')).toBeTruthy();
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-b'))).toBeNull();
  expect(mockedAccount).toHaveBeenCalledTimes(2);
});

it('drops A results after B has displayed its own attendance', async () => {
  const oldRequest = request();
  mockedFetch.mockReturnValueOnce(oldRequest.promise);
  await render(<SharedContextRail threadId="thread" />);
  await switchOwner('owner-b');
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
  await act(async () => { oldRequest.resolve({ ok: true, data: served('@private-a') }); });
  expect(screen.queryByText('Going from this conversation: @private-a')).toBeNull();
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
  expect(mockedAccount).toHaveBeenCalledTimes(2);
});

it('clears an installed response on an auth event before SessionContext catches up', async () => {
  await render(<SharedContextRail threadId="thread" />);
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
  await act(async () => { mockAuthListener?.('owner-b'); });
  expect(screen.queryByText('Going from this conversation: @current')).toBeNull();
  expect(mockedFetch).toHaveBeenCalledTimes(1);
});

it('refetches and rejects the previous epoch after batched A to null to A', async () => {
  const oldRequest = request();
  mockedFetch.mockReturnValueOnce(oldRequest.promise);
  await render(<SharedContextRail threadId="thread" />);
  await act(async () => { mockAuthListener?.(null); mockAuthListener?.('owner-a'); });
  expect(mockedFetch).toHaveBeenCalledTimes(2);
  await act(async () => { oldRequest.resolve({ ok: true, data: served('@old-session') }); });
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
  expect(screen.queryByText('Going from this conversation: @old-session')).toBeNull();
});

it('refuses the original initialResponse after an owner/session transition', async () => {
  await render(<SharedContextRail threadId="thread" initialResponse={served('@seed-a')} />);
  expect(screen.getByText('Going from this conversation: @seed-a')).toBeTruthy();
  await switchOwner('owner-b');
  expect(screen.queryByText('Going from this conversation: @seed-a')).toBeNull();
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
});

it('rejects a previous thread response after the next thread loaded', async () => {
  const oldRequest = request();
  mockedFetch.mockReturnValueOnce(oldRequest.promise);
  const view = await render(<SharedContextRail threadId="old-thread" />);
  mockedFetch.mockResolvedValue({ ok: true, data: served('@next-thread', 'next-thread') });
  await view.rerender(<SharedContextRail threadId="next-thread" />);
  await act(async () => { oldRequest.resolve({ ok: true, data: served('@old-thread', 'old-thread') }); });
  expect(screen.getByText('Going from this conversation: @next-thread')).toBeTruthy();
  expect(screen.queryByText('Going from this conversation: @old-thread')).toBeNull();
  expect(await AsyncStorage.getItem(railSeenKey('old-thread', 'owner-a'))).toBeNull();
});

it('does not let an old failure hide the next owner response', async () => {
  const oldRequest = request();
  mockedFetch.mockReturnValueOnce(oldRequest.promise);
  await render(<SharedContextRail threadId="thread" />);
  await switchOwner('owner-b');
  await act(async () => { oldRequest.resolve({ ok: false, error: 'server' }); });
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
});

it('rejects a response for a different conversation without storage work', async () => {
  mockedFetch.mockResolvedValue({ ok: true, data: served('@wrong-thread', 'wrong-thread') });
  await render(<SharedContextRail threadId="thread" />);
  expect(screen.queryByTestId('telegraph-shared-context-rail')).toBeNull();
  expect(mockedAccount).toHaveBeenCalledTimes(1);
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('rejects a storage account lookup that settles across an owner change', async () => {
  const account = deferred<string | null>();
  mockedAccount.mockReturnValueOnce(account.promise);
  const view = await render(<SharedContextRail threadId="thread" />);
  expect(mockedFetch).not.toHaveBeenCalled();
  await switchOwner('owner-b');
  await act(async () => { account.resolve('owner-b'); });
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  await view.unmount();
});

it('does not trust a seen key that belongs to a different account', async () => {
  mockedAccount.mockResolvedValue('owner-b');
  await render(<SharedContextRail threadId="thread" />);
  expect(screen.queryByTestId('telegraph-shared-context-rail')).toBeNull();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it.each(['switch', 'unmount'] as const)('drops a delayed storage read on %s', async (transition) => {
  const read = deferred<string | null>();
  (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(() => read.promise);
  const view = await render(<SharedContextRail threadId="thread" />);
  if (transition === 'switch') await switchOwner('owner-b');
  else await view.unmount();
  const writesBefore = (AsyncStorage.setItem as jest.Mock).mock.calls.length;
  await act(async () => { read.resolve(null); });
  expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(writesBefore);
});

it.each(['switch', 'thread', 'unmount'] as const)('ignores a stale acknowledgement callback after %s', async (transition) => {
  await seedSeen();
  mockedFetch.mockResolvedValue({ ok: true, data: served('@changed', 'thread', afterTime) });
  const view = await render(<SharedContextRail threadId="thread" />);
  let buttonFiber = screen.getByLabelText('Acknowledge change').unstable_fiber;
  while (buttonFiber && typeof buttonFiber.memoizedProps.onPress !== 'function') buttonFiber = buttonFiber.return;
  expect(buttonFiber).not.toBeNull();
  const acknowledge = buttonFiber!.memoizedProps.onPress as () => void;
  if (transition === 'switch') await switchOwner('owner-b');
  else if (transition === 'thread') {
    mockedFetch.mockResolvedValue({ ok: true, data: served('@next', 'next-thread') });
    await view.rerender(<SharedContextRail threadId="next-thread" />);
  } else await view.unmount();
  const writesBefore = (AsyncStorage.setItem as jest.Mock).mock.calls.length;
  await act(async () => { acknowledge(); });
  expect((AsyncStorage.setItem as jest.Mock).mock.calls.length).toBe(writesBefore);
  const raw = await AsyncStorage.getItem(railSeenKey('thread', 'owner-a'));
  if (transition === 'switch') expect(raw).toBeNull();
  else expect(JSON.parse(raw!).items.event.startsAt).toBe(beforeTime);
});

it('serializes initial seen writes before acknowledgement so a late write cannot undo it', async () => {
  await seedSeen();
  const write = deferred<void>();
  const setItem = AsyncStorage.setItem as jest.Mock;
  const originalWrite = setItem.getMockImplementation()!;
  setItem.mockImplementationOnce(async (key: string, value: string) => {
    await write.promise;
    return originalWrite(key, value);
  });
  mockedFetch.mockResolvedValue({ ok: true, data: served('@changed', 'thread', afterTime) });
  await render(<SharedContextRail threadId="thread" />);
  const writesBefore = setItem.mock.calls.length;
  await fireEvent.press(screen.getByLabelText('Acknowledge change'));
  expect(setItem.mock.calls.length).toBe(writesBefore);
  await act(async () => { write.resolve(); });
  const seen = JSON.parse((await AsyncStorage.getItem(railSeenKey('thread', 'owner-a')))!);
  expect(seen.items.event.startsAt).toBe(afterTime);
  expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
});

it('a sign-out sweep waits for an already-issued write and skips its queued acknowledgement', async () => {
  await seedSeen();
  const write = deferred<void>();
  const setItem = AsyncStorage.setItem as jest.Mock;
  const originalWrite = setItem.getMockImplementation()!;
  setItem.mockImplementationOnce(async (key: string, value: string) => {
    await write.promise;
    return originalWrite(key, value);
  });
  mockedFetch.mockResolvedValue({ ok: true, data: served('@changed', 'thread', afterTime) });
  await render(<SharedContextRail threadId="thread" />);
  await fireEvent.press(screen.getByLabelText('Acknowledge change'));
  const writesBefore = setItem.mock.calls.length;
  const cleared = clearRailSeenForUser('owner-a');
  await switchOwner(null);
  await act(async () => { write.resolve(); await cleared; });
  expect(setItem.mock.calls.length).toBe(writesBefore);
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-a'))).toBeNull();
});

it('a same-account relogin reads after the old in-flight write and sign-out sweep', async () => {
  await seedSeen();
  const write = deferred<void>();
  const setItem = AsyncStorage.setItem as jest.Mock;
  const originalWrite = setItem.getMockImplementation()!;
  setItem.mockImplementationOnce(async (key: string, value: string) => {
    await write.promise;
    return originalWrite(key, value);
  });
  mockedFetch.mockResolvedValue({ ok: true, data: served('@old-session', 'thread', afterTime) });
  await render(<SharedContextRail threadId="thread" />);
  mockedFetch.mockResolvedValue({ ok: true, data: served('@new-session', 'thread', afterTime) });
  await act(async () => { mockAuthListener(null); mockAuthListener('owner-a'); });
  expect(screen.queryByText('Going from this conversation: @old-session')).toBeNull();
  await act(async () => { write.resolve(); });
  expect(screen.getByText('Going from this conversation: @new-session')).toBeTruthy();
  expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
  const seen = JSON.parse((await AsyncStorage.getItem(railSeenKey('thread', 'owner-a')))!);
  expect(seen.items.event.startsAt).toBe(afterTime);
});

it('keeps the current response and acknowledgement on a same-owner auth refresh', async () => {
  await seedSeen();
  mockedFetch.mockResolvedValue({ ok: true, data: served('@changed', 'thread', afterTime) });
  await render(<SharedContextRail threadId="thread" />);
  await fireEvent.press(screen.getByLabelText('Acknowledge change'));
  await act(async () => { mockAuthListener('owner-a'); });
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Going from this conversation: @changed')).toBeTruthy();
  expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
});

it('releases the owner lookup subscription after unmount even when lookup finishes late', async () => {
  const account = deferred<string | null>();
  mockedAccount.mockReturnValueOnce(account.promise);
  const view = await render(<SharedContextRail threadId="thread" />);
  await view.unmount();
  await act(async () => { account.resolve('owner-a'); });
  expect(mockAuthListeners.size).toBe(0);
  expect(mockedFetch).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('refuses a lookup invalidated by a sign-out sweep before it settles', async () => {
  const account = deferred<string | null>();
  mockedAccount.mockReturnValueOnce(account.promise);
  await render(<SharedContextRail threadId="thread" />);
  await clearRailSeenForUser('owner-a');
  await act(async () => { account.resolve('owner-a'); });
  expect(mockedFetch).not.toHaveBeenCalled();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
});

it('a failed write does not poison later writes or the sign-out sweep', async () => {
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('storage failed'));
  const view = await render(<SharedContextRail threadId="thread" />);
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
  await view.unmount();
  await render(<SharedContextRail threadId="thread" />);
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-a'))).not.toBeNull();
  await clearRailSeenForUser('owner-a');
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-a'))).toBeNull();
});

it('an in-flight A write cannot delay B storage or survive the completed A sweep', async () => {
  const write = deferred<void>();
  const setItem = AsyncStorage.setItem as jest.Mock;
  const originalWrite = setItem.getMockImplementation()!;
  setItem.mockImplementationOnce(async (key: string, value: string) => {
    await write.promise;
    return originalWrite(key, value);
  });
  await render(<SharedContextRail threadId="thread" />);
  await switchOwner('owner-b');
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-b'))).not.toBeNull();
  const cleared = clearRailSeenForUser('owner-a');
  await act(async () => { write.resolve(); await cleared; });
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-a'))).toBeNull();
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-b'))).not.toBeNull();
});

it('catches a late rejected fetch without hiding the new owner', async () => {
  const oldRequest = request();
  mockedFetch.mockReturnValueOnce(oldRequest.promise);
  await render(<SharedContextRail threadId="thread" />);
  await switchOwner('owner-b');
  await act(async () => { oldRequest.reject(new Error('token refresh failed')); });
  expect(screen.getByText('Going from this conversation: @current')).toBeTruthy();
});

it.each(['unmount', 'thread'] as const)('preserves an accepted queued acknowledgement across same-account %s', async (navigation) => {
  await seedSeen();
  const write = deferred<void>();
  const setItem = AsyncStorage.setItem as jest.Mock;
  const originalWrite = setItem.getMockImplementation()!;
  setItem.mockImplementationOnce(async (key: string, value: string) => {
    await write.promise;
    return originalWrite(key, value);
  });
  mockedFetch.mockImplementation(async (threadId) => ({ ok: true, data: served('@changed', threadId, afterTime) }));
  const view = await render(<SharedContextRail threadId="thread" />);
  await fireEvent.press(screen.getByLabelText('Acknowledge change'));
  if (navigation === 'unmount') {
    await view.unmount();
    await render(<SharedContextRail threadId="thread" />);
  } else {
    await view.rerender(<SharedContextRail threadId="next-thread" />);
    await view.rerender(<SharedContextRail threadId="thread" />);
  }
  await act(async () => { write.resolve(); });
  expect(screen.getByText('Going from this conversation: @changed')).toBeTruthy();
  expect(screen.queryByTestId('telegraph-rail-change-card')).toBeNull();
  const seen = JSON.parse((await AsyncStorage.getItem(railSeenKey('thread', 'owner-a')))!);
  expect(seen.items.event.startsAt).toBe(afterTime);
});

it('keeps auth revocation subscribed while an accepted acknowledgement outlives its mount', async () => {
  await seedSeen();
  const write = deferred<void>();
  const setItem = AsyncStorage.setItem as jest.Mock;
  const originalWrite = setItem.getMockImplementation()!;
  setItem.mockImplementationOnce(async (key: string, value: string) => {
    await write.promise;
    return originalWrite(key, value);
  });
  mockedFetch.mockResolvedValue({ ok: true, data: served('@changed', 'thread', afterTime) });
  const view = await render(<SharedContextRail threadId="thread" />);
  await fireEvent.press(screen.getByLabelText('Acknowledge change'));
  await view.unmount();
  const writesBefore = setItem.mock.calls.length;
  await act(async () => { mockAuthListener(null); mockAuthListener('owner-a'); });
  await act(async () => { write.resolve(); });
  expect(setItem.mock.calls.length).toBe(writesBefore);
  expect(await AsyncStorage.getItem(railSeenKey('thread', 'owner-a'))).toBeNull();
  expect(mockAuthListeners.size).toBe(0);
});
