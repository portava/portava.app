/**
 * HM-F14 — a user's memories on their profile.
 *
 * `getUserMemories` (GET /users/:userId/memories) had no caller: the Passport
 * Memories tab renders `passport_memories`, a different table. This section
 * renders the `memories` albums the SERVER decided this viewer may see (§23
 * canReadMemory "profile", block check, location protection applied by
 * enrichMemories) and adds nothing of its own.
 *
 * Pinned: it asks for the profile it is given; it pages with the server's
 * cursor; an unreadable list is an error with a retry, never "no memories".
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

const mockPush = jest.fn();
// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({ router: { push: (...a: unknown[]) => mockPush(...a) } }));
// NOTE: intentionally exhaustive — CachedImage resolves through expo-image.
jest.mock('../../../../components/CachedImage.tsx', () => ({ CachedImage: () => null }));

const mockGetUserMemories = jest.fn();
jest.mock('../../../../services/memories.ts', () => ({
  ...jest.requireActual('../../../../services/memories.ts'),
  getUserMemories: (...a: unknown[]) => mockGetUserMemories(...a),
}));

import { ProfileMemoryAlbums } from '../ProfileMemoryAlbums.tsx';

const USER = '99999999-9999-4999-8999-999999999999';
const m = (id: string, title: string) => ({ id, title, locationCity: 'Lisbon', locationCountry: 'Portugal', createdAt: '2026-09-01T00:00:00Z', startsAt: null, cover: null, items: [] });

beforeEach(() => { mockPush.mockReset(); mockGetUserMemories.mockReset(); });

it('lists the memories the server returned for this profile and opens one', async () => {
  mockGetUserMemories.mockResolvedValue({ ok: true, memories: [m('m1', 'Lisbon light')], nextCursor: null });
  await render(<ProfileMemoryAlbums userId={USER} />);
  expect(await screen.findByText('Lisbon light')).toBeTruthy();
  expect(mockGetUserMemories).toHaveBeenCalledWith(USER, null);
  await act(async () => { fireEvent.press(screen.getByTestId('profile-memory-m1')); });
  expect(mockPush).toHaveBeenCalledWith('/memory/m1');
});

it('pages with the server cursor', async () => {
  mockGetUserMemories
    .mockResolvedValueOnce({ ok: true, memories: [m('m1', 'One')], nextCursor: 'c1' })
    .mockResolvedValueOnce({ ok: true, memories: [m('m2', 'Two')], nextCursor: null });
  await render(<ProfileMemoryAlbums userId={USER} />);
  await screen.findByText('One');
  await act(async () => { fireEvent.press(screen.getByTestId('profile-memories-more')); });
  expect(await screen.findByText('Two')).toBeTruthy();
  expect(mockGetUserMemories).toHaveBeenLastCalledWith(USER, 'c1');
  expect(screen.queryByTestId('profile-memories-more')).toBeNull();
});

it('an unreadable list is an error with a retry, not "no memories"', async () => {
  mockGetUserMemories.mockResolvedValueOnce({ ok: false, message: 'HTTP 503' });
  await render(<ProfileMemoryAlbums userId={USER} />);
  expect(await screen.findByTestId('profile-memories-error')).toBeTruthy();
  expect(screen.queryByTestId('profile-memories-empty')).toBeNull();
  mockGetUserMemories.mockResolvedValueOnce({ ok: true, memories: [], nextCursor: null });
  await act(async () => { fireEvent.press(screen.getByTestId('profile-memories-retry')); });
  expect(await screen.findByTestId('profile-memories-empty')).toBeTruthy();
});
