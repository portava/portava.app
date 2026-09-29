/**
 * Event page participant surfaces built for testing mode (PLAT-F29, PLAT-F30):
 *   EventCommunitySection   — posts / photos / comments with true states;
 *   EventMemoryCard         — save a completed event as a Passport memory;
 *   SharedEventLinkPreview  — what a shared link shows for a private event.
 */
import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockApi = {
  getEventPosts: jest.fn(), createEventPost: jest.fn(), getEventMedia: jest.fn(), addEventMedia: jest.fn(),
  getEventComments: jest.fn(), postEventComment: jest.fn(), convertEventToMemory: jest.fn(), previewSharedEvent: jest.fn(),
};
// NOTE: exhaustive by design — these components import only these calls (and types) from the events service.
jest.mock('../../../services/events.ts', () => ({
  getEventPosts: (...a: any[]) => mockApi.getEventPosts(...a),
  createEventPost: (...a: any[]) => mockApi.createEventPost(...a),
  getEventMedia: (...a: any[]) => mockApi.getEventMedia(...a),
  addEventMedia: (...a: any[]) => mockApi.addEventMedia(...a),
  getEventComments: (...a: any[]) => mockApi.getEventComments(...a),
  postEventComment: (...a: any[]) => mockApi.postEventComment(...a),
  convertEventToMemory: (...a: any[]) => mockApi.convertEventToMemory(...a),
  previewSharedEvent: (...a: any[]) => mockApi.previewSharedEvent(...a),
}));

const mockUploadMedia = jest.fn();
jest.mock('../../../services/media.ts', () => ({
  ...jest.requireActual('../../../services/media.ts'),
  uploadMedia: (...a: any[]) => mockUploadMedia(...a),
}));

const mockPickMedia = jest.fn();
// NOTE: exhaustive by design — the section only calls pickMedia.
jest.mock('../../../hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: (...a: any[]) => mockPickMedia(...a) }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...a: any[]) => mockPush(...a), back: jest.fn() },
}));

import { EventCommunitySection } from '../EventCommunitySection.tsx';
import { EventMemoryCard } from '../EventMemoryCard.tsx';
import { SharedEventLinkPreview } from '../SharedEventLinkPreview.tsx';

beforeEach(() => jest.clearAllMocks());
afterEach(async () => { await act(async () => {}); });

const going = { id: 'ev-1', isHost: false, myRole: null, myRsvp: 'going' as const };
const post = { id: 'p1', body: 'Meet at the gate', mediaUrls: [], pinned: false, createdAt: '2026-10-01T17:00:00Z', author: { id: 'u', handle: 'ana', displayName: null, avatarUrl: null } };

