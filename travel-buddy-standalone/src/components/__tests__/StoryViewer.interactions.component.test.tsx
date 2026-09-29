/**
 * PLAT-F33 — the story viewer's controls.
 *
 *   Someone else's story: react with an emoji (POST /stories/:id/react) and
 *   reply (sendStoryReply: the story gate, then the author's direct chat).
 *   Your own story: Save to highlight (POST /stories/:id/save-to-highlight),
 *   with the server's sentence when this story's audience cannot become one.
 *   The viewer list: a failed read is an error, not "No viewers yet".
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';

let mockUserId = 'viewer';
// NOTE: intentionally exhaustive — the real SessionContext starts auth work.
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: mockUserId }) }));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — the identity link navigates through expo-router.
jest.mock('../interaction/UserIdentityLink.tsx', () => ({ UserIdentityLink: ({ children }: { children: React.ReactNode }) => children }));
// NOTE: intentionally exhaustive — media hydration signs URLs through the API.
jest.mock('../ui/DisplayMediaImage.tsx', () => ({ DisplayMediaImage: () => null }));

const mockReact = jest.fn();
const mockSave = jest.fn();
const mockViewers = jest.fn();
const mockReply = jest.fn();
jest.mock('../../services/stories.ts', () => ({
  ...jest.requireActual('../../services/stories.ts'),
  reactToStory: (...a: unknown[]) => mockReact(...a),
  saveToHighlight: (...a: unknown[]) => mockSave(...a),
  getViewers: (...a: unknown[]) => mockViewers(...a),
}));
jest.mock('../../services/storyReply.ts', () => ({
  ...jest.requireActual('../../services/storyReply.ts'),
  sendStoryReply: (...a: unknown[]) => mockReply(...a),
}));

import { StoryViewer } from '../StoryViewer.tsx';

const OWNER = 'owner';
const story = (id: string, over: Record<string, unknown> = {}) => ({
  id, owner_id: OWNER, media_url: 'https://x/a.jpg', media_type: 'image/jpeg', caption: null, visibility: 'public',
  close_friends_only: false, trip_id: null, expires_at: '2999-01-01T00:00:00Z', state: 'active', hide_viewer_list: false,
  created_at: '2026-09-29T00:00:00Z', ...over,
});
const feedUser = (stories = [story('s1')]) => ({ userId: OWNER, handle: 'olive', name: 'Olive', avatarUrl: null, stories, hasUnviewed: true });

beforeEach(() => {
  mockUserId = 'viewer';
  mockReact.mockReset(); mockSave.mockReset(); mockViewers.mockReset(); mockReply.mockReset();
});

it('reacting sends the emoji for the story on screen', async () => {
  mockReact.mockResolvedValue({ ok: true });
  await render(<StoryViewer visible feedUser={feedUser() as never} onClose={() => {}} />);
  await act(async () => { fireEvent.press(screen.getByTestId('story-react-🔥')); });
  expect(mockReact).toHaveBeenCalledWith('s1', '🔥');
  expect(await screen.findByText('Reaction sent')).toBeTruthy();
});

it('a refused reaction says so', async () => {
  mockReact.mockResolvedValue({ ok: false });
  await render(<StoryViewer visible feedUser={feedUser() as never} onClose={() => {}} />);
  await act(async () => { fireEvent.press(screen.getByTestId('story-react-😂')); });
  expect(await screen.findByText('Your reaction could not be sent.')).toBeTruthy();
});

it('a reply goes through sendStoryReply to the author', async () => {
  mockReply.mockResolvedValue({ ok: true, threadId: 't1' });
  await render(<StoryViewer visible feedUser={feedUser() as never} onClose={() => {}} />);
  await act(async () => { fireEvent.changeText(screen.getByTestId('story-reply-input'), 'Looks amazing'); });
  await act(async () => { fireEvent.press(screen.getByTestId('story-reply-send')); });
  expect(mockReply).toHaveBeenCalledWith({ storyId: 's1', ownerId: OWNER, text: 'Looks amazing' });
  expect(await screen.findByText('Reply sent to their chat')).toBeTruthy();
});

it('a reply that could not be delivered keeps the text and says why', async () => {
  mockReply.mockResolvedValue({ ok: false, message: 'This person is not accepting messages' });
  await render(<StoryViewer visible feedUser={feedUser() as never} onClose={() => {}} />);
  await act(async () => { fireEvent.changeText(screen.getByTestId('story-reply-input'), 'hi'); });
  await act(async () => { fireEvent.press(screen.getByTestId('story-reply-send')); });
  expect(await screen.findByText('This person is not accepting messages')).toBeTruthy();
  expect(screen.getByTestId('story-reply-input').props.value).toBe('hi');
});

it('the owner sees no react/reply, and can save the story to a highlight', async () => {
  mockUserId = OWNER;
  mockSave.mockResolvedValue({ ok: true, highlightId: 'h1' });
  await render(<StoryViewer visible feedUser={feedUser() as never} onClose={() => {}} />);
  expect(screen.queryByTestId('story-reply-input')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByTestId('story-save-highlight')); });
  expect(mockSave).toHaveBeenCalledWith('s1');
  expect(await screen.findByText('Saved to your highlights')).toBeTruthy();
});

it("the server's reason is shown when a story's audience cannot become a highlight", async () => {
  mockUserId = OWNER;
  mockSave.mockResolvedValue({ ok: false, message: 'Close-friends stories cannot become a Highlight.' });
  await render(<StoryViewer visible feedUser={feedUser() as never} onClose={() => {}} />);
  await act(async () => { fireEvent.press(screen.getByTestId('story-save-highlight')); });
  expect(await screen.findByText('Close-friends stories cannot become a Highlight.')).toBeTruthy();
});

it('a story already saved is not offered again', async () => {
  mockUserId = OWNER;
  await render(<StoryViewer visible feedUser={feedUser([story('s1', { saved_to_highlight_id: 'h0' })]) as never} onClose={() => {}} />);
  expect(screen.queryByTestId('story-save-highlight')).toBeNull();
  expect(screen.getByText('In your highlights')).toBeTruthy();
});

it('a viewer list that could not be read is an error, not "No viewers yet"', async () => {
  mockUserId = OWNER;
  mockViewers.mockResolvedValue({ ok: false, message: 'HTTP 500' });
  await render(<StoryViewer visible feedUser={feedUser() as never} onClose={() => {}} />);
  await act(async () => { fireEvent.press(screen.getByText('Viewers')); });
  await waitFor(() => expect(mockViewers).toHaveBeenCalledWith('s1'));
  expect(await screen.findByText('Viewers could not be loaded.')).toBeTruthy();
  expect(screen.queryByText('No viewers yet')).toBeNull();
});
