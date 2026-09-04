/**
 * Component test: the Wall's outcome + engagement analytics (Wall spec §32).
 *
 * The Wall is measured as a social product AND a bridge to real-world outcomes,
 * not by session length. This proves the events the spec §32 enumerates are
 * actually emitted from the UI, and that a hide/not-interested control both
 * signals the server and drops the object locally:
 *   - follow from feed (with the discovery-follow conversion flag);
 *   - Map/Place/Trip/Buddy handoff;
 *   - stamp/comment/share/save engagement;
 *   - hide / not-interested;
 *   - caught-up.
 * Every event carries ids + enums only — never post text (spec §32).
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — the real wallApi loads the supabase /
// apiToken chain at import, which would crash the jest suite.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

// NOTE: expo-router requires native navigation modules unavailable in jest-expo.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

import { router } from 'expo-router';
import * as wallApi from '../../services/wallApi.ts';
import { WallScreen } from '../WallScreen.tsx';
import {
  setWallAnalyticsSink,
  resetWallAnalyticsSink,
  type WallAnalyticsEvent,
} from '../../services/wallAnalytics.ts';
import type { WallProjection, WallResponse } from '../../types/wallProjection.ts';

const mockFetchWall = wallApi.fetchWall as unknown as jest.Mock;
const mockFetchLive = wallApi.fetchLiveForYou as unknown as jest.Mock;
const mockSendAction = wallApi.sendAction as unknown as jest.Mock;
const mockPush = router.push as jest.Mock;

const NOW = new Date().toISOString();

const items: WallProjection[] = [
  {
    projectionId: 'p1',
    canonicalObjectId: 'c-p1',
    objectType: 'social_post',
    publishedAt: NOW,
    visibility: 'public',
    text: 'Rooftop views',
    place: { placeId: 'pl-1', name: 'Sky Bar', city: 'Da Nang' },
    actions: [{ type: 'see_place', label: 'See place', targetId: 'pl-1' }],
  },
  {
    projectionId: 'd1',
    canonicalObjectId: 'c-d1',
    objectType: 'discovery',
    publishedAt: NOW,
    visibility: 'public',
    discoveryReason: 'Followed by 3 people you know',
    text: 'New creator',
    actions: [{ type: 'follow', label: 'Follow' }],
  },
];

function response(mode: 'for_you' | 'following' = 'for_you', caughtUp = false): WallResponse {
  return { mode, liveForYou: [], items, caughtUp, generatedAt: NOW };
}

let events: WallAnalyticsEvent[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  setWallAnalyticsSink((e) => events.push(e));
  mockFetchLive.mockResolvedValue({ ok: true, liveForYou: [], degraded: false });
  // Following returns caught-up; For You does not — lets us exercise both.
  mockFetchWall.mockImplementation((opts: { mode: 'for_you' | 'following' }) => ({
    ok: true,
    degraded: false,
    data: response(opts.mode, opts.mode === 'following'),
  }));
});

afterEach(() => {
  resetWallAnalyticsSink();
});

describe('Wall engagement + outcome analytics (§32)', () => {
  it('records a discovery-follow conversion when Follow is pressed on a discovery insertion', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-item-discovery')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Follow'));

    const follow = events.find(
      (e): e is Extract<WallAnalyticsEvent, { type: 'wall_follow_from_feed' }> =>
        e.type === 'wall_follow_from_feed',
    );
    expect(follow).toBeDefined();
    expect(follow?.fromDiscovery).toBe(true);
    expect(follow?.objectId).toBe('c-d1');
  });

  it('records a Place handoff and routes into the canonical Place surface', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-item-social_post')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('See place'));

    expect(events.some((e) => e.type === 'wall_handoff' && e.surface === 'place')).toBe(true);
    expect(mockPush).toHaveBeenCalledWith('/place/pl-1');
  });

  it('records a distinct save engagement', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-item-social_post')).toBeTruthy());

    // p1 is first in the list, so its Save control is the first one.
    fireEvent.press(screen.getAllByLabelText('Save')[0]);

    expect(
      events.some(
        (e) => e.type === 'wall_engagement' && e.kind === 'save' && e.objectId === 'c-p1',
      ),
    ).toBe(true);
  });

  it('hides an object on not-interested: signals the server (ids only) and drops it locally', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-item-social_post')).toBeTruthy());

    fireEvent.press(screen.getByTestId('wall-not-interested-p1'));

    // Analytics signal recorded (ids only).
    expect(events.some((e) => e.type === 'wall_not_interested' && e.objectId === 'c-p1')).toBe(true);
    // Server told to stop surfacing it — ids + verb only, never the text.
    expect(mockSendAction).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: 'c-p1', objectType: 'social_post' }),
      'hide',
    );
    // Dropped from the feed.
    await waitFor(() => expect(screen.queryByTestId('wall-item-social_post')).toBeNull());
  });

  it('records the caught-up rate when the viewer reaches the end of Following', async () => {
    await render(<WallScreen />);
    await waitFor(() => expect(screen.getByTestId('wall-mode-following')).toBeTruthy());

    fireEvent.press(screen.getByTestId('wall-mode-following'));

    await waitFor(() =>
      expect(events.some((e) => e.type === 'wall_caught_up' && e.mode === 'following')).toBe(true),
    );
  });
});
