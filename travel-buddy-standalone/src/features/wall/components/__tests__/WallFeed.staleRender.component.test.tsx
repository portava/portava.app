/**
 * WallFeed — offline stale render (Wall spec §31/§37/§40).
 *
 * When the items on screen are the cached offline page, the feed renders them
 * (never the empty state) WITH a "saved feed" label that does not rely on color
 * alone (§36). When the feed is live (stale=false) no banner shows, and when
 * there is nothing cached to show the ordinary empty state is untouched.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

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

function proj(id: string): WallProjection {
  return {
    projectionId: id,
    objectType: 'social_post',
    canonicalObjectId: `post-${id}`,
    publishedAt: '2026-09-04T00:00:00.000Z',
    visibility: 'public',
    text: `post ${id}`,
    actions: [],
  } as WallProjection;
}

const noop = () => {};

describe('WallFeed offline stale render', () => {
  it('renders the cached items with a saved-feed banner when stale', async () => {
    await render(
      <WallFeed
        items={[proj('a'), proj('b')]}
        mode="for_you"
        loading={false}
        refreshing={false}
        loadingMore={false}
        caughtUp={false}
        stale
        cachedAt={Date.now() - 5 * 60 * 1000}
        onEndReached={noop}
        onRefresh={noop}
      />,
    );
    const banner = screen.getByTestId('wall-stale-banner');
    expect(banner).toBeTruthy();
    // Text carries the offline meaning + a time — not color alone (§36).
    expect(screen.getByText(/Offline · saved feed/)).toBeTruthy();
    expect(screen.getByText(/5m ago/)).toBeTruthy();
  });

  it('shows no banner when the feed is live', async () => {
    await render(
      <WallFeed
        items={[proj('a')]}
        mode="for_you"
        loading={false}
        refreshing={false}
        loadingMore={false}
        caughtUp={false}
        stale={false}
        onEndReached={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.queryByTestId('wall-stale-banner')).toBeNull();
  });

  it('shows no banner (and the empty state stands) when stale but nothing is cached', async () => {
    await render(
      <WallFeed
        items={[]}
        mode="for_you"
        loading={false}
        refreshing={false}
        loadingMore={false}
        caughtUp={false}
        stale
        cachedAt={Date.now()}
        onEndReached={noop}
        onRefresh={noop}
      />,
    );
    expect(screen.queryByTestId('wall-stale-banner')).toBeNull();
  });
});
