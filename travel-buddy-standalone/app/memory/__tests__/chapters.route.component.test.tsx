import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

let mockUserId: string | null = 'owner-a';
let mockAuthListener: ((userId: string | null) => void) | undefined;
let mockFocusCallback: (() => (() => void) | void) | undefined;
let mockFocusCleanup: (() => void) | void;
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('../../../src/__mocks__/expo-router.tsx'),
  router: { ...jest.requireActual('../../../src/__mocks__/expo-router.tsx').router, push: (...args: unknown[]) => mockPush(...args) },
  useFocusEffect: (callback: () => (() => void) | void) => jest.requireActual('react').useEffect(() => {
    mockFocusCallback = callback;
    mockFocusCleanup = callback();
    return () => { mockFocusCleanup?.(); mockFocusCallback = undefined; };
  }, [callback]),
}));
jest.mock('../../../src/context/SessionContext.tsx', () => ({
  ...jest.requireActual('../../../src/context/SessionContext.tsx'), useSession: () => ({ userId: mockUserId }),
}));
jest.mock('../../../src/services/auth.ts', () => ({
  ...jest.requireActual('../../../src/services/auth.ts'), onAuthChange: (listener: (userId: string | null) => void) => {
    mockAuthListener = listener;
    return () => { mockAuthListener = undefined; };
  },
}));
jest.mock('../../../src/services/memoryChapters.ts', () => ({
  ...jest.requireActual('../../../src/services/memoryChapters.ts'), getLifeChapters: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import ChaptersRoute from '../chapters.tsx';
import { getLifeChapters } from '../../../src/services/memoryChapters.ts';
import { MemoryBrowseLinks } from '../../../src/features/memories/social/MemoryBrowseLinks.tsx';
import type { Memory } from '../../../src/services/memories.ts';
import { supabase } from '../../../src/lib/supabase.ts';

const memoryId = '33333333-3333-4333-8333-000000000001';
const result = { ok: true, truncated: false, recordedTimeCount: 0, chapters: [{
  id: 'chapter', kind: 'place', startedAt: '2025-01-01', endedAt: '2026-01-01', memoryIds: [memoryId, '33333333-3333-4333-8333-000000000002'],
}] };
beforeEach(() => {
  mockUserId = 'owner-a'; mockPush.mockReset();
  (getLifeChapters as jest.Mock).mockReset().mockResolvedValue(result);
});
afterAll(async () => { await supabase.auth.stopAutoRefresh(); });

it('lets the owner explore chapters and open original memories', async () => {
  await render(<ChaptersRoute />);
  await act(async () => { fireEvent.press(screen.getByTestId('chapter-0')); });
  await act(async () => { fireEvent.press(screen.getByText('Open memory 1')); });
  expect(mockPush).toHaveBeenCalledWith(`/memory/${memoryId}`);
  expect(screen.getByText(/Private to you/)).toBeTruthy();
});

it('shows an error and retry, not an empty chapter list', async () => {
  (getLifeChapters as jest.Mock).mockResolvedValueOnce({ ok: false, message: 'Unavailable now' });
  await render(<ChaptersRoute />);
  expect(await screen.findByText('Unavailable now')).toBeTruthy();
  expect(screen.queryByText(/No chapters yet/)).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('chapters-retry')); });
  expect(await screen.findByTestId('chapter-0')).toBeTruthy();
});

it('discloses partial history even when it contains no chapters', async () => {
  (getLifeChapters as jest.Mock).mockResolvedValue({ ok: true, chapters: [], truncated: true, recordedTimeCount: 1 });
  await render(<ChaptersRoute />);
  expect(await screen.findByText(/No chapters yet/)).toBeTruthy();
  expect(screen.getByText(/not your complete lifetime/)).toBeTruthy();
  expect(screen.getByText(/not when they happened/)).toBeTruthy();
});

it('does not load when signed out', async () => {
  mockUserId = null;
  await render(<ChaptersRoute />);
  expect(getLifeChapters).not.toHaveBeenCalled();
  expect(screen.getByText(/Sign in/)).toBeTruthy();
});

it('discards a prior account response and aborts its request', async () => {
  let finish: ((value: typeof result) => void) | undefined;
  (getLifeChapters as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = await render(<ChaptersRoute />);
  const signal = (getLifeChapters as jest.Mock).mock.calls[0][0] as AbortSignal;
  await act(async () => { mockAuthListener?.('owner-b'); });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish?.(result); });
  expect(screen.queryByTestId('chapter-0')).toBeNull();
  mockUserId = 'owner-b';
  (getLifeChapters as jest.Mock).mockResolvedValue({ ...result, chapters: [] });
  await view.rerender(<ChaptersRoute />);
  expect(await screen.findByText(/No chapters yet/)).toBeTruthy();
});

it('clears previous chapters on logout/login even for the same account', async () => {
  await render(<ChaptersRoute />);
  expect(await screen.findByTestId('chapter-0')).toBeTruthy();
  (getLifeChapters as jest.Mock).mockResolvedValue({ ...result, chapters: [] });
  await act(async () => { mockAuthListener?.(null); mockAuthListener?.('owner-a'); });
  expect(await screen.findByText(/No chapters yet/)).toBeTruthy();
  expect(screen.queryByTestId('chapter-0')).toBeNull();
});

it('aborts work on unmount', async () => {
  (getLifeChapters as jest.Mock).mockImplementation(() => new Promise(() => {}));
  const view = await render(<ChaptersRoute />);
  const signal = (getLifeChapters as jest.Mock).mock.calls[0][0] as AbortSignal;
  await view.unmount();
  expect(signal.aborted).toBe(true);
});

it('rebuilds chapters after returning from a deleted memory', async () => {
  await render(<ChaptersRoute />);
  expect(await screen.findByTestId('chapter-0')).toBeTruthy();
  await act(async () => { mockFocusCleanup?.(); });
  (getLifeChapters as jest.Mock).mockResolvedValue({ ...result, chapters: [] });
  await act(async () => { mockFocusCleanup = mockFocusCallback?.(); });
  expect(await screen.findByText(/No chapters yet/)).toBeTruthy();
  expect(screen.queryByTestId('chapter-0')).toBeNull();
});

it('refuses a late response after the screen loses focus', async () => {
  let finish: ((value: typeof result) => void) | undefined;
  (getLifeChapters as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await render(<ChaptersRoute />);
  const signal = (getLifeChapters as jest.Mock).mock.calls[0][0] as AbortSignal;
  await act(async () => { mockFocusCleanup?.(); });
  await act(async () => { finish?.(result); });
  expect(signal.aborted).toBe(true);
  expect(screen.queryByTestId('chapter-0')).toBeNull();
});

it('exposes the entry point only from an owned memory', async () => {
  const memory = { id: memoryId } as Memory;
  const view = await render(<MemoryBrowseLinks memory={memory} isOwner />);
  await act(async () => { fireEvent.press(screen.getByTestId('memory-open-chapters')); });
  expect(mockPush).toHaveBeenCalledWith('/memory/chapters');
  await view.rerender(<MemoryBrowseLinks memory={memory} isOwner={false} />);
  expect(screen.queryByTestId('memory-open-chapters')).toBeNull();
});
