/**
 * Component test: the end-of-feed states (Wall spec §27).
 *
 * Following reaching the end of eligible content shows a positive "caught up"
 * state; a degraded/empty feed shows a calm empty state — never a crash or a
 * void (spec §40 #7).
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design mock — WallFeed → WallObjectRenderer → object
// renderers → wallAnalytics → wallApi, whose real module loads the supabase /
// apiToken chain at import and crashes the suite.
jest.mock('../../services/wallApi.ts', () => ({
  fetchWall: jest.fn(),
  fetchLiveForYou: jest.fn(),
  fetchQuickMedia: jest.fn(),
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(),
  sendImpression: jest.fn(),
  sendAction: jest.fn(),
}));

import { WallFeed } from '../WallFeed.tsx';
import type { WallProjection } from '../../types/wallProjection.ts';

const onePost: WallProjection = {
  projectionId: 'p1',
  objectType: 'social_post',
  canonicalObjectId: 'c-p1',
  publishedAt: new Date().toISOString(),
  visibility: 'public',
  text: 'Only post',
  actions: [],
};

const noop = () => {};

describe('WallFeed end states', () => {
  it('shows the caught-up state at the end of Following', async () => {
    await render(
      <WallFeed
        items={[onePost]}
        mode="following"
        loading={false}
        refreshing={false}
        loadingMore={false}
        caughtUp
        onEndReached={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.getByTestId('wall-caught-up-caught_up')).toBeTruthy();
  });

  it('shows a calm empty state when there is nothing to show', async () => {
    await render(
      <WallFeed
        items={[]}
        mode="for_you"
        loading={false}
        refreshing={false}
        loadingMore={false}
        caughtUp={false}
        onEndReached={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.getByTestId('wall-caught-up-empty')).toBeTruthy();
  });
});