describe('EventCommunitySection', () => {
  test('posts: a failed read is an error with Retry — never "No posts yet"', async () => {
    mockApi.getEventPosts.mockResolvedValueOnce({ ok: false, message: 'Posts are only visible to event participants' });
    const view = await render(<EventCommunitySection event={going} />);
    await waitFor(() => expect(view.getByTestId('event-community-error')).toBeTruthy());
    expect(view.queryByText('No posts yet.')).toBeNull();
    mockApi.getEventPosts.mockResolvedValueOnce({ ok: true, data: { posts: [post] } });
    await act(async () => { fireEvent.press(view.getByLabelText('Retry')); });
    await waitFor(() => expect(view.getByText('Meet at the gate')).toBeTruthy());
    expect(view.getByText('@ana')).toBeTruthy();
  });

  test('an empty read is "No posts yet"; posting sends the body and reloads', async () => {
    mockApi.getEventPosts.mockResolvedValueOnce({ ok: true, data: { posts: [] } }).mockResolvedValueOnce({ ok: true, data: { posts: [post] } });
    mockApi.createEventPost.mockResolvedValue({ ok: true, data: { id: 'p1' } });
    const view = await render(<EventCommunitySection event={going} />);
    await waitFor(() => expect(view.getByTestId('event-community-empty')).toBeTruthy());
    await act(async () => { fireEvent.changeText(view.getByLabelText('New post'), 'Meet at the gate'); });
    await act(async () => { fireEvent.press(view.getByLabelText('Post')); });
    await waitFor(() => expect(view.getByText('Meet at the gate')).toBeTruthy());
    expect(mockApi.createEventPost).toHaveBeenCalledWith('ev-1', 'Meet at the gate');
  });

  test('a refused post (host turned attendee posts off) shows the server message', async () => {
    mockApi.getEventPosts.mockResolvedValue({ ok: true, data: { posts: [] } });
    mockApi.createEventPost.mockResolvedValue({ ok: false, message: 'Posting is restricted to host/co-host' });
    const view = await render(<EventCommunitySection event={going} />);
    await waitFor(() => expect(view.getByTestId('event-community-empty')).toBeTruthy());
    await act(async () => { fireEvent.changeText(view.getByLabelText('New post'), 'hi'); });
    await act(async () => { fireEvent.press(view.getByLabelText('Post')); });
    await waitFor(() => expect(view.getByTestId('event-community-send-error')).toBeTruthy());
    expect(view.getByText('Posting is restricted to host/co-host')).toBeTruthy();
  });

  test('comments tab reads /comments and posts a comment', async () => {
    mockApi.getEventPosts.mockResolvedValue({ ok: true, data: { posts: [] } });
    mockApi.getEventComments.mockResolvedValue({ ok: true, data: { updates: [{ id: 'c1', author_id: 'u', body: 'see you', pinned: true, created_at: '2026-10-01T17:00:00Z', author: { id: 'u', handle: 'bo', displayName: null, avatarUrl: null } }] } });
    mockApi.postEventComment.mockResolvedValue({ ok: true, data: {} });
    const view = await render(<EventCommunitySection event={going} />);
    await act(async () => { fireEvent.press(view.getByLabelText('Comments')); });
    await waitFor(() => expect(view.getByText('see you')).toBeTruthy());
    await act(async () => { fireEvent.changeText(view.getByLabelText('New comment'), 'on my way'); });
    await act(async () => { fireEvent.press(view.getByLabelText('Send comment')); });
    await waitFor(() => expect(mockApi.postEventComment).toHaveBeenCalledWith('ev-1', 'on my way'));
  });

  test('photos: uploads through /api/media/upload, then adds the returned ref to the event', async () => {
    mockApi.getEventPosts.mockResolvedValue({ ok: true, data: { posts: [] } });
    mockApi.getEventMedia.mockResolvedValueOnce({ ok: true, data: { media: [] } })
      .mockResolvedValueOnce({ ok: true, data: { media: [{ id: 'm1', uploader_id: 'u', media_url: 'post-media/u/p.jpg', media_type: 'image', caption: null, created_at: '2026-10-01T17:00:00Z' }] } });
    mockPickMedia.mockResolvedValue([{ uri: 'file:///p.jpg', mimeType: 'image/jpeg', width: 10, height: 10 }]);
    mockUploadMedia.mockResolvedValue({ ok: true, url: 'post-media/u/p.jpg', mediaType: 'image' });
    mockApi.addEventMedia.mockResolvedValue({ ok: true, data: {} });
    const view = await render(<EventCommunitySection event={going} />);
    await act(async () => { fireEvent.press(view.getByLabelText('Photos')); });
    await waitFor(() => expect(view.getByText('No photos yet.')).toBeTruthy());
    await act(async () => { fireEvent.press(view.getByTestId('event-community-add-photo')); });
    await waitFor(() => expect(mockApi.addEventMedia).toHaveBeenCalledWith('ev-1', 'post-media/u/p.jpg', 'image'));
    await waitFor(() => expect(view.queryByText('No photos yet.')).toBeNull());
  });

  test('a failed upload is said, and nothing is added to the event', async () => {
    mockApi.getEventPosts.mockResolvedValue({ ok: true, data: { posts: [] } });
    mockApi.getEventMedia.mockResolvedValue({ ok: true, data: { media: [] } });
    mockPickMedia.mockResolvedValue([{ uri: 'file:///p.jpg', mimeType: 'image/jpeg' }]);
    mockUploadMedia.mockResolvedValue({ ok: false, url: null, mediaType: null, message: 'Too many uploads' });
    const view = await render(<EventCommunitySection event={going} />);
    await act(async () => { fireEvent.press(view.getByLabelText('Photos')); });
    await waitFor(() => expect(view.getByTestId('event-community-add-photo')).toBeTruthy());
    await act(async () => { fireEvent.press(view.getByTestId('event-community-add-photo')); });
    await waitFor(() => expect(view.getByText('Too many uploads')).toBeTruthy());
    expect(mockApi.addEventMedia).not.toHaveBeenCalled();
  });

  test('a Maybe RSVP can read but is offered no composer', async () => {
    mockApi.getEventPosts.mockResolvedValue({ ok: true, data: { posts: [post] } });
    const view = await render(<EventCommunitySection event={{ ...going, myRsvp: 'maybe' as const }} />);
    await waitFor(() => expect(view.getByText('Meet at the gate')).toBeTruthy());
    expect(view.queryByLabelText('New post')).toBeNull();
  });
});

