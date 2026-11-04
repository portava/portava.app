/**
 * TripPostsSection (src/components/TripPage.tsx) — the trip's own posts.
 *
 * It used to be mounted with `posts={[]}`, drew a blank box where a picture
 * belonged, and its Add Post opened /create with no trip, so a post made from
 * the trip page never reached the trip. It now reads GET /trips/:tripId/posts
 * (useTripPosts), shows a failed read as a failure, draws the post's still,
 * and Add Post (members only) opens /create?tripId=….
 *
 * Run with: npx jest src/components/__tests__/TripPage.tripPosts.component.test.tsx
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...args: unknown[]) => mockPush(...args) },
  // No navigator here: a focus is the mount, which the section skips.
  useFocusEffect: (cb: () => void) => { require('react').useEffect(() => { cb(); }, []); },
}));

const mockReload = jest.fn(async () => {});
let mockState: Record<string, unknown> = {};
// NOTE: intentionally exhaustive — useTripPosts is the only usePosts export TripPage reads.
jest.mock('../../hooks/usePosts.ts', () => ({
  useTripPosts: () => ({ ...mockState, reload: mockReload }),
}));

jest.mock('../ui/DisplayMediaImage.tsx', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    ...jest.requireActual('../ui/DisplayMediaImage.tsx'),
    DisplayMediaImage: (p: { uri: string }) => R.createElement(View, { testID: `post-still:${p.uri}` }),
  };
});

import { TripPostsSection } from '../TripPage.tsx';

const POST = (over: Record<string, unknown>) => ({
  id: 'p', content: '', mediaUrls: [], media: [], ...over,
});

describe('TripPostsSection', () => {
  beforeEach(() => { mockPush.mockClear(); mockReload.mockClear(); });

  it("draws each post's picture (not an empty box), a text post's words, and Add Post opens the composer for THIS trip", async () => {
    mockState = {
      data: [POST({ id: 'p1', content: 'Sunset', mediaUrls: ['post-media/u/a.jpg'] }), POST({ id: 'p2', content: 'Meet at 8 by the port' })],
      isMember: true, loading: false, error: null,
    };
    await render(<TripPostsSection tripId="trip-abc" />);
    expect(screen.getByTestId('post-still:post-media/u/a.jpg')).toBeTruthy();
    expect(screen.getByText('Sunset')).toBeTruthy();
    expect(screen.getByText('Meet at 8 by the port')).toBeTruthy();
    fireEvent.press(screen.getByText('Add Post'));
    expect(mockPush).toHaveBeenCalledWith('/create?tripId=trip-abc');
    expect(mockReload).not.toHaveBeenCalled(); // the mount's focus does not double-load
  });

  it('a failed read is a failure with a retry — never "No trip posts yet"', async () => {
    mockState = { data: [], isMember: true, loading: false, error: 'network_unreachable' };
    await render(<TripPostsSection tripId="trip-abc" />);
    expect(screen.getByText("Couldn't load this trip's posts")).toBeTruthy();
    expect(screen.queryByText('No trip posts yet')).toBeNull();
    fireEvent.press(screen.getByText('Try again'));
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it('a non-member sees the empty state with no Add Post (the server refuses their trip post)', async () => {
    mockState = { data: [], isMember: false, loading: false, error: null };
    await render(<TripPostsSection tripId="trip-abc" />);
    expect(screen.getByText('No trip posts yet')).toBeTruthy();
    expect(screen.queryByText('Add Post')).toBeNull();
  });

  it('a member with no posts yet can add the first one to this trip', async () => {
    mockState = { data: [], isMember: true, loading: false, error: null };
    await render(<TripPostsSection tripId="trip-abc" />);
    fireEvent.press(screen.getByText('Add Post'));
    expect(mockPush).toHaveBeenCalledWith('/create?tripId=trip-abc');
  });
});
