/**
 * PLAT-F33 — /stories, the place a story can actually be opened.
 *
 * StoriesStrip, StoryViewer and StoryComposer existed and nothing under app/
 * mounted any of them, so no story could be viewed, reacted to, replied to or
 * saved. This route lists "Your story" (GET /me/stories) and the people whose
 * stories you may see (GET /stories/feed), opens the viewer, and offers the
 * composer.
 *
 * Honest states: a feed that could not be read is an error with a retry,
 * never "no stories"; stories switched off says so.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — expo-router's real module needs a navigator.
jest.mock('expo-router', () => ({ router: { back: jest.fn(), push: jest.fn() } }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — the real SessionContext starts auth work.
jest.mock('../../src/context/SessionContext.tsx', () => ({ useSession: () => ({ userId: 'me' }) }));
// NOTE: intentionally exhaustive — the viewer is exercised by its own suite;
// here it only needs to report whose stories it was opened on.
jest.mock('../../src/components/StoryViewer.tsx', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { StoryViewer: ({ visible, feedUser }: { visible: boolean; feedUser: { userId: string } | null }) => (visible && feedUser ? <T>{`viewing:${feedUser.userId}`}</T> : null) };
});
// NOTE: intentionally exhaustive — the composer reaches the camera/picker.
jest.mock('../../src/components/StoryComposer.tsx', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { StoryComposer: ({ visible }: { visible: boolean }) => (visible ? <T>composer-open</T> : null) };
});
// NOTE: intentionally exhaustive — avatars resolve through the media cache.
jest.mock('../../src/components/ui/DisplayMediaImage.tsx', () => ({ AvatarImage: () => null, DisplayMediaImage: () => null }));

const mockFeed = jest.fn();
const mockMine = jest.fn();
jest.mock('../../src/services/stories.ts', () => ({
  ...jest.requireActual('../../src/services/stories.ts'),
  getStoriesFeed: (...a: unknown[]) => mockFeed(...a),
  getMyStories: (...a: unknown[]) => mockMine(...a),
}));

import StoriesRoute from '../stories.tsx';

const st = (id: string, owner: string) => ({ id, owner_id: owner, media_url: 'u', media_type: 'image/jpeg', caption: null, visibility: 'public', close_friends_only: false, trip_id: null, expires_at: '2999-01-01T00:00:00Z', state: 'active', hide_viewer_list: false, created_at: '2026-09-29T00:00:00Z' });
const me = { userId: 'me', handle: 'me', name: 'Me', avatarUrl: null, hasUnviewed: false };

beforeEach(() => { mockFeed.mockReset(); mockMine.mockReset(); });

it('lists your story and your friends, and opens the viewer on a friend', async () => {
  mockMine.mockResolvedValue({ ok: true, user: { ...me, stories: [st('s0', 'me')] } });
  mockFeed.mockResolvedValue({ ok: true, users: [{ userId: 'bea', handle: 'bea', name: 'Bea', avatarUrl: null, hasUnviewed: true, stories: [st('s1', 'bea')] }] });
  await render(<StoriesRoute />);
  expect(await screen.findByText('Bea')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByTestId('stories-user-bea')); });
  expect(screen.getByText('viewing:bea')).toBeTruthy();
});

it('opens your own story, where save-to-highlight lives', async () => {
  mockMine.mockResolvedValue({ ok: true, user: { ...me, stories: [st('s0', 'me')] } });
  mockFeed.mockResolvedValue({ ok: true, users: [] });
  await render(<StoriesRoute />);
  await act(async () => { fireEvent.press(await screen.findByTestId('stories-mine')); });
  expect(screen.getByText('viewing:me')).toBeTruthy();
});

it('with no story of your own, "Your story" opens the composer', async () => {
  mockMine.mockResolvedValue({ ok: true, user: { ...me, stories: [] } });
  mockFeed.mockResolvedValue({ ok: true, users: [] });
  await render(<StoriesRoute />);
  await act(async () => { fireEvent.press(await screen.findByTestId('stories-mine')); });
  expect(screen.getByText('composer-open')).toBeTruthy();
  expect(screen.getByTestId('stories-empty')).toBeTruthy();
});

it('a feed that could not be read is an error with a retry, never "no stories"', async () => {
  mockMine.mockResolvedValue({ ok: true, user: { ...me, stories: [] } });
  mockFeed.mockResolvedValueOnce({ ok: false, message: 'HTTP 503' });
  await render(<StoriesRoute />);
  expect(await screen.findByTestId('stories-error')).toBeTruthy();
  expect(screen.queryByTestId('stories-empty')).toBeNull();
  mockFeed.mockResolvedValueOnce({ ok: true, users: [] });
  await act(async () => { fireEvent.press(screen.getByTestId('stories-retry')); });
  expect(await screen.findByTestId('stories-empty')).toBeTruthy();
});

it('stories switched off says so', async () => {
  mockMine.mockResolvedValue({ ok: false, disabled: true, message: 'Stories are not enabled' });
  mockFeed.mockResolvedValue({ ok: false, message: 'HTTP 404' });
  await render(<StoriesRoute />);
  expect(await screen.findByTestId('stories-disabled')).toBeTruthy();
});