describe('EventMemoryCard', () => {
  const completed = { id: 'ev-1', state: 'completed' as const, isHost: false, myRole: null, myRsvp: 'going' as const };

  test('saves, then offers the Passport', async () => {
    mockApi.convertEventToMemory.mockResolvedValue({ ok: true, data: { memoryId: 'mem-1' } });
    const view = await render(<EventMemoryCard event={completed} />);
    await act(async () => { fireEvent.press(view.getByTestId('event-memory-save')); });
    await waitFor(() => expect(view.getByText('Saved to your Passport')).toBeTruthy());
    await act(async () => { fireEvent.press(view.getByLabelText('View in Passport')); });
    expect(mockPush).toHaveBeenCalledWith('/(tabs)/passport');
  });

  test('a refusal is the server message, not "Saved"', async () => {
    mockApi.convertEventToMemory.mockResolvedValue({ ok: false, message: 'Only completed events can be converted to a memory' });
    const view = await render(<EventMemoryCard event={completed} />);
    await act(async () => { fireEvent.press(view.getByTestId('event-memory-save')); });
    await waitFor(() => expect(view.getByTestId('event-memory-error')).toBeTruthy());
    expect(view.queryByText('Saved to your Passport')).toBeNull();
  });

  test('renders nothing before the event is completed on the server', async () => {
    const view = await render(<EventMemoryCard event={{ ...completed, state: 'started' as const }} />);
    expect(view.toJSON()).toBeNull();
  });

  test('renders nothing for a Maybe RSVP', async () => {
    const view = await render(<EventMemoryCard event={{ ...completed, myRsvp: 'maybe' as const }} />);
    expect(view.toJSON()).toBeNull();
  });
});

describe('SharedEventLinkPreview', () => {
  test('shows the shared event from the preview route', async () => {
    mockApi.previewSharedEvent.mockResolvedValue({ ok: true, data: { shareToken: 'tok12345', event: {
      id: 'ev-1', title: 'Rooftop supper', startsAt: '2026-10-01T18:00:00Z', locationName: 'Casa', city: 'Lisbon',
      hostName: null, hostHandle: 'host', coverUrl: null, description: 'Bring a dish',
    } } });
    const view = await render(<SharedEventLinkPreview token="tok12345" />);
    await waitFor(() => expect(view.getByText('Rooftop supper')).toBeTruthy());
    expect(mockApi.previewSharedEvent).toHaveBeenCalledWith('tok12345');
    expect(view.getByText('Hosted by @host')).toBeTruthy();
  });

  test('an expired or used-up link says so, without Retry', async () => {
    mockApi.previewSharedEvent.mockResolvedValue({ ok: false, message: 'Share link usage limit reached' });
    const view = await render(<SharedEventLinkPreview token="tok12345" />);
    await waitFor(() => expect(view.getByTestId('shared-event-ended')).toBeTruthy());
    expect(view.queryByLabelText('Retry')).toBeNull();
  });

  test('any other failure is an error with Retry', async () => {
    mockApi.previewSharedEvent.mockResolvedValueOnce({ ok: false, message: 'Network request failed' });
    const view = await render(<SharedEventLinkPreview token="tok12345" />);
    await waitFor(() => expect(view.getByTestId('shared-event-error')).toBeTruthy());
    mockApi.previewSharedEvent.mockResolvedValueOnce({ ok: true, data: { shareToken: 't', event: { id: 'ev-1', title: 'Rooftop supper', startsAt: null, locationName: null, city: null, hostName: null, hostHandle: null, coverUrl: null, description: null } } });
    await act(async () => { fireEvent.press(view.getByLabelText('Retry')); });
    await waitFor(() => expect(view.getByText('Rooftop supper')).toBeTruthy());
  });
});
